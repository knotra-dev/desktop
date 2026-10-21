//! Explicit native setup actions. Merely opening Settings never signs in or starts a model.
pub mod connections;
pub mod mcp;
mod providers;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, State};
use tokio::sync::Notify;

fn contains_secret(value: &serde_json::Value, secret: &str) -> bool {
    match value {
        serde_json::Value::String(value) => value.contains(secret),
        serde_json::Value::Array(values) => {
            values.iter().any(|value| contains_secret(value, secret))
        }
        serde_json::Value::Object(values) => values
            .iter()
            .any(|(key, value)| key.contains(secret) || contains_secret(value, secret)),
        _ => false,
    }
}

fn reject_credential_echo(value: &impl Serialize, secret: Option<&str>) -> Result<(), String> {
    if let Some(secret) = secret.filter(|secret| !secret.is_empty()) {
        if contains_secret(
            &serde_json::to_value(value).map_err(|_| "Cannot check connection metadata.")?,
            secret,
        ) {
            return Err("Connection metadata contains its access credential. Remove the credential from the URL or metadata, and retry.".into());
        }
    }
    Ok(())
}

async fn cancellable<T>(
    cancel: &Notify,
    future: impl std::future::Future<Output = T>,
) -> Result<T, String> {
    let notified = cancel.notified();
    futures_util::pin_mut!(notified, future);
    match futures_util::future::select(notified, future).await {
        futures_util::future::Either::Left(_) => Err("Setup cancelled.".into()),
        futures_util::future::Either::Right((value, _)) => Ok(value),
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    phase: String,
    message: Option<String>,
    error: Option<String>,
    endpoint: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    models: Vec<providers::ProviderModel>,
    connection_id: Option<String>,
    base_url: Option<String>,
    sign_in_url: Option<String>,
    code: Option<String>,
    docker_ready: bool,
    runtime_available: bool,
    codex_available: bool,
    claude_available: bool,
    configured: bool,
    connections: Vec<connections::SavedConnection>,
    mcp_connections: Vec<mcp::SavedMcpConnection>,
    source_phase: String,
    source_provider: Option<String>,
    source_message: Option<String>,
    source_error: Option<String>,
    restart_required: bool,
    sources_state: String,
    source_apply_error: Option<String>,
    engine_generation: u64,
}

struct Inner {
    status: SetupStatus,
    generation: u64,
    cancel: Arc<Notify>,
    engine: Option<Child>,
    sign_in: Option<Child>,
    docker_checked: Option<Instant>,
    login_generation: u64,
    login_cancel: Arc<Notify>,
    control_token: Option<String>,
    requested_running: bool,
    exiting: bool,
    retry_at: Option<Instant>,
    retry_attempts: u32,
}

#[derive(Clone)]
pub struct DesktopSetup {
    inner: Arc<Mutex<Inner>>,
    runtime: PathBuf,
    cache: PathBuf,
    data: PathBuf,
    search_path: std::ffi::OsString,
    sources: Arc<Mutex<()>>,
    control: Arc<tokio::sync::Mutex<()>>,
}

impl DesktopSetup {
    pub fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        let resources = app
            .path()
            .resource_dir()
            .map_err(|_| "Cannot locate app resources.")?;
        let data = app
            .path()
            .app_data_dir()
            .map_err(|_| "Cannot locate app data.")?;
        let runtime = std::env::var_os("KNOTRA_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| resources.join("runtime"));
        let cache = data.join("runtime");

        let migration_error = connections::migrate(&data.join("managed-engines")).err();
        Ok(Self {
            inner: Arc::new(Mutex::new(Inner {
                status: SetupStatus {
                    phase: if migration_error.is_some() {
                        "error"
                    } else {
                        "idle"
                    }
                    .into(),
                    source_phase: "idle".into(),
                    error: migration_error,
                    ..Default::default()
                },
                generation: 0,
                cancel: Arc::new(Notify::new()),
                engine: None,
                sign_in: None,
                docker_checked: None,
                login_generation: 0,
                login_cancel: Arc::new(Notify::new()),
                control_token: None,
                requested_running: false,
                exiting: false,
                retry_at: None,
                retry_attempts: 0,
            })),
            search_path: search_path(&runtime, &cache),
            runtime,
            cache,
            data: data.join("managed-engines"),
            sources: Arc::new(Mutex::new(())),
            control: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    pub(crate) fn tool(&self, name: &str) -> Option<PathBuf> {
        let filename = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.into()
        };
        std::env::split_paths(&self.search_path)
            .map(|dir| dir.join(&filename))
            .find(|path| path.is_file())
    }

    fn snapshot(&self) -> SetupStatus {
        let mut status = {
            let inner = self.inner.lock().unwrap();
            inner.status.clone()
        };
        status.runtime_available = self.tool("knotra").is_some()
            && ["amd64", "arm64"].iter().all(|arch| {
                self.runtime
                    .join(format!("sandbox-helper-linux-{arch}"))
                    .is_file()
            });
        status.codex_available = self.tool("codex").is_some();
        status.claude_available = self.tool("claude").is_some();

        if let Ok(saved) = connections::load(&self.data) {
            status.configured = saved.engine_enabled;
            let pending = connections::pending(&saved);
            status.restart_required = false;
            status.sources_state = if status.source_apply_error.is_some() {
                "error"
            } else if status.sources_state == "applying" {
                "applying"
            } else if pending {
                "pending"
            } else {
                "current"
            }
            .into();
            status.connections = saved.connections;
            status.mcp_connections = saved.mcp_connections;
        }
        status
    }

    fn command(&self, executable: impl AsRef<std::ffi::OsStr>) -> Command {
        let mut cmd = Command::new(executable);
        cmd.env_clear();
        // Keep OS/login/network locations, without inheriting provider keys or shell hooks.
        for (name, value) in std::env::vars_os() {
            let upper = name.to_string_lossy().to_uppercase();
            if matches!(
                upper.as_str(),
                "HOME"
                    | "USER"
                    | "LOGNAME"
                    | "USERPROFILE"
                    | "HOMEDRIVE"
                    | "HOMEPATH"
                    | "SYSTEMROOT"
                    | "WINDIR"
                    | "APPDATA"
                    | "LOCALAPPDATA"
                    | "TEMP"
                    | "TMP"
                    | "TMPDIR"
                    | "LANG"
                    | "CODEX_HOME"
                    | "CLAUDE_CONFIG_DIR"
                    | "XDG_CONFIG_HOME"
                    | "XDG_DATA_HOME"
                    | "XDG_CACHE_HOME"
                    | "XDG_RUNTIME_DIR"
                    | "DBUS_SESSION_BUS_ADDRESS"
                    | "HTTP_PROXY"
                    | "HTTPS_PROXY"
                    | "NO_PROXY"
                    | "SSL_CERT_FILE"
                    | "SSL_CERT_DIR"
                    | "NODE_EXTRA_CA_CERTS"
                    | "CODEX_CA_CERTIFICATE"
                    | "DOCKER_HOST"
                    | "DOCKER_CONTEXT"
                    | "DOCKER_CONFIG"
            ) || upper.starts_with("LC_")
            {
                cmd.env(name, value);
            }
        }

        cmd.env("PATH", &self.search_path);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        cmd
    }

    fn begin(
        &self,
        phase: &str,
        provider: &str,
        model: Option<&str>,
    ) -> (u64, Arc<Notify>, Vec<Child>) {
        let mut inner = self.inner.lock().unwrap();
        Self::begin_locked(&mut inner, phase, provider, model)
    }

    fn begin_locked(
        inner: &mut Inner,
        phase: &str,
        provider: &str,
        model: Option<&str>,
    ) -> (u64, Arc<Notify>, Vec<Child>) {
        inner.cancel.notify_one();
        inner.generation += 1;
        inner.cancel = Arc::new(Notify::new());
        let mut children = Vec::new();
        if let Some(child) = inner.engine.take() {
            children.push(child);
        }

        inner.status.phase = phase.into();
        inner.status.provider = Some(provider.into());
        inner.status.model = model.map(str::to_owned);
        inner.status.models.clear();
        inner.status.connection_id = None;
        inner.status.base_url = None;
        inner.status.error = None;
        inner.status.endpoint = None;
        inner.status.message = None;
        (inner.generation, inner.cancel.clone(), children)
    }

    fn update(&self, generation: u64, action: impl FnOnce(&mut SetupStatus)) {
        let mut inner = self.inner.lock().unwrap();
        if inner.generation == generation {
            action(&mut inner.status);
        }
    }

    fn current(&self, generation: u64) -> bool {
        self.inner.lock().unwrap().generation == generation
    }

    fn sources_changed(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.status.source_apply_error = None;
        inner.status.sources_state = "pending".into();
        inner.retry_at = None;
        inner.retry_attempts = 0;
    }

    fn begin_login(&self, provider: &str) -> (u64, Arc<Notify>, Vec<Child>) {
        let mut inner = self.inner.lock().unwrap();
        inner.login_cancel.notify_one();
        inner.login_generation += 1;
        inner.login_cancel = Arc::new(Notify::new());

        inner.status.source_phase = "signing_in".into();
        inner.status.source_provider = Some(provider.into());
        inner.status.source_error = None;
        inner.status.source_message = None;
        inner.status.sign_in_url = None;
        inner.status.code = None;
        (
            inner.login_generation,
            inner.login_cancel.clone(),
            inner.sign_in.take().into_iter().collect(),
        )
    }

    fn login_current(&self, generation: u64) -> bool {
        self.inner.lock().unwrap().login_generation == generation
    }

    fn login_update(&self, generation: u64, action: impl FnOnce(&mut SetupStatus)) {
        let mut inner = self.inner.lock().unwrap();
        if inner.login_generation == generation {
            action(&mut inner.status);
        }
    }

    fn login_fail(&self, generation: u64, error: &str) {
        let child = {
            let mut inner = self.inner.lock().unwrap();
            if inner.login_generation != generation {
                return;
            }
            inner.login_generation += 1;
            inner.login_cancel.notify_one();
            inner.status.source_phase = "error".into();
            inner.status.source_error = Some(error.into());
            inner.status.source_message = None;
            inner.status.sign_in_url = None;
            inner.status.code = None;
            inner.sign_in.take()
        };
        stop_children(child.into_iter().collect());
    }

    pub fn restore(&self) {
        let setup = self.clone();
        tauri::async_runtime::spawn(async move {
            let enabled = connections::load(&setup.data).is_ok_and(|saved| saved.engine_enabled);
            if enabled {
                let launch = {
                    let mut inner = setup.inner.lock().unwrap();
                    if inner.generation == 0 && !inner.exiting {
                        inner.requested_running = true;
                        true
                    } else {
                        false
                    }
                };
                if launch {
                    let _ = start_background(setup.clone(), false, Some(0)).await;
                }
            }

            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let action = {
                    let inner = setup.inner.lock().unwrap();
                    if inner.exiting {
                        return;
                    }
                    if !inner.requested_running
                        || inner.status.source_phase == "signing_in"
                        || inner.retry_at.is_some_and(|at| at > Instant::now())
                    {
                        None
                    } else if inner.status.phase == "ready"
                        && inner.engine.is_some()
                        && inner.status.source_phase != "signing_in"
                    {
                        inner
                            .status
                            .endpoint
                            .clone()
                            .zip(inner.control_token.clone())
                            .map(|(endpoint, token)| (inner.generation, Some((endpoint, token))))
                    } else if inner.status.phase == "error" && inner.engine.is_none() {
                        Some((inner.generation, None))
                    } else {
                        None
                    }
                };
                if let Some((generation, control)) = action {
                    if let Some((endpoint, token)) = control {
                        if let Err(error) =
                            apply_pending(&setup, generation, &endpoint, &token).await
                        {
                            setup.apply_failed(generation, &error);
                        }
                    } else {
                        let _ = start_background(setup.clone(), false, Some(generation)).await;
                    }
                }
            }
        });
    }

    fn apply_failed(&self, generation: u64, error: &str) {
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != generation || !inner.requested_running {
            return;
        }

        inner.retry_attempts = inner.retry_attempts.saturating_add(1).min(5);
        inner.retry_at = Some(Instant::now() + Duration::from_secs(1 << inner.retry_attempts));
        inner.status.source_apply_error = Some(error.into());
        inner.status.sources_state = "error".into();
    }

    fn stop_engine(&self) {
        let children = {
            let mut inner = self.inner.lock().unwrap();
            inner.requested_running = false;
            inner.retry_at = None;
            inner.generation += 1;
            inner.cancel.notify_one();
            inner.status.phase = "idle".into();
            inner.status.error = None;
            inner.status.message = None;
            inner.status.endpoint = None;
            inner.status.models.clear();
            inner.status.connection_id = None;
            inner.status.source_apply_error = None;
            inner.status.sources_state = "current".into();
            inner.control_token = None;
            inner.engine.take().into_iter().collect()
        };
        stop_children(children);
    }

    fn cancel_login(&self) {
        let children = {
            let mut inner = self.inner.lock().unwrap();
            inner.login_generation += 1;
            inner.login_cancel.notify_one();
            inner.status.source_phase = "idle".into();
            inner.status.source_error = None;
            inner.status.source_message = None;
            inner.status.sign_in_url = None;
            inner.status.code = None;
            inner.sign_in.take().into_iter().collect()
        };
        stop_children(children);
    }

    fn fail(&self, generation: u64, error: &str) -> Option<u64> {
        let (next, children) = {
            let mut inner = self.inner.lock().unwrap();
            if inner.generation != generation {
                return None;
            }
            inner.generation += 1;
            inner.cancel.notify_one();
            let status = &mut inner.status;
            status.phase = "error".into();
            status.error = Some(error.into());
            status.message = None;
            status.endpoint = None;
            status.models.clear();
            status.connection_id = None;
            inner.control_token = None;
            (inner.generation, inner.engine.take().into_iter().collect())
        };
        stop_children(children);
        Some(next)
    }

    fn spawn(&self, generation: u64, mut command: Command, sign_in: bool) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        if (if sign_in {
            inner.login_generation
        } else {
            inner.generation
        }) != generation
        {
            return Err("Setup cancelled.".into());
        }
        let mut child = command.spawn().map_err(|_| {
            "Cannot start the bundled runtime. Check its installation and executable permissions."
        })?;
        if sign_in {
            providers::read_login_output(child.stdout.take(), self.clone(), generation);
            providers::read_login_output(child.stderr.take(), self.clone(), generation);
            inner.sign_in = Some(child);
        } else {
            inner.engine = Some(child);
            inner.status.engine_generation += 1;
        }
        Ok(())
    }

    fn process_exited(&self, generation: u64, sign_in: bool) -> Option<bool> {
        let mut inner = self.inner.lock().unwrap();
        if (if sign_in {
            inner.login_generation
        } else {
            inner.generation
        }) != generation
        {
            return Some(false);
        }
        let slot = if sign_in {
            &mut inner.sign_in
        } else {
            &mut inner.engine
        };
        let result = slot.as_mut()?.try_wait();
        match result {
            Ok(Some(exit)) => {
                *slot = None;
                Some(exit.success())
            }
            Err(_) => None,
            Ok(None) => None,
        }
    }

    pub fn shutdown(&self) {
        let children = {
            let mut inner = self.inner.lock().unwrap();
            inner.exiting = true;
            inner.requested_running = false;
            inner.generation += 1;
            inner.cancel.notify_one();
            inner.login_generation += 1;
            inner.login_cancel.notify_one();
            inner.status.phase = "idle".into();
            inner.status.error = None;
            inner.status.message = None;
            inner.status.endpoint = None;
            inner.status.sign_in_url = None;
            inner.status.code = None;
            inner.status.models.clear();
            inner.status.connection_id = None;
            inner.control_token = None;
            inner.status.sources_state = "current".into();
            inner.status.source_apply_error = None;
            inner.status.source_phase = "idle".into();
            inner.status.source_message = None;
            inner.status.source_error = None;
            [inner.engine.take(), inner.sign_in.take()]
                .into_iter()
                .flatten()
                .collect()
        };
        stop_children(children);
    }
}

fn search_path(runtime: &Path, cache: &Path) -> std::ffi::OsString {
    let mut paths = providers::cache_dirs(cache);
    paths.push(runtime.to_path_buf());
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path));
    }
    for variable in ["HOME", "USERPROFILE"] {
        if let Some(home) = std::env::var_os(variable).map(PathBuf::from) {
            paths.extend([
                home.join(".local/bin"),
                home.join(".bun/bin"),
                home.join(".npm-global/bin"),
            ]);
        }
    }
    paths.extend(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/Applications/Docker.app/Contents/Resources/bin",
        ]
        .map(PathBuf::from),
    );
    #[cfg(windows)]
    if let Some(programs) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
        paths.push(programs.join("Docker/Docker/resources/bin"));
    }
    std::env::join_paths(paths).unwrap_or_default()
}

fn stop_child(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }

    #[cfg(unix)]
    {
        // Only the tracked child PID receives SIGTERM; shared services are never stopped.
        let _ = Command::new("/bin/kill")
            .args(["-TERM", &child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let deadline = Instant::now() + Duration::from_secs(12);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    // shortcut: Windows uses owned-child termination; add graceful IPC when the engine exposes it.
    let _ = child.kill();
    let _ = child.wait();
}

fn stop_children(children: Vec<Child>) {
    for mut child in children {
        stop_child(&mut child);
    }
}

fn private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|_| "Cannot create the local runtime data folder.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot protect the local runtime data folder.")?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ports {
    postgres: u16,
    engine: u16,
}

fn free_port() -> Result<u16, String> {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|socket| socket.local_addr())
        .map(|address| address.port())
        .map_err(|_| "Cannot reserve a local engine port.".into())
}

fn engine_command(
    setup: &DesktopSetup,
    provider: &str,
    model: &str,
    api_key: Option<&str>,
    base: Option<&str>,
    dir: &Path,
    ports: &Ports,
) -> Result<Command, String> {
    let executable = setup
        .tool("knotra")
        .ok_or("The local engine is missing from this app. Install a complete Desktop package.")?;
    let mut command = setup.command(executable);
    command
        .arg("quickstart")
        .args([
            "--no-run",
            "--provider",
            provider,
            "--model",
            model,
            "--dir",
        ])
        .arg(dir)
        .args([
            "--listen",
            &format!("127.0.0.1:{}", ports.engine),
            "--postgres-port",
            &ports.postgres.to_string(),
        ]);
    if let Some(base) = base {
        command.args(["--base-url", base]);
    }
    if let Some(key) = api_key.filter(|key| !key.is_empty()) {
        command.env(
            if provider == "anthropic" {
                "ANTHROPIC_API_KEY"
            } else {
                "OPENAI_API_KEY"
            },
            key,
        );
    }
    command.current_dir(dir);
    Ok(command)
}

async fn docker_ready(setup: &DesktopSetup) -> bool {
    let Some(docker) = setup.tool("docker") else {
        return false;
    };
    let mut command = setup.command(docker);
    command
        .args(["info", "--format", "{{.OSType}}"])
        .stdout(Stdio::piped());
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(mut child) = command.spawn() else {
            return false;
        };
        let until = Instant::now() + Duration::from_secs(4);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    use std::io::Read;
                    let mut output = String::new();
                    if let Some(pipe) = child.stdout.take() {
                        let _ = pipe.take(32).read_to_string(&mut output);
                    }
                    return status.success() && output.trim() == "linux";
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

#[tauri::command]
pub async fn desktop_setup_status(setup: State<'_, DesktopSetup>) -> Result<SetupStatus, String> {
    let refresh = {
        let mut inner = setup.inner.lock().unwrap();
        let refresh = inner
            .docker_checked
            .is_none_or(|time| time.elapsed() > Duration::from_secs(15));
        if refresh {
            inner.docker_checked = Some(Instant::now());
        }
        refresh
    };
    if refresh {
        let ready = docker_ready(&setup).await;
        setup.inner.lock().unwrap().status.docker_ready = ready;
    }
    Ok(setup.snapshot())
}

#[tauri::command]
pub async fn desktop_setup_cancel(setup: State<'_, DesktopSetup>) -> Result<SetupStatus, String> {
    let owned = setup.inner.lock().unwrap().status.phase != "idle";
    let manager = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.stop_engine())
        .await
        .map_err(|_| "Cannot finish stopping the local setup.")?;
    let mut status = setup.snapshot();
    if owned {
        status.message =
            Some("Local setup stopped. Saved workflows and engine data are kept.".into());
    }
    Ok(status)
}

#[tauri::command]
pub async fn desktop_provider_sign_in_cancel(
    setup: State<'_, DesktopSetup>,
) -> Result<SetupStatus, String> {
    let manager = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.cancel_login())
        .await
        .map_err(|_| "Cannot cancel the account sign-in.")?;
    Ok(setup.snapshot())
}

fn managed_directory(
    root: &Path,
    saved: &mut connections::SavedSetup,
    allow_port_change: bool,
) -> Result<(PathBuf, Ports), String> {
    let adopting = saved.engine_directory.is_none();
    let directory = saved
        .engine_directory
        .clone()
        .or_else(|| {
            fs::read_dir(root)
                .ok()?
                .filter_map(Result::ok)
                .filter_map(|entry| {
                    let path = entry.path();
                    let modified = fs::metadata(path.join("desktop-ports.json"))
                        .ok()?
                        .modified()
                        .ok()?;
                    path.join("settings.json")
                        .is_file()
                        .then_some((modified, path))
                })
                .max_by_key(|(modified, _)| *modified)
                .map(|(_, path)| path)
        })
        .unwrap_or_else(|| root.join("managed"));
    private_dir(&directory)?;
    if adopting && directory.join("profile.json").is_file() {
        use std::io::Read;
        let profile: serde_json::Value = serde_json::from_reader(
            fs::File::open(directory.join("profile.json"))
                .map_err(|_| "Cannot read the existing engine profile.")?
                .take(8 * 1024 * 1024),
        )
        .map_err(|_| "The existing engine profile is invalid. Your data has not been changed.")?;
        let previous = &profile["spec"]["models"]["model_main"];
        saved.legacy_source_id = saved
            .connections
            .iter()
            .find(|source| {
                previous["provider"] == source.provider.replace('-', "_")
                    && previous["model"].as_str() == source.default_model.as_deref()
                    && previous["baseUrl"].as_str().unwrap_or("")
                        == source.base_url.as_deref().unwrap_or("")
            })
            .map(|source| source.id.clone());
    }

    let file = directory.join("desktop-ports.json");
    let mut ports: Ports = if file.exists() {
        serde_json::from_slice(
            &fs::read(&file).map_err(|_| "Cannot read saved local engine ports.")?,
        )
        .map_err(|_| "Saved local engine ports are invalid. Your data has not been changed.")?
    } else {
        let postgres = free_port()?;
        let mut engine = free_port()?;
        while engine == postgres {
            engine = free_port()?;
        }
        Ports { postgres, engine }
    };
    if ports.postgres == 0 || ports.engine == 0 || ports.postgres == ports.engine {
        return Err("Saved local engine ports are invalid. Your data has not been changed.".into());
    }
    if allow_port_change && TcpListener::bind(("127.0.0.1", ports.engine)).is_err() {
        ports.engine = free_port()?;
    }
    fs::write(file, serde_json::to_vec(&ports).unwrap())
        .map_err(|_| "Cannot save local engine ports.")?;
    saved.engine_directory = Some(directory.clone());
    Ok((directory, ports))
}

fn managed_command(
    setup: &DesktopSetup,
    sources: &[connections::SavedConnection],
    dir: &Path,
    ports: &Ports,
    credentials: &impl connections::Credentials,
    manifest_path: &Path,
) -> Result<(Command, Vec<connections::SavedConnection>, Vec<String>), String> {
    let primary = sources.first();
    let mut command = engine_command(
        setup,
        primary.map(|s| s.provider.as_str()).unwrap_or("codex"),
        primary
            .and_then(|s| s.default_model.as_deref())
            .unwrap_or("default"),
        None,
        primary.and_then(|s| s.base_url.as_deref()),
        dir,
        ports,
    )?;
    command.arg("--connections-file").arg(manifest_path);
    let mut available = Vec::new();
    let mut errors = Vec::new();
    for source in sources {
        match connections::key(source, credentials) {
            Ok(key) => {
                if let Some(key) = key {
                    command.env(connections::env_name(&source.id), key);
                }
                available.push(source.clone());
            }
            Err(error) => errors.push(error),
        }
    }
    Ok((command, available, errors))
}

fn launch_manifest_path(directory: &Path) -> PathBuf {
    directory.join(format!("desktop-models-{}.json", connections::source_id()))
}

pub(super) async fn control_request(
    endpoint: &str,
    token: &str,
    action: &str,
) -> Result<serde_json::Value, String> {
    let client = providers::http_client(Duration::from_secs(3))?;
    let response = client
        .post(format!("{endpoint}/v1/managed/{action}"))
        .bearer_auth(token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|_| "The local engine update control is temporarily unavailable.")?;
    if !response.status().is_success() {
        return Err("The local engine could not prepare a safe configuration update.".into());
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|_| "The local engine update response was interrupted.")?;
    if bytes.len() > 16384 {
        return Err("The local engine returned an invalid update response.".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "The local engine returned an invalid update response.".into())
}

async fn resume_admissions(
    setup: &DesktopSetup,
    generation: u64,
    endpoint: &str,
    token: &str,
) -> Result<bool, String> {
    let cancel = setup.inner.lock().unwrap().cancel.clone();
    let mut attempt = 0u32;
    loop {
        if !setup.current(generation) {
            return Ok(false);
        }
        if setup.process_exited(generation, false).is_some() {
            return Err(
                "The local engine stopped while resuming workflows. Saved configuration is kept."
                    .into(),
            );
        }
        if control_request(endpoint, token, "cancel-restart")
            .await
            .is_ok()
        {
            setup.update(generation, |status| {
                status.source_apply_error = None;
                status.sources_state = "current".into();
            });
            return Ok(setup.current(generation));
        }
        // Release may already have succeeded. Killing here could interrupt a newly admitted run.
        setup.update(generation, |status| {
            status.sources_state = "applying".into();
            status.source_apply_error = Some(
                "The local engine is resuming new workflows. Knotra is retrying automatically."
                    .into(),
            );
        });
        attempt = attempt.saturating_add(1).min(5);
        if cancellable(
            &cancel,
            tokio::time::sleep(Duration::from_secs(1 << (attempt - 1))),
        )
        .await
        .is_err()
        {
            return Ok(false);
        }
    }
}

async fn start_background(
    setup: DesktopSetup,
    explicit: bool,
    expected: Option<u64>,
) -> Result<SetupStatus, String> {
    let before = setup.inner.lock().unwrap().generation;
    let manager = setup.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        // Ordinary startup and crash recovery always restore the last admitted snapshot.
        start_engine(manager, explicit, expected, false)
    })
    .await
    .map_err(|_| "Cannot start the local engine.".to_owned())
    .and_then(|result| result);
    if let Err(error) = &result {
        let failed_start = {
            let inner = setup.inner.lock().unwrap();
            inner.generation == before
                && inner.engine.is_none()
                && inner.status.source_phase != "signing_in"
        };
        if failed_start {
            if let Some(generation) = setup.fail(before, error) {
                setup.apply_failed(generation, error);
            }
        }
    }
    result
}

async fn apply_pending(
    setup: &DesktopSetup,
    generation: u64,
    endpoint: &str,
    token: &str,
) -> Result<(), String> {
    let _control = setup.control.lock().await;
    if !setup.current(generation) {
        return Ok(());
    }
    let pending = {
        let _lock = setup.sources.lock().unwrap();
        let saved = connections::load(&setup.data)?;
        connections::pending(&saved)
    };
    if !pending {
        return Ok(());
    }

    let prepared = match control_request(endpoint, token, "prepare-restart").await {
        Ok(prepared) => prepared,
        Err(error) => {
            // A lost response can follow a successful freeze. Always try to release it.
            let _ = control_request(endpoint, token, "cancel-restart").await;
            return Err(error);
        }
    };
    if prepared["ready"] != true {
        return Ok(());
    }
    let manager = setup.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let (next, children) = {
            let _lock = manager.sources.lock().unwrap();
            if !manager.current(generation) {
                return Ok(());
            }
            let mut saved = connections::load(&manager.data)?;
            let errors = if saved
                .staged
                .as_ref()
                .is_some_and(|staged| staged.revision == saved.desired_revision)
            {
                vec![]
            } else {
                connections::stage_update(&manager.data, &mut saved, &connections::Keychain)?
            };
            let mut inner = manager.inner.lock().unwrap();
            if inner.generation != generation
                || !inner.requested_running
                || inner.status.source_phase == "signing_in"
            {
                return Ok(());
            }
            let (next, _, children) =
                DesktopSetup::begin_locked(&mut inner, "starting", "managed", None);
            inner.status.sources_state = "applying".into();
            inner.status.source_error = (!errors.is_empty()).then(|| errors.join(" "));
            inner.control_token = None;
            (next, children)
        };
        stop_children(children);
        if let Err(error) = start_engine(manager.clone(), false, Some(next), true) {
            if let Some(current) = manager.fail(next, &error) {
                manager.apply_failed(current, &error);
            }
            return Err(error);
        }
        Ok(())
    })
    .await
    .map_err(|_| "Cannot apply the saved connections.")?;
    if setup.current(generation) {
        // Preparation failures and cancellation leave the previous process usable.
        let mut release =
            Err("Cannot resume the local engine after preparing an update.".to_owned());
        for _ in 0..3 {
            release = control_request(endpoint, token, "cancel-restart")
                .await
                .map(|_| ());
            if release.is_ok() {
                break;
            }
        }
        release?;
    }
    result
}

fn start_engine(
    setup: DesktopSetup,
    explicit: bool,
    expected: Option<u64>,
    staged: bool,
) -> Result<SetupStatus, String> {
    let (request_generation, already_running) = {
        let mut inner = setup.inner.lock().unwrap();
        if inner.status.source_phase == "signing_in" {
            return Err(
                "Finish or cancel account sign-in before starting the local engine.".into(),
            );
        }
        if explicit {
            inner.requested_running = true;
            inner.status.source_apply_error = None;
            inner.retry_at = None;
        }
        (
            inner.generation,
            expected.is_some_and(|expected| expected != inner.generation)
                || inner.engine.is_some()
                || (inner.status.phase == "starting" && expected.is_none())
                || !inner.requested_running,
        )
    };
    if already_running {
        return Ok(setup.snapshot());
    }

    let (applied, dir, ports, errors, held) = {
        let _lock = setup.sources.lock().unwrap();
        let mut saved = connections::load(&setup.data)?;
        if !explicit && !saved.engine_enabled {
            return Ok(setup.snapshot());
        }
        let (dir, ports) =
            managed_directory(&setup.data, &mut saved, explicit || request_generation == 0)?;
        saved.engine_enabled = true;
        let mut errors = vec![];
        if saved.applied.is_none() {
            let (applied, missing) = connections::stage_applied(&saved, &connections::Keychain)?;
            errors = missing;
            connections::commit_applied(&setup.data, &mut saved, applied, &connections::Keychain)?;
        } else {
            connections::store(&setup.data, &saved)?;
        }
        let (applied, held) = connections::boot_snapshot(&saved, staged)?;
        (applied, dir, ports, errors, held)
    };
    let credentials = connections::AppliedCredentials {
        applied: &applied,
        credentials: &connections::Keychain,
    };
    let manifest_path = launch_manifest_path(&dir);
    let (mut command, sources, mut missing) = managed_command(
        &setup,
        &applied.connections,
        &dir,
        &ports,
        &credentials,
        &manifest_path,
    )?;
    missing.extend(mcp::configure_command(
        &mut command,
        &applied.mcp_connections,
        &credentials,
    ));
    if !missing.is_empty() {
        return Err(format!("Cannot restore the credentials used by unfinished workflows. Unlock the system credential store and retry. {}", missing.join(" ")));
    }

    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|_| "Cannot create the local engine control token.")?;
    let control_token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    command.env("KNOTRA_DESKTOP_CONTROL_TOKEN", &control_token);
    if held {
        command.env("KNOTRA_DESKTOP_HOLD_ADMISSION", "1");
    }

    let claimed = {
        let mut inner = setup.inner.lock().unwrap();
        if inner.generation != request_generation || !inner.requested_running {
            None
        } else {
            let result = DesktopSetup::begin_locked(&mut inner, "starting", "managed", None);
            inner.control_token = Some(control_token.clone());
            inner.status.source_error = (!errors.is_empty()).then(|| errors.join(" "));
            Some(result)
        }
    };
    let Some((generation, cancel, children)) = claimed else {
        return Ok(setup.snapshot());
    };
    let legacy_source_id = applied.legacy_source_id.clone();
    let mcp_sources = applied.mcp_connections.clone();
    let mcp_ids = applied.mcp_ids.clone();
    let background = setup.clone();
    tauri::async_runtime::spawn(async move {
        tauri::async_runtime::spawn_blocking(move || stop_children(children))
            .await
            .ok();
        let result: Result<(), String> = async {
            if !docker_ready(&background).await {
                return Err("Start Docker Desktop with Linux containers, then start the engine again. Docker Compose must be installed.".into());
            }
            background.update(generation, |status| {
                status.docker_ready = true;
                status.message = Some("Starting your local engine. Saved connections will be available to every block.".into());
            });
            if !background.current(generation) {
                return Ok(());
            }
            let mut manifest = connections::manifest(&sources, legacy_source_id.as_deref());
            mcp::manifest(&mut manifest, &mcp_sources, &mcp_ids);
            fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest).unwrap())
                .map_err(|_| "Cannot prepare the saved connections.")?;
            background.spawn(generation, command, false)?;
            let endpoint = format!("http://127.0.0.1:{}", ports.engine);
            let client = providers::http_client(Duration::from_secs(2))?;
            let until = Instant::now() + Duration::from_secs(20 * 60);
            loop {
                if !background.current(generation) {
                    return Ok(());
                }
                if background.process_exited(generation, false).is_some() {
                    return Err("The local engine could not start. Check Docker and available memory, then retry. Saved engine data is kept.".into());
                }
                if let Ok(response) = client.get(format!("{endpoint}/v1/info")).send().await {
                    if response.status().is_success() {
                        if let Ok(info) = response.json::<serde_json::Value>().await {
                            if info["protocol"] == "knotra.desktop/1" && info["engineId"].is_string() {
                                if held {
                                    let _control = background.control.lock().await;
                                    // A response on the retained port must belong to this held process.
                                    let owned = control_request(
                                        &endpoint,
                                        &control_token,
                                        "prepare-restart"
                                    )
                                    .await?;
                                    if owned["ready"] != true {
                                        return Err("The replacement engine could not confirm its held startup.".into());
                                    }
                                    let manager = background.clone();
                                    let applied = applied.clone();
                                    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
                                        let _lock = manager.sources.lock().unwrap();
                                        if !manager.current(generation) {
                                            return Err("Engine startup was cancelled.".into());
                                        }
                                        let mut saved = connections::load(&manager.data)?;
                                        connections::commit_staged(
                                            &manager.data,
                                            &mut saved,
                                            applied,
                                            &connections::Keychain
                                        )
                                    })
                                    .await
                                    .map_err(|_| "Cannot commit the connection update.")??;

                                    if !resume_admissions(
                                        &background,
                                        generation,
                                        &endpoint,
                                        &control_token
                                    )
                                    .await?
                                    {
                                        return Ok(());
                                    }
                                }
                                {
                                    let manager = background.clone();
                                    tauri::async_runtime::spawn_blocking(move || {
                                        let _lock = manager.sources.lock().unwrap();
                                        connections::cleanup_retired(
                                            &manager.data,
                                            &connections::Keychain
                                        );
                                    });
                                }
                                let pending = {
                                    let _lock = background.sources.lock().unwrap();
                                    let saved = connections::load(&background.data)?;
                                    connections::pending(&saved)
                                };
                                let mut inner = background.inner.lock().unwrap();
                                if inner.generation != generation {
                                    return Ok(());
                                }
                                if !pending {
                                    inner.retry_attempts = 0;
                                    inner.retry_at = None;
                                    inner.status.source_apply_error = None;
                                }
                                let status = &mut inner.status;
                                status.phase = "ready".into();
                                status.sources_state = if pending { "pending" } else { "current" }.into();
                                status.endpoint = Some(endpoint.clone());
                                status.message = Some("Local engine is ready. Choose connections in each block.".into());
                                break;
                            }
                        }
                    }
                }
                if Instant::now() > until {
                    return Err("Local engine setup timed out. Check Docker and available memory before retrying.".into());
                }
                if cancellable(&cancel, tokio::time::sleep(Duration::from_millis(250)))
                    .await
                    .is_err()
                {
                    return Ok(());
                }
            }
            loop {
                if cancellable(&cancel, tokio::time::sleep(Duration::from_secs(1)))
                    .await
                    .is_err()
                {
                    return Ok(());
                }
                if !background.current(generation) {
                    return Ok(());
                }
                if background.process_exited(generation, false).is_some() {
                    return Err("The local engine stopped. Check Docker and available memory, then restart it to resume saved work.".into());
                }
            }
        }
        .await;
        if let Err(error) = result {
            if let Some(current) = background.fail(generation, &error) {
                background.apply_failed(current, &error);
            }
        }
        let _ = fs::remove_file(manifest_path);
    });
    Ok(setup.snapshot())
}

#[tauri::command]
pub async fn desktop_engine_start(setup: State<'_, DesktopSetup>) -> Result<SetupStatus, String> {
    start_background(setup.inner().clone(), true, None).await
}

#[tauri::command]
pub async fn desktop_provider_sign_in(
    setup: State<'_, DesktopSetup>,
    provider: String,
) -> Result<SetupStatus, String> {
    providers::desktop_provider_sign_in(setup, provider).await
}

#[tauri::command]
pub async fn desktop_provider_models(
    setup: State<'_, DesktopSetup>,
    provider: String,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<Vec<providers::ProviderModel>, String> {
    let _ = setup;
    providers::models(&provider, api_key.as_deref(), base_url.as_deref()).await
}

#[tauri::command]
pub async fn desktop_open_dependency(
    app: tauri::AppHandle,
    dependency: String,
) -> Result<(), String> {
    let (name, url) = match dependency.as_str() {
        "docker" => ("Docker", "https://www.docker.com/products/docker-desktop/"),
        "ollama" => ("Ollama", "https://ollama.com/download"),
        _ => return Err("Choose Docker or Ollama.".into()),
    };
    #[cfg(target_os = "macos")]
    {
        let apps: &[&str] = if dependency == "docker" {
            &["/Applications/Docker.app", "/Applications/OrbStack.app"]
        } else {
            &["/Applications/Ollama.app"]
        };
        if let Some(path) = apps.iter().find(|path| Path::new(path).is_dir()) {
            return Command::new("/usr/bin/open")
                .args(["-a", path])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|_| format!("Cannot open {name}."))?
                .success()
                .then_some(())
                .ok_or_else(|| format!("Cannot open {name}."));
        }
    }

    #[cfg(target_os = "windows")]
    {
        let root = std::env::var_os(if dependency == "docker" {
            "ProgramFiles"
        } else {
            "LOCALAPPDATA"
        })
        .map(PathBuf::from);
        let executable = root.map(|root| {
            root.join(if dependency == "docker" {
                "Docker/Docker/Docker Desktop.exe"
            } else {
                "Programs/Ollama/ollama app.exe"
            })
        });
        if let Some(executable) = executable.filter(|path| path.is_file()) {
            use std::os::windows::process::CommandExt;
            let mut child = Command::new(executable)
                .creation_flags(0x08000000)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| format!("Cannot open {name}."))?;
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(());
        }
    }

    #[cfg(target_os = "linux")]
    if dependency == "docker" {
        if let Some(path) = [
            "/opt/docker-desktop/bin/docker-desktop",
            "/usr/bin/docker-desktop",
        ]
        .iter()
        .find(|path| Path::new(path).is_file())
        {
            let mut child = Command::new(path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| format!("Cannot open {name}."))?;
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(());
        }
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| format!("Cannot open the official {name} download page."))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    pub(crate) struct TempDir(pub PathBuf);
    impl TempDir {
        pub(crate) fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "knotra-setup-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    pub(crate) fn manager(root: &Path) -> DesktopSetup {
        DesktopSetup {
            inner: Arc::new(Mutex::new(Inner {
                status: SetupStatus {
                    phase: "idle".into(),
                    ..Default::default()
                },
                generation: 0,
                cancel: Arc::new(Notify::new()),
                engine: None,
                sign_in: None,
                docker_checked: None,
                login_generation: 0,
                login_cancel: Arc::new(Notify::new()),
                control_token: None,
                requested_running: false,
                exiting: false,
                retry_at: None,
                retry_attempts: 0,
            })),
            runtime: root.into(),
            cache: root.join("cache"),
            data: root.join("data"),
            search_path: std::env::join_paths([root]).unwrap(),
            sources: Arc::new(Mutex::new(())),
            control: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    #[test]
    fn keys_are_environment_only_and_arguments_are_not_shell_commands() {
        let root = TempDir::new();
        let setup = manager(&root.0);
        fs::write(
            root.0.join(if cfg!(windows) {
                "knotra.exe"
            } else {
                "knotra"
            }),
            [],
        )
        .unwrap();
        let key = "private-key;$(touch never-execute)";
        let cmd = engine_command(
            &setup,
            "openai-compatible",
            "org/model",
            Some(key),
            Some("https://provider.example/v1"),
            &root.0.join("space and $characters"),
            &Ports {
                postgres: 12345,
                engine: 12346,
            },
        )
        .unwrap();
        let args: Vec<_> = cmd
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args[0], "quickstart");
        assert!(args.contains(&"--no-run".into()));
        assert!(args.contains(&"org/model".into()));
        assert!(!args.iter().any(|arg| arg.contains(key)));
        assert!(cmd
            .get_envs()
            .any(|(name, value)| name == "OPENAI_API_KEY"
                && value == Some(std::ffi::OsStr::new(key))));
        assert!(!serde_json::to_string(&setup.snapshot())
            .unwrap()
            .contains(key));
    }

    #[test]
    fn failures_and_cancellation_prevent_stale_status_updates() {
        let root = TempDir::new();
        let setup = manager(&root.0);
        let (generation, _, _) = setup.begin("starting", "codex", Some("default"));
        setup.update(generation, |status| {
            status.models.push(providers::ProviderModel {
                id: "fixture".into(),
                name: "Fixture".into(),
            });
            status.connection_id = Some("model_main".into());
        });
        setup.fail(generation, "Check Docker and retry.");
        setup.update(generation, |status| status.phase = "ready".into());
        assert_eq!(setup.snapshot().phase, "error");
        assert!(setup.snapshot().models.is_empty());
        assert!(setup.snapshot().connection_id.is_none());
        setup.shutdown();
        assert_eq!(setup.snapshot().phase, "idle");
        assert!(setup.snapshot().error.is_none());
        assert!(!setup.current(generation));
    }

    #[test]
    fn managed_engine_adopts_existing_data_without_retargeting_legacy_workflows() {
        let root = TempDir::new();
        let legacy = root.0.join("previous-engine");
        fs::create_dir(&legacy).unwrap();
        fs::write(
            legacy.join("desktop-ports.json"),
            serde_json::to_vec(&Ports {
                postgres: free_port().unwrap(),
                engine: free_port().unwrap(),
            })
            .unwrap(),
        )
        .unwrap();
        fs::write(legacy.join("settings.json"), "saved-settings").unwrap();
        fs::write(legacy.join("kept-artifact"), "saved").unwrap();
        fs::write(
            legacy.join("profile.json"),
            r#"{"spec":{"models":{"model_main":{"provider":"ollama","model":"existing-model"}}}}"#,
        )
        .unwrap();
        let mut saved = connections::SavedSetup::default();
        saved.connections.push(connections::SavedConnection {
            id: "source_codex".into(),
            title: "Codex".into(),
            provider: "codex".into(),
            base_url: None,
            default_model: Some("default".into()),
            models: vec![],
            has_credential: false,
            revision: 0,
        });
        saved.legacy_source_id = Some("source_codex".into());
        let (dir, ports) = managed_directory(&root.0, &mut saved, true).unwrap();
        assert_eq!(dir, legacy);
        assert!(saved.legacy_source_id.is_none());
        let (same, again) = managed_directory(&root.0, &mut saved, true).unwrap();
        assert_eq!(same, dir);
        assert_eq!(again.postgres, ports.postgres);
        assert_eq!(again.engine, ports.engine);
        assert_eq!(
            fs::read_to_string(dir.join("kept-artifact")).unwrap(),
            "saved"
        );
        assert_eq!(
            fs::read_to_string(dir.join("settings.json")).unwrap(),
            "saved-settings"
        );
    }

    #[test]
    fn managed_port_conflicts_do_not_stop_or_adopt_another_process() {
        let root = TempDir::new();
        let mut saved = connections::SavedSetup::default();
        let (_, ports) = managed_directory(&root.0, &mut saved, true).unwrap();
        let listener = TcpListener::bind(("127.0.0.1", ports.engine)).unwrap();
        let (_, unchanged) = managed_directory(&root.0, &mut saved, false).unwrap();
        assert_eq!(
            unchanged.engine, ports.engine,
            "automatic updates must retain their transport endpoint"
        );
        let persisted: Ports = serde_json::from_slice(
            &fs::read(
                saved
                    .engine_directory
                    .as_ref()
                    .unwrap()
                    .join("desktop-ports.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(persisted.engine, ports.engine);
        let (_, updated) = managed_directory(&root.0, &mut saved, true).unwrap();
        assert_ne!(updated.engine, ports.engine);
        assert_eq!(updated.postgres, ports.postgres);
        assert!(listener.local_addr().is_ok());
    }

    #[test]
    fn sign_in_and_engine_lifecycles_do_not_cancel_each_other() {
        let root = TempDir::new();
        let setup = manager(&root.0);
        let (engine_generation, _, _) = setup.begin("starting", "managed", None);
        setup.update(engine_generation, |status| {
            status.phase = "ready".into();
            status.endpoint = Some("http://127.0.0.1:1234".into());
        });
        let (login_generation, _, children) = setup.begin_login("codex");
        assert!(children.is_empty());
        assert!(setup.current(engine_generation));
        assert!(setup.login_current(login_generation));
        setup.cancel_login();
        assert!(setup.current(engine_generation));
        assert!(!setup.login_current(login_generation));
        assert_eq!(
            setup.snapshot().endpoint.as_deref(),
            Some("http://127.0.0.1:1234")
        );
        let (login_generation, _, _) = setup.begin_login("claude");
        setup.stop_engine();
        assert!(setup.login_current(login_generation));
        assert_eq!(setup.snapshot().source_phase, "signing_in");
        setup.shutdown();
    }

    #[test]
    fn source_changes_are_pending_automatically_but_stop_suppresses_current_session_retries() {
        let root = TempDir::new();
        let setup = manager(&root.0);
        let mut saved = connections::SavedSetup::default();
        saved.engine_enabled = true;
        saved.applied = Some(connections::AppliedSetup {
            revision: 0,
            incomplete: false,
            connections: vec![],
            mcp_connections: vec![],
            mcp_ids: vec![],
            legacy_source_id: None,
            credential_entries: Default::default(),
        });
        connections::store(&setup.data, &saved).unwrap();
        let (generation, _, _) = setup.begin("starting", "managed", None);
        setup.inner.lock().unwrap().requested_running = true;
        assert_eq!(setup.snapshot().sources_state, "current");
        assert!(!setup.snapshot().restart_required);
        saved.desired_revision = 1;
        connections::store(&setup.data, &saved).unwrap();
        setup.sources_changed();
        assert_eq!(setup.snapshot().sources_state, "pending");
        setup.apply_failed(generation, "Cannot read the credential store.");
        assert!(setup.inner.lock().unwrap().retry_at.is_some());
        assert_eq!(setup.snapshot().sources_state, "error");
        setup.stop_engine();
        assert!(!setup.snapshot().restart_required);
        assert_eq!(setup.snapshot().sources_state, "pending");
        assert!(!setup.inner.lock().unwrap().requested_running);
        assert!(setup.inner.lock().unwrap().retry_at.is_none());
        setup.apply_failed(generation, "A stale error must not restore retries.");
        assert!(setup.snapshot().source_apply_error.is_none());
        assert!(setup.snapshot().configured);
        setup.shutdown();
        assert!(connections::load(&setup.data).unwrap().engine_enabled);
    }

    fn control_server(
        responses: Vec<&'static str>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{BufRead, Write};
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            responses
                .into_iter()
                .map(|body| {
                    let (mut socket, _) = listener.accept().unwrap();
                    socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                    let mut reader = std::io::BufReader::new(&socket);
                    let mut request = String::new();
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        if line == "\r\n" || line.is_empty() {
                            break;
                        }
                        request.push_str(&line);
                    }

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
        (endpoint, server)
    }

    fn pending_manager(root: &Path) -> DesktopSetup {
        let setup = manager(root);
        let mut saved = connections::SavedSetup::default();
        saved.engine_enabled = true;
        saved.desired_revision = 1;
        saved.applied = Some(connections::AppliedSetup {
            revision: 0,
            incomplete: false,
            connections: vec![],
            mcp_connections: vec![],
            mcp_ids: vec![],
            legacy_source_id: None,
            credential_entries: Default::default(),
        });
        connections::store(&setup.data, &saved).unwrap();
        setup.inner.lock().unwrap().requested_running = true;
        setup
    }

    #[test]
    fn busy_managed_control_keeps_existing_configuration_and_private_auth_out_of_status() {
        let root = TempDir::new();
        let setup = pending_manager(&root.0);
        let (endpoint, server) = control_server(vec![r#"{"ready":false,"activeRuns":2}"#]);
        setup.inner.lock().unwrap().control_token = Some("fixture-private-control-token".into());
        tauri::async_runtime::block_on(apply_pending(
            &setup,
            0,
            &endpoint,
            "fixture-private-control-token",
        ))
        .unwrap();
        assert!(setup.current(0));
        assert!(connections::load(&setup.data).unwrap().staged.is_none());
        assert_eq!(setup.snapshot().sources_state, "pending");
        assert!(!serde_json::to_string(&setup.snapshot())
            .unwrap()
            .contains("fixture-private-control-token"));
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("POST /v1/managed/prepare-restart HTTP/1.1"));
        assert!(requests[0].contains("authorization: Bearer fixture-private-control-token"));
        assert!(!requests[0].contains("Idempotency-Key"));
    }

    #[test]
    fn interrupted_prepare_response_attempts_to_release_a_possibly_frozen_engine() {
        let root = TempDir::new();
        let setup = pending_manager(&root.0);
        let (endpoint, server) = control_server(vec!["{interrupted", r#"{"accepted":true}"#]);
        assert!(tauri::async_runtime::block_on(apply_pending(
            &setup,
            0,
            &endpoint,
            "fixture-token"
        ))
        .is_err());
        let requests = server.join().unwrap();
        assert!(requests[1].starts_with("POST /v1/managed/cancel-restart HTTP/1.1"));
        assert!(setup.current(0));
        assert_eq!(
            connections::load(&setup.data)
                .unwrap()
                .applied
                .unwrap()
                .revision,
            0
        );
    }

    #[test]
    fn stale_process_failure_cannot_mark_a_new_engine_for_retry() {
        let root = TempDir::new();
        let setup = manager(&root.0);
        let (old, _, _) = setup.begin("starting", "managed", None);
        let (new, _, _) = setup.begin("starting", "managed", None);
        setup.inner.lock().unwrap().requested_running = true;
        assert!(setup.fail(old, "An old monitor failed.").is_none());
        assert!(setup.current(new));
        assert!(setup.inner.lock().unwrap().retry_at.is_none());
        assert!(setup.snapshot().source_apply_error.is_none());
    }

    #[test]
    fn ambiguous_release_retries_without_killing_the_owned_engine() {
        let root = TempDir::new();
        let setup = manager(&root.0);
        struct Cleanup(DesktopSetup);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.0.shutdown();
            }
        }
        let _cleanup = Cleanup(setup.clone());
        let (generation, _, _) = setup.begin("starting", "managed", None);
        setup.inner.lock().unwrap().requested_running = true;
        let mut command = setup.command(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "setup::tests::managed_child_fixture",
                "--nocapture",
            ])
            .env("KNOTRA_SETUP_CHILD_TEST", "1")
            .env("KNOTRA_SETUP_CHILD_MARKER", root.0.join("owned-child"));
        setup.spawn(generation, command, false).unwrap();
        setup.inner.lock().unwrap().status.source_phase = "signing_in".into();
        assert!(
            tauri::async_runtime::block_on(start_background(setup.clone(), true, None)).is_err()
        );
        assert!(setup.current(generation));
        assert!(setup.inner.lock().unwrap().engine.is_some());
        setup.inner.lock().unwrap().status.source_phase = "idle".into();
        // An invalid response represents a completed release whose response was lost.
        let (endpoint, server) = control_server(vec!["{lost", "{lost", r#"{"accepted":true}"#]);
        tauri::async_runtime::block_on(async {
            let background = setup.clone();
            let resume = tauri::async_runtime::spawn(async move {
                resume_admissions(&background, generation, &endpoint, "fixture-token").await
            });
            let until = Instant::now() + Duration::from_secs(2);
            while setup.snapshot().source_apply_error.is_none() && Instant::now() < until {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(setup.snapshot().source_apply_error.is_some());
            assert!(setup.current(generation));
            assert!(setup
                .inner
                .lock()
                .unwrap()
                .engine
                .as_mut()
                .unwrap()
                .try_wait()
                .unwrap()
                .is_none());
            assert!(resume.await.unwrap().unwrap());
        });
        assert!(setup.snapshot().source_apply_error.is_none());
        assert!(setup
            .inner
            .lock()
            .unwrap()
            .engine
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none());
        assert_eq!(server.join().unwrap().len(), 3);
    }

    #[test]
    fn each_launch_binds_an_immutable_manifest_even_after_a_stale_write() {
        let root = TempDir::new();
        let setup = manager(&root.0);
        fs::write(
            root.0.join(if cfg!(windows) {
                "knotra.exe"
            } else {
                "knotra"
            }),
            [],
        )
        .unwrap();
        let first = launch_manifest_path(&root.0);
        let latest = launch_manifest_path(&root.0);
        assert_ne!(first, latest);
        let source = |id: &str, provider: &str| connections::SavedConnection {
            id: id.into(),
            title: provider.into(),
            provider: provider.into(),
            base_url: None,
            models: vec![],
            default_model: Some("default".into()),
            has_credential: false,
            revision: 0,
        };
        let ports = Ports {
            engine: 12345,
            postgres: 12346,
        };
        let (old_command, _, _) = managed_command(
            &setup,
            &[source("source_old", "codex")],
            &root.0,
            &ports,
            &connections::Keychain,
            &first,
        )
        .unwrap();
        let (new_command, _, _) = managed_command(
            &setup,
            &[source("source_new", "claude")],
            &root.0,
            &ports,
            &connections::Keychain,
            &latest,
        )
        .unwrap();
        fs::write(&latest, "new-model-manifest").unwrap();
        // The cancelled task can finish writing its own file after the new launch was prepared.
        fs::write(&first, "stale-model-manifest").unwrap();
        assert_eq!(new_command.get_args().last(), Some(latest.as_os_str()));
        assert_eq!(old_command.get_args().last(), Some(first.as_os_str()));
        assert_eq!(fs::read_to_string(&latest).unwrap(), "new-model-manifest");
        assert!(!latest.to_string_lossy().contains("fixture-token"));
    }

    #[test]
    fn managed_child_fixture() {
        if std::env::var_os("KNOTRA_SETUP_CHILD_TEST").is_some() {
            fs::write(
                std::env::var_os("KNOTRA_SETUP_CHILD_MARKER").unwrap(),
                "started",
            )
            .unwrap();
            loop {
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    }

    #[test]
    fn shutdown_reaps_only_its_tracked_child() {
        let root = TempDir::new();
        let setup = manager(&root.0);
        let marker = root.0.join("started");
        let (generation, _, _) = setup.begin("starting", "codex", Some("default"));
        let mut command = setup.command(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "setup::tests::managed_child_fixture",
                "--nocapture",
            ])
            .env("KNOTRA_SETUP_CHILD_TEST", "1")
            .env("KNOTRA_SETUP_CHILD_MARKER", &marker);
        setup.spawn(generation, command, false).unwrap();
        let until = Instant::now() + Duration::from_secs(5);
        while !marker.exists() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(marker.exists(), "controlled test child did not start");
        setup.shutdown();
        assert!(setup.inner.lock().unwrap().engine.is_none());
        assert_eq!(setup.snapshot().phase, "idle");
    }

    #[test]
    fn cancellation_interrupts_pending_io() {
        let cancel = Notify::new();
        cancel.notify_one();
        let result =
            tauri::async_runtime::block_on(cancellable(&cancel, std::future::pending::<()>()));
        assert_eq!(result.unwrap_err(), "Setup cancelled.");
    }
}
