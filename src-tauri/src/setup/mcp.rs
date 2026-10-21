use super::*;
use connections::{Credentials, Keychain};
use serde_json::Value;
use std::io::{Read, Write};

const MAX_CATALOG_BYTES: u64 = 8 * 1024 * 1024;
const DISCOVERY_ERROR: &str =
    "Cannot connect to the MCP server. Check its URL, access token, and server availability.";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub input_schema: Value,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedMcpConnection {
    pub id: String,
    pub title: String,
    pub transport: String,
    pub url: String,
    pub tools: Vec<McpTool>,
    pub allowed_tools: Vec<String>,
    pub has_credential: bool,

    #[serde(default)]
    pub revision: u64,
}

pub(super) fn validate_url(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value.trim()).map_err(|_| "Enter a valid MCP server URL.")?;
    let local = url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if value.len() > 4096
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
        || !(url.scheme() == "https" || (url.scheme() == "http" && local))
    {
        return Err("Use an HTTPS MCP URL, or HTTP on localhost. Put access tokens in the token field, without URL credentials, queries, or fragments.".into());
    }
    Ok(url.to_string())
}

fn validate_token(token: &str) -> Result<(), String> {
    if token.is_empty()
        || token.len() > 65536
        || !token.is_ascii()
        || token.bytes().any(|c| c.is_ascii_control())
    {
        return Err("Enter a valid bearer token without line breaks or control characters.".into());
    }
    Ok(())
}

fn validate_tools(tools: &[McpTool]) -> Result<(), String> {
    let mut names = std::collections::HashSet::new();
    if tools.len() > 1024 {
        return Err("The MCP server returned too many tools.".into());
    }
    for tool in tools {
        if !valid_tool_name(&tool.name)
            || !names.insert(&tool.name)
            || !tool.input_schema.is_object()
            || tool
                .output_schema
                .as_ref()
                .is_some_and(|schema| !schema.is_object())
            || tool.title.as_ref().is_some_and(|title| title.len() > 1024)
            || tool
                .description
                .as_ref()
                .is_some_and(|description| description.len() > 65536)
        {
            return Err("The MCP server returned an invalid tool catalog.".into());
        }
    }
    Ok(())
}

fn valid_tool_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
}

fn validate_selection(
    tools: &[McpTool],
    allowed: &[String],
    previous: Option<&SavedMcpConnection>,
) -> Result<(), String> {
    if allowed.iter().any(|name| {
        !tools.iter().any(|tool| &tool.name == name)
            && !previous.is_some_and(|source| source.allowed_tools.contains(name))
    }) {
        return Err("Choose tools from the discovered MCP catalog.".into());
    }
    Ok(())
}

pub(super) fn validate_saved(source: &SavedMcpConnection) -> Result<(), String> {
    if source.transport != "streamable_http"
        || source.title.trim().is_empty()
        || source.title.len() > 200
        || source.title.chars().any(char::is_control)
    {
        return Err("The saved MCP connection is invalid.".into());
    }
    validate_url(&source.url)?;
    validate_tools(&source.tools)?;

    let mut allowed = std::collections::HashSet::new();
    if source.allowed_tools.len() > 1024
        || source
            .allowed_tools
            .iter()
            .any(|name| !valid_tool_name(name) || !allowed.insert(name))
    {
        return Err("The saved MCP tool selection is invalid.".into());
    }
    Ok(())
}

pub(super) fn key(
    source: &SavedMcpConnection,
    credentials: &impl Credentials,
) -> Result<Option<String>, String> {
    if source.has_credential {
        let token = credentials
            .get(&source.id)?
            .ok_or("The saved MCP token is unavailable. Unlock the system credential store, or save the token again.")?;
        validate_token(&token)?;
        Ok(Some(token))
    } else {
        Ok(None)
    }
}

fn selected_token(
    existing: Option<&SavedMcpConnection>,
    url: &str,
    token: Option<&str>,
    clear: bool,
    credentials: &impl Credentials,
) -> Result<Option<String>, String> {
    if clear && token.is_some() {
        return Err("Provide a new token or remove the existing token, not both.".into());
    }
    if let Some(token) = token {
        validate_token(token)?;
        return Ok(Some(token.into()));
    }
    if clear {
        return Ok(None);
    }
    if let Some(source) = existing {
        if source.has_credential && source.url != url {
            return Err("The MCP URL changed. Provide a new token or explicitly remove the saved token before connecting.".into());
        }
        return key(source, credentials);
    }
    Ok(None)
}

pub(super) fn env_name(id: &str) -> String {
    format!("KNOTRA_MCP_AUTH_{}", id.to_ascii_uppercase())
}

fn secret_ref(id: &str) -> String {
    format!("mcp_{id}_auth")
}

pub(super) fn configure_command(
    command: &mut Command,
    sources: &[SavedMcpConnection],
    credentials: &impl Credentials,
) -> Vec<String> {
    let mut errors = vec![];
    for source in sources {
        match key(source, credentials) {
            Ok(Some(token)) => {
                command.env(env_name(&source.id), format!("Bearer {token}"));
            }
            Ok(None) => {}
            Err(error) => errors.push(error),
        }
    }
    errors
}

pub(super) fn manifest(manifest: &mut Value, sources: &[SavedMcpConnection], known_ids: &[String]) {
    let mut servers = serde_json::Map::new();
    for source in sources {
        let mut server = serde_json::json!({"transport":"streamable_http", "url":source.url, "allowedTools":source.allowed_tools});
        if source.has_credential {
            let reference = secret_ref(&source.id);
            server["headers"] = serde_json::json!({"Authorization":{"secretRef":reference}});
            manifest["secrets"][&reference] = serde_json::json!({"env":env_name(&source.id)});
        }
        servers.insert(source.id.clone(), server);
    }
    manifest["mcp"] = servers.into();
    manifest["removeMcp"] = known_ids
        .iter()
        .filter(|id| !sources.iter().any(|source| &source.id == *id))
        .cloned()
        .collect::<Vec<_>>()
        .into();
}

fn discovery_command(
    setup: &DesktopSetup,
    url: &str,
    token: Option<&str>,
) -> Result<(Command, Vec<u8>), String> {
    let executable = setup
        .tool("knotra")
        .ok_or("The bundled engine is unavailable. Reinstall the desktop app.")?;
    let mut command = setup.command(executable);
    command
        .args(["mcp", "discover", "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());

    let mut request = serde_json::json!({"url":url});
    if let Some(token) = token {
        command.env("KNOTRA_MCP_DISCOVERY_AUTH", format!("Bearer {token}"));
        request["headers"] =
            serde_json::json!({"Authorization":{"secretRef":"mcp_discovery_auth"}});
        request["secrets"] =
            serde_json::json!({"mcp_discovery_auth":{"env":"KNOTRA_MCP_DISCOVERY_AUTH"}});
    }
    Ok((
        command,
        serde_json::to_vec(&request).map_err(|_| DISCOVERY_ERROR)?,
    ))
}

fn run_discovery(
    mut command: Command,
    request: &[u8],
    timeout: Duration,
) -> Result<Vec<McpTool>, String> {
    let mut child = command
        .spawn()
        .map_err(|_| "Cannot start MCP discovery. Check the bundled engine installation.")?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(DISCOVERY_ERROR.into());
    };
    let output = std::thread::spawn(move || {
        let mut bytes = vec![];
        stdout
            .take(MAX_CATALOG_BYTES + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });

    let written = child
        .stdin
        .take()
        .ok_or(DISCOVERY_ERROR)
        .and_then(|mut stdin| stdin.write_all(request).map_err(|_| DISCOVERY_ERROR));
    let until = Instant::now() + timeout;
    let result = if written.is_err() {
        Err(DISCOVERY_ERROR)
    } else {
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    break if status.success() {
                        Ok(())
                    } else {
                        Err(DISCOVERY_ERROR)
                    }
                }
                Err(_) => break Err(DISCOVERY_ERROR),
                Ok(None) if Instant::now() >= until => {
                    break Err("MCP discovery timed out. Check the server and retry.")
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            }
        }
    };
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();

    let bytes = output
        .join()
        .map_err(|_| DISCOVERY_ERROR)?
        .map_err(|_| DISCOVERY_ERROR)?;
    result?;
    if bytes.len() > MAX_CATALOG_BYTES as usize {
        return Err("The MCP tool catalog is too large.".into());
    }

    #[derive(Deserialize)]
    struct Catalog {
        tools: Vec<McpTool>,
    }
    let catalog: Catalog = serde_json::from_slice(&bytes).map_err(|_| DISCOVERY_ERROR)?;
    validate_tools(&catalog.tools)?;
    Ok(catalog.tools)
}

async fn discover(
    setup: DesktopSetup,
    url: String,
    token: Option<String>,
) -> Result<Vec<McpTool>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (command, request) = discovery_command(&setup, &url, token.as_deref())?;
        let tools = run_discovery(command, &request, Duration::from_secs(30))?;
        reject_credential_echo(&tools, token.as_deref())?;
        Ok(tools)
    })
    .await
    .map_err(|_| "Cannot finish MCP discovery.")?
}

fn existing(root: &Path, id: Option<&str>) -> Result<Option<SavedMcpConnection>, String> {
    let saved = connections::load(root)?;
    id.map(|id| {
        saved
            .mcp_connections
            .into_iter()
            .find(|source| source.id == id)
            .ok_or_else(|| "This MCP connection no longer exists.".into())
    })
    .transpose()
}

pub(super) fn save(
    root: &Path,
    credentials: &impl Credentials,
    mut source: SavedMcpConnection,
    token: Option<&str>,
    clear: bool,
    expected: Option<u64>,
) -> Result<SavedMcpConnection, String> {
    validate_saved(&source)?;
    let mut saved = connections::load(root)?;
    let previous = saved
        .mcp_connections
        .iter()
        .find(|item| item.id == source.id)
        .cloned();
    if previous.as_ref().map(|item| item.revision) != expected {
        return Err(
            "This MCP connection changed while you were editing it. Reload it and retry.".into(),
        );
    }

    source.revision = expected
        .unwrap_or(0)
        .checked_add(1)
        .ok_or("The MCP connection revision is invalid.")?;
    let revision = saved
        .desired_revision
        .checked_add(1)
        .ok_or("The saved connection revision is invalid.")?;

    let new_token = selected_token(previous.as_ref(), &source.url, token, clear, credentials)?;
    let previous_token = previous
        .as_ref()
        .filter(|source| source.has_credential)
        .map(|source| credentials.get(&source.id))
        .transpose()?
        .flatten();
    reject_credential_echo(&source, new_token.as_deref())?;
    reject_credential_echo(&source, previous_token.as_deref())?;
    source.has_credential = new_token.is_some();
    if token.is_some() {
        credentials.set(&source.id, new_token.as_deref().unwrap())?;
    } else if clear
        && previous
            .as_ref()
            .is_some_and(|source| source.has_credential)
    {
        credentials.remove(&source.id)?;
    }

    if let Some(old) = saved
        .mcp_connections
        .iter_mut()
        .find(|item| item.id == source.id)
    {
        *old = source.clone();
    } else {
        saved.mcp_connections.push(source.clone());
    }
    if !saved.mcp_ids.contains(&source.id) {
        saved.mcp_ids.push(source.id.clone());
    }
    saved.desired_revision = revision;

    if let Err(error) = connections::store(root, &saved) {
        if token.is_some() || clear {
            if let Some(token) = previous_token {
                let _ = credentials.set(&source.id, &token);
            } else {
                let _ = credentials.remove(&source.id);
            }
        }
        return Err(error);
    }
    Ok(source)
}

fn refresh(
    root: &Path,
    expected: &SavedMcpConnection,
    tools: Vec<McpTool>,
) -> Result<SavedMcpConnection, String> {
    validate_tools(&tools)?;
    let mut saved = connections::load(root)?;
    let source = saved
        .mcp_connections
        .iter_mut()
        .find(|item| item.id == expected.id)
        .ok_or("This MCP connection no longer exists.")?;
    if source.revision != expected.revision {
        return Err(
            "This MCP connection changed while its tools were loading. Reload it and retry.".into(),
        );
    }

    source.revision = source
        .revision
        .checked_add(1)
        .ok_or("The MCP connection revision is invalid.")?;
    source.tools = tools;
    let source = source.clone();
    connections::store(root, &saved)?;
    Ok(source)
}

fn remove(
    root: &Path,
    credentials: &impl Credentials,
    id: &str,
) -> Result<Vec<SavedMcpConnection>, String> {
    let mut saved = connections::load(root)?;
    let source = saved
        .mcp_connections
        .iter()
        .find(|source| source.id == id)
        .ok_or("This MCP connection no longer exists.")?;
    let revision = saved
        .desired_revision
        .checked_add(1)
        .ok_or("The saved connection revision is invalid.")?;
    let token = if source.has_credential {
        credentials.get(id)?
    } else {
        None
    };
    if source.has_credential {
        credentials.remove(id)?;
    }
    saved.mcp_connections.retain(|source| source.id != id);
    saved.desired_revision = revision;

    if let Err(error) = connections::store(root, &saved) {
        if let Some(token) = token {
            let _ = credentials.set(id, &token);
        }
        return Err(error);
    }
    Ok(saved.mcp_connections)
}

#[tauri::command]
pub async fn desktop_mcp_connections_list(
    setup: State<'_, DesktopSetup>,
) -> Result<Vec<SavedMcpConnection>, String> {
    let setup = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = setup.sources.lock().unwrap();
        Ok(connections::load(&setup.data)?.mcp_connections)
    })
    .await
    .map_err(|_| "Cannot read MCP connections.")?
}

#[tauri::command]
pub async fn desktop_mcp_tools(
    setup: State<'_, DesktopSetup>,
    url: String,
    token: Option<String>,
    id: Option<String>,
    clear_token: Option<bool>,
) -> Result<Vec<McpTool>, String> {
    let setup = setup.inner().clone();
    let url = validate_url(&url)?;
    let token = {
        let _lock = setup.sources.lock().unwrap();
        selected_token(
            existing(&setup.data, id.as_deref())?.as_ref(),
            &url,
            token.as_deref(),
            clear_token.unwrap_or(false),
            &Keychain,
        )?
    };
    discover(setup, url, token).await
}

#[tauri::command]
pub async fn desktop_mcp_connection_save(
    setup: State<'_, DesktopSetup>,
    id: Option<String>,
    title: Option<String>,
    url: String,
    token: Option<String>,
    clear_token: Option<bool>,
    allowed_tools: Vec<String>,
    expected_revision: Option<u64>,
) -> Result<SavedMcpConnection, String> {
    let setup = setup.inner().clone();
    let url = validate_url(&url)?;
    let clear = clear_token.unwrap_or(false);
    let (previous, selected) = {
        let _lock = setup.sources.lock().unwrap();
        let previous = existing(&setup.data, id.as_deref())?;
        if expected_revision.is_some_and(|revision| {
            previous.as_ref().map(|source| source.revision) != Some(revision)
        }) {
            return Err(
                "This MCP connection changed since it was loaded. Reload it and retry.".into(),
            );
        }
        let selected = selected_token(previous.as_ref(), &url, token.as_deref(), clear, &Keychain)?;
        (previous, selected)
    };

    let tools = discover(setup.clone(), url.clone(), selected).await?;
    validate_selection(&tools, &allowed_tools, previous.as_ref())?;
    let source = SavedMcpConnection {
        id: previous
            .as_ref()
            .map(|source| source.id.clone())
            .unwrap_or_else(|| format!("mcp_{}", &connections::source_id()[7..])),
        title: title
            .filter(|title| !title.trim().is_empty())
            .or_else(|| previous.as_ref().map(|source| source.title.clone()))
            .unwrap_or_else(|| "MCP server".into())
            .trim()
            .into(),
        transport: "streamable_http".into(),
        url,
        tools,
        allowed_tools,
        has_credential: false,
        revision: 0,
    };

    let expected = previous.as_ref().map(|source| source.revision);
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = setup.sources.lock().unwrap();
        let source = save(
            &setup.data,
            &Keychain,
            source,
            token.as_deref(),
            clear,
            expected,
        )?;
        setup.sources_changed();
        Ok(source)
    })
    .await
    .map_err(|_| "Cannot save this MCP connection.")?
}

#[tauri::command]
pub async fn desktop_mcp_connection_refresh(
    setup: State<'_, DesktopSetup>,
    id: String,
    expected_revision: Option<u64>,
) -> Result<SavedMcpConnection, String> {
    let setup = setup.inner().clone();
    let (previous, token) = {
        let _lock = setup.sources.lock().unwrap();
        let previous = existing(&setup.data, Some(&id))?.unwrap();
        if expected_revision.is_some_and(|revision| previous.revision != revision) {
            return Err(
                "This MCP connection changed since it was loaded. Reload it and retry.".into(),
            );
        }
        let token = key(&previous, &Keychain)?;
        (previous, token)
    };
    let tools = discover(setup.clone(), previous.url.clone(), token.clone()).await?;
    let mut checked = previous.clone();
    checked.tools = tools.clone();
    reject_credential_echo(&checked, token.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = setup.sources.lock().unwrap();
        refresh(&setup.data, &previous, tools)
    })
    .await
    .map_err(|_| "Cannot refresh MCP tools.")?
}

#[tauri::command]
pub async fn desktop_mcp_connection_remove(
    setup: State<'_, DesktopSetup>,
    id: String,
    expected_revision: Option<u64>,
) -> Result<Vec<SavedMcpConnection>, String> {
    let setup = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = setup.sources.lock().unwrap();
        if let Some(revision) = expected_revision {
            if existing(&setup.data, Some(&id))?.map(|source| source.revision) != Some(revision) {
                return Err(
                    "This MCP connection changed since it was loaded. Reload it and retry.".into(),
                );
            }
        }
        let connections = remove(&setup.data, &Keychain, &id)?;
        setup.sources_changed();
        Ok(connections)
    })
    .await
    .map_err(|_| "Cannot remove this MCP connection.")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::setup::tests::TempDir;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryCredentials(Mutex<HashMap<String, String>>);
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

    fn tool(name: &str) -> McpTool {
        McpTool {
            name: name.into(),
            title: Some(format!("Friendly {name}")),
            description: Some("Read an item".into()),
            input_schema: serde_json::json!({"type":"object","properties":{"item":{"type":"string"}},"required":["item"]}),
            output_schema: Some(
                serde_json::json!({"type":"object","properties":{"value":{"type":"string"}}}),
            ),
        }
    }

    fn source(id: &str) -> SavedMcpConnection {
        SavedMcpConnection {
            id: id.into(),
            title: "Team tools".into(),
            transport: "streamable_http".into(),
            url: "https://tools.example/mcp".into(),
            tools: vec![tool("read"), tool("write")],
            allowed_tools: vec!["read".into()],
            has_credential: false,
            revision: 0,
        }
    }

    fn apply(root: &Path, credentials: &MemoryCredentials) -> connections::AppliedSetup {
        let mut saved = connections::load(root).unwrap();
        let (applied, errors) = connections::stage_applied(&saved, credentials).unwrap();
        assert!(errors.is_empty());
        connections::commit_applied(root, &mut saved, applied.clone(), credentials).unwrap();
        applied
    }

    #[test]
    fn mcp_urls_allow_https_and_loopback_but_never_url_credentials_or_redirect_queries() {
        for url in [
            "https://tools.example/mcp",
            "http://localhost:1234/mcp",
            "http://127.0.0.2:1234/mcp",
            "http://[::1]:1234/mcp",
        ] {
            assert!(validate_url(url).is_ok(), "{url}");
        }
        for url in [
            "http://tools.example/mcp",
            "file:///private/data",
            "https://key:secret@tools.example/mcp",
            "https://tools.example/mcp?token=secret",
            "https://tools.example/mcp#secret",
            "not-a-url",
        ] {
            assert!(validate_url(url).is_err(), "{url}");
        }
        assert_eq!(
            validate_url(" HTTPS://TOOLS.EXAMPLE:443/mcp ").unwrap(),
            "https://tools.example/mcp"
        );
        for token in ["", "key\r\nInjected: yes", "key\0suffix", "non-ascii-ключ"] {
            assert!(validate_token(token).is_err());
        }
    }

    #[test]
    fn mcp_tool_names_and_counts_match_the_engine_profile_contract() {
        for name in ["read", "files.read", "read_file-2", "UPPER_123"] {
            assert!(valid_tool_name(name));
        }
        for name in ["", "read file", "read/file", "read:all", "read\nfile"] {
            assert!(!valid_tool_name(name));
            assert!(validate_tools(&[tool(name)]).is_err());
        }
        assert!(!valid_tool_name(&"x".repeat(129)));
        let too_many = (0..1025)
            .map(|index| tool(&format!("tool_{index}")))
            .collect::<Vec<_>>();
        assert!(validate_tools(&too_many).is_err());
        let mut invalid = source("mcp_fixture");
        invalid.allowed_tools = vec!["missing/invalid".into()];
        assert!(validate_saved(&invalid).is_err());
        invalid.allowed_tools = (0..1025).map(|index| format!("tool_{index}")).collect();
        assert!(validate_saved(&invalid).is_err());
    }

    #[test]
    fn retained_token_is_bound_to_the_exact_saved_url_before_any_secret_lookup() {
        struct NoLookup;
        impl Credentials for NoLookup {
            fn get(&self, _: &str) -> Result<Option<String>, String> {
                panic!("A changed endpoint must not read its old credential");
            }
            fn set(&self, _: &str, _: &str) -> Result<(), String> {
                unreachable!()
            }
            fn remove(&self, _: &str) -> Result<(), String> {
                unreachable!()
            }
        }
        let mut original = source("mcp_fixture");
        original.has_credential = true;
        for url in [
            "https://other.example/mcp",
            "https://tools.example/different-path",
        ] {
            assert!(selected_token(Some(&original), url, None, false, &NoLookup)
                .err()
                .unwrap()
                .contains("URL changed"));
        }
        assert_eq!(
            selected_token(
                Some(&original),
                "https://other.example/mcp",
                Some("new-token"),
                false,
                &NoLookup
            )
            .unwrap()
            .as_deref(),
            Some("new-token")
        );
        assert!(selected_token(
            Some(&original),
            "https://other.example/mcp",
            None,
            true,
            &NoLookup
        )
        .unwrap()
        .is_none());
        assert!(selected_token(
            Some(&original),
            &original.url,
            Some("new-token"),
            true,
            &NoLookup
        )
        .is_err());
    }

    #[test]
    fn mcp_catalog_and_allowlist_survive_reopen_without_plaintext_credentials() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        let first = save(
            &root.0,
            &credentials,
            source("mcp_first"),
            Some("first-private-token"),
            false,
            None,
        )
        .unwrap();
        let second = save(
            &root.0,
            &credentials,
            source("mcp_second"),
            Some("second-private-token"),
            false,
            None,
        )
        .unwrap();
        let saved = connections::load(&root.0).unwrap();
        assert_eq!(saved.desired_revision, 2);
        assert_eq!(saved.mcp_connections.len(), 2);
        assert_eq!(saved.mcp_connections[0].allowed_tools, ["read"]);
        assert_eq!(
            saved.mcp_connections[0].tools[0].input_schema["required"],
            serde_json::json!(["item"])
        );
        assert_eq!(
            saved.mcp_connections[0].tools[0]
                .output_schema
                .as_ref()
                .unwrap()["type"],
            "object"
        );
        assert_eq!(
            key(&first, &credentials).unwrap().as_deref(),
            Some("first-private-token")
        );
        assert_eq!(
            key(&second, &credentials).unwrap().as_deref(),
            Some("second-private-token")
        );
        let metadata = fs::read_to_string(root.0.join("desktop-connections.json")).unwrap();
        assert!(!metadata.contains("private-token"));
        assert!(!saved.engine_enabled);
    }

    #[test]
    fn mcp_manifest_and_command_keep_bearer_tokens_in_separate_secret_environments() {
        let credentials = MemoryCredentials::default();
        let mut first = source("mcp_first");
        first.has_credential = true;
        let mut second = source("mcp_second");
        second.has_credential = true;
        second.allowed_tools.clear();
        credentials.set(&first.id, "first-token").unwrap();
        credentials.set(&second.id, "second-token").unwrap();
        let mut manifest_value = connections::manifest(&[], None);
        manifest(
            &mut manifest_value,
            &[first.clone(), second.clone()],
            &[first.id.clone(), second.id.clone(), "mcp_removed".into()],
        );
        assert_eq!(
            manifest_value["mcp"]["mcp_first"]["allowedTools"],
            serde_json::json!(["read"])
        );
        assert_eq!(
            manifest_value["mcp"]["mcp_second"]["allowedTools"],
            serde_json::json!([])
        );
        assert_eq!(
            manifest_value["removeMcp"],
            serde_json::json!(["mcp_removed"])
        );
        assert_eq!(
            manifest_value["mcp"]["mcp_first"]["headers"]["Authorization"]["secretRef"],
            "mcp_mcp_first_auth"
        );
        assert_ne!(
            manifest_value["secrets"]["mcp_mcp_first_auth"]["env"],
            manifest_value["secrets"]["mcp_mcp_second_auth"]["env"]
        );
        assert!(!manifest_value.to_string().contains("first-token"));
        let mut command = Command::new("fixture-engine");
        assert!(configure_command(&mut command, &[first, second], &credentials).is_empty());
        assert!(command
            .get_args()
            .all(|arg| !arg.to_string_lossy().contains("token")));
        assert!(command
            .get_envs()
            .any(|(name, value)| name == "KNOTRA_MCP_AUTH_MCP_FIRST"
                && value == Some(std::ffi::OsStr::new("Bearer first-token"))));
        assert!(command
            .get_envs()
            .any(|(name, value)| name == "KNOTRA_MCP_AUTH_MCP_SECOND"
                && value == Some(std::ffi::OsStr::new("Bearer second-token"))));
    }

    #[test]
    fn mcp_rotation_removal_and_reopen_keep_the_applied_workflow_credential() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        let initial = save(
            &root.0,
            &credentials,
            source("mcp_first"),
            Some("token-a"),
            false,
            None,
        )
        .unwrap();
        let applied = apply(&root.0, &credentials);
        let old_entry = applied.credential_entries[&initial.id].clone();
        let changed = save(
            &root.0,
            &credentials,
            initial.clone(),
            Some("token-b"),
            false,
            Some(initial.revision),
        )
        .unwrap();
        let reopened = connections::load(&root.0).unwrap();
        let (boot, held) = connections::boot_snapshot(&reopened, false).unwrap();
        assert!(!held);
        assert_eq!(
            key(
                &boot.mcp_connections[0],
                &connections::AppliedCredentials {
                    applied: &boot,
                    credentials: &credentials
                }
            )
            .unwrap()
            .as_deref(),
            Some("token-a")
        );
        assert_eq!(
            key(&changed, &credentials).unwrap().as_deref(),
            Some("token-b")
        );
        assert!(connections::pending(&reopened));
        remove(&root.0, &credentials, &initial.id).unwrap();
        assert!(credentials.get(&initial.id).unwrap().is_none());
        assert!(credentials.get(&old_entry).unwrap().is_some());
        let mut saved = connections::load(&root.0).unwrap();
        connections::stage_update(&root.0, &mut saved, &credentials).unwrap();
        let staged = saved.staged.clone().unwrap();
        assert!(staged.mcp_connections.is_empty());
        let mut removed_manifest = connections::manifest(&[], None);
        manifest(
            &mut removed_manifest,
            &staged.mcp_connections,
            &staged.mcp_ids,
        );
        assert_eq!(
            removed_manifest["removeMcp"],
            serde_json::json!(["mcp_first"])
        );
        connections::commit_staged(&root.0, &mut saved, staged, &credentials).unwrap();
        connections::cleanup_retired(&root.0, &credentials);
        assert!(credentials.get(&old_entry).unwrap().is_none());
    }

    #[test]
    fn mcp_staging_with_a_missing_token_never_publishes_a_partial_target() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        save(
            &root.0,
            &credentials,
            source("mcp_first"),
            Some("token-a"),
            false,
            None,
        )
        .unwrap();
        let old = apply(&root.0, &credentials);
        save(
            &root.0,
            &credentials,
            source("mcp_second"),
            Some("token-b"),
            false,
            None,
        )
        .unwrap();
        credentials.remove("mcp_second").unwrap();
        let mut saved = connections::load(&root.0).unwrap();
        assert!(connections::stage_update(&root.0, &mut saved, &credentials).is_err());
        let restored = connections::load(&root.0).unwrap();
        assert!(restored.staged.is_none());
        assert_eq!(restored.applied.unwrap().revision, old.revision);
        assert_eq!(
            credentials
                .get(&old.credential_entries["mcp_first"])
                .unwrap()
                .as_deref(),
            Some("token-a")
        );
    }

    #[test]
    fn mcp_failed_metadata_save_clear_and_remove_restore_the_previous_token() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        let original = save(
            &root.0,
            &credentials,
            source("mcp_first"),
            Some("token-a"),
            false,
            None,
        )
        .unwrap();
        fs::create_dir(root.0.join(".desktop-connections.tmp")).unwrap();
        assert!(save(
            &root.0,
            &credentials,
            original.clone(),
            Some("token-b"),
            false,
            Some(original.revision)
        )
        .is_err());
        assert_eq!(
            credentials.get(&original.id).unwrap().as_deref(),
            Some("token-a")
        );
        assert!(save(
            &root.0,
            &credentials,
            original.clone(),
            None,
            true,
            Some(original.revision)
        )
        .is_err());
        assert_eq!(
            credentials.get(&original.id).unwrap().as_deref(),
            Some("token-a")
        );
        assert!(remove(&root.0, &credentials, &original.id).is_err());
        assert_eq!(
            credentials.get(&original.id).unwrap().as_deref(),
            Some("token-a")
        );
        assert_eq!(connections::load(&root.0).unwrap().mcp_connections.len(), 1);
    }

    #[test]
    fn mcp_late_save_or_refresh_cannot_replace_a_newer_endpoint_or_token() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        let original = save(
            &root.0,
            &credentials,
            source("mcp_first"),
            Some("token-a"),
            false,
            None,
        )
        .unwrap();
        let mut changed = original.clone();
        changed.url = "https://new.example/mcp".into();
        let newer = save(
            &root.0,
            &credentials,
            changed,
            Some("token-b"),
            false,
            Some(original.revision),
        )
        .unwrap();
        assert!(save(
            &root.0,
            &credentials,
            original.clone(),
            Some("late-token"),
            false,
            Some(original.revision)
        )
        .err()
        .unwrap()
        .contains("changed"));
        assert!(refresh(&root.0, &original, vec![tool("late-tool")])
            .err()
            .unwrap()
            .contains("changed"));
        let saved = connections::load(&root.0).unwrap();
        assert_eq!(saved.mcp_connections[0].url, newer.url);
        assert_eq!(
            key(&saved.mcp_connections[0], &credentials)
                .unwrap()
                .as_deref(),
            Some("token-b")
        );
    }

    #[test]
    fn refreshing_mcp_tools_preserves_missing_permissions_and_never_enables_new_tools() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        let original = save(
            &root.0,
            &credentials,
            source("mcp_first"),
            None,
            false,
            None,
        )
        .unwrap();
        let revision = connections::load(&root.0).unwrap().desired_revision;
        let refreshed = refresh(&root.0, &original, vec![tool("new-tool")]).unwrap();
        assert_eq!(refreshed.allowed_tools, ["read"]);
        assert_eq!(refreshed.tools[0].name, "new-tool");
        assert_eq!(
            connections::load(&root.0).unwrap().desired_revision,
            revision
        );
        assert!(validate_selection(&refreshed.tools, &["read".into()], Some(&refreshed)).is_ok());
        assert!(validate_selection(
            &refreshed.tools,
            &["missing-never-enabled".into()],
            Some(&refreshed)
        )
        .is_err());
        assert!(validate_selection(&refreshed.tools, &[], None).is_ok());
    }

    #[test]
    fn discovery_credentials_are_in_environment_only_and_public_stdin_has_only_refs() {
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
        let (command, input) = discovery_command(
            &setup,
            "https://tools.example/mcp",
            Some("fixture-private-token"),
        )
        .unwrap();
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(args, ["mcp", "discover", "--json"]);
        assert!(!String::from_utf8(input.clone())
            .unwrap()
            .contains("fixture-private-token"));
        let public: Value = serde_json::from_slice(&input).unwrap();
        assert_eq!(
            public["headers"]["Authorization"]["secretRef"],
            "mcp_discovery_auth"
        );
        assert!(command
            .get_envs()
            .any(|(name, value)| name == "KNOTRA_MCP_DISCOVERY_AUTH"
                && value == Some(std::ffi::OsStr::new("Bearer fixture-private-token"))));
    }

    #[test]
    fn server_metadata_cannot_echo_saved_credentials_into_public_catalogs_or_files() {
        let root = TempDir::new();
        let credentials = MemoryCredentials::default();
        let mut unsafe_source = source("mcp_first");
        unsafe_source.tools[0].description = Some("Echo: fixture-private-token".into());
        assert!(
            reject_credential_echo(&unsafe_source.tools, Some("fixture-private-token")).is_err()
        );
        let error = save(
            &root.0,
            &credentials,
            unsafe_source,
            Some("fixture-private-token"),
            false,
            None,
        )
        .err()
        .unwrap();
        assert!(!error.contains("fixture-private-token"));
        assert!(!root.0.join("desktop-connections.json").exists());
        assert!(credentials.0.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn discovery_process_is_bounded_parses_schema_and_redacts_child_errors() {
        fn command(script: &str) -> Command {
            let mut c = Command::new("/bin/sh");
            c.args(["-c", script])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            c
        }
        let tools = run_discovery(
            command("cat >/dev/null; printf '%s' '{\"tools\":[{\"name\":\"read\",\"title\":\"Friendly read\",\"inputSchema\":{\"type\":\"object\"},\"outputSchema\":{\"type\":\"object\"}}]}'"),
            b"{}",
            Duration::from_secs(2)
        )
        .unwrap();
        assert_eq!(tools[0].title.as_deref(), Some("Friendly read"));
        assert!(tools[0].output_schema.is_some());
        let error = run_discovery(
            command("printf '%s' 'fixture-private-token' >&2; exit 1"),
            b"{}",
            Duration::from_secs(2),
        )
        .err()
        .unwrap();
        assert_eq!(error, DISCOVERY_ERROR);
        assert!(!error.contains("fixture-private-token"));
        let started = Instant::now();
        let error = run_discovery(
            command("exec /bin/sleep 30"),
            b"{}",
            Duration::from_millis(80),
        )
        .err()
        .unwrap();
        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
