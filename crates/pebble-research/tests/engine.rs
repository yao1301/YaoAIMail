use pebble_research::*;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, Semaphore};

#[derive(Default)]
struct MemoryRepo {
    jobs: Mutex<Vec<Job>>,
    saves: AtomicUsize,
    fail_load: AtomicBool,
    fail_save: AtomicBool,
}
#[derive(Default)]
struct ArchiveRepo {
    live: MemoryRepo,
    archived: Mutex<Vec<Job>>,
    fail_archive: AtomicBool,
    fail_archive_lookup: AtomicBool,
}
impl JobRepository for ArchiveRepo {
    fn load(&self) -> Result<Vec<Job>, String> { self.live.load() }
    fn save(&self, jobs: &[Job]) -> Result<(), String> { self.live.save(jobs) }
    fn archive(&self, jobs: &[Job]) -> Result<(), String> {
        if self.fail_archive.load(Ordering::SeqCst) { return Err("private archive credential".into()); }
        let mut archived = self.archived.lock().unwrap();
        for job in jobs {
            if let Some(existing) = archived.iter_mut().find(|j| j.id == job.id) { *existing = job.clone(); }
            else { archived.push(job.clone()); }
        }
        Ok(())
    }
    fn get_archived(&self, id: &str) -> Result<Option<Job>, String> {
        if self.fail_archive_lookup.load(Ordering::SeqCst) { return Err("private archive credential".into()); }
        Ok(self.archived.lock().unwrap().iter().find(|j| j.id == id).cloned())
    }
    fn find_archived_idempotency(&self, key: &str) -> Result<Option<Job>, String> {
        if self.fail_archive_lookup.load(Ordering::SeqCst) { return Err("private archive credential".into()); }
        Ok(self.archived.lock().unwrap().iter().find(|j| j.request.idempotency_key.as_deref() == Some(key)).cloned())
    }
}
impl JobRepository for MemoryRepo {
    fn load(&self) -> Result<Vec<Job>, String> {
        if self.fail_load.load(Ordering::SeqCst) { return Err("private repository credential".into()); }
        Ok(self.jobs.lock().unwrap().clone())
    }
    fn save(&self, jobs: &[Job]) -> Result<(), String> {
        self.saves.fetch_add(1, Ordering::SeqCst);
        if self.fail_save.load(Ordering::SeqCst) { return Err("private repository credential".into()); }
        *self.jobs.lock().unwrap() = jobs.to_vec();
        Ok(())
    }
}
struct Backend {
    started: mpsc::UnboundedSender<TaskRequest>,
    gate: Arc<Semaphore>,
    active: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
    calls: AtomicUsize,
    progress: Mutex<Vec<Progress>>,
}
struct Active(Arc<AtomicUsize>, Arc<AtomicUsize>);
impl Drop for Active {
    fn drop(&mut self) { self.0.fetch_sub(1, Ordering::SeqCst); self.1.fetch_add(1, Ordering::SeqCst); }
}
impl ResearchBackend for Backend {
    fn validate(&self, r: &TaskRequest) -> Result<(), String> {
        if r.input["invalid"] == true { Err("private validation secret".into()) } else { Ok(()) }
    }
    fn run(&self, r: TaskRequest, p: Progress) -> BoxFuture<'_, Result<Value, String>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.active.fetch_add(1, Ordering::SeqCst);
            let _active = Active(self.active.clone(), self.dropped.clone());
            self.progress.lock().unwrap().push(p.clone());
            p.stage("searching");
            p.snapshot(json!({"found": 1}));
            self.started.send(r.clone()).unwrap();
            self.gate.acquire().await.unwrap().forget();
            p.stage("late_stage");
            if r.input["fail"] == true { return Err("API_KEY=DO_NOT_EXPOSE".into()); }
            if r.input["panic"] == true { panic!("simulated provider panic"); }
            if r.input["oversized"] == true { return Ok(Value::String("x".repeat(513 * 1024))); }
            Ok(json!({"ok": true}))
        })
    }
}
fn setup() -> (Arc<Engine>, Arc<Backend>, Arc<MemoryRepo>, mpsc::UnboundedReceiver<TaskRequest>) {
    let (started, rx) = mpsc::unbounded_channel();
    let backend = Arc::new(Backend { started, gate: Arc::new(Semaphore::new(0)), active: Arc::default(), dropped: Arc::default(), calls: AtomicUsize::new(0), progress: Mutex::default() });
    let repo = Arc::new(MemoryRepo::default());
    let engine = Engine::new(backend.clone(), repo.clone()).unwrap();
    (engine, backend, repo, rx)
}
fn request(kind: ResearchKind, name: &str) -> TaskRequest {
    TaskRequest { kind, input: json!({"query": name}), idempotency_key: None }
}
async fn started(rx: &mut mpsc::UnboundedReceiver<TaskRequest>) -> TaskRequest {
    tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.unwrap().unwrap()
}
async fn terminal(engine: &Engine, id: &str) -> Job {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let j = engine.get(id).unwrap().unwrap();
            if !j.status.is_active() { return j; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap()
}
async fn dropped(backend: &Backend, count: usize) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while backend.dropped.load(Ordering::SeqCst) < count { tokio::task::yield_now().await; }
    }).await.unwrap();
}

#[tokio::test]
async fn persists_full_request_but_lists_redacted_copies() {
    let (engine, backend, repo, mut rx) = setup();
    let mut r = request(ResearchKind::Leads, "private input");
    r.idempotency_key = Some("private-key".into());
    let job = engine.submit(r.clone()).unwrap();
    assert_eq!(job.status, JobStatus::Queued);
    assert_eq!(repo.jobs.lock().unwrap()[0].request, r);
    started(&mut rx).await;
    backend.gate.add_permits(1);
    let done = terminal(&engine, &job.id).await;
    assert_eq!(done.status, JobStatus::Succeeded);
    assert_eq!(done.result, Some(json!({"ok": true})));
    assert!(done.finished_at.is_some());
    let list = engine.list().unwrap();
    assert!(list[0].request.input.is_null());
    assert!(list[0].request.idempotency_key.is_none());
    assert!(list[0].result.is_none() && list[0].snapshot.is_none());
    let encoded = serde_json::to_vec(&repo.jobs.lock().unwrap()[0]).unwrap();
    let decoded: Job = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(decoded.request, r);
    assert_eq!(engine.get(&job.id).unwrap().unwrap().request, r);
}

#[tokio::test]
async fn native_host_can_preserve_three_contact_slots_without_unbounding_the_queue(){
    let (_,backend,repo,mut rx)=setup();
    assert!(Engine::new_with_limits(backend.clone(),repo.clone(),0,3).is_err());
    assert!(Engine::new_with_limits(backend.clone(),repo.clone(),2,5).is_err());
    let engine=Engine::new_with_limits(backend.clone(),repo,2,3).unwrap();
    let jobs=(0..4).map(|n|engine.submit(request(ResearchKind::Contacts,&format!("native-{n}"))).unwrap()).collect::<Vec<_>>();
    for _ in 0..3{started(&mut rx).await;}
    assert_eq!(backend.active.load(Ordering::SeqCst),3);
    assert_eq!(engine.get(&jobs[3].id).unwrap().unwrap().status,JobStatus::Queued);
    engine.cancel(&jobs[3].id).unwrap();backend.gate.add_permits(3);
    for job in jobs.iter().take(3){terminal(&engine,&job.id).await;}
}

#[tokio::test]
async fn bounded_queue_reserves_contacts_and_cancels_queued_work() {
    let (engine, backend, _, mut rx) = setup();
    let a = engine.submit(request(ResearchKind::Leads, "a")).unwrap();
    let b = engine.submit(request(ResearchKind::Company, "b")).unwrap();
    let c = engine.submit(request(ResearchKind::Leads, "c")).unwrap();
    let d = engine.submit(request(ResearchKind::Contacts, "d")).unwrap();
    let e = engine.submit(request(ResearchKind::Contacts, "e")).unwrap();
    let mut names = HashSet::new();
    for _ in 0..3 { names.insert(started(&mut rx).await.input["query"].as_str().unwrap().to_owned()); }
    assert_eq!(names, HashSet::from(["a".into(), "b".into(), "d".into()]));
    assert_eq!(backend.active.load(Ordering::SeqCst), 3);
    assert_eq!(engine.get(&c.id).unwrap().unwrap().status, JobStatus::Queued);
    assert_eq!(engine.get(&e.id).unwrap().unwrap().status, JobStatus::Queued);
    engine.cancel(&c.id).unwrap();
    engine.cancel(&e.id).unwrap();
    engine.cancel(&a.id).unwrap();
    dropped(&backend, 1).await;
    assert!(rx.try_recv().is_err());
    backend.gate.add_permits(2);
    terminal(&engine, &b.id).await;
    terminal(&engine, &d.id).await;
    assert_eq!(backend.calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn cancellation_drops_future_and_fences_old_progress_after_resume() {
    let (engine, backend, _, mut rx) = setup();
    let job = engine.submit(request(ResearchKind::Company, "cancel")).unwrap();
    started(&mut rx).await;
    let old_progress = backend.progress.lock().unwrap()[0].clone();
    assert_eq!(engine.cancel(&job.id).unwrap().status, JobStatus::Cancelled);
    dropped(&backend, 1).await;
    old_progress.stage("must_not_write");
    old_progress.snapshot(json!({"old": true}));
    let resumed = engine.resume(&job.id).unwrap();
    assert_eq!(resumed.attempts, 2);
    started(&mut rx).await;
    old_progress.stage("stale_attempt");
    assert_eq!(engine.get(&job.id).unwrap().unwrap().stage, "searching");
    backend.gate.add_permits(1);
    assert_eq!(terminal(&engine, &job.id).await.status, JobStatus::Succeeded);
}

#[tokio::test]
async fn idempotency_reuses_active_and_completed_jobs_and_conflicts() {
    let (engine, backend, _, mut rx) = setup();
    let mut r = request(ResearchKind::Leads, "same");
    r.idempotency_key = Some("request-1".into());
    let first = engine.submit(r.clone()).unwrap();
    assert_eq!(engine.submit(r.clone()).unwrap().id, first.id);
    let mut other = r.clone();
    other.input = json!({"query": "different"});
    assert!(engine.submit(other).unwrap_err().contains("conflict"));
    started(&mut rx).await;
    backend.gate.add_permits(1);
    terminal(&engine, &first.id).await;
    assert_eq!(engine.execute(r, None).await.unwrap(), json!({"ok": true}));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn restart_marks_queued_and_running_interrupted_without_auto_run() {
    let (engine, backend, repo, mut rx) = setup();
    let first = engine.submit(request(ResearchKind::Leads, "first")).unwrap();
    let second = engine.submit(request(ResearchKind::Company, "second")).unwrap();
    let third = engine.submit(request(ResearchKind::Leads, "third")).unwrap();
    started(&mut rx).await;
    started(&mut rx).await;
    // A repository snapshot models abrupt process termination, before Drop cleanup.
    let recovered = Arc::new(MemoryRepo::default());
    *recovered.jobs.lock().unwrap() = repo.load().unwrap();
    engine.shutdown().unwrap();
    dropped(&backend, 2).await;
    let next = Engine::new(backend.clone(), recovered.clone()).unwrap();
    for id in [&first.id, &second.id, &third.id] {
        assert_eq!(next.get(id).unwrap().unwrap().status, JobStatus::Interrupted);
    }
    tokio::task::yield_now().await;
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    assert!(rx.try_recv().is_err());
    next.resume(&third.id).unwrap();
    assert_eq!(started(&mut rx).await.input["query"], "third");
    backend.gate.add_permits(1);
    assert_eq!(terminal(&next, &third.id).await.status, JobStatus::Succeeded);
}

#[tokio::test]
async fn shutdown_and_drop_interrupt_work_and_preserve_checkpoint() {
    let (engine, backend, repo, mut rx) = setup();
    let job = engine.submit(request(ResearchKind::Leads, "drop")).unwrap();
    started(&mut rx).await;
    let weak = Arc::downgrade(&engine);
    drop(engine);
    assert!(weak.upgrade().is_none());
    dropped(&backend, 1).await;
    let saved = repo.load().unwrap();
    assert_eq!(saved[0].id, job.id);
    assert_eq!(saved[0].status, JobStatus::Interrupted);
    assert_eq!(saved[0].snapshot, Some(json!({"found": 1})));
}

#[tokio::test]
async fn backend_failure_panic_and_oversized_result_are_safe() {
    for field in ["fail", "panic", "oversized"] {
        let (engine, backend, _, mut rx) = setup();
        let r = TaskRequest { kind: ResearchKind::Leads, input: json!({(field): true}), idempotency_key: Some("failed".into()) };
        let job = engine.submit(r.clone()).unwrap();
        started(&mut rx).await;
        backend.gate.add_permits(1);
        let failed = terminal(&engine, &job.id).await;
        assert_eq!(failed.status, JobStatus::Failed, "{field}");
        assert!(!failed.error.unwrap().contains("API_KEY"));
        assert!(!engine.execute(r, None).await.unwrap_err().contains("API_KEY"));
    }
}

#[tokio::test]
async fn rejects_invalid_requests_and_full_history_without_pruning() {
    let (engine, backend, repo, _) = setup();
    let mut invalid = request(ResearchKind::Leads, "invalid");
    invalid.input = json!({"invalid": true});
    assert_eq!(engine.submit(invalid.clone()).unwrap_err(), "invalid research request");
    invalid.input = Value::String("x".repeat(64 * 1024));
    assert!(engine.submit(invalid.clone()).is_err());
    invalid.input = json!({});
    invalid.idempotency_key = Some("\n".into());
    assert!(engine.submit(invalid).is_err());
    let first = engine.submit(request(ResearchKind::Leads, "seed")).unwrap();
    engine.shutdown().unwrap();
    let mut saved = repo.load().unwrap();
    for _ in 1..128 {
        let mut job = saved[0].clone(); job.id = uuid::Uuid::new_v4().to_string(); saved.push(job);
    }
    *repo.jobs.lock().unwrap() = saved.clone();
    let next = Engine::new(backend, repo.clone()).unwrap();
    assert!(next.submit(request(ResearchKind::Leads, "capacity")).unwrap_err().contains("capacity"));
    assert_eq!(repo.load().unwrap(), saved);
    assert_eq!(next.get(&first.id).unwrap().unwrap().request.input["query"], "seed");
}

#[tokio::test]
async fn corrupt_and_unavailable_repositories_are_preserved_and_sanitized() {
    let (engine, backend, repo, _) = setup();
    repo.fail_load.store(true, Ordering::SeqCst);
    let error = Engine::new(backend.clone(), repo.clone()).err().unwrap();
    assert!(!error.contains("credential"));
    repo.fail_load.store(false, Ordering::SeqCst);
    let job = engine.submit(request(ResearchKind::Leads, "valid")).unwrap();
    engine.shutdown().unwrap();
    let mut invalid = repo.load().unwrap();
    invalid.push(invalid[0].clone());
    *repo.jobs.lock().unwrap() = invalid.clone();
    let saves = repo.saves.load(Ordering::SeqCst);
    assert!(Engine::new(backend.clone(), repo.clone()).is_err());
    assert_eq!(*repo.jobs.lock().unwrap(), invalid);
    assert_eq!(repo.saves.load(Ordering::SeqCst), saves);
    repo.jobs.lock().unwrap().truncate(1);
    repo.fail_save.store(true, Ordering::SeqCst);
    let next = Engine::new(backend, repo.clone()).unwrap();
    assert!(!next.resume(&job.id).unwrap_err().contains("credential"));
    assert!(next.submit(request(ResearchKind::Leads, "blocked")).is_err());
}

#[tokio::test(start_paused = true)]
async fn progress_callbacks_keep_shapes_and_checkpoint_writes_are_throttled() {
    let (engine, backend, repo, mut rx) = setup();
    let events = Arc::new(Mutex::new(Vec::new()));
    let out = events.clone();
    let e = engine.clone();
    let execute = tokio::spawn(async move {
        e.execute(request(ResearchKind::Company, "progress"), Some(Arc::new(move |v| { out.lock().unwrap().push(v); }))).await
    });
    rx.recv().await.unwrap();
    tokio::task::yield_now().await;
    let progress = backend.progress.lock().unwrap()[0].clone();
    let before = repo.saves.load(Ordering::SeqCst);
    for i in 0..100 { progress.snapshot(json!({"found": i})); }
    assert_eq!(repo.saves.load(Ordering::SeqCst), before);
    tokio::time::advance(Duration::from_millis(1100)).await;
    tokio::task::yield_now().await;
    assert_eq!(repo.saves.load(Ordering::SeqCst), before + 1);
    assert_eq!(repo.load().unwrap()[0].snapshot, Some(json!({"found": 99})));
    assert!(events.lock().unwrap().contains(&Value::String("searching".into())));
    assert!(events.lock().unwrap().contains(&json!({"found": 99})));
    backend.gate.add_permits(1);
    assert!(execute.await.unwrap().is_ok());
}

#[tokio::test]
async fn save_failure_during_completion_never_reports_success() {
    let (engine, backend, repo, mut rx) = setup();
    let mut r = request(ResearchKind::Leads, "save-fail");
    r.idempotency_key = Some("save-fail".into());
    let job = engine.submit(r.clone()).unwrap();
    started(&mut rx).await;
    repo.fail_save.store(true, Ordering::SeqCst);
    backend.gate.add_permits(1);
    assert_eq!(terminal(&engine, &job.id).await.status, JobStatus::Interrupted);
    assert!(engine.get(&job.id).unwrap().unwrap().result.is_none());
    assert!(engine.execute(r, None).await.is_err());
}

#[tokio::test]
async fn in_flight_execute_observes_persistence_failure_instead_of_success() {
    let (engine, backend, repo, mut rx) = setup();
    let e = engine.clone();
    let task = tokio::spawn(async move { e.execute(request(ResearchKind::Leads, "durability"), None).await });
    started(&mut rx).await;
    repo.fail_save.store(true, Ordering::SeqCst);
    backend.gate.add_permits(1);
    let result = tokio::time::timeout(Duration::from_secs(3), task).await.unwrap().unwrap();
    assert!(result.is_err());
    let job = engine.list().unwrap().pop().unwrap();
    assert_eq!(job.status, JobStatus::Interrupted);
    assert!(job.result.is_none());
}

#[tokio::test]
async fn reentrant_leads_observer_can_cancel_and_prevent_a_late_success() {
    let (engine, backend, _, mut rx) = setup();
    let e = engine.clone();
    let weak = Arc::downgrade(&engine);
    let events = Arc::new(Mutex::new(Vec::new()));
    let out = events.clone();
    let task = tokio::spawn(async move {
        e.execute(request(ResearchKind::Leads, "observer-cancel"), Some(Arc::new(move |event| {
            out.lock().unwrap().push(event.clone());
            if event == json!({"stage": "late_stage"}) {
                let engine = weak.upgrade().unwrap();
                let job = engine.list().unwrap().pop().unwrap();
                engine.cancel(&job.id).unwrap();
            }
        }))).await
    });
    started(&mut rx).await;
    backend.gate.add_permits(1);
    assert!(task.await.unwrap().unwrap_err().contains("cancelled"));
    let job = engine.list().unwrap().pop().unwrap();
    assert_eq!(job.status, JobStatus::Cancelled);
    assert!(job.result.is_none());
    assert!(events.lock().unwrap().contains(&json!({"stage": "searching"})));
}

fn saved_job(index: usize, status: JobStatus) -> Job {
    Job {
        id: uuid::Uuid::new_v4().to_string(),
        request: TaskRequest { kind: ResearchKind::Leads, input: json!({"query": index}), idempotency_key: Some(format!("seed-{index}")) },
        status, stage: "saved".into(),
        result: (status == JobStatus::Succeeded).then(|| json!({"ok": true})),
        error: (status == JobStatus::Failed).then(|| "research failed; check provider settings and retry".into()),
        snapshot: None, created_at: index as u64 + 1, updated_at: index as u64 + 1,
        started_at: Some(index as u64 + 1), finished_at: (!status.is_active()).then_some(index as u64 + 1), attempts: 1,
    }
}

#[tokio::test]
async fn automatic_archive_runs_hundreds_of_jobs_and_preserves_idempotency_across_restart() {
    let (_, backend, _, _rx) = setup();
    backend.gate.add_permits(400);
    let repo = Arc::new(ArchiveRepo::default());
    let engine = Engine::new(backend.clone(), repo.clone()).unwrap();
    for i in 0..300 {
        let r = TaskRequest { kind: ResearchKind::Contacts, input: json!({"query": i}), idempotency_key: Some(format!("contact-{i}")) };
        assert_eq!(engine.execute(r, None).await.unwrap(), json!({"ok": true}));
        assert!(engine.list().unwrap().len() <= 128);
    }
    assert_eq!(backend.calls.load(Ordering::SeqCst), 300);
    let archived = repo.archived.lock().unwrap().clone();
    assert!(!archived.is_empty());
    assert_eq!(archived.len() + repo.load().unwrap().len(), 300);
    let old = archived[0].clone();
    assert_eq!(engine.get(&old.id).unwrap().unwrap(), old);
    assert_eq!(engine.submit(old.request.clone()).unwrap().id, old.id);
    assert_eq!(engine.execute(old.request.clone(), None).await.unwrap(), old.result.clone().unwrap());
    let mut conflict = old.request.clone();
    conflict.input = json!({"query":"changed"});
    assert!(engine.submit(conflict).unwrap_err().contains("conflict"));
    assert!(engine.cancel(&old.id).unwrap_err().contains("archived"));
    assert!(engine.resume(&old.id).unwrap_err().contains("archived"));
    engine.shutdown().unwrap();
    drop(engine);
    let restarted = Engine::new(backend.clone(), repo.clone()).unwrap();
    assert_eq!(restarted.get(&old.id).unwrap().unwrap(), old);
    assert_eq!(restarted.execute(old.request, None).await.unwrap(), json!({"ok":true}));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 300);
}

#[tokio::test]
async fn archive_selects_oldest_terminal_batch_and_keeps_interrupted_running_and_queued() {
    let (_, backend, _, _rx) = setup();
    let repo = Arc::new(ArchiveRepo::default());
    let saved: Vec<Job> = (0..128).map(|i| saved_job(i, if i == 0 { JobStatus::Interrupted } else if i == 1 { JobStatus::Cancelled } else if i == 2 { JobStatus::Failed } else { JobStatus::Succeeded })).collect();
    *repo.live.jobs.lock().unwrap() = saved.clone();
    let engine = Engine::new(backend.clone(), repo.clone()).unwrap();
    engine.submit(request(ResearchKind::Leads, "new")).unwrap();
    let archived = repo.archived.lock().unwrap().clone();
    assert_eq!(archived.len(), 16);
    assert_eq!(archived.iter().map(|j| j.id.clone()).collect::<Vec<_>>(), saved[1..17].iter().map(|j| j.id.clone()).collect::<Vec<_>>());
    assert_eq!(engine.get(&saved[0].id).unwrap().unwrap().status, JobStatus::Interrupted);
    assert!(repo.load().unwrap().iter().any(|j| j.id == saved[0].id));
    engine.shutdown().unwrap();

    let (_, backend, _, mut rx) = setup();
    let repo = Arc::new(ArchiveRepo::default());
    *repo.live.jobs.lock().unwrap() = (0..125).map(|i| saved_job(i, JobStatus::Interrupted)).collect();
    let engine = Engine::new(backend, repo.clone()).unwrap();
    let a = engine.submit(request(ResearchKind::Leads, "active-a")).unwrap();
    let b = engine.submit(request(ResearchKind::Company, "active-b")).unwrap();
    let c = engine.submit(request(ResearchKind::Leads, "queued-c")).unwrap();
    started(&mut rx).await;
    started(&mut rx).await;
    assert!(engine.submit(request(ResearchKind::Contacts, "full")).unwrap_err().contains("capacity"));
    assert!(repo.archived.lock().unwrap().is_empty());
    assert_eq!(repo.load().unwrap().len(), 128);
    assert_eq!(engine.get(&a.id).unwrap().unwrap().status, JobStatus::Running);
    assert_eq!(engine.get(&b.id).unwrap().unwrap().status, JobStatus::Running);
    assert_eq!(engine.get(&c.id).unwrap().unwrap().status, JobStatus::Queued);
}

#[tokio::test]
async fn unsupported_or_failed_archive_and_failed_live_commit_never_remove_live_records() {
    let (_, backend, _, _rx) = setup();
    let saved: Vec<Job> = (0..128).map(|i| saved_job(i, JobStatus::Succeeded)).collect();
    let unsupported = Arc::new(MemoryRepo::default());
    *unsupported.jobs.lock().unwrap() = saved.clone();
    let engine = Engine::new(backend.clone(), unsupported.clone()).unwrap();
    assert!(engine.submit(request(ResearchKind::Leads, "no-support")).unwrap_err().contains("capacity"));
    assert_eq!(unsupported.load().unwrap(), saved);
    assert_eq!(engine.list().unwrap().len(), 128);
    drop(engine);

    let repo = Arc::new(ArchiveRepo::default());
    *repo.live.jobs.lock().unwrap() = saved.clone();
    repo.fail_archive.store(true, Ordering::SeqCst);
    let engine = Engine::new(backend.clone(), repo.clone()).unwrap();
    let error = engine.submit(request(ResearchKind::Leads, "archive-fails")).unwrap_err();
    assert!(!error.contains("credential"));
    assert_eq!(repo.load().unwrap(), saved);
    assert_eq!(engine.list().unwrap().len(), 128);
    repo.fail_archive.store(false, Ordering::SeqCst);
    repo.live.fail_save.store(true, Ordering::SeqCst);
    assert!(engine.submit(request(ResearchKind::Leads, "save-fails")).is_err());
    assert_eq!(repo.load().unwrap(), saved);
    assert_eq!(engine.list().unwrap().len(), 128);
    assert_eq!(repo.archived.lock().unwrap().len(), 16);
    drop(engine);

    repo.live.fail_save.store(false, Ordering::SeqCst);
    let recovered = Engine::new(backend.clone(), repo.clone()).unwrap();
    recovered.submit(request(ResearchKind::Leads, "retry-archive")).unwrap();
    assert_eq!(repo.archived.lock().unwrap().len(), 16); // repeated copy is idempotent
    assert_eq!(repo.load().unwrap().len(), 113);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn archive_lookup_errors_and_corruption_cannot_trigger_rebilling_or_clear_history() {
    let (_, backend, _, _rx) = setup();
    let repo = Arc::new(ArchiveRepo::default());
    let old = saved_job(0, JobStatus::Succeeded);
    repo.archived.lock().unwrap().push(old.clone());
    let engine = Engine::new(backend.clone(), repo.clone()).unwrap();
    repo.fail_archive_lookup.store(true, Ordering::SeqCst);
    assert!(!engine.get(&old.id).unwrap_err().contains("credential"));
    assert!(engine.submit(old.request.clone()).is_err());
    assert!(repo.load().unwrap().is_empty());
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    repo.fail_archive_lookup.store(false, Ordering::SeqCst);
    repo.archived.lock().unwrap()[0].result = None; // corrupt succeeded record
    assert!(engine.get(&old.id).is_err());
    assert!(engine.submit(old.request).is_err());
    assert_eq!(repo.archived.lock().unwrap().len(), 1);
    assert!(repo.load().unwrap().is_empty());
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
}
