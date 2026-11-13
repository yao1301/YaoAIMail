#![cfg(feature = "api")]
use axum::{body::{to_bytes, Body}, http::{Method, Request, StatusCode}, Router};
use pebble_research::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

const TOKEN: &str = "anonymous-test-token-0123456789abcdef";
const HOST: &str = "127.0.0.1:38219";
#[derive(Default)]
struct Repo { live: Mutex<Vec<Job>>, archived: Mutex<Vec<Job>> }
impl JobRepository for Repo {
    fn load(&self) -> Result<Vec<Job>, String> { Ok(self.live.lock().unwrap().clone()) }
    fn save(&self, jobs: &[Job]) -> Result<(), String> { *self.live.lock().unwrap() = jobs.to_vec(); Ok(()) }
    fn archive(&self, jobs: &[Job]) -> Result<(), String> {
        let mut archived = self.archived.lock().unwrap();
        for job in jobs {
            if let Some(old) = archived.iter_mut().find(|j| j.id == job.id) { *old = job.clone(); }
            else { archived.push(job.clone()); }
        }
        Ok(())
    }
    fn get_archived(&self, id: &str) -> Result<Option<Job>, String> {
        Ok(self.archived.lock().unwrap().iter().find(|j| j.id == id).cloned())
    }
    fn find_archived_idempotency(&self, key: &str) -> Result<Option<Job>, String> {
        Ok(self.archived.lock().unwrap().iter().find(|j| j.request.idempotency_key.as_deref() == Some(key)).cloned())
    }
}
struct Backend;
impl ResearchBackend for Backend {
    fn validate(&self, _: &TaskRequest) -> Result<(), String> { Ok(()) }
    fn run(&self, _: TaskRequest, p: Progress) -> BoxFuture<'_, Result<Value, String>> {
        Box::pin(async move {
            p.snapshot(json!({"sensitive_checkpoint": "private checkpoint"}));
            std::future::pending().await
        })
    }
}
fn setup() -> (Router, Arc<Engine>, Arc<Repo>) {
    let repo = Arc::new(Repo::default());
    let engine = Engine::new(Arc::new(Backend), repo.clone()).unwrap();
    let app = api::router(engine.clone(), HOST.parse().unwrap(), TOKEN.into()).unwrap();
    (app, engine, repo)
}
fn req(method: Method, path: &str, auth: Option<&str>, host: Option<&str>, body: impl Into<Body>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path).header("Content-Type", "application/json");
    if let Some(auth) = auth { builder = builder.header("Authorization", auth); }
    if let Some(host) = host { builder = builder.header("Host", host); }
    builder.body(body.into()).unwrap()
}
fn auth() -> String { format!("Bearer {TOKEN}") }
async fn body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
}

#[tokio::test]
async fn every_route_and_unknown_path_requires_authentication() {
    let (app, _, _) = setup();
    for (method, path) in [
        (Method::GET, "/v1/research/health"),
        (Method::GET, "/v1/research/jobs"),
        (Method::POST, "/v1/research/jobs"),
        (Method::GET, "/v1/research/jobs/missing"),
        (Method::POST, "/v1/research/jobs/missing/cancel"),
        (Method::POST, "/v1/research/jobs/missing/resume"),
        (Method::GET, "/missing"),
        (Method::DELETE, "/v1/research/jobs"),
    ] {
        for key in [None, Some("Bearer wrong-key")] {
            let response = app.clone().oneshot(req(method.clone(), path, key, Some(HOST), "")).await.unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{method} {path}");
            assert_eq!(response.headers()["cache-control"], "no-store");
            assert_eq!(response.headers()["www-authenticate"], "Bearer");
        }
    }
}

#[tokio::test]
async fn rejects_origins_hosts_duplicate_credentials_and_query_tokens() {
    let (app, _, _) = setup();
    for origin in ["https://untrusted.example", "null", "http://localhost:38219"] {
        let mut r = req(Method::GET, "/v1/research/health", Some(&auth()), Some(HOST), "");
        r.headers_mut().insert("Origin", origin.parse().unwrap());
        let response = app.clone().oneshot(r).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(!response.headers().contains_key("access-control-allow-origin"));
    }
    for host in [None, Some("untrusted.example:38219"), Some("127.0.0.1:9999"), Some("127.0.0.1"), Some("127.0.0.1:38219.untrusted.example")] {
        assert_eq!(app.clone().oneshot(req(Method::GET, "/v1/research/health", Some(&auth()), host, "")).await.unwrap().status(), StatusCode::FORBIDDEN);
    }
    let mut duplicate = req(Method::GET, "/v1/research/health", Some(&auth()), Some(HOST), "");
    duplicate.headers_mut().append("Host", HOST.parse().unwrap());
    assert_eq!(app.clone().oneshot(duplicate).await.unwrap().status(), StatusCode::FORBIDDEN);
    let mut duplicate = req(Method::GET, "/v1/research/health", Some(&auth()), Some(HOST), "");
    duplicate.headers_mut().append("Authorization", auth().parse().unwrap());
    assert_eq!(app.clone().oneshot(duplicate).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    for key in [None, Some(auth())] {
        let path = format!("/v1/research/health?token={TOKEN}");
        let status = app.clone().oneshot(req(Method::GET, &path, key.as_deref(), Some(HOST), "")).await.unwrap().status();
        assert_eq!(status, if key.is_some() { StatusCode::BAD_REQUEST } else { StatusCode::UNAUTHORIZED });
    }
    let mut absolute = req(Method::GET, "http://untrusted.example/v1/research/health", Some(&auth()), Some(HOST), "");
    absolute.headers_mut().insert("Host", HOST.parse().unwrap());
    assert_eq!(app.clone().oneshot(absolute).await.unwrap().status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn bounds_actual_body_without_trusting_content_length_and_checks_json_schema() {
    let (app, _, repo) = setup();
    for path in ["/v1/research/jobs", "/v1/research/health"] {
        let mut r = req(Method::POST, path, Some(&auth()), Some(HOST), "x".repeat(65537));
        r.headers_mut().insert("Content-Length", "1".parse().unwrap());
        assert_eq!(app.clone().oneshot(r).await.unwrap().status(), StatusCode::PAYLOAD_TOO_LARGE);
    }
    for invalid in [
        json!({}), json!({"kind": "leads"}), json!({"kind": "unknown", "input": {}}),
        json!({"kind": "Leads", "input": {}}), json!({"kind": "leads", "input": {}, "unexpected": true}),
        json!({"kind": "leads", "input": {}, "idempotency_key": 12}),
    ] {
        let response = app.clone().oneshot(req(Method::POST, "/v1/research/jobs", Some(&auth()), Some(HOST), invalid.to_string())).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY, "{invalid}");
        assert_eq!(body(response).await, json!({"error": "invalid_request"}));
    }
    let malformed = app.clone().oneshot(req(Method::POST, "/v1/research/jobs", Some(&auth()), Some(HOST), "{")).await.unwrap();
    assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);
    let mut no_type = req(Method::POST, "/v1/research/jobs", Some(&auth()), Some(HOST), "{}");
    no_type.headers_mut().remove("Content-Type");
    assert_eq!(app.clone().oneshot(no_type).await.unwrap().status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert!(repo.load().unwrap().is_empty());
}

#[tokio::test]
async fn submit_detail_list_cancel_resume_never_expose_inputs_or_checkpoints() {
    let (app, engine, repo) = setup();
    let input = json!({"kind": "company", "input": {"query": "PRIVATE_INPUT_MARKER"}, "idempotency_key": "PRIVATE_KEY_MARKER"});
    let response = app.clone().oneshot(req(Method::POST, "/v1/research/jobs", Some(&auth()), Some(HOST), input.to_string())).await.unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let submitted = body(response).await;
    assert_eq!(submitted["status"], "queued");
    let id = submitted["id"].as_str().unwrap();
    tokio::task::yield_now().await;
    for (method, path, expected) in [
        (Method::GET, "/v1/research/jobs".to_owned(), StatusCode::OK),
        (Method::GET, format!("/v1/research/jobs/{id}"), StatusCode::OK),
        (Method::POST, format!("/v1/research/jobs/{id}/cancel"), StatusCode::OK),
        (Method::POST, format!("/v1/research/jobs/{id}/resume"), StatusCode::ACCEPTED),
    ] {
        let response = app.clone().oneshot(req(method, &path, Some(&auth()), Some(HOST), "")).await.unwrap();
        assert_eq!(response.status(), expected, "{path}");
        let value = body(response).await;
        for marker in ["PRIVATE_INPUT_MARKER", "PRIVATE_KEY_MARKER", "private checkpoint", "\"request\"", "\"input\"", "\"snapshot\""] {
            assert!(!value.to_string().contains(marker), "{path}: {value}");
            assert!(!submitted.to_string().contains(marker));
        }
    }
    assert_eq!(repo.load().unwrap()[0].request.input["query"], "PRIVATE_INPUT_MARKER");
    assert_eq!(repo.load().unwrap()[0].request.idempotency_key.as_deref(), Some("PRIVATE_KEY_MARKER"));
    engine.shutdown().unwrap();
}

#[tokio::test]
async fn health_methods_not_found_conflicts_and_configuration() {
    let (app, engine, _) = setup();
    let response = app.clone().oneshot(req(Method::GET, "/v1/research/health", Some(&auth()), Some("localhost:38219"), "")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await, json!({"status": "ok"}));
    for (method, path, expected) in [
        (Method::DELETE, "/v1/research/jobs", StatusCode::METHOD_NOT_ALLOWED),
        (Method::PUT, "/v1/research/jobs", StatusCode::METHOD_NOT_ALLOWED),
        (Method::POST, "/v1/research/health", StatusCode::METHOD_NOT_ALLOWED),
        (Method::HEAD, "/v1/research/health", StatusCode::METHOD_NOT_ALLOWED),
        (Method::OPTIONS, "/v1/research/jobs", StatusCode::METHOD_NOT_ALLOWED),
        (Method::GET, "/v1/research/jobs/missing", StatusCode::NOT_FOUND),
        (Method::POST, "/v1/research/jobs/missing/cancel", StatusCode::NOT_FOUND),
        (Method::POST, "/v1/research/jobs/missing/resume", StatusCode::NOT_FOUND),
        (Method::GET, "/v1/research/mail", StatusCode::NOT_FOUND),
    ] {
        assert_eq!(app.clone().oneshot(req(method, path, Some(&auth()), Some(HOST), "")).await.unwrap().status(), expected);
    }
    for token in ["".to_owned(), "x".repeat(31), format!("{}\n", "x".repeat(32)), " ".repeat(32), "x".repeat(1025)] {
        assert!(api::router(engine.clone(), HOST.parse().unwrap(), token).is_err());
    }
    for addr in ["0.0.0.0:38219", "192.0.2.1:38219", "[::]:38219"] {
        assert!(api::router(engine.clone(), addr.parse().unwrap(), TOKEN.into()).is_err());
        assert!(api::serve(engine.clone(), addr.parse().unwrap(), TOKEN.into()).await.is_err());
    }
    let v6 = api::router(engine.clone(), "[::1]:38219".parse().unwrap(), TOKEN.into()).unwrap();
    assert_eq!(v6.oneshot(req(Method::GET, "/v1/research/health", Some(&auth()), Some("[::1]:38219"), "")).await.unwrap().status(), StatusCode::OK);
    let first = json!({"kind":"leads", "input":{"q":"a"}, "idempotency_key":"one"});
    assert_eq!(app.clone().oneshot(req(Method::POST, "/v1/research/jobs", Some(&auth()), Some(HOST), first.to_string())).await.unwrap().status(), StatusCode::ACCEPTED);
    let conflict = json!({"kind":"leads", "input":{"q":"b"}, "idempotency_key":"one"});
    assert_eq!(app.oneshot(req(Method::POST, "/v1/research/jobs", Some(&auth()), Some(HOST), conflict.to_string())).await.unwrap().status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn real_loopback_http_listener_smoke_with_mock_backend() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (_, engine, repo) = setup();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = api::router(engine.clone(), addr, TOKEN.into()).unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).with_graceful_shutdown(async { let _ = stopped.await; }).await.unwrap();
    });
    async fn exchange(addr: std::net::SocketAddr, headers: &str, payload: Option<&str>) -> (u16, Value) {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let payload = payload.unwrap_or("");
        let (method, path) = if payload.is_empty() { ("GET", "/v1/research/health") } else { ("POST", "/v1/research/jobs") };
        let request = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{headers}\r\n{payload}", payload.len());
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(std::time::Duration::from_secs(3), stream.read_to_end(&mut response)).await.unwrap().unwrap();
        let response = String::from_utf8(response).unwrap();
        let (head, body) = response.split_once("\r\n\r\n").unwrap();
        let status = head.split_whitespace().nth(1).unwrap().parse::<u16>().unwrap();
        (status, serde_json::from_str(body).unwrap())
    }
    assert_eq!(exchange(addr, "", None).await.0, 401);
    assert_eq!(exchange(addr, "Authorization: Bearer wrong\r\n", None).await.0, 401);
    let headers = format!("Authorization: Bearer {TOKEN}\r\n");
    assert_eq!(exchange(addr, &headers, None).await, (200, json!({"status":"ok"})));
    assert_eq!(exchange(addr, &format!("{headers}Origin: https://untrusted.example\r\n"), None).await.0, 403);
    let payload = json!({"kind":"company", "input":{"private":"PRIVATE_TCP_INPUT"}, "idempotency_key":"tcp-smoke"}).to_string();
    let (status, job) = exchange(addr, &headers, Some(&payload)).await;
    assert_eq!(status, 202);
    assert_eq!(job["status"], "queued");
    assert!(job.get("request").is_none());
    assert!(!job.to_string().contains("PRIVATE_TCP_INPUT"));
    assert_eq!(repo.load().unwrap()[0].request.input["private"], "PRIVATE_TCP_INPUT");
    engine.shutdown().unwrap();
    stop.send(()).unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn archived_detail_and_idempotency_work_without_exposing_inputs_and_mutations_conflict() {
    let (_, engine, repo) = setup();
    let request = TaskRequest { kind: ResearchKind::Company, input: json!({"query":"PRIVATE_ARCHIVE_INPUT"}), idempotency_key: Some("archive-key".into()) };
    let job = engine.submit(request.clone()).unwrap();
    let job = engine.cancel(&job.id).unwrap();
    engine.shutdown().unwrap();
    drop(engine);
    repo.archive(&[job.clone()]).unwrap();
    repo.save(&[]).unwrap();
    let engine = Engine::new(Arc::new(Backend), repo).unwrap();
    let app = api::router(engine, HOST.parse().unwrap(), TOKEN.into()).unwrap();
    let response = app.clone().oneshot(req(Method::GET, &format!("/v1/research/jobs/{}", job.id), Some(&auth()), Some(HOST), "")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let detail = body(response).await;
    assert_eq!(detail["id"], job.id);
    assert!(detail.get("request").is_none());
    assert!(!detail.to_string().contains("PRIVATE_ARCHIVE_INPUT"));
    let response = app.clone().oneshot(req(Method::POST, "/v1/research/jobs", Some(&auth()), Some(HOST), serde_json::to_string(&request).unwrap())).await.unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert_eq!(body(response).await["id"], job.id);
    let response = app.clone().oneshot(req(Method::GET, "/v1/research/jobs", Some(&auth()), Some(HOST), "")).await.unwrap();
    assert_eq!(body(response).await, json!([]));
    for action in ["cancel", "resume"] {
        let response = app.clone().oneshot(req(Method::POST, &format!("/v1/research/jobs/{}/{action}", job.id), Some(&auth()), Some(HOST), "")).await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(body(response).await, json!({"error":"archived_job_read_only"}));
    }
}
