//! Authenticated, loopback-only HTTP access to the same single-profile engine.
use crate::{engine::{ARCHIVED_NOT_MUTABLE, IDEMPOTENCY_CONFLICT, INVALID_REQUEST, NOT_FOUND, MAX_REQUEST_BYTES}, Engine, Job, JobStatus, ResearchKind, TaskRequest};
use axum::{
    body::{to_bytes, Body},
    extract::{rejection::JsonRejection, Path, Request, State},
    http::{header, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{net::SocketAddr, sync::Arc};
use subtle::ConstantTimeEq;

#[derive(Clone)]
struct Guard { token: Arc<str>, hosts: Arc<Vec<String>> }

/// HTTP task projection deliberately has no request, input, or idempotency key.
#[derive(Serialize)]
struct PublicJob {
    id: String,
    kind: ResearchKind,
    status: JobStatus,
    stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    created_at: u64,
    updated_at: u64,
    started_at: Option<u64>,
    finished_at: Option<u64>,
    attempts: u32,
}
impl From<Job> for PublicJob {
    fn from(j: Job) -> Self {
        Self { id: j.id, kind: j.request.kind, status: j.status, stage: j.stage,
            result: j.result, error: j.error, created_at: j.created_at, updated_at: j.updated_at,
            started_at: j.started_at, finished_at: j.finished_at, attempts: j.attempts }
    }
}
fn error(status: StatusCode, message: &str) -> Response {
    let mut response = (status, Json(json!({"error": message}))).into_response();
    response.headers_mut().insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    if status == StatusCode::UNAUTHORIZED {
        response.headers_mut().insert(header::WWW_AUTHENTICATE, "Bearer".parse().unwrap());
    }
    response
}
fn engine_error(message: String) -> Response {
    let (status, code) = match message.as_str() {
        NOT_FOUND => (StatusCode::NOT_FOUND, "job_not_found"),
        IDEMPOTENCY_CONFLICT => (StatusCode::CONFLICT, "idempotency_conflict"),
        INVALID_REQUEST => (StatusCode::BAD_REQUEST, "invalid_request"),
        ARCHIVED_NOT_MUTABLE => (StatusCode::CONFLICT, "archived_job_read_only"),
        "research job cannot be resumed in its current state" => (StatusCode::CONFLICT, "job_not_resumable"),
        "research job capacity reached" => (StatusCode::TOO_MANY_REQUESTS, "job_capacity_reached"),
        _ => (StatusCode::SERVICE_UNAVAILABLE, "research_unavailable"),
    };
    error(status, code)
}
fn configuration(addr: SocketAddr, token: &str) -> Result<(), String> {
    if !addr.ip().is_loopback() { return Err("research API requires a loopback bind address".into()); }
    if token.len() < 32 || token.len() > 1024 || !token.is_ascii()
        || token.bytes().any(|b| b.is_ascii_control() || b.is_ascii_whitespace()) {
        return Err("research API token must contain 32 to 1024 printable ASCII bytes without whitespace".into());
    }
    Ok(())
}

/// `addr` must be the listener's actual loopback address (including its bound port).
/// No environment variables are read here; enabling the listener belongs to the host runtime.
pub fn router(engine: Arc<Engine>, addr: SocketAddr, token: String) -> Result<Router, String> {
    configuration(addr, &token)?;
    let guard = Guard {
        token: token.into(),
        hosts: Arc::new(vec![addr.to_string(), format!("localhost:{}", addr.port())]),
    };
    Ok(Router::new()
        .route("/v1/research/health", get(health))
        .route("/v1/research/jobs", post(submit).get(list))
        .route("/v1/research/jobs/{id}", get(detail))
        .route("/v1/research/jobs/{id}/cancel", post(cancel))
        .route("/v1/research/jobs/{id}/resume", post(resume))
        .with_state(engine)
        // `layer` also guards method/fallback responses, including health and unknown paths.
        .layer(middleware::from_fn_with_state(guard, protect)))
}

async fn protect(State(guard): State<Guard>, request: Request, next: Next) -> Response {
    let mut auth = request.headers().get_all(header::AUTHORIZATION).iter();
    let authenticated = auth.next().and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .is_some_and(|s| bool::from(s.as_bytes().ct_eq(guard.token.as_bytes())));
    if !authenticated || auth.next().is_some() { return error(StatusCode::UNAUTHORIZED, "unauthorized"); }
    if request.headers().contains_key(header::ORIGIN) { return error(StatusCode::FORBIDDEN, "browser_origin_denied"); }
    let mut hosts = request.headers().get_all(header::HOST).iter();
    let valid_host = hosts.next().and_then(|h| h.to_str().ok())
        .is_some_and(|host| guard.hosts.iter().any(|h| h.eq_ignore_ascii_case(host)));
    if !valid_host || hosts.next().is_some()
        || request.uri().authority().is_some_and(|a| !guard.hosts.iter().any(|h| h.eq_ignore_ascii_case(a.as_str()))) {
        return error(StatusCode::FORBIDDEN, "invalid_host");
    }
    // No query parameters are part of this API, especially no query-string tokens.
    if request.uri().query().is_some() { return error(StatusCode::BAD_REQUEST, "query_parameters_denied"); }
    let (parts, body) = request.into_parts();
    let Ok(bytes) = to_bytes(body, MAX_REQUEST_BYTES).await else {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "request_body_too_large");
    };
    // axum's GET routing accepts HEAD implicitly; this API intentionally exposes only GET/POST.
    if parts.method != Method::GET && parts.method != Method::POST {
        return error(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed");
    }
    let mut response = next.run(Request::from_parts(parts, Body::from(bytes))).await;
    response.headers_mut().insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
async fn health() -> Json<Value> { Json(json!({"status": "ok"})) }
async fn submit(State(engine): State<Arc<Engine>>, request: Result<Json<TaskRequest>, JsonRejection>) -> Response {
    let request = match request {
        Ok(Json(request)) => request,
        Err(rejection) => return error(rejection.status(), "invalid_request"),
    };
    match engine.submit(request) {
        Ok(job) => (StatusCode::ACCEPTED, Json(PublicJob::from(job))).into_response(),
        Err(e) => engine_error(e),
    }
}
async fn list(State(engine): State<Arc<Engine>>) -> Response {
    match engine.list() {
        Ok(jobs) => Json(jobs.into_iter().map(PublicJob::from).collect::<Vec<_>>()).into_response(),
        Err(e) => engine_error(e),
    }
}
async fn detail(State(engine): State<Arc<Engine>>, Path(id): Path<String>) -> Response {
    match engine.get(&id) {
        Ok(Some(job)) => Json(PublicJob::from(job)).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "job_not_found"),
        Err(e) => engine_error(e),
    }
}
async fn cancel(State(engine): State<Arc<Engine>>, Path(id): Path<String>) -> Response {
    match engine.cancel(&id) {
        Ok(job) => Json(PublicJob::from(job)).into_response(),
        Err(e) => engine_error(e),
    }
}
async fn resume(State(engine): State<Arc<Engine>>, Path(id): Path<String>) -> Response {
    match engine.resume(&id) {
        Ok(job) => (StatusCode::ACCEPTED, Json(PublicJob::from(job))).into_response(),
        Err(e) => engine_error(e),
    }
}

/// Serves until the server future is dropped or the host runtime exits.
/// Hosts should call `engine.shutdown()` before stopping their runtime. Hosts needing a
/// graceful HTTP stop signal can serve `router` with `with_graceful_shutdown` themselves.
pub async fn serve(engine: Arc<Engine>, addr: SocketAddr, token: String) -> Result<(), String> {
    configuration(addr, &token)?;
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|_| "research API could not bind".to_string())?;
    let bound = listener.local_addr().map_err(|_| "research API address unavailable".to_string())?;
    let app = router(engine, bound, token)?;
    axum::serve(listener, app).await.map_err(|_| "research API stopped".into())
}
