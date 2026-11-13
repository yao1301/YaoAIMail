use crate::{JobRepository, Observer, ResearchBackend, ResearchKind, TaskRequest};
use futures_util::FutureExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{Arc, Mutex, MutexGuard, Weak},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{watch, Semaphore};

pub const MAX_JOBS: usize = 128;
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
pub const MAX_RESULT_BYTES: usize = 512 * 1024;
pub const MAX_SNAPSHOT_BYTES: usize = 256 * 1024;
pub const REPOSITORY_ERROR: &str = "research repository unavailable";
pub const INVALID_REQUEST: &str = "invalid research request";
pub const IDEMPOTENCY_CONFLICT: &str = "idempotency key conflicts with another request";
pub const RESEARCH_FAILED: &str = "research failed; check provider settings and retry";
pub const NOT_FOUND: &str = "research job not found";
pub const ARCHIVED_NOT_MUTABLE: &str = "archived research jobs cannot be modified";
const ARCHIVE_BATCH: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus { Queued, Running, Succeeded, Failed, Cancelled, Interrupted }
impl JobStatus {
    pub fn is_active(self) -> bool { matches!(self, Self::Queued | Self::Running) }
}

/// Repository records contain the original request. HTTP responses use a separate DTO.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Job {
    pub id: String,
    pub request: TaskRequest,
    pub status: JobStatus,
    pub stage: String,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub snapshot: Option<Value>,
    pub created_at: u64,
    pub updated_at: u64,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub attempts: u32,
}

struct Control {
    cancel: watch::Sender<bool>,
    completion: watch::Sender<Job>,
    observers: Vec<Observer>,
    dirty: bool,
}
struct State {
    jobs: Vec<Job>,
    controls: HashMap<String, Control>,
    closed: bool,
    storage_failed: bool,
}

/// One engine and repository per desktop profile; not a multi-tenant boundary.
pub struct Engine {
    backend: Arc<dyn ResearchBackend>,
    repo: Arc<dyn JobRepository>,
    state: Mutex<State>,
    main_slots: Arc<Semaphore>,
    contact_slots: Arc<Semaphore>,
}

#[derive(Clone)]
pub struct Progress {
    engine: Weak<Engine>,
    id: String,
    attempt: u32,
}
impl Progress {
    pub fn stage(&self, stage: &str) {
        if stage.len() > 256 || stage.chars().any(char::is_control) { return; }
        if let Some(engine) = self.engine.upgrade() {
            engine.progress(&self.id, self.attempt, Some(stage), None);
        }
    }
    pub fn snapshot(&self, value: Value) {
        if !fits(&value, MAX_SNAPSHOT_BYTES) { return; }
        if let Some(engine) = self.engine.upgrade() {
            engine.progress(&self.id, self.attempt, None, Some(value));
        }
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64
}
fn fits<T: Serialize>(value: &T, max: usize) -> bool {
    serde_json::to_vec(value).is_ok_and(|v| v.len() <= max)
}
fn valid_request(request: &TaskRequest) -> bool {
    fits(request, MAX_REQUEST_BYTES) && request.idempotency_key.as_ref().is_none_or(|k| {
        !k.is_empty() && k.len() <= 128 && !k.chars().any(char::is_control)
    })
}
fn same_request(a: &TaskRequest, b: &TaskRequest) -> bool { a.kind == b.kind && a.input == b.input }
fn valid_record(j: &Job) -> bool {
    uuid::Uuid::parse_str(&j.id).is_ok() && valid_request(&j.request) && j.attempts > 0
        && j.stage.len() <= 256 && !j.stage.chars().any(char::is_control)
        && j.error.as_ref().is_none_or(|e| e.len() <= 1024)
        && j.snapshot.as_ref().is_none_or(|v| fits(v, MAX_SNAPSHOT_BYTES))
        && j.result.as_ref().is_none_or(|v| fits(v, MAX_RESULT_BYTES))
        && (j.status != JobStatus::Succeeded || j.result.is_some())
}
fn archivable(j: &Job) -> bool {
    matches!(j.status, JobStatus::Succeeded | JobStatus::Failed | JobStatus::Cancelled)
}
fn checked_archive(job: Option<Job>) -> Result<Option<Job>, String> {
    let Some(mut job) = job else { return Ok(None); };
    if !valid_record(&job) || !archivable(&job) { return Err(REPOSITORY_ERROR.into()); }
    if job.error.as_ref().is_some_and(|e| e != RESEARCH_FAILED && e != REPOSITORY_ERROR) {
        job.error = Some(RESEARCH_FAILED.into());
    }
    Ok(Some(job))
}
fn outcome(job: &Job) -> Result<Value, String> {
    match job.status {
        JobStatus::Succeeded => job.result.clone().ok_or_else(|| RESEARCH_FAILED.into()),
        JobStatus::Failed => Err(RESEARCH_FAILED.into()),
        JobStatus::Cancelled => Err("research cancelled".into()),
        _ => Err("research interrupted; explicitly resume the job".into()),
    }
}

impl Engine {
    pub fn new(backend: Arc<dyn ResearchBackend>, repo: Arc<dyn JobRepository>) -> Result<Arc<Self>, String> {
        Self::new_with_limits(backend,repo,2,1)
    }
    /// Host-level defaults, not end-user configuration. Keep each class bounded.
    pub fn new_with_limits(backend:Arc<dyn ResearchBackend>,repo:Arc<dyn JobRepository>,main:usize,contacts:usize)->Result<Arc<Self>,String>{
        if !(1..=4).contains(&main)||!(1..=4).contains(&contacts){return Err("invalid research concurrency limits".into());}
        let mut jobs = repo.load().map_err(|_| REPOSITORY_ERROR.to_string())?;
        // Validate the entire repository before writing anything. Never discard damaged records.
        let mut ids = HashSet::new();
        let mut keys = HashSet::new();
        if jobs.len() > MAX_JOBS || jobs.iter().any(|j| {
            !valid_record(j) || !ids.insert(j.id.clone())
                || j.request.idempotency_key.as_ref().is_some_and(|k| !keys.insert(k.clone()))
        }) { return Err("research repository is invalid; preserve it for recovery".into()); }
        let mut changed = false;
        for job in &mut jobs {
            // Errors loaded from older adapters must not become an error-secret disclosure path.
            if job.error.as_ref().is_some_and(|e| e != RESEARCH_FAILED && e != REPOSITORY_ERROR) {
                job.error = Some(RESEARCH_FAILED.into());
                changed = true;
            }
            if job.status.is_active() {
                job.status = JobStatus::Interrupted;
                job.stage = "interrupted".into();
                job.updated_at = now();
                job.finished_at = Some(job.updated_at);
                changed = true;
            }
        }
        if changed { repo.save(&jobs).map_err(|_| REPOSITORY_ERROR.to_string())?; }
        Ok(Arc::new(Self {
            backend, repo,
            state: Mutex::new(State { jobs, controls: HashMap::new(), closed: false, storage_failed: false }),
            main_slots: Arc::new(Semaphore::new(main)),
            contact_slots: Arc::new(Semaphore::new(contacts)),
        }))
    }

    fn lock(&self) -> Result<MutexGuard<'_, State>, String> {
        self.state.lock().map_err(|_| "research state unavailable".into())
    }
    // All saves are serialized under the state mutex, never held across an await. Repositories
    // must atomically replace the full record set and must not re-enter the engine.
    fn persist(&self, state: &mut State) -> Result<(), String> {
        if self.repo.save(&state.jobs).is_ok() { return Ok(()); }
        Self::storage_failure(state)
    }
    fn storage_failure(state: &mut State) -> Result<(), String> {
        state.storage_failed = true;
        for job in &mut state.jobs {
            if job.status.is_active() || state.controls.contains_key(&job.id) {
                job.status = JobStatus::Interrupted;
                job.stage = "storage_unavailable".into();
                job.error = Some(REPOSITORY_ERROR.into());
                job.result = None;
                job.updated_at = now();
                job.finished_at = Some(job.updated_at);
            }
            if let Some(control) = state.controls.get(&job.id) {
                control.cancel.send_replace(true);
                control.completion.send_replace(job.clone());
            }
        }
        state.controls.clear();
        Err(REPOSITORY_ERROR.into())
    }
    fn archived_by_id(&self, id: &str) -> Result<Option<Job>, String> {
        let job = checked_archive(self.repo.get_archived(id).map_err(|_| REPOSITORY_ERROR.to_string())?)?;
        if job.as_ref().is_some_and(|j| j.id != id) { return Err(REPOSITORY_ERROR.into()); }
        Ok(job)
    }
    fn archived_by_key(&self, key: &str) -> Result<Option<Job>, String> {
        let job = checked_archive(self.repo.find_archived_idempotency(key).map_err(|_| REPOSITORY_ERROR.to_string())?)?;
        if job.as_ref().is_some_and(|j| j.request.idempotency_key.as_deref() != Some(key)) {
            return Err(REPOSITORY_ERROR.into());
        }
        Ok(job)
    }
    fn make_room(&self, state: &mut State) -> Result<(), String> {
        if state.jobs.len() < MAX_JOBS { return Ok(()); }
        let mut candidates: Vec<Job> = state.jobs.iter().filter(|j| archivable(j)).cloned().collect();
        candidates.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
        candidates.truncate(ARCHIVE_BATCH);
        if candidates.is_empty() { return Err("research job capacity reached".into()); }
        // A failed or unsupported archive must never remove live history.
        self.repo.archive(&candidates).map_err(|_| "research job capacity reached".to_string())?;
        let ids: HashSet<&str> = candidates.iter().map(|j| j.id.as_str()).collect();
        let remaining: Vec<Job> = state.jobs.iter().filter(|j| !ids.contains(j.id.as_str())).cloned().collect();
        // Keep the original in-memory live records until the live replacement commits.
        // If saving fails, durable archive copies may coexist with live records; live wins.
        if self.repo.save(&remaining).is_err() { return Self::storage_failure(state); }
        state.jobs = remaining;
        Ok(())
    }
    fn available(state: &State) -> Result<(), String> {
        if state.closed { return Err("research engine is shut down".into()); }
        if state.storage_failed { return Err(REPOSITORY_ERROR.into()); }
        Ok(())
    }

    pub fn submit(self: &Arc<Self>, request: TaskRequest) -> Result<Job, String> {
        self.submit_observed(request, None).map(|(job, _)| job)
    }
    fn submit_observed(self: &Arc<Self>, request: TaskRequest, observer: Option<Observer>) -> Result<(Job, watch::Receiver<Job>), String> {
        if !valid_request(&request) { return Err(INVALID_REQUEST.into()); }
        let handle = tokio::runtime::Handle::try_current().map_err(|_| "research requires a Tokio runtime".to_string())?;
        let mut state = self.lock()?;
        Self::available(&state)?;
        if let Some(key) = request.idempotency_key.as_ref() {
            if let Some(existing) = state.jobs.iter().find(|j| j.request.idempotency_key.as_ref() == Some(key)).cloned() {
                if !same_request(&existing.request, &request) { return Err(IDEMPOTENCY_CONFLICT.into()); }
                let rx = if let Some(control) = state.controls.get_mut(&existing.id) {
                    if let Some(observer) = observer {
                        if control.observers.len() >= 32 { return Err("too many research observers".into()); }
                        control.observers.push(observer);
                    }
                    control.completion.subscribe()
                } else { watch::channel(existing.clone()).1 };
                return Ok((existing, rx));
            }
            if let Some(existing) = self.archived_by_key(key)? {
                if !same_request(&existing.request, &request) { return Err(IDEMPOTENCY_CONFLICT.into()); }
                let rx = watch::channel(existing.clone()).1;
                return Ok((existing, rx));
            }
        }
        // Validation is synchronous and must be cheap, side-effect-free, and non-reentrant.
        if catch_unwind(AssertUnwindSafe(|| self.backend.validate(&request))).ok().is_none_or(|r| r.is_err()) {
            return Err(INVALID_REQUEST.into());
        }
        self.make_room(&mut state)?;
        let timestamp = now();
        let job = Job {
            id: uuid::Uuid::new_v4().to_string(), request, status: JobStatus::Queued,
            stage: "queued".into(), result: None, error: None, snapshot: None,
            created_at: timestamp, updated_at: timestamp, started_at: None, finished_at: None, attempts: 1,
        };
        state.jobs.push(job.clone());
        self.persist(&mut state)?;
        let rx = Self::attach(&mut state, &job, observer);
        let cancel = state.controls[&job.id].cancel.subscribe();
        // Spawn only after durable acceptance, while the mutex prevents a cancellation race.
        self.spawn(&handle, job.clone(), cancel);
        Ok((job, rx))
    }
    fn attach(state: &mut State, job: &Job, observer: Option<Observer>) -> watch::Receiver<Job> {
        let (completion, rx) = watch::channel(job.clone());
        state.controls.insert(job.id.clone(), Control {
            cancel: watch::channel(false).0, completion, observers: observer.into_iter().collect(), dirty: false,
        });
        rx
    }

    pub async fn execute(self: &Arc<Self>, request: TaskRequest, observer: Option<Observer>) -> Result<Value, String> {
        let (_, mut rx) = self.submit_observed(request, observer)?;
        loop {
            let job = rx.borrow_and_update().clone();
            if !job.status.is_active() { return outcome(&job); }
            if rx.changed().await.is_err() { return Err("research interrupted".into()); }
        }
    }

    pub fn get(&self, id: &str) -> Result<Option<Job>, String> {
        let state = self.lock()?;
        if let Some(job) = state.jobs.iter().find(|j| j.id == id) { return Ok(Some(job.clone())); }
        self.archived_by_id(id)
    }
    /// Returns redacted live copies only; archives remain accessible through `get`.
    /// The repository is always saved from the internal full records.
    pub fn list(&self) -> Result<Vec<Job>, String> {
        Ok(self.lock()?.jobs.iter().map(|j| {
            let mut j = j.clone();
            j.request.input = Value::Null;
            j.request.idempotency_key = None;
            j.result = None;
            j.snapshot = None;
            j
        }).collect())
    }
    pub fn cancel(&self, id: &str) -> Result<Job, String> {
        let mut state = self.lock()?;
        if !state.jobs.iter().any(|j| j.id == id) && self.archived_by_id(id)?.is_some() {
            return Err(ARCHIVED_NOT_MUTABLE.into());
        }
        let job = state.jobs.iter_mut().find(|j| j.id == id).ok_or_else(|| NOT_FOUND.to_string())?;
        if !job.status.is_active() { return Ok(job.clone()); }
        job.status = JobStatus::Cancelled;
        job.stage = "cancelled".into();
        job.updated_at = now();
        job.finished_at = Some(job.updated_at);
        let job = job.clone();
        if let Some(control) = state.controls.remove(id) {
            control.cancel.send_replace(true);
            control.completion.send_replace(job.clone());
        }
        self.persist(&mut state)?;
        Ok(job)
    }
    pub fn resume(self: &Arc<Self>, id: &str) -> Result<Job, String> {
        let handle = tokio::runtime::Handle::try_current().map_err(|_| "research requires a Tokio runtime".to_string())?;
        let mut state = self.lock()?;
        Self::available(&state)?;
        if !state.jobs.iter().any(|j| j.id == id) && self.archived_by_id(id)?.is_some() {
            return Err(ARCHIVED_NOT_MUTABLE.into());
        }
        let job = state.jobs.iter_mut().find(|j| j.id == id).ok_or_else(|| NOT_FOUND.to_string())?;
        if !matches!(job.status, JobStatus::Interrupted | JobStatus::Cancelled | JobStatus::Failed) {
            return Err("research job cannot be resumed in its current state".into());
        }
        if catch_unwind(AssertUnwindSafe(|| self.backend.validate(&job.request))).ok().is_none_or(|r| r.is_err()) {
            return Err(INVALID_REQUEST.into());
        }
        job.attempts = job.attempts.checked_add(1).ok_or_else(|| "research attempt limit reached".to_string())?;
        job.status = JobStatus::Queued;
        job.stage = "queued".into();
        job.result = None;
        job.error = None;
        job.started_at = None;
        job.finished_at = None;
        job.updated_at = now();
        let job = job.clone();
        self.persist(&mut state)?;
        Self::attach(&mut state, &job, None);
        let cancel = state.controls[id].cancel.subscribe();
        self.spawn(&handle, job.clone(), cancel);
        Ok(job)
    }

    fn spawn(self: &Arc<Self>, handle: &tokio::runtime::Handle, job: Job, mut cancel: watch::Receiver<bool>) {
        let weak = Arc::downgrade(self);
        let backend = self.backend.clone();
        let slots = if job.request.kind == ResearchKind::Contacts { self.contact_slots.clone() } else { self.main_slots.clone() };
        handle.spawn(async move {
            let permit = tokio::select! {
                biased;
                _ = cancelled(&mut cancel) => return,
                permit = slots.acquire_owned() => match permit { Ok(p) => p, Err(_) => return },
            };
            let started = weak.upgrade().is_some_and(|e| e.start(&job.id, job.attempts));
            if !started { return; }
            let progress = Progress { engine: weak.clone(), id: job.id.clone(), attempt: job.attempts };
            let run = AssertUnwindSafe(async { backend.run(job.request.clone(), progress).await }).catch_unwind();
            tokio::pin!(run);
            let mut timer = tokio::time::interval(Duration::from_secs(1));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    biased;
                    _ = cancelled(&mut cancel) => break,
                    result = &mut run => {
                        if let Some(engine) = weak.upgrade() {
                            engine.finish(&job.id, job.attempts, result.unwrap_or_else(|_| Err(RESEARCH_FAILED.into())));
                        }
                        break;
                    }
                    _ = timer.tick() => {
                        if let Some(engine) = weak.upgrade() { engine.flush(&job.id, job.attempts); }
                        else { break; }
                    }
                }
            }
            drop(permit);
            // `run` is dropped here on cancellation, aborting the backend future.
        });
    }
    fn start(&self, id: &str, attempt: u32) -> bool {
        let Ok(mut state) = self.lock() else { return false; };
        if Self::available(&state).is_err() { return false; }
        let Some(job) = state.jobs.iter_mut().find(|j| j.id == id && j.attempts == attempt && j.status == JobStatus::Queued) else { return false; };
        job.status = JobStatus::Running;
        job.stage = "running".into();
        job.updated_at = now();
        job.started_at = Some(job.updated_at);
        let job = job.clone();
        if self.persist(&mut state).is_err() { return false; }
        if let Some(control) = state.controls.get(id) { control.completion.send_replace(job); }
        true
    }
    fn progress(&self, id: &str, attempt: u32, stage: Option<&str>, snapshot: Option<Value>) {
        let observers;
        let event;
        {
            let Ok(mut state) = self.lock() else { return; };
            let Some(job) = state.jobs.iter_mut().find(|j| j.id == id && j.attempts == attempt && j.status == JobStatus::Running) else { return; };
            event = if let Some(stage) = stage {
                job.stage = stage.into();
                if job.request.kind == ResearchKind::Company { Value::String(stage.into()) }
                else { json!({"stage": stage}) }
            } else if let Some(value) = snapshot {
                job.snapshot = Some(value.clone());
                value
            } else { return; };
            job.updated_at = now();
            let Some(control) = state.controls.get_mut(id) else { return; };
            control.dirty = true;
            observers = control.observers.clone();
        }
        // User code is invoked without the engine mutex. A faulty observer cannot fail the job.
        for observer in observers { let _ = catch_unwind(AssertUnwindSafe(|| observer(event.clone()))); }
    }
    fn flush(&self, id: &str, attempt: u32) {
        let Ok(mut state) = self.lock() else { return; };
        if !state.jobs.iter().any(|j| j.id == id && j.attempts == attempt && j.status == JobStatus::Running) { return; }
        if let Some(control) = state.controls.get_mut(id) {
            if !control.dirty { return; }
            control.dirty = false;
            let _ = self.persist(&mut state);
        }
    }
    fn finish(&self, id: &str, attempt: u32, result: Result<Value, String>) {
        let Ok(mut state) = self.lock() else { return; };
        let Some(job) = state.jobs.iter_mut().find(|j| j.id == id && j.attempts == attempt && j.status == JobStatus::Running) else { return; };
        match result {
            Ok(result) if fits(&result, MAX_RESULT_BYTES) => { job.status = JobStatus::Succeeded; job.result = Some(result); job.error = None; }
            _ => { job.status = JobStatus::Failed; job.error = Some(RESEARCH_FAILED.into()); }
        }
        job.stage = if job.status == JobStatus::Succeeded { "succeeded" } else { "failed" }.into();
        job.updated_at = now();
        job.finished_at = Some(job.updated_at);
        let job = job.clone();
        // Publish a success only after persistence. If saving fails, report interruption instead.
        if self.persist(&mut state).is_err() {
            if let Some(stored) = state.jobs.iter_mut().find(|j| j.id == id) {
                stored.status = JobStatus::Interrupted;
                stored.error = Some(REPOSITORY_ERROR.into());
                stored.result = None;
            }
            return;
        }
        if let Some(control) = state.controls.remove(id) { control.completion.send_replace(job); }
    }
    /// Interrupts work, persists checkpoints, and signals cancellation. Does not await workers.
    pub fn shutdown(&self) -> Result<(), String> {
        let mut guard = self.lock()?;
        let state = &mut *guard;
        if state.closed { return Ok(()); }
        state.closed = true;
        let mut changed = false;
        for job in &mut state.jobs {
            if job.status.is_active() {
                changed = true;
                job.status = JobStatus::Interrupted;
                job.stage = "interrupted".into();
                job.updated_at = now();
                job.finished_at = Some(job.updated_at);
                if let Some(control) = state.controls.get(&job.id) {
                    control.cancel.send_replace(true);
                    control.completion.send_replace(job.clone());
                }
            }
        }
        state.controls.clear();
        if changed { self.persist(state)?; }
        Ok(())
    }
}
impl Drop for Engine {
    fn drop(&mut self) { let _ = self.shutdown(); }
}
async fn cancelled(rx: &mut watch::Receiver<bool>) {
    loop {
        if *rx.borrow_and_update() { return; }
        if rx.changed().await.is_err() { return; }
    }
}
