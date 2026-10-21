use super::*;
use std::io::{Read, Write};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub id: String,
    pub title: String,
    pub provider: String,
    pub base_url: Option<String>,
    pub models: Vec<providers::ProviderModel>,
    pub default_model: Option<String>,
    pub has_credential: bool,
    #[serde(default)]
    pub revision: u64,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SavedSetup {
    #[serde(default)]
    pub engine_enabled: bool,
    pub engine_directory: Option<PathBuf>,
    pub legacy_source_id: Option<String>,
    #[serde(default)]
    pub connections: Vec<SavedConnection>,
    #[serde(default)]
    pub mcp_connections: Vec<mcp::SavedMcpConnection>,
    #[serde(default)]
    pub mcp_ids: Vec<String>,
    #[serde(default)]
    pub desired_revision: u64,
    pub applied: Option<AppliedSetup>,
    pub staged: Option<AppliedSetup>,
    #[serde(default)]
    pub retired_credentials: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AppliedSetup {
    pub revision: u64,
    #[serde(default)]
    pub incomplete: bool,
    pub connections: Vec<SavedConnection>,
    #[serde(default)]
    pub mcp_connections: Vec<mcp::SavedMcpConnection>,
    #[serde(default)]
    pub mcp_ids: Vec<String>,
    pub legacy_source_id: Option<String>,
    pub credential_entries: std::collections::BTreeMap<String, String>,
}

pub(super) fn pending(saved: &SavedSetup) -> bool {
    saved
        .applied
        .as_ref()
        .is_some_and(|applied| applied.incomplete || applied.revision != saved.desired_revision)
}

pub(super) trait Credentials {
    fn get(&self, id: &str) -> Result<Option<String>, String>;
    fn set(&self, id: &str, value: &str) -> Result<(), String>;
    fn remove(&self, id: &str) -> Result<(), String>;
}

pub(super) struct Keychain;

impl Credentials for Keychain {
    fn get(&self, id: &str) -> Result<Option<String>, String> {
        match credential(id)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Cannot unlock the system credential store. Unlock it and retry.".into()),
        }
    }

    fn set(&self, id: &str, value: &str) -> Result<(), String> {
        credential(id)?.set_password(value).map_err(|_| {
            "Cannot save the connection credential in the system credential store. Unlock it and retry.".into()
        })
    }

    fn remove(&self, id: &str) -> Result<(), String> {
        match credential(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(
                "Cannot remove the connection credential from the system credential store.".into(),
            ),
        }
    }
}

fn credential(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("dev.knotra.desktop.model-source", id)
        .map_err(|_| "Cannot open the system credential store.".into())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

pub(super) fn load(root: &Path) -> Result<SavedSetup, String> {
    let file = match fs::File::open(root.join("desktop-connections.json")) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SavedSetup::default())
        }
        Err(_) => return Err("Cannot read your saved connections.".into()),
    };
    let saved: SavedSetup = serde_json::from_reader(file.take(8 * 1024 * 1024))
        .map_err(|_| "Saved connections are invalid. Your data has not been changed.")?;
    let mut ids = std::collections::HashSet::new();
    for source in &saved.connections {
        if !valid_id(&source.id) || !ids.insert(&source.id) {
            return Err("Saved connections are invalid. Your data has not been changed.".into());
        }
        providers::validate(
            &source.provider,
            source.default_model.as_deref().unwrap_or("default"),
            (source.has_credential || ["openai", "anthropic"].contains(&source.provider.as_str()))
                .then_some("stored-key"),
            source.base_url.as_deref(),
        )
        .map_err(|_| "Saved connections are invalid. Your data has not been changed.")?;
    }
    for source in &saved.mcp_connections {
        if !valid_id(&source.id) || !ids.insert(&source.id) {
            return Err("Saved connections are invalid. Your data has not been changed.".into());
        }
        mcp::validate_saved(source)
            .map_err(|_| "Saved MCP connections are invalid. Your data has not been changed.")?;
    }
    let mut known_mcp = std::collections::HashSet::new();
    if saved
        .mcp_ids
        .iter()
        .any(|id| !valid_id(id) || !known_mcp.insert(id))
    {
        return Err("Saved MCP connection IDs are invalid. Your data has not been changed.".into());
    }
    if saved
        .engine_directory
        .as_ref()
        .is_some_and(|path| path.parent() != Some(root))
    {
        return Err(
            "The saved engine data folder is invalid. Your data has not been changed.".into(),
        );
    }
    Ok(saved)
}

pub(super) fn migrate(root: &Path) -> Result<(), String> {
    if root.join("desktop-connections.json").exists() {
        return Ok(());
    }
    let Some(directory) = fs::read_dir(root).ok().and_then(|entries| {
        entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                let modified = fs::metadata(path.join("desktop-ports.json"))
                    .ok()?
                    .modified()
                    .ok()?;
                (path.join("settings.json").is_file() && path.join("profile.json").is_file())
                    .then_some((modified, path))
            })
            .max_by_key(|(modified, _)| *modified)
            .map(|(_, path)| path)
    }) else {
        return Ok(());
    };
    let profile: serde_json::Value = serde_json::from_reader(
        fs::File::open(directory.join("profile.json"))
            .map_err(|_| "Cannot read the previous model connection.")?
            .take(8 * 1024 * 1024),
    )
    .map_err(|_| "The previous engine profile is invalid. Your data has not been changed.")?;
    let primary = &profile["spec"]["models"]["model_main"];
    let provider = primary["provider"]
        .as_str()
        .ok_or("The previous engine profile has no primary model source.")?
        .replace('_', "-");
    let model = primary["model"]
        .as_str()
        .ok_or("The previous model source has no default model.")?;
    let base_url = providers::validate(
        &provider,
        model,
        ["openai", "anthropic"]
            .contains(&provider.as_str())
            .then_some("previous-session-key"),
        primary["baseUrl"].as_str(),
    )?;
    let source = SavedConnection {
        id: source_id(),
        title: provider.clone(),
        provider,
        base_url,
        models: vec![providers::ProviderModel {
            id: model.into(),
            name: model.into(),
        }],
        default_model: Some(model.into()),
        has_credential: false,
        revision: 0,
    };
    store(
        root,
        &SavedSetup {
            engine_enabled: true,
            engine_directory: Some(directory),
            legacy_source_id: Some(source.id.clone()),
            connections: vec![source],
            ..Default::default()
        },
    )
}

pub(super) fn store(root: &Path, saved: &SavedSetup) -> Result<(), String> {
    let encoded = serde_json::to_vec_pretty(saved).unwrap();
    if encoded.len() > 8 * 1024 * 1024 {
        return Err("Saved connection catalogs exceed the supported size. Remove an unused connection before adding another.".into());
    }
    private_dir(root)?;
    let temporary = root.join(".desktop-connections.tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "Cannot save your connections.")?;
    file.write_all(&encoded)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot save your connections.")?;
    fs::rename(temporary, root.join("desktop-connections.json"))
        .map_err(|_| "Cannot finish saving your connections.".into())
}

pub(super) fn key(
    source: &SavedConnection,
    credentials: &impl Credentials,
) -> Result<Option<String>, String> {
    if source.has_credential {
        credentials.get(&source.id)?.ok_or_else(|| {
            format!("The saved API key for {} is unavailable. Edit this source and save its key again.", source.title)
        }).map(Some)
    } else if ["openai", "anthropic"].contains(&source.provider.as_str()) {
        Err(format!("The API key for {} was not saved by the previous app version. Edit this source and save its key once.", source.title))
    } else {
        Ok(None)
    }
}

fn retained_key_origin(
    previous: &SavedConnection,
    provider: &str,
    base: Option<&str>,
    supplied: bool,
) -> Result<(), String> {
    if previous.provider != provider {
        return Err("Create a new source to use a different provider.".into());
    }
    if !supplied
        && previous.has_credential
        && providers::api_endpoint(provider, base)?
            != providers::api_endpoint(&previous.provider, previous.base_url.as_deref())?
    {
        return Err("The API URL changed. Enter the API key again before connecting to a different endpoint.".into());
    }
    Ok(())
}

pub(super) fn save(
    root: &Path,
    credentials: &impl Credentials,
    mut source: SavedConnection,
    api_key: Option<&str>,
) -> Result<SavedConnection, String> {
    let mut saved = load(root)?;
    let old = saved
        .connections
        .iter()
        .find(|item| item.id == source.id)
        .cloned();
    if old.as_ref().map(|source| source.revision).unwrap_or(0) != source.revision {
        return Err(
            "This model source changed while you were editing it. Reload it and try again.".into(),
        );
    }
    source.revision = source
        .revision
        .checked_add(1)
        .ok_or("The saved model source revision is invalid. Your data has not been changed.")?;
    let desired_revision = saved
        .desired_revision
        .checked_add(1)
        .ok_or("The saved model source revision is invalid. Your data has not been changed.")?;
    let previous_key = if old.as_ref().is_some_and(|old| old.has_credential) {
        retained_key_origin(
            old.as_ref().unwrap(),
            &source.provider,
            source.base_url.as_deref(),
            api_key.is_some_and(|key| !key.is_empty()),
        )?;
        credentials.get(&source.id)?
    } else {
        None
    };
    let api_key = api_key.filter(|value| !value.is_empty());
    source.has_credential = api_key.is_some() || previous_key.is_some();
    reject_credential_echo(&source, api_key)?;
    reject_credential_echo(&source, previous_key.as_deref())?;
    if let Some(value) = api_key {
        credentials.set(&source.id, value)?;
    }
    if let Some(existing) = saved
        .connections
        .iter_mut()
        .find(|item| item.id == source.id)
    {
        *existing = source.clone();
    } else {
        if saved.connections.is_empty() && saved.legacy_source_id.is_none() {
            saved.legacy_source_id = Some(source.id.clone());
        }
        saved.connections.push(source.clone());
    }
    saved.desired_revision = desired_revision;
    if let Err(error) = store(root, &saved) {
        if api_key.is_some() {
            match previous_key {
                Some(value) => {
                    let _ = credentials.set(&source.id, &value);
                }
                None => {
                    let _ = credentials.remove(&source.id);
                }
            }
        }
        return Err(error);
    }
    Ok(source)
}

fn refresh(
    root: &Path,
    expected: &SavedConnection,
    models: Vec<providers::ProviderModel>,
) -> Result<SavedConnection, String> {
    let mut saved = load(root)?;
    let source = saved
        .connections
        .iter_mut()
        .find(|source| source.id == expected.id)
        .ok_or("This model source no longer exists.")?;
    if source.revision != expected.revision {
        return Err(
            "This model source changed while its catalog was loading. Reload it and try again."
                .into(),
        );
    }
    source.revision = source
        .revision
        .checked_add(1)
        .ok_or("The saved model source revision is invalid. Your data has not been changed.")?;
    source.models = models;
    let source = source.clone();
    store(root, &saved)?;
    Ok(source)
}

pub(super) fn remove(
    root: &Path,
    credentials: &impl Credentials,
    id: &str,
) -> Result<Vec<SavedConnection>, String> {
    let mut saved = load(root)?;
    let source = saved
        .connections
        .iter()
        .find(|source| source.id == id)
        .cloned()
        .ok_or("This model source no longer exists.")?;
    let desired_revision = saved
        .desired_revision
        .checked_add(1)
        .ok_or("The saved model source revision is invalid. Your data has not been changed.")?;
    let previous_key = if source.has_credential {
        credentials.get(id)?
    } else {
        None
    };
    if source.has_credential {
        credentials.remove(id)?;
    }
    saved.connections.retain(|source| source.id != id);
    saved.desired_revision = desired_revision;
    if let Err(error) = store(root, &saved) {
        if let Some(value) = previous_key {
            let _ = credentials.set(id, &value);
        }
        return Err(error);
    }
    Ok(saved.connections)
}

pub(super) fn stage_applied(
    saved: &SavedSetup,
    credentials: &impl Credentials,
) -> Result<(AppliedSetup, Vec<String>), String> {
    let mut applied = AppliedSetup {
        revision: saved.desired_revision,
        incomplete: false,
        connections: vec![],
        mcp_connections: vec![],
        mcp_ids: saved.mcp_ids.clone(),
        legacy_source_id: saved.legacy_source_id.clone(),
        credential_entries: Default::default(),
    };
    let mut errors = vec![];
    for source in &saved.connections {
        match key(source, credentials) {
            Ok(value) => {
                if let Some(value) = value {
                    let entry = format!("applied_{}_{}", source_id(), source.id);
                    if let Err(error) = credentials.set(&entry, &value) {
                        discard_applied(&applied, credentials);
                        return Err(error);
                    }
                    applied.credential_entries.insert(source.id.clone(), entry);
                }
                applied.connections.push(source.clone());
            }
            Err(error) => errors.push(error),
        }
    }
    for source in &saved.mcp_connections {
        match mcp::key(source, credentials) {
            Ok(value) => {
                if let Some(value) = value {
                    let entry = format!("applied_{}_{}", source_id(), source.id);
                    if let Err(error) = credentials.set(&entry, &value) {
                        discard_applied(&applied, credentials);
                        return Err(error);
                    }
                    applied.credential_entries.insert(source.id.clone(), entry);
                }
                applied.mcp_connections.push(source.clone());
            }
            Err(error) => errors.push(error),
        }
    }
    applied.incomplete = !errors.is_empty();
    Ok((applied, errors))
}

pub(super) fn discard_applied(applied: &AppliedSetup, credentials: &impl Credentials) {
    for entry in applied.credential_entries.values() {
        let _ = credentials.remove(entry);
    }
}

pub(super) fn commit_applied(
    root: &Path,
    saved: &mut SavedSetup,
    applied: AppliedSetup,
    credentials: &impl Credentials,
) -> Result<(), String> {
    let previous_staged = saved.staged.clone();
    let from_staged = previous_staged.as_ref().is_some_and(|staged| {
        staged.credential_entries == applied.credential_entries
            && staged.revision == applied.revision
    });
    if from_staged {
        saved.staged = None;
    }
    let previous = saved.applied.replace(applied);
    let old_retired = saved.retired_credentials.len();
    if let Some(previous) = &previous {
        saved
            .retired_credentials
            .extend(previous.credential_entries.values().cloned());
    }
    if let Err(error) = store(root, saved) {
        if let Some(staged) = &saved.applied {
            if !from_staged {
                discard_applied(staged, credentials);
            }
        }
        saved.applied = previous;
        saved.staged = previous_staged;
        saved.retired_credentials.truncate(old_retired);
        return Err(error);
    }
    Ok(())
}

pub(super) fn commit_staged(
    root: &Path,
    saved: &mut SavedSetup,
    started: AppliedSetup,
    credentials: &impl Credentials,
) -> Result<(), String> {
    let staged = saved
        .staged
        .as_ref()
        .ok_or("The pending connection snapshot is unavailable.")?;
    if staged.revision != started.revision
        || staged.credential_entries != started.credential_entries
    {
        return Err("The pending connection snapshot changed before startup finished.".into());
    }
    commit_applied(root, saved, started, credentials)
}

pub(super) fn boot_snapshot(
    saved: &SavedSetup,
    prepared: bool,
) -> Result<(AppliedSetup, bool), String> {
    if prepared {
        if let Some(staged) = &saved.staged {
            return Ok((staged.clone(), true));
        }
    }
    saved
        .applied
        .clone()
        .map(|applied| (applied, false))
        .ok_or_else(|| "The saved runtime configuration is unavailable.".into())
}

pub(super) fn stage_update(
    root: &Path,
    saved: &mut SavedSetup,
    credentials: &impl Credentials,
) -> Result<Vec<String>, String> {
    let (staged, errors) = stage_applied(saved, credentials)?;
    if !errors.is_empty() {
        discard_applied(&staged, credentials);
        return Err(errors.join(" "));
    }
    let previous = saved.staged.replace(staged);
    if let Err(error) = store(root, saved) {
        if let Some(staged) = &saved.staged {
            discard_applied(staged, credentials);
        }
        saved.staged = previous;
        return Err(error);
    }
    if let Some(previous) = previous {
        discard_applied(&previous, credentials);
    }
    Ok(errors)
}

pub(super) fn cleanup_retired(root: &Path, credentials: &impl Credentials) {
    if let Ok(mut saved) = load(root) {
        if saved.retired_credentials.is_empty() {
            return;
        }
        saved
            .retired_credentials
            .retain(|entry| credentials.remove(entry).is_err());
        let _ = store(root, &saved);
    }
}

pub(super) struct AppliedCredentials<'a, C: Credentials> {
    pub applied: &'a AppliedSetup,
    pub credentials: &'a C,
}
impl<C: Credentials> Credentials for AppliedCredentials<'_, C> {
    fn get(&self, id: &str) -> Result<Option<String>, String> {
        match self.applied.credential_entries.get(id) {
            Some(entry) => self.credentials.get(entry),
            None => Ok(None),
        }
    }
    fn set(&self, _: &str, _: &str) -> Result<(), String> {
        Err("Applied credentials are immutable.".into())
    }
    fn remove(&self, _: &str) -> Result<(), String> {
        Err("Applied credentials are immutable.".into())
    }
}

pub(super) fn source_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let hash = Sha256::digest(format!(
        "{:?}-{}-{}",
        std::time::SystemTime::now(),
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    format!("source_{}", &format!("{hash:x}")[..16])
}

pub(super) fn manifest(
    sources: &[SavedConnection],
    legacy_source_id: Option<&str>,
) -> serde_json::Value {
    let mut models = serde_json::Map::new();
    let mut secrets = serde_json::Map::new();
    for source in sources {
        let mut model = serde_json::json!({
            "provider": source.provider.replace('-', "_"),
            "model": source.default_model.as_deref().unwrap_or("default")
        });
        if let Some(base) = &source.base_url {
            model["baseUrl"] = base.clone().into();
        }
        if source.has_credential {
            model["auth"] = serde_json::json!({"key": {"secretRef": source.id}});
            secrets.insert(
                source.id.clone(),
                serde_json::json!({"env": env_name(&source.id)}),
            );
        }
        models.insert(source.id.clone(), model.clone());
        // Preserve the original connection ID used by existing authored pipelines.
        if legacy_source_id == Some(source.id.as_str()) {
            models.insert("model_main".into(), model);
        }
    }
    let remove: Vec<&str> =
        if legacy_source_id.is_some_and(|id| !sources.iter().any(|source| source.id == id)) {
            vec!["model_main"]
        } else {
            vec![]
        };
    serde_json::json!({"models": models, "secrets": secrets, "remove": remove})
}

pub(super) fn env_name(id: &str) -> String {
    format!("KNOTRA_MODEL_KEY_{}", id.to_ascii_uppercase())
}

#[tauri::command]
pub async fn desktop_connections_list(
    setup: State<'_, DesktopSetup>,
) -> Result<Vec<SavedConnection>, String> {
    let setup = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = setup.sources.lock().unwrap();
        Ok(load(&setup.data)?.connections)
    })
    .await
    .map_err(|_| "Cannot read your model sources.")?
}

#[tauri::command]
pub async fn desktop_connection_save(
    setup: State<'_, DesktopSetup>,
    id: Option<String>,
    title: Option<String>,
    provider: String,
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    expected_revision: Option<u64>,
) -> Result<SavedConnection, String> {
    let setup = setup.inner().clone();
    let supplied = api_key.filter(|value| !value.is_empty());
    let (existing, retained_key) = {
        let _lock = setup.sources.lock().unwrap();
        let saved = load(&setup.data)?;
        let existing = match id.as_deref() {
            Some(id) => Some(
                saved
                    .connections
                    .into_iter()
                    .find(|source| source.id == id)
                    .ok_or("This model source no longer exists.")?,
            ),
            None => None,
        };
        if expected_revision.is_some_and(|revision| {
            existing.as_ref().map(|source| source.revision) != Some(revision)
        }) {
            return Err(
                "This model source changed since it was loaded. Reload it and retry.".into(),
            );
        }
        if let Some(previous) = &existing {
            retained_key_origin(
                previous,
                &provider,
                base_url.as_deref().or(previous.base_url.as_deref()),
                supplied.is_some(),
            )?;
        }
        let retained_key = if supplied.is_none() {
            existing
                .as_ref()
                .map(|source| key(source, &Keychain))
                .transpose()?
                .flatten()
        } else {
            None
        };
        (existing, retained_key)
    };
    if existing
        .as_ref()
        .is_some_and(|source| source.provider != provider)
    {
        return Err("Create a new source to use a different provider.".into());
    }
    let key = supplied.clone().or(retained_key);
    let base_url =
        base_url.or_else(|| existing.as_ref().and_then(|source| source.base_url.clone()));
    let base = providers::validate(
        &provider,
        model.as_deref().unwrap_or("default"),
        key.as_deref(),
        base_url.as_deref(),
    )?;
    let mut models = match providers::models(&provider, key.as_deref(), base.as_deref()).await {
        Ok(models) => models,
        Err(error) => match &existing {
            Some(source) => source.models.clone(),
            None if model.is_some() => Vec::new(),
            None => return Err(error),
        },
    };
    let default_model = model
        .or_else(|| {
            existing
                .as_ref()
                .and_then(|source| source.default_model.clone())
        })
        .or_else(|| models.first().map(|model| model.id.clone()));
    if let Some(model) = &default_model {
        providers::validate(&provider, model, key.as_deref(), base.as_deref())?;
        if !models.iter().any(|item| item.id == *model) {
            models.push(providers::ProviderModel {
                id: model.clone(),
                name: model.clone(),
            });
        }
    }
    let title = title
        .filter(|value| !value.trim().is_empty())
        .or_else(|| existing.as_ref().map(|source| source.title.clone()))
        .unwrap_or_else(|| provider.clone());
    if title.len() > 200 || title.chars().any(char::is_control) {
        return Err("Use a source name of up to 200 characters.".into());
    }
    let revision = existing.as_ref().map(|source| source.revision).unwrap_or(0);
    let source = SavedConnection {
        id: existing.map(|source| source.id).unwrap_or_else(source_id),
        title: title.trim().into(),
        provider,
        base_url: base,
        models,
        default_model,
        has_credential: false,
        revision,
    };
    let editing = id.is_some();
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = setup.sources.lock().unwrap();
        if editing
            && !load(&setup.data)?
                .connections
                .iter()
                .any(|item| item.id == source.id)
        {
            return Err("This model source was removed while you were editing it.".into());
        }
        let source = save(&setup.data, &Keychain, source, supplied.as_deref())?;
        setup.sources_changed();
        Ok(source)
    })
    .await
    .map_err(|_| "Cannot save this model source.")?
}

#[tauri::command]
pub async fn desktop_connection_refresh(
    setup: State<'_, DesktopSetup>,
    id: String,
    expected_revision: Option<u64>,
) -> Result<SavedConnection, String> {
    let (source, key) = {
        let _lock = setup.sources.lock().unwrap();
        let source = load(&setup.data)?
            .connections
            .into_iter()
            .find(|source| source.id == id)
            .ok_or("This model source no longer exists.")?;
        if expected_revision.is_some_and(|revision| source.revision != revision) {
            return Err(
                "This model source changed since it was loaded. Reload it and retry.".into(),
            );
        }
        let key = key(&source, &Keychain)?;
        (source, key)
    };
    let models =
        providers::models(&source.provider, key.as_deref(), source.base_url.as_deref()).await?;
    let mut checked = source.clone();
    checked.models = models.clone();
    reject_credential_echo(&checked, key.as_deref())?;
    let setup = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = setup.sources.lock().unwrap();
        refresh(&setup.data, &source, models)
    })
    .await
    .map_err(|_| "Cannot save the refreshed model catalog.")?
}

#[tauri::command]
pub async fn desktop_connection_remove(
    setup: State<'_, DesktopSetup>,
    id: String,
    expected_revision: Option<u64>,
) -> Result<Vec<SavedConnection>, String> {
    let setup = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = setup.sources.lock().unwrap();
        if let Some(revision) = expected_revision {
            if load(&setup.data)?
                .connections
                .iter()
                .find(|source| source.id == id)
                .map(|source| source.revision)
                != Some(revision)
            {
                return Err(
                    "This model source changed since it was loaded. Reload it and retry.".into(),
                );
            }
        }
        let sources = remove(&setup.data, &Keychain, &id)?;
        setup.sources_changed();
        Ok(sources)
    })
    .await
    .map_err(|_| "Cannot remove this model source.")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::setup::tests::TempDir;
    use std::collections::HashMap;

    #[derive(Default)]
    pub(super) struct MemoryCredentials(Mutex<HashMap<String, String>>);
    impl Credentials for MemoryCredentials {
        fn get(&self, id: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(id).cloned())
        }
        fn set(&self, id: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(id.into(), value.into());
            Ok(())
        }
        fn remove(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    pub(super) fn source(id: &str, provider: &str) -> SavedConnection {
        SavedConnection {
            id: id.into(),
            title: provider.into(),
            provider: provider.into(),
            base_url: None,
            models: vec![providers::ProviderModel {
                id: "default".into(),
                name: "Default model".into(),
            }],
            default_model: Some("default".into()),
            has_credential: false,
            revision: 0,
        }
    }

    #[test]
    fn multiple_sources_and_catalogs_survive_restart_without_starting_engine_or_serializing_keys() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        save(
            &root.0,
            &credentials,
            source("source_api", "openai"),
            Some("secret-only-in-keychain"),
        )
        .unwrap();
        save(&root.0, &credentials, source("source_codex", "codex"), None).unwrap();
        save(
            &root.0,
            &credentials,
            source("source_claude", "claude"),
            None,
        )
        .unwrap();
        let restored = load(&root.0).unwrap();
        assert_eq!(restored.connections.len(), 3);
        assert!(!restored.engine_enabled);
        assert_eq!(restored.connections[0].models[0].name, "Default model");
        assert_eq!(
            key(&restored.connections[0], &credentials)
                .unwrap()
                .as_deref(),
            Some("secret-only-in-keychain")
        );
        let serialized = fs::read_to_string(root.0.join("desktop-connections.json")).unwrap();
        assert!(!serialized.contains("secret-only-in-keychain"));
        assert!(restored.engine_directory.is_none());
    }

    #[test]
    fn editing_retains_credentials_and_rotation_does_not_change_source_id() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        let first = save(
            &root.0,
            &credentials,
            source("source_api", "openai"),
            Some("original"),
        )
        .unwrap();
        let mut changed = first.clone();
        changed.title = "Renamed source".into();
        let edited = save(&root.0, &credentials, changed, None).unwrap();
        assert_eq!(
            key(&edited, &credentials).unwrap().as_deref(),
            Some("original")
        );
        let rotated = save(&root.0, &credentials, edited, Some("replacement")).unwrap();
        assert_eq!(rotated.id, first.id);
        assert_eq!(
            key(&rotated, &credentials).unwrap().as_deref(),
            Some("replacement")
        );
        assert_eq!(load(&root.0).unwrap().connections.len(), 1);
    }

    #[test]
    fn removing_one_source_keeps_other_sources_and_saved_engine_data() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        save(
            &root.0,
            &credentials,
            source("source_api", "openai"),
            Some("private-key"),
        )
        .unwrap();
        save(
            &root.0,
            &credentials,
            source("source_claude", "claude"),
            None,
        )
        .unwrap();
        let mut state = load(&root.0).unwrap();
        state.engine_enabled = true;
        state.engine_directory = Some(root.0.join("managed"));
        fs::create_dir(root.0.join("managed")).unwrap();
        fs::write(root.0.join("managed/kept-artifact"), "saved").unwrap();
        store(&root.0, &state).unwrap();
        let remaining = remove(&root.0, &credentials, "source_api").unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "source_claude");
        assert!(credentials.get("source_api").unwrap().is_none());
        let restored = load(&root.0).unwrap();
        assert!(restored.engine_enabled);
        assert_eq!(restored.legacy_source_id.as_deref(), Some("source_api"));
        assert!(
            manifest(&restored.connections, restored.legacy_source_id.as_deref())["models"]
                ["model_main"]
                .is_null()
        );
        assert_eq!(
            fs::read_to_string(root.0.join("managed/kept-artifact")).unwrap(),
            "saved"
        );
    }

    #[test]
    fn manifest_keeps_distinct_credentials_and_legacy_id_without_secret_values() {
        let mut first = source("source_api", "openai");
        first.has_credential = true;
        let mut second = source("source_gateway", "openai-compatible");
        second.has_credential = true;
        second.base_url = Some("https://gateway.example/v1".into());
        let manifest = manifest(
            &[
                first,
                second,
                source("source_codex", "codex"),
                source("source_claude", "claude"),
            ],
            Some("source_api"),
        );
        assert_eq!(manifest["models"].as_object().unwrap().len(), 5);
        assert_eq!(
            manifest["models"]["model_main"],
            manifest["models"]["source_api"]
        );
        assert_eq!(
            manifest["models"]["source_gateway"]["provider"],
            "openai_compatible"
        );
        assert_eq!(
            manifest["models"]["source_gateway"]["auth"]["key"]["secretRef"],
            "source_gateway"
        );
        assert_ne!(
            manifest["secrets"]["source_gateway"]["env"],
            manifest["secrets"]["source_api"]["env"]
        );
        assert!(manifest["models"]["source_codex"]["auth"].is_null());
    }

    #[test]
    fn malformed_metadata_is_not_replaced_on_save() {
        let root = TempDir::new();
        fs::write(root.0.join("desktop-connections.json"), "{broken").unwrap();
        let credentials = MemoryCredentials::default();
        assert!(save(&root.0, &credentials, source("source_codex", "codex"), None).is_err());
        assert_eq!(
            fs::read_to_string(root.0.join("desktop-connections.json")).unwrap(),
            "{broken"
        );
    }

    #[test]
    fn same_provider_sources_keep_independent_keys_models_and_urls() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        let first_id = source_id();
        let second_id = source_id();
        assert_ne!(first_id, second_id);
        let mut first = source(&first_id, "openai-compatible");
        first.base_url = Some("https://first.example/v1".into());
        first.default_model = Some("first-model".into());
        let mut second = source(&second_id, "openai-compatible");
        second.base_url = Some("https://second.example/v1".into());
        second.default_model = Some("second-model".into());
        save(&root.0, &credentials, first, Some("first-key")).unwrap();
        save(&root.0, &credentials, second, Some("second-key")).unwrap();
        let saved = load(&root.0).unwrap();
        assert_eq!(
            key(&saved.connections[0], &credentials).unwrap().as_deref(),
            Some("first-key")
        );
        assert_eq!(
            key(&saved.connections[1], &credentials).unwrap().as_deref(),
            Some("second-key")
        );
        let payload = manifest(&saved.connections, saved.legacy_source_id.as_deref());
        assert_eq!(payload["models"][&first_id]["model"], "first-model");
        assert_eq!(
            payload["models"][&second_id]["baseUrl"],
            "https://second.example/v1"
        );
        remove(&root.0, &credentials, &first_id).unwrap();
        let restored = load(&root.0).unwrap();
        assert_eq!(restored.connections[0].id, second_id);
        assert_eq!(
            key(&restored.connections[0], &credentials)
                .unwrap()
                .as_deref(),
            Some("second-key")
        );
    }

    #[test]
    fn engine_receives_distinct_key_environments_and_missing_key_only_disables_its_source() {
        let root = TempDir::new();
        let setup = crate::setup::tests::manager(&root.0);
        fs::write(
            root.0.join(if cfg!(windows) {
                "knotra.exe"
            } else {
                "knotra"
            }),
            [],
        )
        .unwrap();
        let credentials = MemoryCredentials::default();
        let mut first = source("source_first", "openai");
        first.has_credential = true;
        credentials.set(&first.id, "first-private-key").unwrap();
        let mut second = source("source_second", "openai");
        second.has_credential = true;
        credentials.set(&second.id, "second-private-key").unwrap();
        let mut missing = source("source_missing", "openai");
        missing.has_credential = true;
        let (command, available, errors) = crate::setup::managed_command(
            &setup,
            &[first, second, missing, source("source_codex", "codex")],
            &root.0,
            &Ports {
                postgres: 12345,
                engine: 12346,
            },
            &credentials,
            &root.0.join("launch-models.json"),
        )
        .unwrap();
        assert_eq!(available.len(), 3);
        assert_eq!(errors.len(), 1);
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args.iter().any(|arg| arg == "--connections-file"));
        assert!(!args.iter().any(|arg| arg.contains("private-key")));
        assert!(command
            .get_envs()
            .any(|(name, value)| name == "KNOTRA_MODEL_KEY_SOURCE_FIRST"
                && value == Some(std::ffi::OsStr::new("first-private-key"))));
        assert!(command
            .get_envs()
            .any(|(name, value)| name == "KNOTRA_MODEL_KEY_SOURCE_SECOND"
                && value == Some(std::ffi::OsStr::new("second-private-key"))));
        assert!(!command.get_envs().any(|(name, _)| name == "OPENAI_API_KEY"));
        let payload = manifest(&available, Some("source_missing"));
        assert!(payload["models"]["source_missing"].is_null());
        assert!(payload["models"]["model_main"].is_null());
    }

    #[test]
    fn failed_metadata_write_restores_previous_credential() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        let source = save(
            &root.0,
            &credentials,
            source("source_api", "openai"),
            Some("original-key"),
        )
        .unwrap();
        fs::create_dir(root.0.join(".desktop-connections.tmp")).unwrap();
        assert!(save(
            &root.0,
            &credentials,
            source.clone(),
            Some("replacement-key")
        )
        .is_err());
        assert_eq!(
            key(&source, &credentials).unwrap().as_deref(),
            Some("original-key")
        );
        assert_eq!(load(&root.0).unwrap().connections.len(), 1);
    }

    fn legacy(root: &Path, name: &str, provider: &str, model: &str) -> PathBuf {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("desktop-ports.json"),
            r#"{"postgres":12345,"engine":12346}"#,
        )
        .unwrap();
        fs::write(dir.join("settings.json"), "keep-settings").unwrap();
        fs::write(dir.join("saved-artifact"), "keep-artifact").unwrap();
        fs::write(dir.join("profile.json"), serde_json::to_vec(&serde_json::json!({"spec": {"models": {"model_main": {"provider": provider, "model": model}}}})).unwrap()).unwrap();
        dir
    }

    #[test]
    fn migration_imports_only_latest_explicit_provider_without_network_or_other_account_discovery()
    {
        let root = TempDir::new();
        let older = legacy(&root.0, "older", "codex", "default");
        fs::File::open(older.join("desktop-ports.json"))
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH)
            .unwrap();
        let latest = legacy(&root.0, "latest", "ollama", "existing-model");
        migrate(&root.0).unwrap();
        let saved = load(&root.0).unwrap();
        assert!(saved.engine_enabled);
        assert_eq!(saved.engine_directory, Some(latest.clone()));
        assert_eq!(saved.connections.len(), 1);
        assert_eq!(saved.connections[0].provider, "ollama");
        assert_eq!(saved.connections[0].models[0].id, "existing-model");
        assert!(!saved.connections[0].has_credential);
        assert_eq!(
            saved.legacy_source_id.as_deref(),
            Some(saved.connections[0].id.as_str())
        );
        let first_id = saved.connections[0].id.clone();
        migrate(&root.0).unwrap();
        assert_eq!(load(&root.0).unwrap().connections[0].id, first_id);
        assert_eq!(
            fs::read_to_string(latest.join("settings.json")).unwrap(),
            "keep-settings"
        );
        assert_eq!(
            fs::read_to_string(latest.join("saved-artifact")).unwrap(),
            "keep-artifact"
        );
    }

    #[test]
    fn migrated_session_only_api_key_is_requested_again_without_blocking_other_sources() {
        let root = TempDir::new();
        legacy(&root.0, "api", "openai", "existing-model");
        migrate(&root.0).unwrap();
        let saved = load(&root.0).unwrap();
        assert!(!saved.connections[0].has_credential);
        assert!(key(&saved.connections[0], &MemoryCredentials::default())
            .unwrap_err()
            .contains("previous app version"));
        let payload = manifest(&[], saved.legacy_source_id.as_deref());
        assert_eq!(payload["remove"], serde_json::json!(["model_main"]));
        let credentials = MemoryCredentials::default();
        save(
            &root.0,
            &credentials,
            saved.connections[0].clone(),
            Some("newly-saved-key"),
        )
        .unwrap();
        assert!(load(&root.0).unwrap().connections[0].has_credential);
    }

    #[test]
    fn fresh_install_migration_creates_no_sources_or_engine_configuration() {
        let root = TempDir::new();
        migrate(&root.0).unwrap();
        assert!(!root.0.join("desktop-connections.json").exists());
        assert!(!load(&root.0).unwrap().engine_enabled);
    }

    #[test]
    fn late_save_and_catalog_results_do_not_overwrite_a_newer_edit_or_credential() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        let mut initial = source("source_api", "openai-compatible");
        initial.base_url = Some("https://original.example/v1".into());
        let original = save(&root.0, &credentials, initial, Some("original-key")).unwrap();
        let mut slow_edit = original.clone();
        slow_edit.title = "Late edit".into();
        let mut newer_edit = original.clone();
        newer_edit.title = "Newer edit".into();
        newer_edit.base_url = Some("https://newer.example/v1".into());
        newer_edit.models = vec![providers::ProviderModel {
            id: "newer-model".into(),
            name: "Newer model".into(),
        }];
        let newer = save(&root.0, &credentials, newer_edit, Some("newer-key")).unwrap();
        assert!(save(&root.0, &credentials, slow_edit, Some("late-key"))
            .err()
            .unwrap()
            .contains("changed while"));
        assert!(refresh(
            &root.0,
            &original,
            vec![providers::ProviderModel {
                id: "late-model".into(),
                name: "Late model".into()
            }]
        )
        .err()
        .unwrap()
        .contains("changed while"));
        let restored = load(&root.0).unwrap().connections.remove(0);
        assert_eq!(restored.title, "Newer edit");
        assert_eq!(
            restored.base_url.as_deref(),
            Some("https://newer.example/v1")
        );
        assert_eq!(restored.models[0].id, "newer-model");
        assert_eq!(restored.revision, newer.revision);
        assert_eq!(
            key(&restored, &credentials).unwrap().as_deref(),
            Some("newer-key")
        );
    }

    #[test]
    fn key_only_rotation_and_catalog_refresh_invalidate_older_edits() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        let original = save(
            &root.0,
            &credentials,
            source("source_api", "openai"),
            Some("original-key"),
        )
        .unwrap();
        let rotated = save(&root.0, &credentials, original.clone(), Some("rotated-key")).unwrap();
        assert!(save(&root.0, &credentials, original, Some("late-key")).is_err());
        let refreshed = refresh(&root.0, &rotated, vec![]).unwrap();
        assert!(save(&root.0, &credentials, rotated, None).is_err());
        assert_eq!(
            load(&root.0).unwrap().connections[0].revision,
            refreshed.revision
        );
        assert_eq!(
            key(&refreshed, &credentials).unwrap().as_deref(),
            Some("rotated-key")
        );
    }

    #[test]
    fn engine_can_start_with_no_available_keys_while_saved_metadata_stays_intact() {
        let root = TempDir::new();
        let setup = crate::setup::tests::manager(&root.0);
        fs::write(
            root.0.join(if cfg!(windows) {
                "knotra.exe"
            } else {
                "knotra"
            }),
            [],
        )
        .unwrap();
        let mut unavailable = source("source_missing", "openai");
        unavailable.has_credential = true;
        let (_, available, errors) = crate::setup::managed_command(
            &setup,
            &[unavailable],
            &root.0,
            &Ports {
                postgres: 12345,
                engine: 12346,
            },
            &MemoryCredentials::default(),
            &root.0.join("launch-models.json"),
        )
        .unwrap();
        assert!(available.is_empty());
        assert_eq!(errors.len(), 1);
        assert!(manifest(&available, Some("source_missing"))["models"]
            .as_object()
            .unwrap()
            .is_empty());
    }

    fn apply_initial(root: &Path, credentials: &MemoryCredentials) -> AppliedSetup {
        let mut saved = load(root).unwrap();
        let (applied, errors) = stage_applied(&saved, credentials).unwrap();
        assert!(errors.is_empty());
        commit_applied(root, &mut saved, applied.clone(), credentials).unwrap();
        applied
    }

    #[test]
    fn pending_rotation_and_reopen_keep_the_credential_used_by_existing_runs() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        let source = save(
            &root.0,
            &credentials,
            source("source_api", "openai"),
            Some("original-key"),
        )
        .unwrap();
        let applied = apply_initial(&root.0, &credentials);
        save(&root.0, &credentials, source, Some("replacement-key")).unwrap();
        let restored = load(&root.0).unwrap();
        let (boot, held) = boot_snapshot(&restored, false).unwrap();
        assert!(!held);
        assert_eq!(boot.revision, applied.revision);
        assert_ne!(boot.revision, restored.desired_revision);
        assert_eq!(
            key(
                &boot.connections[0],
                &AppliedCredentials {
                    applied: &boot,
                    credentials: &credentials
                }
            )
            .unwrap()
            .as_deref(),
            Some("original-key")
        );
        assert_eq!(
            key(&restored.connections[0], &credentials)
                .unwrap()
                .as_deref(),
            Some("replacement-key")
        );
        let metadata = fs::read_to_string(root.0.join("desktop-connections.json")).unwrap();
        assert!(!metadata.contains("original-key"));
        assert!(!metadata.contains("replacement-key"));
    }

    #[test]
    fn removing_a_source_retains_applied_key_until_replacement_is_committed() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        save(
            &root.0,
            &credentials,
            source("source_api", "openai"),
            Some("original-key"),
        )
        .unwrap();
        let applied = apply_initial(&root.0, &credentials);
        let old_entry = applied.credential_entries["source_api"].clone();
        remove(&root.0, &credentials, "source_api").unwrap();
        assert!(credentials.get("source_api").unwrap().is_none());
        let mut saved = load(&root.0).unwrap();
        assert_eq!(
            credentials.get(&old_entry).unwrap().as_deref(),
            Some("original-key")
        );
        stage_update(&root.0, &mut saved, &credentials).unwrap();
        assert!(credentials.get(&old_entry).unwrap().is_some());
        let staged = saved.staged.clone().unwrap();
        assert!(staged.connections.is_empty());
        commit_staged(&root.0, &mut saved, staged, &credentials).unwrap();
        assert!(credentials.get(&old_entry).unwrap().is_some());
        cleanup_retired(&root.0, &credentials);
        assert!(credentials.get(&old_entry).unwrap().is_none());
        assert!(load(&root.0).unwrap().retired_credentials.is_empty());
    }

    #[test]
    fn failed_staging_or_commit_preserves_previous_snapshot_and_retry_credentials() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        let source = save(
            &root.0,
            &credentials,
            source("source_api", "openai"),
            Some("original-key"),
        )
        .unwrap();
        let previous = apply_initial(&root.0, &credentials);
        save(&root.0, &credentials, source, Some("replacement-key")).unwrap();
        let mut saved = load(&root.0).unwrap();
        let entries = credentials.0.lock().unwrap().len();
        let obstacle = root.0.join(".desktop-connections.tmp");
        fs::create_dir(&obstacle).unwrap();
        assert!(stage_update(&root.0, &mut saved, &credentials).is_err());
        assert_eq!(credentials.0.lock().unwrap().len(), entries);
        assert!(load(&root.0).unwrap().staged.is_none());
        assert_eq!(saved.applied.as_ref().unwrap().revision, previous.revision);
        fs::remove_dir(&obstacle).unwrap();
        stage_update(&root.0, &mut saved, &credentials).unwrap();
        let staged = saved.staged.clone().unwrap();
        let entry = staged.credential_entries["source_api"].clone();
        fs::create_dir(&obstacle).unwrap();
        assert!(commit_staged(&root.0, &mut saved, staged.clone(), &credentials).is_err());
        let reopened = load(&root.0).unwrap();
        assert_eq!(reopened.applied.unwrap().revision, previous.revision);
        assert_eq!(reopened.staged.unwrap().revision, staged.revision);
        assert_eq!(
            credentials.get(&entry).unwrap().as_deref(),
            Some("replacement-key")
        );
        assert_eq!(
            credentials
                .get(&previous.credential_entries["source_api"])
                .unwrap()
                .as_deref(),
            Some("original-key")
        );
        fs::remove_dir(&obstacle).unwrap();
        commit_staged(&root.0, &mut saved, staged, &credentials).unwrap();
        cleanup_retired(&root.0, &credentials);
        assert!(credentials
            .get(&previous.credential_entries["source_api"])
            .unwrap()
            .is_none());
        assert_eq!(
            credentials.get(&entry).unwrap().as_deref(),
            Some("replacement-key")
        );
    }

    #[test]
    fn missing_target_credential_never_commits_a_partial_update_and_can_retry() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        save(
            &root.0,
            &credentials,
            source("source_original", "codex"),
            None,
        )
        .unwrap();
        let applied = apply_initial(&root.0, &credentials);
        save(
            &root.0,
            &credentials,
            source("source_missing", "openai"),
            Some("saved-key"),
        )
        .unwrap();
        credentials.remove("source_missing").unwrap();
        let mut saved = load(&root.0).unwrap();
        assert!(stage_update(&root.0, &mut saved, &credentials)
            .unwrap_err()
            .contains("unavailable"));
        let restored = load(&root.0).unwrap();
        assert!(restored.staged.is_none());
        assert_eq!(restored.applied.unwrap().revision, applied.revision);
        assert_eq!(restored.connections.len(), 2);
        credentials.set("source_missing", "saved-key").unwrap();
        stage_update(&root.0, &mut saved, &credentials).unwrap();
        assert_eq!(saved.staged.unwrap().connections.len(), 2);
    }

    #[test]
    fn initial_partial_snapshot_preserves_history_access_and_remains_pending_for_unlock() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        save(
            &root.0,
            &credentials,
            source("source_api", "openai"),
            Some("saved-key"),
        )
        .unwrap();
        credentials.remove("source_api").unwrap();
        let mut saved = load(&root.0).unwrap();
        let (partial, errors) = stage_applied(&saved, &credentials).unwrap();
        assert_eq!(errors.len(), 1);
        assert!(partial.incomplete);
        assert!(partial.connections.is_empty());
        commit_applied(&root.0, &mut saved, partial, &credentials).unwrap();
        assert!(pending(&load(&root.0).unwrap()));
        assert!(boot_snapshot(&saved, false)
            .unwrap()
            .0
            .connections
            .is_empty());
        credentials.set("source_api", "saved-key").unwrap();
        stage_update(&root.0, &mut saved, &credentials).unwrap();
        let restored = saved.staged.clone().unwrap();
        assert!(!restored.incomplete);
        assert_eq!(restored.connections.len(), 1);
        commit_staged(&root.0, &mut saved, restored, &credentials).unwrap();
        assert!(!pending(&load(&root.0).unwrap()));
    }

    #[test]
    fn recovery_ignores_failed_staged_update_and_commit_uses_exact_started_snapshot() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        let source = save(
            &root.0,
            &credentials,
            source("source_api", "openai"),
            Some("key-a"),
        )
        .unwrap();
        let previous = apply_initial(&root.0, &credentials);
        let source = save(&root.0, &credentials, source, Some("key-b")).unwrap();
        let mut saved = load(&root.0).unwrap();
        stage_update(&root.0, &mut saved, &credentials).unwrap();
        let staged = saved.staged.clone().unwrap();
        let (recovery, held) = boot_snapshot(&load(&root.0).unwrap(), false).unwrap();
        assert!(!held);
        assert_eq!(recovery.revision, previous.revision);
        let (prepared, held) = boot_snapshot(&saved, true).unwrap();
        assert!(held);
        assert_eq!(prepared.revision, staged.revision);
        // Saving C while B is starting cannot make B publish C or lose C's pending state.
        save(&root.0, &credentials, source, Some("key-c")).unwrap();
        let mut latest = load(&root.0).unwrap();
        commit_staged(&root.0, &mut latest, staged.clone(), &credentials).unwrap();
        assert_eq!(latest.applied.as_ref().unwrap().revision, staged.revision);
        assert_ne!(latest.desired_revision, staged.revision);
        assert_eq!(
            key(
                &staged.connections[0],
                &AppliedCredentials {
                    applied: &staged,
                    credentials: &credentials
                }
            )
            .unwrap()
            .as_deref(),
            Some("key-b")
        );
        stage_update(&root.0, &mut latest, &credentials).unwrap();
        assert!(commit_staged(&root.0, &mut latest, staged, &credentials)
            .unwrap_err()
            .contains("changed"));
    }

    #[test]
    fn invalid_revision_cannot_change_credentials_before_save_or_remove_fails() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        let source = save(
            &root.0,
            &credentials,
            source("source_api", "openai"),
            Some("original-key"),
        )
        .unwrap();
        let mut saved = load(&root.0).unwrap();
        saved.desired_revision = u64::MAX;
        store(&root.0, &saved).unwrap();
        assert!(save(&root.0, &credentials, source, Some("replacement-key")).is_err());
        assert!(remove(&root.0, &credentials, "source_api").is_err());
        assert_eq!(
            credentials.get("source_api").unwrap().as_deref(),
            Some("original-key")
        );
    }

    #[test]
    fn model_metadata_cannot_persist_provided_or_retained_credentials() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        let mut invalid = source("source_first", "openai");
        invalid.title = "fixture-private-key".into();
        assert!(save(&root.0, &credentials, invalid, Some("fixture-private-key")).is_err());
        assert!(!root.0.join("desktop-connections.json").exists());
        assert!(credentials.get("source_first").unwrap().is_none());
        let original = save(
            &root.0,
            &credentials,
            source("source_first", "openai"),
            Some("fixture-private-key"),
        )
        .unwrap();
        let mut invalid = original.clone();
        invalid.default_model = Some("fixture-private-key".into());
        assert!(save(&root.0, &credentials, invalid, None).is_err());
        assert_eq!(
            load(&root.0).unwrap().connections[0].default_model,
            original.default_model
        );
        assert_eq!(
            credentials.get("source_first").unwrap().as_deref(),
            Some("fixture-private-key")
        );
        assert!(!fs::read_to_string(root.0.join("desktop-connections.json"))
            .unwrap()
            .contains("fixture-private-key"));
    }

    #[test]
    fn retained_model_key_never_moves_to_another_normalized_endpoint() {
        let mut previous = source("source_api", "openai");
        previous.has_credential = true;
        assert!(retained_key_origin(
            &previous,
            "openai",
            Some("https://API.OPENAI.COM:443/v1/"),
            false
        )
        .is_ok());
        for base in [
            "https://other.example/v1",
            "https://api.openai.com/different",
        ] {
            assert!(retained_key_origin(&previous, "openai", Some(base), false)
                .unwrap_err()
                .contains("URL changed"));
            assert!(retained_key_origin(&previous, "openai", Some(base), true).is_ok());
        }
        struct NoLookup;
        impl Credentials for NoLookup {
            fn get(&self, _: &str) -> Result<Option<String>, String> {
                panic!("Endpoint change must reject before key lookup")
            }
            fn set(&self, _: &str, _: &str) -> Result<(), String> {
                unreachable!()
            }
            fn remove(&self, _: &str) -> Result<(), String> {
                unreachable!()
            }
        }
        let root = TempDir::new();
        let mut state = SavedSetup::default();
        state.connections.push(previous.clone());
        store(&root.0, &state).unwrap();
        let mut changed = previous;
        changed.base_url = Some("https://other.example/v1".into());
        assert!(save(&root.0, &NoLookup, changed, None).is_err());
    }
}
