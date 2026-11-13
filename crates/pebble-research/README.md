# pebble-research

Shared research jobs for one desktop profile. The desktop commands and optional HTTP
listener use the same `Engine` and native business backend. This crate is the external
calling foundation for that engine, not a multi-tenant or standalone production service.
It does not read environment variables, credentials, mail, or local application files.
The host decides whether to enable its listener (for example using
`PEBBLE_RESEARCH_API_ADDR` and `PEBBLE_RESEARCH_API_TOKEN`). The default Cargo feature
includes `api`; `default-features = false` omits HTTP dependencies.

## Integration contract

```rust,ignore
pub enum ResearchKind { Leads, Company, Contacts } // serde: leads/company/contacts
pub struct TaskRequest {
    pub kind: ResearchKind,
    pub input: serde_json::Value,
    pub idempotency_key: Option<String>, // serde default: None
}
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type Observer = Arc<dyn Fn(serde_json::Value) + Send + Sync>;
pub trait ResearchBackend: Send + Sync {
    fn validate(&self, request: &TaskRequest) -> Result<(), String>;
    fn run(&self, request: TaskRequest, progress: Progress)
        -> BoxFuture<'_, Result<serde_json::Value, String>>;
}
pub trait JobRepository: Send + Sync {
    fn load(&self) -> Result<Vec<Job>, String>;
    fn save(&self, jobs: &[Job]) -> Result<(), String>;
    fn archive(&self, jobs: &[Job]) -> Result<(), String>; // default: Err (unsupported)
    fn get_archived(&self, id: &str) -> Result<Option<Job>, String>; // default: Ok(None)
    fn find_archived_idempotency(&self, key: &str) -> Result<Option<Job>, String>; // default: Ok(None)
}
Engine::new(backend, repo) -> Result<Arc<Engine>, String>;
engine.execute(request, observer).await -> Result<Value, String>;
engine.submit(request) -> Result<Job, String>;
engine.get(id: &str) -> Result<Option<Job>, String>;
engine.list() -> Result<Vec<Job>, String>;
engine.cancel(id: &str) -> Result<Job, String>;
engine.resume(id: &str) -> Result<Job, String>;
engine.shutdown() -> Result<(), String>;
api::router(engine: Arc<Engine>, addr: SocketAddr, token: String) -> Result<axum::Router, String>;
api::serve(engine: Arc<Engine>, addr: SocketAddr, token: String).await -> Result<(), String>;
```

`Job.request` is a **full `TaskRequest`**, not optional and not skipped by serde.
The repository must encrypt and atomically replace the entire record set. It must report
malformed/decryption failures as `Err`, never convert them into an empty history. The
engine never directly writes files. Only one engine may own a profile repository at a time;
a static repository mutex alone does not coordinate independent engine state snapshots.
Profile-specific repository selection and idempotency scope belong to the native runtime.

All repository methods are synchronous. Saves are serialized, and acceptance, running, terminal,
cancel, resume and shutdown transitions are persisted. Repository operations and backend
`validate` must be short, non-reentrant, and must not call back into the engine. No engine
mutex is held across `await`. Native repositories must not use engine callbacks while
holding their own locks. All repository, validation and backend errors returned to callers
are generic; raw provider errors are never forwarded or logged by this crate.

`list()` returns copies with `request.input = null`, `request.idempotency_key = None`, and
`result/snapshot = None`; these copies are never used to save the repository. Native
`get/submit/cancel/resume` return full records for live jobs. HTTP projects every job into a separate
DTO: it never includes `request`, `input`, `idempotency_key`, or `snapshot`, including on
submit and detail. Detail can include the actual research `result`; backends must only
produce client-safe results and progress labels. List omits results entirely.

## Execution, limits, and lifecycle

Submission requires a running Tokio runtime and returns a durably queued job without
waiting for research. Two main research jobs run concurrently. Contacts have a separate
single slot so a contact backlog cannot take the main slots. The total concurrency limit
is three by default. The native host uses `new_with_limits(..., 2, 3)` to preserve the
existing three-way contact queue; each host limit must be between 1 and 4. Waiting jobs
and in-memory history are bounded by a 128-record live limit. At
capacity the engine automatically selects up to 16 oldest terminal records (succeeded,
failed, or cancelled, ordered by creation time then ID), copies them through the repository's
archive method, and commits a reduced live record set before accepting more jobs. Queued,
running, and interrupted records are never archived. Ordinary users do not manage archives.
The native encrypted repository supplies durable per-job archive storage and a durable
idempotency index; the generic engine does not write archive files itself.

`archive` success must mean that **every** supplied complete record is durable and available
through both lookups. It must be idempotent by ID and support updating the same ID with a
newer explicit resume attempt (a prior archive copy can coexist with live history following
a failed live save). Never overwrite a different job or silently discard damaged archive
records/index entries. Default trait methods keep existing repositories compatible: archive
returns an unsupported error and lookups return None. Repositories enabling automatic
archiving must implement all three methods together.

Copy-before-remove is deliberate: archive failure leaves all live records in place. If
archive succeeds but saving the reduced live set fails, original live records remain both
in memory and in the durable live repository (assuming the required atomic save contract).
The engine then fails closed on storage errors. Retrying after repair may copy the same
records again. If archive and live copies coexist, live wins for get and idempotency.
Unsupported/unavailable archives or a live set containing only active/interrupted work
return capacity errors without evicting anything. Archive corruption/lookup failure returns
a generic repository error instead of treating an unknown key as a new billable job.

`list()` includes only live jobs. `get(id)` and HTTP detail look up archived jobs after a
live miss, applying the same input-hiding HTTP DTO. A same-key/same-request submission
finds and returns an archived job without rerunning or charging the backend; changed input
is still an idempotency conflict. Archived jobs are read-only in this iteration: cancel
and resume return a conflict (HTTP 409 `archived_job_read_only`). Archive storage/retention
is a native repository responsibility; engine archiving does not modify the host's separate
business report history or its existing report retention policy.

Requests are at most 64 KiB serialized, results 512 KiB, snapshots 256 KiB, stages 256
UTF-8 bytes, and idempotency keys 1–128 UTF-8 bytes without controls. HTTP additionally
bounds the actual request body to 64 KiB before JSON extraction. Oversize results fail
with the generic backend error. Oversize progress values are ignored. There are at most
32 observers per active job. The fixed job/payload limits also bound retained memory and
repository size (roughly 105 MiB of JSON payload at the maximum, plus encoding/clone
overhead). This bound covers live records, not the cumulative durable archive, which is
retrieved one record at a time. A native repository should reject oversize encoded files
before deserializing and provide its own safe archive/index storage limits without silent
loss of history or idempotency.

`Progress` is cloneable. `stage(&str)` stores a label; company stage callbacks receive a
JSON string, while leads/contacts receive `{"stage":"..."}`. `snapshot(Value)` stores and
forwards the JSON value unchanged. Callbacks run without the state lock. Callback panics
are contained. Every update changes the in-memory checkpoint, while a running task flushes
dirty checkpoints at most once per second. Lifecycle transitions always flush. An abrupt
process exit may lose up to the last interval of progress; checkpoint is informational,
not an executable continuation token.

On load, **all** records are validated before any normalization or save. Invalid or duplicate
records fail construction without clearing or replacing the repository. Persisted queued
or running jobs become `interrupted`; no backend call is made automatically. Explicit
`resume` reuses the original request and increments the attempt counter. The business
backend may reuse its own cached research; it must decide which steps remain necessary.
Failed and cancelled jobs can also be explicitly resumed. Succeeded/running/queued jobs
cannot. Same-key/same-kind-and-input submissions reuse the existing job, including terminal
jobs. A changed kind or input with the same key is a conflict. This scope is one profile,
not unrelated desktop users or network tenants.

Cancellation updates the status before notifying the worker. The worker drops the backend
future, including while queued for a slot. Old progress handles and old attempt results
cannot overwrite a cancelled or resumed job. Backends must keep cancellable work inside
their returned future; detached tasks are outside the engine's cancellation ownership.
Dropping a caller's `execute` future does not cancel its accepted job; call `cancel`.
Backend failures and future panics become a failed job with a generic error. Repository
save failure interrupts active jobs and blocks further submissions/resumes on that engine;
it never reports a result as durably succeeded. Preserve the repository and fix storage
before constructing a new engine. Engine-owned code emits no logs; host panic hooks are
outside this crate's control.

Call synchronous `shutdown()` before stopping the host's Tokio runtime. It rejects new
jobs, interrupts active jobs, saves their checkpoints, and signals cancellation; it does
not block waiting for futures to be dropped. Allow the runtime to schedule worker cleanup
before closing it. Workers hold weak engine references. Dropping the last engine owner
performs best-effort shutdown with the same synchronous repository operation; errors on
Drop cannot be returned. On abrupt runtime/process termination, load-time interruption
provides recovery. The HTTP `serve` future runs until dropped or its runtime stops;
dropping it only closes HTTP and does not shut down the shared desktop engine. Hosts can
serve `router` with their own graceful shutdown signal.

## HTTP contract

Only loopback addresses can be bound. Tokens must contain 32–1024 printable ASCII bytes
with no whitespace or control characters. Use an independently generated random token;
length validation is not an entropy guarantee. Authentication uses the Authorization
header and constant-time equality for equal-length credentials. Every route, including
health, unknown paths and method errors, is protected. Multiple Authorization or Host
headers are rejected. Query parameters (including query tokens) are never supported.

Every `Origin` header, including `null` and localhost, is denied. There is no CORS policy.
`Host` must be exactly the bound IP and port or `localhost` and that port (case-insensitive);
IPv6 addresses use `[::1]:port`. Absolute request URI authorities must pass the same check.
With port zero, `serve` derives the actual bound port before constructing the router.
Gateways must authenticate separately and intentionally forward the bound loopback Host;
this crate does not trust forwarded headers or expose a browser gateway configuration.
Responses use `Cache-Control: no-store`. No secret/token/request body is logged.

| Method | Path | Success |
| --- | --- | --- |
| GET | `/v1/research/health` | 200 `{"status":"ok"}` |
| POST | `/v1/research/jobs` | 202 queued/existing job DTO |
| GET | `/v1/research/jobs` | 200 array of redacted job DTOs |
| GET | `/v1/research/jobs/{id}` | 200 detail job DTO |
| POST | `/v1/research/jobs/{id}/cancel` | 200 job DTO |
| POST | `/v1/research/jobs/{id}/resume` | 202 job DTO |

The API has no send-message, filesystem, or mailbox endpoints. Authentication errors are
401, Origin/Host errors 403, body overflow 413, invalid JSON schema 422, malformed JSON
400, missing JSON content type 415, unsupported methods 405, missing jobs 404, idempotency
or resume-state conflicts 409, full history 429, and storage/runtime unavailability 503.
Error bodies are generic `{"error":"code"}`. A valid JSON request rejected by native
validation is 400.

Anonymous example (the host must supply a real token in `$token`):

```powershell
$headers = @{ Authorization = "Bearer $token" }
$body = '{"kind":"company","input":{"companyName":"Sample Company","website":"https://sample.invalid"},"idempotency_key":"example-request-1"}'
$job = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7465/v1/research/jobs -Headers $headers -ContentType application/json -Body $body
Invoke-RestMethod -Uri "http://127.0.0.1:7465/v1/research/jobs/$($job.id)" -Headers $headers
```

The generic engine accepts any JSON `input`; the integrated native backend supports the
following business inputs. Company investigation can include optional identification fields:

```json
{"kind":"company","input":{"companyName":"Sample Company","website":"https://sample.invalid","country":"Example Country","vat":"EXAMPLE-VAT"},"idempotency_key":"company-example-1"}
```

Only `companyName` is required here; `website`, `country`, and `vat` are optional. Leads
also accept a user's instruction directly, for example:

```json
{"kind":"leads","input":{"instruction":"Find packaging distributors in Germany that publish a business contact page","sessionId":"example-search-session","page":1},"idempotency_key":"leads-example-page-1"}
```

Native planning converts that instruction to English search terms and customer roles once,
retains the user's original hard conditions, and reuses an encrypted planning cache across
pages for that session. For the next page, keep `sessionId`, change `page` and use a new
idempotency key: reusing a key with a changed input is a conflict. Desktop callers may
continue sending their existing normalized `LeadRequest`, including English `input.product`
and the existing normalized fields; already planned desktop requests are not planned twice.
The HTTP layer does not invent a separate normalized lead schema.

Contact enrichment accepts the minimal aliases below; native fills the remaining fields
with defaults:

```json
{"kind":"contacts","input":{"companyName":"Sample Company","website":"https://sample.invalid"},"idempotency_key":"contacts-example-1"}
```

These business mappings and the encrypted planning cache belong to the native adapter,
not to this crate's mock backend or a second planning implementation.

## Native host startup

The existing native executable supports `--research-api` without opening the desktop
window or starting mailbox synchronization. This mode still uses the same native backend,
encrypted profile repository, and research engine. It requires `PEBBLE_PROFILE_DIR` to
be an **absolute path to an already initialized dedicated profile directory**. Initialize
the profile and provider credentials through the host's existing setup first. There is no
HTTP endpoint for profile initialization, credentials, local files, or reading mail.

In this native mode, `PEBBLE_RESEARCH_API_ADDR` defaults to `127.0.0.1:7465`. In desktop
mode the API is disabled unless `PEBBLE_RESEARCH_API_ADDR` is explicitly supplied. Both
modes require a valid `PEBBLE_RESEARCH_API_TOKEN`. Environment handling and the executable
argument are provided by native integration; this library adds no CLI or configuration
mutation. Set environment variables only for the intended launch process and use a private
dedicated profile. Do not point a second engine at a running desktop profile's repository.
This launch mode does not add tenant isolation or change the foundation-level service scope.

## Verification

No real model, profile, data, application, or configuration is needed by the tests.
From the containing Rust workspace, after its owner has updated its lockfile:

```powershell
$env:PATH = '<MinGW installation>/bin;' + $env:PATH
$env:CARGO_TARGET_DIR = Join-Path $env:TEMP 'research-engine-check-target'
cargo check --locked -p pebble-research
cargo test --locked -p pebble-research
cargo check --locked -p pebble-research --no-default-features
```

Do not remove the shared target directory or format the rest of the workspace. To format
only this crate, use `rustfmt --edition 2021 src/lib.rs src/engine.rs src/api.rs tests/engine.rs tests/api.rs`.

Verified on Windows GNU: 17 engine tests and 7 HTTP tests, including a real loopback TCP
listener with the in-memory repository and mock backend. Default and no-default-feature
checks pass with `--locked`. Tests never call real model providers or access a user profile.
The native executable/profile/encryption integration smoke is a separate host check.
