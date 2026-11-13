//! Shared, single-profile research engine. See the crate README for lifecycle guarantees.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{future::Future, pin::Pin, sync::Arc};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type Observer = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResearchKind { Leads, Company, Contacts }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskRequest {
    pub kind: ResearchKind,
    pub input: Value,
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

pub trait ResearchBackend: Send + Sync {
    fn validate(&self, request: &TaskRequest) -> Result<(), String>;
    fn run(&self, request: TaskRequest, progress: Progress) -> BoxFuture<'_, Result<Value, String>>;
}
pub trait JobRepository: Send + Sync {
    fn load(&self) -> Result<Vec<Job>, String>;
    fn save(&self, jobs: &[Job]) -> Result<(), String>;
    /// Durably copy complete records to an archive before live records are removed.
    /// Must be idempotent by job ID and make both archive lookups available on success.
    fn archive(&self, _jobs: &[Job]) -> Result<(), String> {
        Err("research archive is not supported".into())
    }
    fn get_archived(&self, _id: &str) -> Result<Option<Job>, String> { Ok(None) }
    fn find_archived_idempotency(&self, _key: &str) -> Result<Option<Job>, String> { Ok(None) }
}

mod engine;
pub use engine::{Engine, Job, JobStatus, Progress};
#[cfg(feature = "api")]
pub mod api;
