use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{body::Incoming, service::service_fn, Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    convert::Infallible,
    fs::{self, File, OpenOptions},
    future::Future,
    io::Write,
    net::TcpListener,
    path::PathBuf,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, State};
use tokio::sync::{oneshot, Notify, Semaphore};

const PROTOCOL: &str = "knotra.desktop-control/1";
const MAX_BYTES: usize = 8 * 1024 * 1024;
const RECEIPT_BYTES: usize = 64 * 1024 * 1024;
const MAX_RECEIPTS: usize = 1024;
const FRONTEND_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlError {
    pub code: String,
    pub message: String,
}
type Result<T> = std::result::Result<T, ControlError>;
type Outcome = Result<Value>;
type Dispatch = Arc<
    dyn Fn(Arc<Bridge>, String, Value) -> Pin<Box<dyn Future<Output = Outcome> + Send>>
        + Send
        + Sync,
>;

impl ControlError {
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    fn invalid() -> Self {
        Self::new("invalid", "The control request is invalid.")
    }
    fn disabled() -> Self {
        Self::new(
            "disabled",
            "Open Knotra and wait for the workspace to finish loading.",
        )
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlStatus {
    protocol: &'static str,
    available: bool,
    frontend_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    config: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    descriptor_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub struct DesktopControl {
    bridge: Option<Arc<Bridge>>,
    error: Option<String>,
}
struct Receipt {
    fingerprint: [u8; 32],
    outcome: Mutex<Option<Outcome>>,
    changed: Notify,
}
#[derive(Default)]
struct Receipts {
    entries: HashMap<String, Arc<Receipt>>,
    bytes: usize,
}
struct Bridge {
    endpoint: String,
    token: String,
    descriptor: PathBuf,
    command: PathBuf,
    _lock: File,
    stopped: AtomicBool,
    ready: AtomicBool,
    stop: Notify,
    pending: Mutex<HashMap<String, oneshot::Sender<Outcome>>>,
    receipts: Mutex<Receipts>,
    dispatch: Dispatch,
    sequence: AtomicU64,
}

impl DesktopControl {
    pub fn new(app: &tauri::AppHandle) -> Self {
        let result = (|| {
            let data = app.path().app_data_dir().map_err(|_| {
                ControlError::new("disabled", "Cannot locate the desktop control settings.")
            })?;
            let command = app
                .state::<crate::setup::DesktopSetup>()
                .tool("knotra")
                .ok_or_else(|| {
                    ControlError::new("disabled", "The bundled engine is unavailable.")
                })?;
            let app = app.clone();
            let dispatch: Dispatch = Arc::new(move |bridge, operation, arguments| {
                let app = app.clone();
                Box::pin(async move { dispatch(&app, &bridge, &operation, arguments).await })
            });
            start(data, command, dispatch)
        })();
        match result {
            Ok(bridge) => Self {
                bridge: Some(bridge),
                error: None,
            },
            Err(error) => Self {
                bridge: None,
                error: Some(error.message),
            },
        }
    }

    fn status(&self) -> ControlStatus {
        let available = self
            .bridge
            .as_ref()
            .is_some_and(|bridge| !bridge.stopped.load(Ordering::SeqCst));
        let descriptor = self
            .bridge
            .as_ref()
            .filter(|_| available)
            .map(|bridge| bridge.descriptor.to_string_lossy().into_owned());
        let command = self
            .bridge
            .as_ref()
            .filter(|_| available)
            .map(|bridge| bridge.command.to_string_lossy().into_owned());
        let args = descriptor.as_ref().map(|descriptor| {
            vec![
                "mcp".into(),
                "serve".into(),
                "--desktop".into(),
                "--bridge-file".into(),
                descriptor.clone(),
            ]
        });
        let config = command.as_ref().zip(args.as_ref()).map(
            |(command, args)| json!({"mcpServers":{"knotra":{"command":command,"args":args}}}),
        );
        ControlStatus {
            protocol: PROTOCOL,
            available,
            frontend_ready: self
                .bridge
                .as_ref()
                .is_some_and(|bridge| bridge.ready.load(Ordering::SeqCst)),
            command,
            args,
            config,
            descriptor_path: descriptor,
            error: self.error.clone(),
        }
    }

    pub fn shutdown(&self) {
        if let Some(bridge) = &self.bridge {
            bridge.shutdown();
        }
    }
}

fn random_token() -> Result<String> {
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|_| {
        ControlError::new("disabled", "Cannot create the desktop control credential.")
    })?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn start(data: PathBuf, command: PathBuf, dispatch: Dispatch) -> Result<Arc<Bridge>> {
    fs::create_dir_all(&data)
        .map_err(|_| ControlError::new("disabled", "Cannot prepare desktop control settings."))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).map_err(|_| {
            ControlError::new("disabled", "Cannot protect desktop control settings.")
        })?;
    }
    let lock_path = data.join("desktop-control.lock");
    if fs::symlink_metadata(&lock_path)
        .is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err(ControlError::new(
            "disabled",
            "Desktop control lock is invalid.",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32);
    }
    let lock = options
        .open(lock_path)
        .map_err(|_| ControlError::new("disabled", "Cannot open the desktop control lock."))?;
    lock.try_lock().map_err(|_| {
        ControlError::new(
            "busy",
            "Desktop control is already owned by another Knotra app instance.",
        )
    })?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|_| ControlError::new("disabled", "Cannot start local desktop control."))?;
    listener
        .set_nonblocking(true)
        .map_err(|_| ControlError::new("disabled", "Cannot start local desktop control."))?;
    let endpoint = format!(
        "http://{}",
        listener
            .local_addr()
            .map_err(|_| ControlError::new("disabled", "Cannot locate desktop control."))?
    );
    let descriptor = data.join("desktop-control.json");
    let token = random_token()?;
    let temporary = data.join(format!(".desktop-control-{}.tmp", &random_token()?[..16]));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary).map_err(|_| {
            ControlError::new(
                "disabled",
                "Cannot save desktop control discovery settings.",
            )
        })?;
        file.write_all(
            &serde_json::to_vec(&json!({"protocol":PROTOCOL,"endpoint":endpoint,"token":token}))
                .unwrap(),
        )
        .and_then(|_| file.sync_all())
        .map_err(|_| {
            ControlError::new(
                "disabled",
                "Cannot save desktop control discovery settings.",
            )
        })?;
        fs::rename(&temporary, &descriptor).map_err(|_| {
            ControlError::new(
                "disabled",
                "Cannot publish desktop control discovery settings.",
            )
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    let bridge = Arc::new(Bridge {
        endpoint,
        token,
        descriptor,
        command,
        _lock: lock,
        stopped: AtomicBool::new(false),
        ready: AtomicBool::new(false),
        stop: Notify::new(),
        pending: Mutex::new(HashMap::new()),
        receipts: Mutex::new(Receipts::default()),
        dispatch,
        sequence: AtomicU64::new(0),
    });
    let background = bridge.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
            background.shutdown();
            return;
        };
        let connections = Arc::new(Semaphore::new(16));
        loop {
            if background.stopped.load(Ordering::SeqCst) {
                return;
            }
            let accept = listener.accept();
            let stop = background.stop.notified();
            futures_util::pin_mut!(accept, stop);
            let accepted = match futures_util::future::select(accept, stop).await {
                futures_util::future::Either::Left((accepted, _)) => accepted,
                _ => return,
            };
            let Ok((stream, peer)) = accepted else {
                continue;
            };
            if !peer.ip().is_loopback() {
                continue;
            }
            let Ok(permit) = connections.clone().try_acquire_owned() else {
                continue;
            };
            let bridge = background.clone();
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                let service = service_fn(move |request| http_request(bridge.clone(), request));
                let _ = hyper::server::conn::http1::Builder::new()
                    .keep_alive(false)
                    .max_headers(32)
                    .max_buf_size(16 * 1024)
                    .timer(TokioTimer::new())
                    .header_read_timeout(Duration::from_secs(5))
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    Ok(bridge)
}

impl Bridge {
    fn shutdown(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        self.stop.notify_waiters();
        self.ready.store(false, Ordering::SeqCst);
        for (_, reply) in self.pending.lock().unwrap().drain() {
            let _ = reply.send(Err(ControlError::disabled()));
        }
        // Only this owner can write the descriptor while the file lock is held.
        let _ = fs::remove_file(&self.descriptor);
    }

    async fn forward<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        operation: &str,
        arguments: Value,
    ) -> Outcome {
        if !self.ready.load(Ordering::SeqCst) || self.stopped.load(Ordering::SeqCst) {
            return Err(ControlError::disabled());
        }
        let id = format!(
            "control_{}_{}",
            self.sequence.fetch_add(1, Ordering::Relaxed),
            &random_token()?[..16]
        );
        let (send, receive) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), send);
        if app
            .emit(
                "knotra-control-request",
                json!({"id":id,"operation":operation,"arguments":arguments}),
            )
            .is_err()
        {
            self.pending.lock().unwrap().remove(&id);
            return Err(ControlError::disabled());
        }
        let result = tokio::time::timeout(FRONTEND_TIMEOUT, receive).await;
        self.pending.lock().unwrap().remove(&id);
        match result { Ok(Ok(outcome)) => outcome, _ => Err(ControlError::new("timeout", "Knotra did not finish the request in time. Inspect the app before retrying a mutation with a new request ID.")) }
    }

    async fn invoke(
        self: &Arc<Self>,
        operation: String,
        arguments: Value,
        request_id: Option<String>,
    ) -> Outcome {
        let mutation = is_mutation(&operation, &arguments)?;
        if !mutation {
            return (self.dispatch)(self.clone(), operation, arguments).await;
        }
        let id = request_id
            .filter(|id| {
                if operation == "engine_call" {
                    valid_operation_id(id)
                } else {
                    valid_request_id(id)
                }
            })
            .ok_or_else(|| {
                ControlError::new(
                    "invalid",
                    "Mutating control requests require a stable X-Knotra-Request-Id.",
                )
            })?;
        let mut hash = Sha256::new();
        hash.update(operation.as_bytes());
        hash.update([0]);
        hash.update(serde_json::to_vec(&arguments).unwrap());
        let fingerprint: [u8; 32] = hash.finalize().into();
        let (receipt, created) = {
            let mut receipts = self.receipts.lock().unwrap();
            if let Some(receipt) = receipts.entries.get(&id) {
                if receipt.fingerprint != fingerprint {
                    return Err(ControlError::new(
                        "conflict",
                        "This request ID already belongs to another operation.",
                    ));
                }
                (receipt.clone(), false)
            } else {
                if receipts.entries.len() >= MAX_RECEIPTS
                    || receipts.bytes + MAX_BYTES > RECEIPT_BYTES
                {
                    return Err(ControlError::new("busy", "Desktop control receipt capacity is full. Finish this session before starting more mutations."));
                }
                let receipt = Arc::new(Receipt {
                    fingerprint,
                    outcome: Mutex::new(None),
                    changed: Notify::new(),
                });
                receipts.bytes += MAX_BYTES;
                receipts.entries.insert(id, receipt.clone());
                (receipt, true)
            }
        };
        if created {
            let bridge = self.clone();
            let receipt = receipt.clone();
            // Own the task independently of the HTTP connection; a disconnected client must not repeat it.
            tauri::async_runtime::spawn(async move {
                let mut outcome = (bridge.dispatch)(bridge.clone(), operation, arguments).await;
                let mut bytes = serde_json::to_vec(&wire(&outcome)).unwrap().len();
                if bytes > MAX_BYTES {
                    outcome = Err(ControlError::new("limit", "The operation finished but its result exceeds the desktop control size limit. Inspect the app before retrying."));
                    bytes = serde_json::to_vec(&wire(&outcome)).unwrap().len();
                }
                bridge.receipts.lock().unwrap().bytes -= MAX_BYTES - bytes;
                *receipt.outcome.lock().unwrap() = Some(outcome);
                receipt.changed.notify_waiters();
            });
        }
        loop {
            let changed = receipt.changed.notified();
            if let Some(outcome) = receipt.outcome.lock().unwrap().clone() {
                return outcome;
            }
            changed.await;
        }
    }
}

fn valid_request_id(id: &str) -> bool {
    (8..=128).contains(&id.len())
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}

fn valid_operation_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}

fn is_mutation(operation: &str, arguments: &Value) -> Result<bool> {
    if !arguments.is_object() {
        return Err(ControlError::invalid());
    }
    match operation {
        "app_status"
        | "artifact_download"
        | "pipeline_list"
        | "pipeline_get"
        | "pipeline_validate"
        | "model_source_list"
        | "model_source_catalog"
        | "model_source_sign_in_status"
        | "mcp_server_list"
        | "mcp_server_discover"
        | "engine_status" => Ok(false),
        "pipeline_create"
        | "pipeline_update"
        | "pipeline_delete"
        | "pipeline_publish"
        | "app_navigate"
        | "model_source_save"
        | "model_source_refresh"
        | "model_source_remove"
        | "model_source_sign_in"
        | "model_source_sign_in_cancel"
        | "mcp_server_save"
        | "mcp_server_refresh"
        | "mcp_server_remove"
        | "engine_start"
        | "engine_stop"
        | "engine_connect"
        | "engine_disconnect" => Ok(true),
        "engine_call" => {
            let call: crate::backend::Call =
                serde_json::from_value(arguments.clone()).map_err(|_| ControlError::invalid())?;
            let canonical = serde_json::to_value(&call).map_err(|_| ControlError::invalid())?;
            if arguments
                .as_object()
                .unwrap()
                .keys()
                .any(|key| canonical.get(key).is_none())
            {
                return Err(ControlError::invalid());
            }
            Ok(matches!(
                call,
                crate::backend::Call::Publish { .. }
                    | crate::backend::Call::Start { .. }
                    | crate::backend::Call::Cancel { .. }
                    | crate::backend::Call::Respond { .. }
                    | crate::backend::Call::Resume { .. }
                    | crate::backend::Call::Resolve { .. }
                    | crate::backend::Call::Upload { .. }
            ))
        }
        _ => Err(ControlError::new(
            "not_found",
            "Unknown desktop control operation.",
        )),
    }
}

fn wire(outcome: &Outcome) -> Value {
    match outcome {
        Ok(result) => json!({"result":result}),
        Err(error) => json!({"error":error}),
    }
}
fn response(status: StatusCode, outcome: Outcome) -> Response<Full<Bytes>> {
    let mut bytes = serde_json::to_vec(&wire(&outcome)).unwrap();
    if bytes.len() > MAX_BYTES {
        bytes = serde_json::to_vec(&wire(&Err(ControlError::new(
            "limit",
            "The desktop control response exceeds 8 MiB.",
        ))))
        .unwrap();
    }
    Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .header("Cache-Control", "no-store")
        .header("Connection", "close")
        .body(Full::new(Bytes::from(bytes)))
        .unwrap()
}

async fn http_request(
    bridge: Arc<Bridge>,
    request: Request<Incoming>,
) -> std::result::Result<Response<Full<Bytes>>, Infallible> {
    let deny = |code, message| {
        Ok(response(
            StatusCode::UNAUTHORIZED,
            Err(ControlError::new(code, message)),
        ))
    };
    if request.headers().contains_key("origin")
        || request
            .headers()
            .get("host")
            .and_then(|value| value.to_str().ok())
            != bridge.endpoint.strip_prefix("http://")
    {
        return deny(
            "invalid",
            "Browser and foreign-host control requests are not accepted.",
        );
    }
    let expected = format!("Bearer {}", bridge.token);
    let auth = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let valid_auth = auth.len() == expected.len()
        && auth
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |different, (a, b)| different | (a ^ b))
            == 0;
    if !valid_auth || request.headers().get_all("authorization").iter().count() != 1 {
        return deny(
            "unauthorized",
            "The desktop control credential is unavailable or expired.",
        );
    }
    if bridge.stopped.load(Ordering::SeqCst) {
        return Ok(response(
            StatusCode::SERVICE_UNAVAILABLE,
            Err(ControlError::disabled()),
        ));
    }
    if request.method() != Method::POST || request.uri().query().is_some() {
        return Ok(response(
            StatusCode::NOT_FOUND,
            Err(ControlError::new(
                "not_found",
                "Unknown desktop control route.",
            )),
        ));
    }
    let Some(operation) = request
        .uri()
        .path()
        .strip_prefix("/v1/tools/")
        .filter(|operation| !operation.contains('/') && !operation.is_empty())
        .map(str::to_owned)
    else {
        return Ok(response(
            StatusCode::NOT_FOUND,
            Err(ControlError::new(
                "not_found",
                "Unknown desktop control route.",
            )),
        ));
    };
    let request_id = request
        .headers()
        .get("x-knotra-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = match tokio::time::timeout(
        Duration::from_secs(5),
        Limited::new(request.into_body(), MAX_BYTES).collect(),
    )
    .await
    {
        Ok(Ok(body)) => body.to_bytes(),
        _ => {
            return Ok(response(
                StatusCode::BAD_REQUEST,
                Err(ControlError::new(
                    "limit",
                    "The control body was interrupted or exceeds 8 MiB.",
                )),
            ))
        }
    };
    let arguments: Value = match serde_json::from_slice(&body) {
        Ok(arguments) => arguments,
        Err(_) => {
            return Ok(response(
                StatusCode::BAD_REQUEST,
                Err(ControlError::invalid()),
            ))
        }
    };
    let outcome = bridge.invoke(operation, arguments, request_id).await;
    Ok(response(StatusCode::OK, outcome))
}

fn parse<T: for<'a> Deserialize<'a>>(arguments: Value) -> Result<T> {
    serde_json::from_value(arguments).map_err(|_| ControlError::invalid())
}
fn source_error(message: String) -> ControlError {
    if message.contains("changed since") || message.contains("changed while") {
        ControlError::new(
            "conflict",
            "The connection changed. Reload the source list and use its latest revision.",
        )
    } else if message.contains("no longer exists") || message.contains("was removed") {
        ControlError::new("not_found", "The connection no longer exists.")
    } else {
        ControlError::new(
            "setup",
            "The connection operation could not finish. Check its settings in Knotra.",
        )
    }
}

async fn dispatch<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    bridge: &Arc<Bridge>,
    operation: &str,
    arguments: Value,
) -> Outcome {
    use crate::setup::{self, connections, mcp};
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Empty {}
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Id {
        id: String,
        expected_revision: u64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Credentials {
        provider: String,
        api_key: Option<String>,
        base_url: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ModelSave {
        id: Option<String>,
        title: Option<String>,
        provider: String,
        api_key: Option<String>,
        base_url: Option<String>,
        model: Option<String>,
        expected_revision: Option<u64>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Provider {
        provider: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct McpDiscover {
        id: Option<String>,
        url: String,
        token: Option<String>,
        clear_token: Option<bool>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct McpSave {
        id: Option<String>,
        title: Option<String>,
        url: String,
        token: Option<String>,
        clear_token: Option<bool>,
        allowed_tools: Vec<String>,
        expected_revision: Option<u64>,
    }
    let result = match operation {
        "model_source_list" => {
            let _: Empty = parse(arguments)?;
            json!({"connections":connections::desktop_connections_list(app.state()).await.map_err(source_error)?})
        }
        "model_source_catalog" => {
            let input: Credentials = parse(arguments)?;
            json!({"items":setup::desktop_provider_models(app.state(),input.provider,input.api_key,input.base_url).await.map_err(source_error)?})
        }
        "model_source_save" => {
            let input: ModelSave = parse(arguments)?;
            if input.id.is_some() && input.expected_revision.is_none() {
                return Err(ControlError::invalid());
            }
            json!({"connection":connections::desktop_connection_save(app.state(),input.id,input.title,input.provider,input.api_key,input.base_url,input.model,input.expected_revision).await.map_err(source_error)?})
        }
        "model_source_refresh" => {
            let input: Id = parse(arguments)?;
            json!({"connection":connections::desktop_connection_refresh(app.state(),input.id,Some(input.expected_revision)).await.map_err(source_error)?})
        }
        "model_source_remove" => {
            let input: Id = parse(arguments)?;
            json!({"connections":connections::desktop_connection_remove(app.state(),input.id,Some(input.expected_revision)).await.map_err(source_error)?})
        }
        "model_source_sign_in" => {
            let input: Provider = parse(arguments)?;
            json!({"status":setup::desktop_provider_sign_in(app.state(),input.provider).await.map_err(source_error)?})
        }
        "model_source_sign_in_status" => {
            let _: Empty = parse(arguments)?;
            json!({"status":setup::desktop_setup_status(app.state()).await.map_err(source_error)?})
        }
        "model_source_sign_in_cancel" => {
            let _: Empty = parse(arguments)?;
            json!({"status":setup::desktop_provider_sign_in_cancel(app.state()).await.map_err(source_error)?})
        }
        "mcp_server_list" => {
            let _: Empty = parse(arguments)?;
            json!({"connections":mcp::desktop_mcp_connections_list(app.state()).await.map_err(source_error)?})
        }
        "mcp_server_discover" => {
            let input: McpDiscover = parse(arguments)?;
            json!({"items":mcp::desktop_mcp_tools(app.state(),input.url,input.token,input.id,input.clear_token).await.map_err(source_error)?})
        }
        "mcp_server_save" => {
            let input: McpSave = parse(arguments)?;
            if input.id.is_some() && input.expected_revision.is_none() {
                return Err(ControlError::invalid());
            }
            json!({"connection":mcp::desktop_mcp_connection_save(app.state(),input.id,input.title,input.url,input.token,input.clear_token,input.allowed_tools,input.expected_revision).await.map_err(source_error)?})
        }
        "mcp_server_refresh" => {
            let input: Id = parse(arguments)?;
            json!({"connection":mcp::desktop_mcp_connection_refresh(app.state(),input.id,Some(input.expected_revision)).await.map_err(source_error)?})
        }
        "mcp_server_remove" => {
            let input: Id = parse(arguments)?;
            json!({"connections":mcp::desktop_mcp_connection_remove(app.state(),input.id,Some(input.expected_revision)).await.map_err(source_error)?})
        }
        _ => return bridge.forward(app, operation, arguments).await,
    };
    if matches!(
        operation,
        "model_source_save"
            | "model_source_refresh"
            | "model_source_remove"
            | "model_source_sign_in"
            | "model_source_sign_in_cancel"
            | "mcp_server_save"
            | "mcp_server_refresh"
            | "mcp_server_remove"
    ) {
        let _ = app.emit("knotra-control-changed", json!({"connectionsChanged":true}));
    }
    Ok(result)
}

#[tauri::command]
pub fn desktop_control_status(control: State<'_, DesktopControl>) -> ControlStatus {
    control.status()
}
#[tauri::command]
pub fn desktop_control_ready(control: State<'_, DesktopControl>, ready: bool) {
    if let Some(bridge) = &control.bridge {
        bridge.ready.store(ready, Ordering::SeqCst);
        if !ready {
            for (_, reply) in bridge.pending.lock().unwrap().drain() {
                let _ = reply.send(Err(ControlError::disabled()));
            }
        }
    }
}
#[tauri::command]
pub fn desktop_control_reply(
    control: State<'_, DesktopControl>,
    id: String,
    result: Option<Value>,
    error: Option<ControlError>,
) -> std::result::Result<bool, String> {
    let outcome = match (result, error) {
        (Some(result), None) if result.is_object() => Ok(result),
        (None, Some(error)) if error.code.len() <= 80 && error.message.len() <= 2048 => Err(error),
        _ => return Err("Reply with one result object or error.".into()),
    };
    let Some(bridge) = &control.bridge else {
        return Ok(false);
    };
    let Some(reply) = bridge.pending.lock().unwrap().remove(&id) else {
        return Ok(false);
    };
    Ok(reply.send(outcome).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::setup::tests::TempDir;
    use std::{io::Write, net::TcpStream, sync::atomic::AtomicUsize};
    use tauri::Listener;

    struct Harness {
        bridge: Arc<Bridge>,
        _root: TempDir,
    }
    impl Drop for Harness {
        fn drop(&mut self) {
            self.bridge.shutdown();
        }
    }
    fn harness(dispatch: Dispatch) -> Harness {
        let root = TempDir::new();
        let bridge = start(
            root.0.join("control"),
            root.0.join("fixture-knotra"),
            dispatch,
        )
        .unwrap();
        Harness {
            bridge,
            _root: root,
        }
    }
    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap()
    }
    async fn call(bridge: &Bridge, operation: &str, arguments: Value, id: Option<&str>) -> Value {
        let mut request = client()
            .post(format!("{}/v1/tools/{operation}", bridge.endpoint))
            .bearer_auth(&bridge.token)
            .json(&arguments);
        if let Some(id) = id {
            request = request.header("X-Knotra-Request-Id", id);
        }
        request.send().await.unwrap().json().await.unwrap()
    }
    fn simple_dispatch() -> Dispatch {
        Arc::new(|_, operation, _| Box::pin(async move { Ok(json!({"operation":operation})) }))
    }

    #[test]
    fn protected_descriptor_and_status_never_expose_auth_and_second_owner_cannot_replace_it() {
        let harness = harness(simple_dispatch());
        let descriptor: Value =
            serde_json::from_slice(&fs::read(&harness.bridge.descriptor).unwrap()).unwrap();
        assert_eq!(descriptor["protocol"], PROTOCOL);
        assert_eq!(descriptor["token"].as_str().unwrap().len(), 64);
        assert!(descriptor["endpoint"]
            .as_str()
            .unwrap()
            .starts_with("http://127.0.0.1:"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&harness.bridge.descriptor)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let status = DesktopControl {
            bridge: Some(harness.bridge.clone()),
            error: None,
        }
        .status();
        let public = serde_json::to_string(&status).unwrap();
        assert!(!public.contains(&harness.bridge.token));
        assert!(!public.contains(&harness.bridge.endpoint));
        assert_eq!(
            status.args.as_ref().unwrap()[..4],
            ["mcp", "serve", "--desktop", "--bridge-file"]
        );
        let old = fs::read(&harness.bridge.descriptor).unwrap();
        let second = start(
            harness.bridge.descriptor.parent().unwrap().into(),
            PathBuf::from("other"),
            simple_dispatch(),
        );
        assert_eq!(second.err().unwrap().code, "busy");
        assert_eq!(fs::read(&harness.bridge.descriptor).unwrap(), old);
        harness.bridge.shutdown();
        assert!(!harness.bridge.descriptor.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_lock_does_not_follow_or_replace_a_foreign_file() {
        let root = TempDir::new();
        let data = root.0.join("control");
        fs::create_dir(&data).unwrap();
        let foreign = root.0.join("keep");
        fs::write(&foreign, "keep").unwrap();
        std::os::unix::fs::symlink(&foreign, data.join("desktop-control.lock")).unwrap();
        assert!(start(data, root.0.join("cli"), simple_dispatch()).is_err());
        assert_eq!(fs::read_to_string(foreign).unwrap(), "keep");
    }

    #[test]
    fn actual_http_rejects_bad_auth_browser_origins_foreign_hosts_and_arbitrary_operations() {
        let harness = harness(simple_dispatch());
        let bridge = &harness.bridge;
        tauri::async_runtime::block_on(async {
            let url = format!("{}/v1/tools/app_status", bridge.endpoint);
            let unauth = client().post(&url).json(&json!({})).send().await.unwrap();
            assert_eq!(unauth.status(), 401);
            let origin = client()
                .post(&url)
                .bearer_auth(&bridge.token)
                .header("Origin", "https://foreign.example")
                .json(&json!({}))
                .send()
                .await
                .unwrap();
            assert_eq!(origin.status(), 401);
            assert!(origin
                .headers()
                .get("Access-Control-Allow-Origin")
                .is_none());
            let foreign = client()
                .post(&url)
                .bearer_auth(&bridge.token)
                .header("Host", "foreign.example")
                .json(&json!({}))
                .send()
                .await
                .unwrap();
            assert_eq!(foreign.status(), 401);
            assert_eq!(
                call(bridge, "arbitrary_invoke", json!({"command":"shell"}), None).await["error"]
                    ["code"],
                "not_found"
            );
            assert_eq!(
                call(
                    bridge,
                    "engine_call",
                    json!({"op":"rawHttp","url":"https://foreign.example"}),
                    None
                )
                .await["error"]["code"],
                "invalid"
            );
            assert_eq!(
                call(
                    bridge,
                    "engine_call",
                    json!({"op":"info","arbitrary":true}),
                    None
                )
                .await["error"]["code"],
                "invalid"
            );
            assert_eq!(
                call(
                    bridge,
                    "artifact_download",
                    json!({"artifactId":"fixture"}),
                    None
                )
                .await["result"]["operation"],
                "artifact_download"
            );
            assert_eq!(
                call(bridge, "app_status", json!({}), None).await["result"]["operation"],
                "app_status"
            );
        });
    }

    #[test]
    fn http_mutations_replay_one_inflight_result_and_reject_changed_payload_without_storing_secrets(
    ) {
        let count = Arc::new(AtomicUsize::new(0));
        let dispatch_count = count.clone();
        let harness = harness(Arc::new(move |_, _, _| {
            let count = dispatch_count.clone();
            Box::pin(async move {
                count.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok(json!({"connection":{"id":"fixture-source"}}))
            })
        }));
        tauri::async_runtime::block_on(async {
            let first = call(
                &harness.bridge,
                "model_source_save",
                json!({"provider":"openai","apiKey":"fixture-private-key"}),
                Some("stable_request_123"),
            );
            let second = call(
                &harness.bridge,
                "model_source_save",
                json!({"provider":"openai","apiKey":"fixture-private-key"}),
                Some("stable_request_123"),
            );
            let (first, second) = futures_util::future::join(first, second).await;
            assert_eq!(first, second);
            assert_eq!(count.load(Ordering::SeqCst), 1);
            assert!(!first.to_string().contains("fixture-private-key"));
            let replay = call(
                &harness.bridge,
                "model_source_save",
                json!({"apiKey":"fixture-private-key","provider":"openai"}),
                Some("stable_request_123"),
            )
            .await;
            assert_eq!(replay, first);
            assert_eq!(count.load(Ordering::SeqCst), 1);
            assert_eq!(
                call(
                    &harness.bridge,
                    "model_source_save",
                    json!({"provider":"openai","apiKey":"different-private-key"}),
                    Some("stable_request_123")
                )
                .await["error"]["code"],
                "conflict"
            );
            assert_eq!(
                call(
                    &harness.bridge,
                    "model_source_remove",
                    json!({"id":"fixture"}),
                    None
                )
                .await["error"]["code"],
                "invalid"
            );
            assert_eq!(count.load(Ordering::SeqCst), 1);
        });
        let receipts = harness.bridge.receipts.lock().unwrap();
        assert_eq!(receipts.entries.len(), 1);
        assert!(receipts.bytes < MAX_BYTES);
    }

    #[test]
    fn client_disconnect_cannot_cancel_a_mutation_or_repeat_its_side_effect() {
        let count = Arc::new(AtomicUsize::new(0));
        let dispatch_count = count.clone();
        let harness = harness(Arc::new(move |_, _, _| {
            let count = dispatch_count.clone();
            Box::pin(async move {
                count.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(100)).await;
                Ok(json!({"created":true}))
            })
        }));
        let body = r#"{"source":"fixture-source"}"#;
        let mut socket =
            TcpStream::connect(harness.bridge.endpoint.strip_prefix("http://").unwrap()).unwrap();
        write!(socket,"POST /v1/tools/pipeline_create HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nX-Knotra-Request-Id: dropped_request_123\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",harness.bridge.endpoint.strip_prefix("http://").unwrap(),harness.bridge.token,body.len()).unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(2);
        while count.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(count.load(Ordering::SeqCst), 1);
        drop(socket);
        let replay = tauri::async_runtime::block_on(call(
            &harness.bridge,
            "pipeline_create",
            json!({"source":"fixture-source"}),
            Some("dropped_request_123"),
        ));
        assert_eq!(replay["result"]["created"], true);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn engine_call_preserves_human_request_id_and_existing_short_durable_operation_id() {
        let harness = harness(Arc::new(|_, _, arguments| {
            Box::pin(async move { Ok(json!({"arguments":arguments})) })
        }));
        let body = json!({"op":"respond","requestId":"human_request_123","outputs":{},"operationId":"op1"});
        let result = tauri::async_runtime::block_on(call(
            &harness.bridge,
            "engine_call",
            body.clone(),
            Some("op1"),
        ));
        assert_eq!(result["result"]["arguments"], body);
    }

    fn mock_app(
        root: &TempDir,
    ) -> (
        tauri::App<tauri::test::MockRuntime>,
        Arc<Bridge>,
        Arc<Mutex<Option<Value>>>,
    ) {
        let app = tauri::test::mock_app();
        // No Backend::new, DesktopSetup::new, restore, or real provider/credential access.
        app.manage(crate::setup::tests::manager(&root.0.join("setup")));
        let app_handle = app.handle().clone();
        let dispatcher: Dispatch = Arc::new(move |bridge, operation, arguments| {
            let app = app_handle.clone();
            Box::pin(async move { dispatch(&app, &bridge, &operation, arguments).await })
        });
        let bridge = start(
            root.0.join("control"),
            root.0.join("fixture-cli"),
            dispatcher,
        )
        .unwrap();
        app.manage(DesktopControl {
            bridge: Some(bridge.clone()),
            error: None,
        });
        let workspace = Arc::new(Mutex::new(None::<Value>));
        let state = workspace.clone();
        let replies = app.handle().clone();
        app.listen("knotra-control-request",move |event| {
            let request:Value=serde_json::from_str(event.payload()).unwrap(); let arguments=&request["arguments"];
            let revision=|value:&Value|format!("{:x}",Sha256::digest(serde_json::to_vec(value).unwrap()));
            let outcome=match request["operation"].as_str().unwrap() {
                "app_status"=>Ok(json!({"activeId":state.lock().unwrap().as_ref().map(|workspace|workspace["id"].clone())})),
                "pipeline_create"=>{ let value=json!({"id":"fixture-workspace","source":arguments["source"],"savedSource":arguments["source"],"entrypoint":"pipeline.yaml","files":[],"updatedAt":"2026-10-21T00:00:00Z"}); *state.lock().unwrap()=Some(value.clone()); Ok(json!({"workspace":value,"revision":revision(&value)})) },
                "pipeline_get"=>{ let value=state.lock().unwrap().clone().unwrap(); Ok(json!({"workspace":value,"revision":revision(&value)})) },
                "pipeline_update"=>{ let mut value=state.lock().unwrap(); let workspace=value.as_mut().unwrap(); if arguments["expectedRevision"]!=revision(workspace) { Err(ControlError::new("conflict","Fixture revision changed.")) } else { workspace["source"]=arguments["source"].clone(); Ok(json!({"workspace":workspace,"revision":revision(workspace)})) } },
                _=>Err(ControlError::invalid()),
            };
            let (result,error)=match outcome { Ok(result)=>(Some(result),None),Err(error)=>(None,Some(error)) };
            assert!(desktop_control_reply(replies.state(),request["id"].as_str().unwrap().into(),result,error).unwrap());
        });
        desktop_control_ready(app.state(), true);
        (app, bridge, workspace)
    }

    #[test]
    fn actual_http_tauri_event_reply_uses_frontend_ready_and_source_revision_guards() {
        let root = TempDir::new();
        let (app, bridge, _) = mock_app(&root);
        tauri::async_runtime::block_on(async {
            let created = call(
                &bridge,
                "pipeline_create",
                json!({"source":"fixture-yaml"}),
                Some("create_pipeline_123"),
            )
            .await;
            assert_eq!(created["result"]["workspace"]["source"], "fixture-yaml");
            let get = call(
                &bridge,
                "pipeline_get",
                json!({"id":"fixture-workspace"}),
                None,
            )
            .await;
            assert_eq!(get, created);
            assert_eq!(
                call(&bridge, "model_source_list", json!({}), None).await["result"]["connections"],
                json!([])
            );
            desktop_control_ready(app.state(), false);
            assert_eq!(
                call(&bridge, "app_status", json!({}), None).await["error"]["code"],
                "disabled"
            );
        });
        let source_data = root.0.join("setup/data");
        fs::create_dir_all(&source_data).unwrap();
        fs::write(source_data.join("desktop-connections.json"),json!({"connections":[{"id":"source_fixture","title":"Fixture","provider":"openai","baseUrl":null,"models":[],"defaultModel":"default","hasCredential":true,"revision":2}]}).to_string()).unwrap();
        // A deliberately missing credential is never queried: the stale revision is rejected first.
        tauri::async_runtime::block_on(async {
            for operation in ["model_source_refresh", "model_source_remove"] {
                let result = call(
                    &bridge,
                    operation,
                    json!({"id":"source_fixture","expectedRevision":1}),
                    Some(&format!("stale_{operation}_123")),
                )
                .await;
                assert_eq!(result["error"]["code"], "conflict");
            }
            let result = call(
                &bridge,
                "model_source_save",
                json!({"id":"source_fixture","provider":"openai","expectedRevision":1}),
                Some("stale_model_save_123"),
            )
            .await;
            assert_eq!(result["error"]["code"], "conflict");
        });
        bridge.shutdown();
    }

    #[test]
    #[ignore = "requires owned temporary Go CLI and official MCP SDK driver paths"]
    fn official_stdio_sdk_through_native_http_and_tauri_frontend_round_trip() {
        let cli = std::env::var_os("KNOTRA_CONTROL_E2E_CLI").expect("set owned test CLI path");
        let driver = std::env::var_os("KNOTRA_CONTROL_E2E_DRIVER")
            .expect("set owned official SDK driver path");
        let root = TempDir::new();
        let (_app, bridge, workspace) = mock_app(&root);
        let catalog = TcpListener::bind("127.0.0.1:0").unwrap();
        let catalog_url = format!("http://{}", catalog.local_addr().unwrap());
        catalog.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let catalog_requests = std::thread::spawn(move || {
            use std::io::Read;
            let mut requests = vec![];
            while !stopped.load(Ordering::SeqCst) {
                match catalog.accept() {
                    Ok((mut socket, _)) => {
                        socket
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut bytes = [0; 4096];
                        let length = socket.read(&mut bytes).unwrap();
                        requests.push(String::from_utf8_lossy(&bytes[..length]).to_string());
                        socket.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("owned catalog fixture failed: {error}"),
                }
            }
            requests
        });
        let result = std::process::Command::new(driver)
            .arg(cli)
            .arg(&bridge.descriptor)
            .arg(catalog_url)
            .current_dir(&root.0)
            .output()
            .unwrap();
        stop.store(true, Ordering::SeqCst);
        let catalog_requests = catalog_requests.join().unwrap();
        bridge.shutdown();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(String::from_utf8_lossy(&result.stdout).contains("official SDK"));
        assert!(String::from_utf8_lossy(&result.stdout).contains("native source save/list/remove"));
        assert_eq!(catalog_requests.len(), 1);
        assert!(catalog_requests[0].starts_with("GET /api/tags HTTP/1.1\r\n"));
        assert!(!catalog_requests[0]
            .to_ascii_lowercase()
            .contains("authorization:"));
        let saved: Value = serde_json::from_slice(
            &fs::read(root.0.join("setup/data/desktop-connections.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved["connections"], json!([]));
        assert_eq!(saved["engineEnabled"], false);
        assert_eq!(saved["applied"], Value::Null);
        assert!(workspace.lock().unwrap().as_ref().unwrap()["source"]
            .as_str()
            .unwrap()
            .contains("Changed through actual MCP stdio"));
    }
}
