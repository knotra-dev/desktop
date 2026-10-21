use super::*;
use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde_json::Value;
use std::io::{BufRead, Read, Write};

const MAX_DOWNLOAD: u64 = 1024 * 1024 * 1024;

fn version(provider: &str) -> Result<String, String> {
    let manifest: Value = serde_json::from_str(include_str!("../../account-clis.json"))
        .map_err(|_| "The account CLI manifest is invalid.")?;
    manifest[provider]["version"]
        .as_str()
        .filter(|version| {
            !version.is_empty()
                && version
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
        })
        .map(str::to_owned)
        .ok_or_else(|| "The account CLI version is invalid.".into())
}

pub(super) fn cache_dirs(cache: &Path) -> Vec<PathBuf> {
    ["codex", "claude"]
        .into_iter()
        .filter_map(|provider| {
            version(provider)
                .ok()
                .map(|version| cache.join(format!("{provider}-{version}")))
        })
        .collect()
}

async fn pinned_version(setup: &DesktopSetup, executable: PathBuf, expected: String) -> bool {
    let mut command = setup.command(executable);
    command.arg("--version").stdout(Stdio::piped());
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(mut child) = command.spawn() else {
            return false;
        };
        let until = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let mut output = String::new();
                    if let Some(pipe) = child.stdout.take() {
                        let _ = pipe.take(4096).read_to_string(&mut output);
                    }
                    return status.success()
                        && output.split_whitespace().any(|token| {
                            token.trim_start_matches('v') == expected.trim_start_matches('v')
                        });
                }
                Err(_) => return false,
                Ok(None) => {}
            }
            if Instant::now() > until {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
    })
    .await
    .unwrap_or(false)
}

pub(super) fn http_client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Cannot initialize a secure provider connection.".into())
}

fn provider(value: &str) -> Result<(), String> {
    if ![
        "codex",
        "claude",
        "ollama",
        "openai",
        "anthropic",
        "openai-compatible",
    ]
    .contains(&value)
    {
        return Err("Choose a supported model provider.".into());
    }
    Ok(())
}

fn endpoint(value: &str) -> Result<String, String> {
    let url = Url::parse(value).map_err(|_| "Enter an absolute API base URL.")?;
    let host = url.host_str().ok_or("The API base URL needs a host.")?;
    let local = host == "localhost"
        || host
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| match ip {
                std::net::IpAddr::V4(ip) => ip.is_loopback() || ip.is_private(),
                std::net::IpAddr::V6(ip) => {
                    ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00
                }
            });
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !["http", "https"].contains(&url.scheme())
        || (url.scheme() != "https" && !local)
    {
        return Err("Use HTTPS for remote providers, without credentials, query or fragment. HTTP is allowed only for localhost or a private IP address.".into());
    }
    Ok(url.as_str().trim_end_matches('/').into())
}

pub(super) fn api_endpoint(provider: &str, base: Option<&str>) -> Result<String, String> {
    endpoint(
        base.filter(|base| !base.is_empty())
            .unwrap_or(match provider {
                "openai" => "https://api.openai.com/v1",
                "anthropic" => "https://api.anthropic.com/v1",
                "ollama" => "http://127.0.0.1:11434",
                _ => return Err("Enter the provider API URL.".into()),
            }),
    )
}

fn key_valid(key: Option<&str>) -> Result<(), String> {
    if key.is_some_and(|key| key.len() > 8192 || key.chars().any(char::is_control)) {
        return Err("The API key contains invalid characters.".into());
    }
    Ok(())
}

fn model_id(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 512
        && model.as_bytes()[0].is_ascii_alphanumeric()
        && model
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_./:-".contains(&c))
}

pub(super) fn validate(
    provider_name: &str,
    model: &str,
    key: Option<&str>,
    base: Option<&str>,
) -> Result<Option<String>, String> {
    provider(provider_name)?;
    key_valid(key)?;
    if !model_id(model) {
        return Err("Choose a model ID using letters, numbers, dots, underscores, slashes, colons or hyphens.".into());
    }
    if ["openai", "anthropic"].contains(&provider_name)
        && key.is_none_or(|key| key.trim().is_empty())
    {
        return Err(
            "Enter an API key for this provider. It will be saved in your system credential store."
                .into(),
        );
    }
    if ["codex", "claude"].contains(&provider_name)
        && (base.is_some_and(|base| !base.is_empty()) || key.is_some_and(|key| !key.is_empty()))
    {
        return Err("Account connections use the official CLI sign-in, without an API key or custom API URL.".into());
    }

    let base = base
        .filter(|value| !value.is_empty())
        .map(endpoint)
        .transpose()?;
    if provider_name == "openai-compatible" && base.is_none() {
        return Err("Enter your provider's API base URL, usually ending in /v1.".into());
    }
    Ok(base)
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ProviderModel {
    pub(super) id: String,
    pub(super) name: String,
}

pub(super) async fn models(
    provider: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
) -> Result<Vec<ProviderModel>, String> {
    validate(provider, "default", api_key, base_url)?;
    reject_credential_echo(&base_url, api_key)?;
    if provider == "codex" || provider == "claude" {
        let mut models = vec![ProviderModel {
            id: "default".into(),
            name: "Account default".into(),
        }];
        if provider == "claude" {
            models.extend(
                [
                    ("sonnet", "Claude Sonnet"),
                    ("opus", "Claude Opus"),
                    ("haiku", "Claude Haiku"),
                ]
                .into_iter()
                .map(|(id, name)| ProviderModel {
                    id: id.into(),
                    name: name.into(),
                }),
            );
        }
        if provider == "codex" {
            // Read only public model metadata on explicit discovery, never login credentials.
            let home = std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                        .map(|home| PathBuf::from(home).join(".codex"))
                });
            if let Some(path) = home.map(|home| home.join("models_cache.json")) {
                if let Ok(file) = fs::File::open(path) {
                    if let Ok(value) =
                        serde_json::from_reader::<_, Value>(file.take(4 * 1024 * 1024))
                    {
                        if let Some(items) = value["models"].as_array() {
                            for item in items {
                                if item["visibility"]
                                    .as_str()
                                    .is_some_and(|value| value != "list")
                                {
                                    continue;
                                }
                                if let Some(id) = item["slug"].as_str() {
                                    if model_id(id) {
                                        models.push(ProviderModel {
                                            id: id.into(),
                                            name: item["display_name"]
                                                .as_str()
                                                .unwrap_or(id)
                                                .chars()
                                                .take(200)
                                                .collect(),
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        return Ok(models);
    }

    let base = api_endpoint(provider, base_url)?;
    let suffix = if provider == "ollama" {
        "/api/tags"
    } else {
        "/models"
    };
    let client = http_client(Duration::from_secs(30))?;
    let mut result = Vec::new();
    let mut after = None;
    let mut cursors = std::collections::HashSet::new();
    let mut downloaded = 0;
    loop {
        let mut request = client.get(format!("{base}{suffix}"));
        if let Some(cursor) = &after {
            request = request.query(&[("after_id", cursor)]);
        }
        if provider == "anthropic" {
            request = request.header("anthropic-version", "2023-06-01");
            if let Some(key) = api_key {
                request = request.header("x-api-key", key);
            }
        } else if let Some(key) = api_key {
            request = request.bearer_auth(key);
        }

        let response = request.send().await.map_err(|_| {
            "Could not reach the model catalog. Check the API URL, network and TLS certificate."
        })?;
        if !response.status().is_success() {
            return Err(
                "The provider rejected the model-list request. Check your API key and API URL."
                    .into(),
            );
        }

        let mut bytes = Vec::new();

        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "The model catalog download failed.")?;
            downloaded += chunk.len();
            if downloaded > 4 * 1024 * 1024 {
                return Err("The model catalog exceeds the supported size.".into());
            }
            bytes.extend_from_slice(&chunk);
        }

        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "The provider returned an invalid model catalog.")?;
        let items = value[if provider == "ollama" {
            "models"
        } else {
            "data"
        }]
        .as_array()
        .ok_or("The provider returned an invalid model catalog.")?;
        for item in items {
            if let Some(id) = item[if provider == "ollama" { "name" } else { "id" }].as_str() {
                if !model_id(id) || item["lifecycle"] == "retired" {
                    continue;
                }
                result.push(ProviderModel {
                    id: id.into(),
                    name: item["display_name"]
                        .as_str()
                        .unwrap_or(id)
                        .chars()
                        .take(200)
                        .collect(),
                });
            }
        }
        if provider != "anthropic" || value["has_more"] != true {
            break;
        }
        let cursor = value["last_id"]
            .as_str()
            .filter(|id| model_id(id))
            .ok_or("The provider returned an invalid model catalog cursor.")?;
        if !cursors.insert(cursor.to_owned()) || cursors.len() > 100 {
            return Err("The provider returned an invalid model catalog cursor.".into());
        }
        after = Some(cursor.to_owned());
    }

    result.sort_by(|a, b| a.id.cmp(&b.id));
    result.dedup_by(|a, b| a.id == b.id);
    reject_credential_echo(&result, api_key)?;
    Ok(result)
}

#[derive(Deserialize)]
struct Asset {
    url: String,
    sha256: String,
    size: u64,
    archive: String,
    executable: String,
}

fn platform() -> String {
    format!(
        "{}-{}",
        match std::env::consts::OS {
            "macos" => "darwin",
            other => other,
        },
        match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "amd64",
            other => other,
        }
    )
}

fn asset(provider: &str) -> Result<Asset, String> {
    let value: Value = serde_json::from_str(include_str!("../../account-clis.json"))
        .map_err(|_| "The bundled account CLI manifest is invalid.")?;
    let asset: Asset = serde_json::from_value(value[provider]["platforms"][platform()].clone())
        .map_err(|_| {
            "This account CLI is not available for this operating system and processor."
        })?;
    let url = Url::parse(&asset.url).map_err(|_| "The bundled account CLI URL is invalid.")?;
    if url.scheme() != "https"
        || asset.size == 0
        || asset.size > MAX_DOWNLOAD
        || asset.sha256.len() != 64
        || !asset.sha256.bytes().all(|c| c.is_ascii_hexdigit())
        || Path::new(&asset.executable).components().count() != 1
        || asset.executable.starts_with('.')
    {
        return Err("The bundled account CLI manifest is invalid.".into());
    }
    Ok(asset)
}

struct Partial(PathBuf);
impl Drop for Partial {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn unpack(asset: &Asset, archive: &Path, candidate: &Path) -> Result<(), String> {
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(candidate)
        .map_err(|_| "Cannot stage the account CLI.")?;
    if asset.archive == "raw" {
        std::io::copy(
            &mut fs::File::open(archive).map_err(|_| "Cannot read the verified CLI download.")?,
            &mut output,
        )
        .map_err(|_| "Cannot stage the account CLI.")?;
    } else if asset.archive == "tar.gz" {
        let gzip = flate2::read::GzDecoder::new(
            fs::File::open(archive).map_err(|_| "Cannot read the verified CLI download.")?,
        );
        let mut archive = tar::Archive::new(gzip);
        let mut found = false;
        for entry in archive
            .entries()
            .map_err(|_| "The account CLI archive is invalid.")?
        {
            let mut entry = entry.map_err(|_| "The account CLI archive is invalid.")?;
            if entry
                .path()
                .map_err(|_| "The account CLI archive has an invalid path.")?
                .as_ref()
                != Path::new(&asset.executable)
            {
                continue;
            }
            if found || !entry.header().entry_type().is_file() || entry.size() > MAX_DOWNLOAD {
                return Err("The account CLI archive has an invalid executable entry.".into());
            }
            std::io::copy(&mut entry, &mut output).map_err(|_| "Cannot unpack the account CLI.")?;
            found = true;
        }
        if !found {
            return Err("The account CLI executable is absent from its archive.".into());
        }
    } else {
        return Err("The account CLI archive format is unsupported.".into());
    }
    output
        .sync_all()
        .map_err(|_| "Cannot save the account CLI.")?;
    Ok(())
}

pub(super) async fn ensure_cli(
    setup: &DesktopSetup,
    provider: &str,
    generation: u64,
    cancel: Arc<Notify>,
) -> Result<PathBuf, String> {
    let version = version(provider)?;
    if let Some(path) = setup.tool(provider) {
        if pinned_version(setup, path.clone(), version.clone()).await {
            return Ok(path);
        }
    }

    let asset = asset(provider)?;
    let cache = setup.cache.join(format!("{provider}-{version}"));
    private_dir(&cache)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Cannot create a temporary download name.")?
        .as_nanos();
    let temporary = Partial(cache.join(format!(".{provider}-{generation}-{nonce}.download")));
    let candidate = Partial(cache.join(format!(".{provider}-{generation}-{nonce}.staged")));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary.0)
        .map_err(|_| "A previous CLI download is still finishing. Cancel and retry.")?;
    setup.login_update(generation, |status| {
        status.source_message = Some(format!(
            "Downloading the official {provider} CLI ({} MB).",
            asset.size / 1_000_000
        ))
    });
    // Only the pinned asset's trusted download hosts may redirect; credentials are never attached.
    let client = Client::builder()
        .timeout(Duration::from_secs(15 * 60))
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let trusted = [
                "github.com",
                "release-assets.githubusercontent.com",
                "objects.githubusercontent.com",
                "downloads.claude.ai",
                "storage.googleapis.com",
            ];
            if attempt.previous().len() < 4
                && attempt.url().scheme() == "https"
                && attempt
                    .url()
                    .host_str()
                    .is_some_and(|host| trusted.contains(&host))
            {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|_| "Cannot initialize a secure CLI download.")?;
    let response = cancellable(&cancel, client.get(&asset.url).send())
        .await?
        .map_err(|_| "The account CLI download failed. Check your network and retry.")?;
    if !response.status().is_success() {
        return Err(
            "The official CLI download is unavailable. Check the network and retry.".into(),
        );
    }

    let mut stream = response.bytes_stream();
    let mut received = 0u64;
    let mut hash = Sha256::new();
    loop {
        let chunk = cancellable(&cancel, stream.next()).await?;
        let Some(chunk) = chunk else {
            break;
        };
        let chunk =
            chunk.map_err(|_| "The account CLI download was interrupted. Retry the download.")?;
        received += chunk.len() as u64;
        if received > asset.size {
            return Err("The account CLI download exceeds its pinned size.".into());
        }
        file.write_all(&chunk)
            .map_err(|_| "Cannot save the account CLI download. Check free disk space.")?;
        hash.update(&chunk);
        setup.login_update(generation, |status| {
            status.source_message = Some(format!(
                "Downloading {provider}: {} / {} MB",
                received / 1_000_000,
                asset.size / 1_000_000
            ))
        });
    }

    if received != asset.size || format!("{:x}", hash.finalize()) != asset.sha256.to_lowercase() {
        return Err("The account CLI checksum did not match. Nothing was installed; retry on a trusted network.".into());
    }
    drop(file);
    unpack(&asset, &temporary.0, &candidate.0)?;
    if !setup.login_current(generation) {
        return Err("Setup cancelled.".into());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&candidate.0, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot make the verified CLI executable.")?;
    }
    let destination = cache.join(if cfg!(windows) {
        format!("{provider}.exe")
    } else {
        provider.into()
    });
    fs::rename(&candidate.0, &destination)
        .map_err(|_| "Cannot install the verified account CLI.")?;
    Ok(destination)
}

fn login_details(text: &str) -> (Option<String>, Option<String>) {
    let mut plain = String::new();
    let mut escape = 0;
    for character in text.chars() {
        match escape {
            0 if character == '\u{1b}' => escape = 1,
            0 => plain.push(character),
            1 => escape = if character == '[' { 2 } else { 0 },
            _ if ('@'..='~').contains(&character) => escape = 0,
            _ => {}
        }
    }

    let mut url = None;
    let mut code = None;
    for token in plain.split_whitespace() {
        let token = token.trim_matches(|c: char| {
            !c.is_ascii_alphanumeric()
                && !matches!(c, ':' | '/' | '?' | '=' | '&' | '%' | '_' | '-' | '.' | '~')
        });
        if let Ok(parsed) = Url::parse(token) {
            if parsed.scheme() == "https"
                && parsed.host_str().is_some_and(|host| {
                    [
                        "auth.openai.com",
                        "claude.ai",
                        "console.anthropic.com",
                        "platform.claude.com",
                    ]
                    .contains(&host)
                })
                && parsed.username().is_empty()
                && parsed.password().is_none()
            {
                url = Some(parsed.to_string());
            }
        }
        if token.len() == 9
            && token.as_bytes()[4] == b'-'
            && token
                .bytes()
                .enumerate()
                .all(|(index, c)| index == 4 || c.is_ascii_uppercase() || c.is_ascii_digit())
        {
            code = Some(token.into());
        }
    }
    (url, code)
}

pub(super) fn read_login_output<R: Read + Send + 'static>(
    pipe: Option<R>,
    setup: DesktopSetup,
    generation: u64,
) {
    if let Some(pipe) = pipe {
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(pipe.take(256 * 1024));
            for line in reader.split(b'\n') {
                if !setup.login_current(generation) {
                    break;
                }
                let Ok(line) = line else {
                    break;
                };
                let text = String::from_utf8_lossy(&line);
                let (url, code) = login_details(&text);
                setup.login_update(generation, |status| {
                    if url.is_some() {
                        status.sign_in_url = url;
                    }
                    if code.is_some() {
                        status.code = code;
                    }
                });
            }
        });
    }
}

pub async fn desktop_provider_sign_in(
    setup: State<'_, DesktopSetup>,
    provider: String,
) -> Result<SetupStatus, String> {
    if !["codex", "claude"].contains(&provider.as_str()) {
        return Err("Choose Codex or Claude to sign in with an account.".into());
    }
    let setup = setup.inner().clone();
    let (generation, cancel, children) = setup.begin_login(&provider);
    let background = setup.clone();
    tauri::async_runtime::spawn(async move {
        tauri::async_runtime::spawn_blocking(move || stop_children(children))
            .await
            .ok();
        let guard = cancellable(&cancel, background.control.clone().lock_owned()).await;
        let Ok(_guard) = guard else {
            return;
        };
        if !background.login_current(generation) {
            return;
        }
        let mut frozen = None;
        let result: Result<(), String> = async {
            let replacing_account = {
                let _lock = background.sources.lock().unwrap();
                let saved = connections::load(&background.data)?;
                saved
                    .applied
                    .iter()
                    .chain(saved.staged.iter())
                    .any(|snapshot| snapshot
                        .connections
                        .iter()
                        .any(|source| source.provider == provider))
            };
            if replacing_account {
                let (engine_generation, endpoint, token) = {
                    let inner = background.inner.lock().unwrap();
                    if inner.status.phase != "ready" || inner.engine.is_none() {
                        return Err("Start the local engine before replacing this account so Knotra can check for unfinished workflows.".into());
                    }
                    (
                        inner.generation,
                        inner.status.endpoint.clone().ok_or("The local engine is not ready.")?,
                        inner.control_token.clone().ok_or("The local engine is not ready.")?
                    )
                };
                let prepared = match control_request(&endpoint, &token, "prepare-restart").await {
                    Ok(prepared) => prepared,
                    Err(error) => {
                        let _ = control_request(&endpoint, &token, "cancel-restart").await;
                        return Err(error);
                    }
                };
                if prepared["ready"] != true {
                    return Err("Finish or cancel unfinished workflows before replacing this account. Their current sign-in is still in use.".into());
                }
                frozen = Some((engine_generation, endpoint, token));
            }
            if !background.login_current(generation) {
                return Ok(());
            }

            let executable = ensure_cli(&background, &provider, generation, cancel.clone()).await?;
            if !background.login_current(generation) {
                return Ok(());
            }
            private_dir(&background.data)?;
            let mut command = background.command(executable);
            command
                .current_dir(&background.data)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if provider == "codex" {
                command.args(["login", "-c", r#"forced_login_method="chatgpt""#]);
            } else {
                command.args(["auth", "login", "--claudeai"]);
            }
            background.login_update(generation, |status| {
                status.source_message = Some(
                    "Complete sign-in in your browser. Then return here and save this model source.".into(),
                )
            });
            background.spawn(generation, command, true)?;
            let until = Instant::now() + Duration::from_secs(15 * 60);
            loop {
                if !background.login_current(generation) {
                    return Ok(());
                }
                if let Some(success) = background.process_exited(generation, true) {
                    if !success {
                        return Err(
                            "Account sign-in did not finish. Retry sign-in in your browser.".into(),
                        );
                    }
                    background.login_update(generation, |status| {
                        status.source_phase = "idle".into();
                        status.sign_in_url = None;
                        status.code = None;
                        status.source_message =
                            Some("Signed in. Save this model source to use the account in your nodes.".into());
                    });
                    return Ok(());
                }
                if Instant::now() > until {
                    return Err("Account sign-in timed out. Cancel and retry.".into());
                }
                if cancellable(&cancel, tokio::time::sleep(Duration::from_millis(250)))
                    .await
                    .is_err()
                {
                    return Ok(());
                }
            }
        }
        .await;
        if let Some((engine_generation, endpoint, token)) = frozen {
            match resume_admissions(&background, engine_generation, &endpoint, &token).await {
                Ok(_) => {
                    background.update(engine_generation, |status| status.source_apply_error = None)
                }
                Err(error) => {
                    if let Some(next) = background.fail(engine_generation, &error) {
                        background.apply_failed(next, &error);
                    }
                }
            }
        }
        if let Err(error) = result {
            background.login_fail(generation, &error);
        }
    });
    Ok(setup.snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog_server(responses: Vec<Value>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            responses
                .into_iter()
                .map(|response| {
                    let (mut socket, _) = listener.accept().unwrap();
                    socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                    let mut request = String::new();
                    let mut reader = std::io::BufReader::new(&socket);
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        if line == "\r\n" || line.is_empty() {
                            break;
                        }
                        request.push_str(&line);
                    }

                    let body = response.to_string();
                    write!(
                        socket,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .unwrap();
                    request
                })
                .collect()
        });
        (url, server)
    }

    #[test]
    fn anthropic_catalog_fetches_every_page_and_preserves_only_safe_model_metadata() {
        let (base, server) = catalog_server(vec![
            serde_json::json!({"data": [{"id":"z-model", "display_name":"Z Model"}, {"id":"retired", "lifecycle":"retired"}], "has_more":true, "last_id":"z-model"}),
            serde_json::json!({"data": [{"id":"a-model"}, {"id":"z-model"}, {"id":"--invalid"}], "has_more":false}),
        ]);
        let models = tauri::async_runtime::block_on(models(
            "anthropic",
            Some("fixture-private-key"),
            Some(&base),
        ))
        .unwrap();
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["a-model", "z-model"]
        );
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("GET /v1/models HTTP/1.1"));
        assert!(requests[1].starts_with("GET /v1/models?after_id=z-model HTTP/1.1"));
        assert!(requests
            .iter()
            .all(|request| request.contains("x-api-key: fixture-private-key")));
        assert!(!serde_json::to_string(&models)
            .unwrap()
            .contains("fixture-private-key"));
    }

    #[test]
    fn catalog_rejects_repeating_pagination_cursors() {
        let page = serde_json::json!({"data": [], "has_more":true, "last_id":"same"});
        let (base, server) = catalog_server(vec![page.clone(), page]);
        assert!(
            tauri::async_runtime::block_on(models("anthropic", Some("fixture"), Some(&base)))
                .is_err()
        );
        server.join().unwrap();
    }

    #[test]
    fn provider_model_catalog_cannot_echo_its_private_api_key() {
        for model in [
            serde_json::json!({"id":"safe-model","display_name":"Echo fixture-private-key"}),
            serde_json::json!({"id":"fixture-private-key"}),
        ] {
            let (base, server) = catalog_server(vec![serde_json::json!({"data":[model]})]);
            let error = tauri::async_runtime::block_on(models(
                "openai",
                Some("fixture-private-key"),
                Some(&base),
            ))
            .err()
            .unwrap();
            assert!(error.contains("credential"));
            assert!(!error.contains("fixture-private-key"));
            server.join().unwrap();
        }
    }

    #[test]
    fn claude_account_exposes_supported_cli_choices_without_reading_credentials() {
        let result = tauri::async_runtime::block_on(models("claude", None, None)).unwrap();
        assert_eq!(
            result
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["default", "sonnet", "opus", "haiku"]
        );
    }

    #[test]
    fn provider_inputs_reject_injection_and_insecure_remote_urls() {
        for url in [
            "http://example.com/v1",
            "https://user:password@example.com",
            "https://example.com/v1?api_key=secret",
            "file:///etc/passwd",
            "http://169.254.169.254",
            "https://example.com/#key",
        ] {
            assert!(endpoint(url).is_err(), "accepted {url}");
        }
        for url in [
            "http://127.0.0.1:1234/v1",
            "http://localhost:11434",
            "http://192.168.1.2:1234/v1",
            "http://[::1]:1234/v1",
            "https://example.com/v1",
        ] {
            assert!(endpoint(url).is_ok(), "rejected {url}");
        }
        assert!(validate("codex", "model;touch /tmp/no", None, None).is_err());
        assert!(validate("codex", "--help", None, None).is_err());
        assert!(validate("codex", "default", None, None).is_ok());
        assert!(validate("openai", "model", Some("secret\nvalue"), None).is_err());
        assert!(validate("openai", "model", None, None).is_err());
        assert!(validate(
            "openai-compatible",
            "org/model:latest",
            None,
            Some("http://127.0.0.1:1234/v1")
        )
        .is_ok());
        let error = validate("anthropic", "model", Some("private-key\n"), None).unwrap_err();
        assert!(!error.contains("private-key"));
    }

    #[test]
    fn login_output_exposes_only_official_urls_and_device_code() {
        let (url, code) = login_details(
            "key=private-token\n\x1b[1mABCD-1234\x1b[0m\nhttps://auth.openai.com/codex/device\n",
        );
        assert_eq!(url.as_deref(), Some("https://auth.openai.com/codex/device"));
        assert_eq!(code.as_deref(), Some("ABCD-1234"));
        assert_eq!(
            login_details("secret-token https://evil.example/oauth"),
            (None, None)
        );
        assert_eq!(
            login_details("http://auth.openai.com/foo https://auth.openai.com.evil.example/"),
            (None, None)
        );
        assert!(
            login_details("https://claude.ai/oauth/authorize?state=callback")
                .0
                .is_some()
        );
    }

    #[test]
    fn manifest_has_bounded_assets_for_the_current_platform() {
        for provider in ["codex", "claude"] {
            let asset = asset(provider).unwrap();
            assert!(asset.size < MAX_DOWNLOAD);
            assert!(["raw", "tar.gz"].contains(&asset.archive.as_str()));
        }
        assert!(asset("untrusted-provider").is_err());
    }

    #[test]
    fn extraction_uses_only_exact_regular_executable_and_rejects_links() {
        let root = super::super::tests::TempDir::new();
        let archive = root.0.join("archive.tar.gz");
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            fs::File::create(&archive).unwrap(),
            flate2::Compression::fast(),
        ));
        let mut header = tar::Header::new_gnu();
        header.set_size(6);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, "binary", &b"native"[..])
            .unwrap();
        let encoder = builder.into_inner().unwrap();
        encoder.finish().unwrap();
        let asset = Asset {
            url: "https://example.com".into(),
            sha256: "0".repeat(64),
            size: 1,
            archive: "tar.gz".into(),
            executable: "binary".into(),
        };
        let output = root.0.join("output");
        unpack(&asset, &archive, &output).unwrap();
        assert_eq!(fs::read(output).unwrap(), b"native");

        let link_archive = root.0.join("link.tar.gz");
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            fs::File::create(&link_archive).unwrap(),
            flate2::Compression::fast(),
        ));
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_link(&mut header, "binary", "elsewhere")
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap();
        assert!(unpack(&asset, &link_archive, &root.0.join("rejected")).is_err());
    }
}
