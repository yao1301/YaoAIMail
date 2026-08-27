use crate::realtime::SyncTrigger;
use pebble_crypto::CryptoService;
use pebble_search::TantivySearch;
use pebble_store::Store;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::{mpsc, watch, Mutex};

pub struct SyncHandle {
    pub stop_tx: watch::Sender<bool>,
    pub trigger_tx: mpsc::UnboundedSender<SyncTrigger>,
    pub task: tokio::task::JoinHandle<()>,
}

pub struct AppState {
    pub store: Arc<Store>,
    pub search: Arc<TantivySearch>,
    pub crypto: Arc<CryptoService>,
    pub sync_handles: Mutex<HashMap<String, SyncHandle>>,
    /// Kept alive so the snooze watcher's `stop_rx` remains open.
    #[allow(dead_code)]
    pub snooze_stop_tx: std::sync::mpsc::Sender<()>,
    pub attachments_dir: PathBuf,
    pub notifications_enabled: Arc<AtomicBool>,
    pub notification_attention_active: Arc<AtomicBool>,
    /// 正在后台补全正文的 message_id（防同一封邮件并发重复拉取）。
    pub hydrating_messages: Mutex<HashSet<String>>,
}

impl Clone for AppState {
    fn clone(&self) -> Self {
        AppState {
            store: self.store.clone(),
            search: self.search.clone(),
            crypto: self.crypto.clone(),
            // 后台补全用不到同步句柄，克隆时置空即可。
            sync_handles: Mutex::new(HashMap::new()),
            snooze_stop_tx: self.snooze_stop_tx.clone(),
            attachments_dir: self.attachments_dir.clone(),
            notifications_enabled: self.notifications_enabled.clone(),
            notification_attention_active: self.notification_attention_active.clone(),
            hydrating_messages: Mutex::new(HashSet::new()),
        }
    }
}

impl AppState {
    pub fn new(
        store: Store,
        search: TantivySearch,
        crypto: CryptoService,
        snooze_stop_tx: std::sync::mpsc::Sender<()>,
        attachments_dir: PathBuf,
    ) -> Self {
        Self {
            store: Arc::new(store),
            search: Arc::new(search),
            crypto: Arc::new(crypto),
            sync_handles: Mutex::new(HashMap::new()),
            snooze_stop_tx,
            attachments_dir,
            notifications_enabled: Arc::new(AtomicBool::new(true)),
            notification_attention_active: Arc::new(AtomicBool::new(false)),
            hydrating_messages: Mutex::new(HashSet::new()),
        }
    }
}
