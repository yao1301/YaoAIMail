use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::backoff::SyncBackoff;
use pebble_core::{new_id, now_timestamp, Folder, Message, PebbleError, ProviderType, Result};
use pebble_store::Store;
use tokio::sync::{mpsc, watch};
use tracing::{debug, error, info, warn};

/// Structured error info emitted by the sync worker.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncError {
    pub error_type: String,
    pub message: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncProgress {
    pub account_id: String,
    pub status: String,
    pub phase: String,
    pub message: Option<String>,
    /// Server-side total messages in the mailbox being synced (history backfill).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u32>,
    /// Messages processed so far in the current history backfill pass.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received: Option<u32>,
}

impl SyncProgress {
    fn started(account_id: &str, phase: &str) -> Self {
        Self {
            account_id: account_id.to_string(),
            status: "started".to_string(),
            phase: phase.to_string(),
            message: None,
            total: None,
            received: None,
        }
    }

    fn completed(account_id: &str, phase: &str) -> Self {
        Self {
            account_id: account_id.to_string(),
            status: "completed".to_string(),
            phase: phase.to_string(),
            message: None,
            total: None,
            received: None,
        }
    }

    fn error(account_id: &str, phase: &str, message: &str) -> Self {
        Self {
            account_id: account_id.to_string(),
            status: "error".to_string(),
            phase: phase.to_string(),
            message: Some(message.to_string()),
            total: None,
            received: None,
        }
    }
}

use crate::parser::{parse_raw_email, AttachmentData, ParsedMessage};
use crate::provider::imap_provider::ImapMailProvider;
use crate::realtime_policy::{RealtimePollPolicy, RealtimeRuntimeState, SyncTrigger};
use crate::reconcile;
use crate::thread::compute_thread_id;

/// Reject a MIME prefix before it reaches the parser. An incomplete MIME
/// message can still yield a valid text body while its attachment part is
/// absent, so the batch path must enforce the size it fetched beforehand.
fn verify_raw_message_size(uid: u32, raw: &[u8], expected_size: Option<u32>) -> Result<()> {
    if let Some(expected) = expected_size {
        let expected = expected as usize;
        if raw.len() != expected {
            return Err(PebbleError::Sync(format!(
                "IMAP message UID {uid} incomplete: received {} of {expected} bytes",
                raw.len()
            )));
        }
    }
    Ok(())
}

fn verify_downloaded_message_identity(expected: Option<&str>, actual: Option<&str>) -> Result<()> {
    // A UID is scoped to one mailbox. Length alone cannot catch a response
    // from a different mailbox that happens to contain the same UID.
    if let Some(expected) = expected.filter(|value| !value.trim().is_empty()) {
        let normalize = |value: &str| value.trim().trim_start_matches('<').trim_end_matches('>').to_string();
        if actual.map(normalize).as_deref() != Some(normalize(expected).as_str()) {
            return Err(PebbleError::Sync(
                "Downloaded MIME Message-ID does not match the stored header; local content unchanged".into(),
            ));
        }
    }
    Ok(())
}

/// Collect all message-ID references (In-Reply-To + References) from a batch of
/// pre-parsed messages. Used to limit the thread-mappings query to only the IDs
/// that are actually needed by this batch.
fn collect_ref_ids_from_parsed(
    parsed_messages: &[(u32, pebble_core::Result<ParsedMessage>)],
) -> Vec<String> {
    let mut refs = std::collections::HashSet::new();
    for (_, result) in parsed_messages {
        if let Ok(parsed) = result {
            if let Some(irt) = &parsed.in_reply_to {
                for id in irt.split_whitespace() {
                    refs.insert(id.trim().to_string());
                }
            }
            if let Some(r) = &parsed.references_header {
                for id in r.split_whitespace() {
                    refs.insert(id.trim().to_string());
                }
            }
        }
    }
    refs.into_iter().collect()
}

/// Sanitize a filename to prevent path traversal attacks.
/// Removes path separators, `..` sequences, and trims leading dots/spaces.
pub(crate) fn sanitize_filename(name: &str) -> String {
    fn is_windows_reserved(stem: &str) -> bool {
        let upper = stem.trim().to_ascii_uppercase();
        matches!(
            upper.as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        )
    }

    // Take only the last component if there are path separators
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    // Reject if the component is exactly ".."
    if base == ".." || base == "." {
        return "unnamed_attachment".to_string();
    }
    // Remove `..` sequences repeatedly until none remain, then strip unsafe chars.
    let mut cleaned = base.to_string();
    while cleaned.contains("..") {
        cleaned = cleaned.replace("..", ".");
    }
    let sanitized: String = cleaned
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
            _ => c,
        })
        .filter(|c| !c.is_control())
        .collect();

    // Windows disallows names ending with dots/spaces and hidden/path-like prefixes are unsafe.
    let trimmed = sanitized
        .trim()
        .trim_matches(|c: char| c == '.' || c == ' ');
    if trimmed.is_empty() {
        return "unnamed_attachment".to_string();
    }

    let stem = trimmed.split('.').next().unwrap_or(trimmed);
    if is_windows_reserved(stem) {
        return "unnamed_attachment".to_string();
    }

    trimmed.to_string()
}

/// Write attachments to disk and record them in the store.
///
/// Takes ownership of `attachments` so that each buffer can be freed the
/// moment it has been flushed — we don't keep every attachment's bytes
/// live in memory until the whole function returns. Writes use a buffered
/// writer with 64 KiB chunks so the working set stays bounded.
pub fn persist_message_attachments(
    store: &Store,
    attachments_root: &Path,
    message_id: &str,
    attachments: Vec<AttachmentData>,
) {
    if let Err(error) = persist_message_attachments_checked(store, attachments_root, message_id, attachments) {
        warn!("Failed to persist attachments for message {message_id}: {error}");
    }
}

/// Strict variant used by IMAP hydration. A body download is not complete
/// until every decoded attachment is both written and recorded in SQLite.
pub fn persist_message_attachments_checked(
    store: &Store,
    attachments_root: &Path,
    message_id: &str,
    attachments: Vec<AttachmentData>,
) -> Result<()> {
    use std::io::Write;
    const CHUNK_SIZE: usize = 64 * 1024;

    for att_data in attachments.into_iter() {
        let att_dir = attachments_root.join(message_id);
        std::fs::create_dir_all(&att_dir).map_err(|e| {
            PebbleError::Storage(format!(
                "failed to create attachment directory {}: {e}",
                att_dir.display()
            ))
        })?;

        let safe_filename = sanitize_filename(&att_data.meta.filename);
        if safe_filename.is_empty() {
            return Err(PebbleError::Storage(
                "attachment has empty filename after sanitization".to_string(),
            ));
        }
        let AttachmentData { meta, data } = att_data;
        if meta.size != data.len() {
            return Err(PebbleError::Sync(format!(
                "attachment {} is incomplete: decoded {} of {} bytes",
                meta.filename,
                data.len(),
                meta.size
            )));
        }

        let mut file_path = att_dir.join(&safe_filename);
        let mut counter = 1u32;
        while file_path.exists() {
            let stem = std::path::Path::new(&safe_filename)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy();
            let ext = std::path::Path::new(&safe_filename)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            file_path = att_dir.join(format!("{stem}_{counter}{ext}"));
            counter += 1;
        }
        let file = std::fs::File::create(&file_path).map_err(|e| {
            PebbleError::Storage(format!(
                "failed to create attachment file {}: {e}",
                file_path.display()
            ))
        })?;
        let mut writer = std::io::BufWriter::with_capacity(CHUNK_SIZE, file);

        for chunk in data.chunks(CHUNK_SIZE) {
            if let Err(e) = writer.write_all(chunk) {
                let _ = std::fs::remove_file(&file_path);
                return Err(PebbleError::Storage(format!(
                    "failed to write attachment file {}: {e}",
                    file_path.display()
                )));
            }
        }
        // Release the attachment buffer as soon as bytes are flushed to the
        // buffered writer, before we touch the store — callers often invoke us
        // in a tight loop where peak memory matters.
        drop(data);

        if let Err(e) = writer.flush() {
            let _ = std::fs::remove_file(&file_path);
            return Err(PebbleError::Storage(format!(
                "failed to flush attachment file {}: {e}",
                file_path.display()
            )));
        }

        let attachment = pebble_core::Attachment {
            id: new_id(),
            message_id: message_id.to_string(),
            filename: meta.filename,
            mime_type: meta.mime_type,
            size: meta.size as i64,
            local_path: Some(file_path.to_string_lossy().to_string()),
            content_id: meta.content_id,
            is_inline: meta.is_inline,
        };
        store.insert_attachment(&attachment)?;
    }
    Ok(())
}

/// Async wrapper that offloads attachment I/O to a blocking thread.
pub(crate) async fn persist_message_attachments_async(
    store: Arc<Store>,
    attachments_root: PathBuf,
    message_id: String,
    attachments: Vec<AttachmentData>,
) {
    if attachments.is_empty() {
        return;
    }
    let _ = tokio::task::spawn_blocking(move || {
        persist_message_attachments(&store, &attachments_root, &message_id, attachments);
    })
    .await;
}

/// Strict async wrapper for IMAP hydration. Errors are returned so the body
/// job remains retryable instead of being marked complete with missing files.
pub(crate) async fn persist_message_attachments_async_checked(
    store: Arc<Store>,
    attachments_root: PathBuf,
    message_id: String,
    attachments: Vec<AttachmentData>,
) -> Result<()> {
    if attachments.is_empty() {
        return Ok(());
    }
    tokio::task::spawn_blocking(move || {
        persist_message_attachments_checked(&store, &attachments_root, &message_id, attachments)
    })
    .await
    .map_err(|error| PebbleError::Internal(format!("attachment task failed: {error}")))?
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
struct ImapFolderCursor {
    uidvalidity: Option<u64>,
    last_uid: Option<u32>,
    highest_modseq: Option<u64>,
    #[serde(default)]
    history_complete: bool,
    /// Next IMAP sequence number range to backfill, moving from newest to oldest.
    /// `None` means the oldest message has already been reached.
    #[serde(default)]
    history_next_sequence: Option<u32>,
    /// Version 1 introduced a real advancing history cursor. Older cursor
    /// records may incorrectly claim completion after a duplicate-only page.
    #[serde(default)]
    history_cursor_version: u8,
    #[serde(default)]
    unavailable: bool,
    /// Signature of the last history-count verification that required a
    /// recovery pass. This prevents a permanently missing/undeliverable set
    /// of UIDs from causing the same full mailbox scan every tick.
    #[serde(default)]
    history_recovery_server_exists: Option<u32>,
    #[serde(default)]
    history_recovery_local_count: Option<u64>,
    #[serde(default)]
    history_recovery_paused: bool,
}

fn parse_imap_folder_cursor(state: Option<&str>) -> ImapFolderCursor {
    match state {
        Some(raw) => serde_json::from_str(raw).unwrap_or_default(),
        None => ImapFolderCursor::default(),
    }
}

fn prepare_imap_folder_cursor_for_status(
    mut cursor: ImapFolderCursor,
    uidvalidity: Option<u64>,
    highest_modseq: Option<u64>,
) -> ImapFolderCursor {
    if let (Some(stored), Some(current)) = (cursor.uidvalidity, uidvalidity) {
        if stored != current {
            cursor.last_uid = None;
            cursor.highest_modseq = None;
            cursor.history_complete = false;
            cursor.history_next_sequence = None;
            cursor.history_recovery_server_exists = None;
            cursor.history_recovery_local_count = None;
            cursor.history_recovery_paused = false;
        }
    }
    if uidvalidity.is_some() {
        cursor.uidvalidity = uidvalidity;
    }
    if highest_modseq.is_some() {
        cursor.highest_modseq = highest_modseq;
    }
    cursor
}

fn serialize_imap_folder_cursor(cursor: &ImapFolderCursor) -> Option<String> {
    serde_json::to_string(cursor).ok()
}

fn can_advance_imap_folder_cursor(has_unresolved_failures: bool) -> bool {
    !has_unresolved_failures
}

fn should_run_imap_deletion_diff(server_exists: u32, local_count: usize) -> bool {
    local_count > 0 || server_exists > 0
}

pub(crate) fn valid_imap_uid_inventory(expected_epoch: Option<u64>, status: crate::imap::ImapMailboxStatus, uids: &[u32]) -> bool {
    let unique: HashSet<_> = uids.iter().copied().collect();
    expected_epoch.is_some_and(|epoch| epoch > 0 && Some(epoch) == status.uid_validity.map(u64::from))
        && unique.len() == status.exists as usize && unique.len() == uids.len()
        && !unique.contains(&0) && status.uid_next.is_none_or(|next| unique.iter().all(|&uid| uid < next))
}

fn can_seed_imap_polling_baseline_after_startup(initial_sync_succeeded: bool) -> bool {
    initial_sync_succeeded
}

fn can_refresh_imap_polling_baseline_after_idle_fallback(catch_up_succeeded: bool) -> bool {
    catch_up_succeeded
}

fn apply_local_inbox_uid_baseline(
    last_exists: &mut Option<crate::idle::MailboxUidState>,
    uidvalidity: Option<u64>,
    local_max_uid: Option<u32>,
    has_unresolved_failures: bool,
) -> bool {
    if has_unresolved_failures {
        return false;
    }
    *last_exists = Some(crate::idle::MailboxUidState {
        uidvalidity,
        highest_uid: local_max_uid.unwrap_or(0),
    });
    true
}

fn should_skip_missing_imap_mailbox_during_initial_sync(
    folder_role: Option<pebble_core::FolderRole>,
) -> bool {
    folder_role != Some(pebble_core::FolderRole::Inbox)
}

fn should_fail_initial_sync_for_folder_error(
    folder_role: Option<pebble_core::FolderRole>,
    _is_retryable: bool,
) -> bool {
    // A slow or broken Spam/Trash mailbox must never prevent Inbox and Sent
    // history from becoming available. Those folders retain an incomplete
    // cursor and are retried independently on the next pass.
    folder_role == Some(pebble_core::FolderRole::Inbox)
}

fn idle_check_recovery_user_error(
    reconnect_error: Option<String>,
    poll_error: Option<String>,
) -> Option<(&'static str, String)> {
    if let Some(error) = reconnect_error {
        return Some((
            "connection",
            format!("IMAP reconnect after idle check failed: {error}"),
        ));
    }
    if let Some(error) = poll_error {
        return Some((
            "poll",
            format!("Poll after idle check reconnect failed: {error}"),
        ));
    }
    None
}

fn is_retryable_imap_connection_error(error: &PebbleError) -> bool {
    let PebbleError::Network(message) = error else {
        return false;
    };
    let lower = message.to_ascii_lowercase();

    lower.contains("imap uidvalidity unavailable")
        || lower.contains("os error 10053")
        || lower.contains("os error 10054")
        || lower.contains("connection reset")
        || lower.contains("connection aborted")
        || lower.contains("远程主机强迫关闭")
        || lower.contains("远程主机强制关闭")
        || lower.contains("主机中的软件中止了一个已建立的连接")
        || lower.contains("broken pipe")
        || lower.contains("connection closed")
        || lower.contains("closed connection")
        || lower.contains("tls close_notify")
        || lower.contains("unexpected eof")
        || lower.contains("unexpected-eof")
        || lower.contains("timed out")
        || lower == "not connected"
}

fn is_missing_imap_mailbox_error(error: &PebbleError) -> bool {
    let PebbleError::Network(message) = error else {
        return false;
    };
    let lower = message.to_ascii_lowercase();

    lower.contains("folder not exist")
        || lower.contains("mailbox does not exist")
        || lower.contains("mailbox doesn't exist")
        || lower.contains("no such mailbox")
        || lower.contains("nonexistent")
        || lower.contains("not selectable")
}

fn should_attempt_imap_remote_folder(folder: &pebble_core::Folder) -> bool {
    !folder.remote_id.starts_with("__local_")
}

/// Fallback page size used when a server rejects a larger headers-only history
/// range. Complete RFC822 messages, images and attachments are not downloaded
/// during initial sync; they are fetched only when a user opens a message.
const HISTORY_PAGE_SIZE: u32 = 3;

/// Default page size for history backfill. 100 封/页：headers-only 拉取
/// 开销小；服务器拒绝大范围时自动降级为 HISTORY_PAGE_SIZE(=3) 小页重试。
const HISTORY_PAGE_SIZE_FAST: u32 = 100;
/// New mail is the highest-priority work: after headers are committed, the
/// complete MIME message (body and attachments) for the whole incremental
/// batch is hydrated immediately on a dedicated connection. A large message
/// must not prevent the headers for later mail from being stored, but it also
/// must not be demoted behind historical backfill.
const NEW_MESSAGE_HYDRATION_LIMIT: usize = 100;

/// How many header-only messages the background body backfill hydrates per
/// pass. Kept modest so a few large attachments do not hog the dedicated
/// connection for too long; remaining messages continue next pass.
/// 每轮 100 封 + 封间让出，避免长时间独占数据库写连接（SQLite 单写者），
/// 否则邮件列表等其它读写会被堵住（"一直加载中"）。
/// 原 20 封/轮 + 20s 轮间 ≈ 1 封/秒，几千封要几小时；加大批量 + 缩短轮间后
/// 约 30+ 封/秒（网络往返仍是一封一次 FETCH）。
const BODY_HYDRATION_BATCH: u32 = 100;

/// 全局正文补齐互斥锁：所有账号的补齐任务共用，同一时间只允许一个账号
/// 跑补齐（多账号并发会争抢唯一的数据库写连接导致其它操作超时）。
static BODY_BACKFILL_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> =
    std::sync::OnceLock::new();

/// 进程级"批量 UID FETCH 不可用"标记：某些服务器（如 Zoho）对批量
/// BODY.PEEK[] 支持差，一次批量就要超时。第一次失败后记住，整个进程
/// 生命周期内不再尝试批量，直接逐封分片拉取（避免每 pass 都白等 30s）。
static BODY_BACKFILL_BATCH_DISABLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// History-sync cursor version for the newer implementation.
const HISTORY_CURSOR_VERSION: u8 = 3;

/// Maximum history pages advanced per folder in a single backfill pass.
/// 10 页 × 100 封/页 ≈ 1000 封/轮：大多数文件夹一轮收全；超大文件夹
/// 也只需几轮（每 2 分钟一轮）。超时页会自动降级成 3 封小页重试
/// （fetch_history_page_with_fallback），不会因单页失败卡死。
const HISTORY_BACKFILL_PAGES_PER_RUN: u32 = 10;

fn imap_history_priority(folder: &pebble_core::Folder) -> u8 {
    match folder.role {
        Some(pebble_core::FolderRole::Inbox) => 0,
        Some(pebble_core::FolderRole::Sent) => 1,
        Some(pebble_core::FolderRole::Drafts) => 2,
        Some(pebble_core::FolderRole::Archive) => 3,
        None => 4,
        Some(pebble_core::FolderRole::Trash) => 8,
        Some(pebble_core::FolderRole::Spam) => 9,
    }
}

fn should_defer_imap_recent_fetch(folder: &pebble_core::Folder) -> bool {
    matches!(
        folder.role,
        Some(pebble_core::FolderRole::Trash | pebble_core::FolderRole::Spam)
    )
}

/// Inclusive sequence-number ranges covering a mailbox from newest to
/// oldest, each at most `page_size` messages long. `exists == 0` yields no
/// ranges.
fn history_page_ranges(exists: u32, page_size: u32) -> Vec<(u32, u32)> {
    let mut ranges = Vec::new();
    let mut end = exists;
    while end >= 1 {
        let start = if end > page_size {
            end - page_size + 1
        } else {
            1
        };
        ranges.push((start, end));
        if start == 1 {
            break;
        }
        end = start - 1;
    }
    ranges
}

fn should_include_discovered_imap_folder(
    folder: &pebble_core::Folder,
    selected_remote_ids: Option<&HashSet<String>>,
) -> bool {
    let Some(selected_remote_ids) = selected_remote_ids else {
        // Existing accounts without an explicit preference retain the legacy
        // behaviour of syncing every selectable mailbox.
        return true;
    };

    folder.role == Some(pebble_core::FolderRole::Inbox)
        || folder.remote_id.eq_ignore_ascii_case("INBOX")
        || selected_remote_ids.contains(&folder.remote_id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImapPollScope {
    Realtime,
    Full,
}

fn should_poll_imap_folder_for_scope(folder: &pebble_core::Folder, scope: ImapPollScope) -> bool {
    if !should_attempt_imap_remote_folder(folder) {
        return false;
    }

    match scope {
        ImapPollScope::Realtime => folder.role == Some(pebble_core::FolderRole::Inbox),
        ImapPollScope::Full => true,
    }
}

#[cfg(test)]
fn should_poll_imap_folder_for_realtime(folder: &pebble_core::Folder) -> bool {
    should_poll_imap_folder_for_scope(folder, ImapPollScope::Realtime)
}

fn should_probe_custom_folder_for_new_mail(folder: &pebble_core::Folder) -> bool {
    should_attempt_imap_remote_folder(folder) && folder.role.is_none() && !folder.is_system
}

/// Configuration for the sync worker.
#[derive(Debug, Clone)]
pub struct SyncConfig {
    /// How often to poll for new messages, in seconds.
    pub poll_interval_secs: u64,
    /// How often to do a full reconcile, in seconds.
    pub reconcile_interval_secs: u64,
    /// How many messages to fetch on initial sync.
    pub initial_fetch_limit: u32,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            poll_interval_secs: 15,
            reconcile_interval_secs: 900,
            initial_fetch_limit: 200,
        }
    }
}

impl SyncConfig {
    pub fn manual_only(&self) -> bool {
        self.poll_interval_secs == 0
    }
}

fn imap_poll_policy(config: &SyncConfig) -> RealtimePollPolicy {
    RealtimePollPolicy::from_foreground_interval_secs(config.poll_interval_secs)
}

fn custom_folder_poll_interval_secs(config: &SyncConfig) -> Option<u64> {
    (!config.manual_only()).then_some(config.poll_interval_secs.max(1))
}

fn first_reconcile_deadline(now: Instant, interval: Duration) -> Instant {
    now + interval
}

fn should_notify_imap_startup_fetch(since_uid: Option<u32>) -> bool {
    since_uid.is_some()
}

/// A newly stored message along with the folder IDs it belongs to.
/// Emitted via `message_tx` so callers (e.g. the search indexer) can react.
#[derive(Debug, Clone)]
pub struct StoredMessage {
    pub message: Message,
    pub folder_ids: Vec<String>,
    pub notify: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncRuntimeStatus {
    ImapIdleAvailable,
    ImapPollingFallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImapWorkerTrigger {
    ProviderPush,
}

pub(crate) async fn recv_sync_trigger(
    trigger_rx: &mut Option<mpsc::UnboundedReceiver<SyncTrigger>>,
) -> Option<SyncTrigger> {
    match trigger_rx {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

/// Common fields shared by all sync workers.
#[derive(Clone)]
pub(crate) struct SyncWorkerBase {
    pub(crate) account_id: String,
    pub(crate) store: Arc<Store>,
    pub(crate) attachments_dir: PathBuf,
    pub(crate) error_tx: Option<mpsc::UnboundedSender<SyncError>>,
    pub(crate) message_tx: Option<mpsc::UnboundedSender<StoredMessage>>,
    pub(crate) runtime_status_tx: Option<mpsc::UnboundedSender<SyncRuntimeStatus>>,
    pub(crate) progress_tx: Option<mpsc::UnboundedSender<SyncProgress>>,
}

impl SyncWorkerBase {
    /// Emit a structured error through the error channel.
    pub(crate) fn emit_error(&self, error_type: &str, message: &str) {
        if let Some(tx) = &self.error_tx {
            let _ = tx.send(SyncError {
                error_type: error_type.to_string(),
                message: message.to_string(),
                timestamp: now_timestamp() as u64,
            });
        }
    }

    /// Emit a newly stored message through the message channel.
    pub(crate) fn emit_message(&self, message: StoredMessage) {
        if let Some(tx) = &self.message_tx {
            let _ = tx.send(message);
        }
    }

    pub(crate) fn emit_runtime_status(&self, status: SyncRuntimeStatus) {
        if let Some(tx) = &self.runtime_status_tx {
            let _ = tx.send(status);
        }
    }

    pub(crate) fn emit_sync_started(&self, phase: &str) {
        if let Some(tx) = &self.progress_tx {
            let _ = tx.send(SyncProgress::started(&self.account_id, phase));
        }
    }

    pub(crate) fn emit_sync_completed(&self, phase: &str) {
        if let Some(tx) = &self.progress_tx {
            let _ = tx.send(SyncProgress::completed(&self.account_id, phase));
        }
    }

    pub(crate) fn emit_sync_error(&self, phase: &str, message: &str) {
        if let Some(tx) = &self.progress_tx {
            let _ = tx.send(SyncProgress::error(&self.account_id, phase, message));
        }
    }

    /// Emit a fine-grained progress tick (e.g. history backfill page done).
    pub(crate) fn emit_sync_progress(&self, phase: &str, total: u32, received: u32) {
        if let Some(tx) = &self.progress_tx {
            let _ = tx.send(SyncProgress {
                account_id: self.account_id.clone(),
                status: "progress".to_string(),
                phase: phase.to_string(),
                message: None,
                total: Some(total),
                received: Some(received),
            });
        }
    }
}

/// A worker that syncs mail for one account.
#[derive(Clone)]
pub struct SyncWorker {
    pub(crate) base: SyncWorkerBase,
    provider: Arc<ImapMailProvider>,
    idle_provider: Arc<ImapMailProvider>,
    stop_rx: watch::Receiver<bool>,
}

impl SyncWorker {
    /// Create a new sync worker.
    pub fn new(
        account_id: impl Into<String>,
        provider: Arc<ImapMailProvider>,
        store: Arc<Store>,
        stop_rx: watch::Receiver<bool>,
        attachments_dir: impl Into<PathBuf>,
    ) -> Self {
        let idle_provider = Arc::new(provider.clone_for_idle());
        Self {
            base: SyncWorkerBase {
                account_id: account_id.into(),
                store,
                attachments_dir: attachments_dir.into(),
                error_tx: None,
                message_tx: None,
                runtime_status_tx: None,
                progress_tx: None,
            },
            provider,
            idle_provider,
            stop_rx,
        }
    }

    /// Set the error channel for emitting structured sync errors.
    pub fn with_error_tx(mut self, tx: mpsc::UnboundedSender<SyncError>) -> Self {
        self.base.error_tx = Some(tx);
        self
    }

    /// Set the channel for emitting newly stored messages (used for search indexing).
    pub fn with_message_tx(mut self, tx: mpsc::UnboundedSender<StoredMessage>) -> Self {
        self.base.message_tx = Some(tx);
        self
    }

    pub fn with_runtime_status_tx(mut self, tx: mpsc::UnboundedSender<SyncRuntimeStatus>) -> Self {
        self.base.runtime_status_tx = Some(tx);
        self
    }

    pub fn with_progress_tx(mut self, tx: mpsc::UnboundedSender<SyncProgress>) -> Self {
        self.base.progress_tx = Some(tx);
        self
    }

    fn refresh_inbox_local_uid_baseline(
        &self,
        last_exists: &mut Option<crate::idle::MailboxUidState>,
    ) -> bool {
        let folders = match self.base.store.list_folders(&self.base.account_id) {
            Ok(folders) => folders,
            Err(e) => {
                warn!(
                    "Failed to load folders while refreshing IMAP polling baseline for account {}: {}",
                    self.base.account_id, e
                );
                return false;
            }
        };

        let Some(inbox) = folders
            .iter()
            .find(|folder| folder.role == Some(pebble_core::FolderRole::Inbox))
        else {
            warn!(
                "Failed to refresh IMAP polling baseline for account {}: no Inbox folder found",
                self.base.account_id
            );
            return false;
        };

        let has_unresolved_failures = match self
            .base
            .store
            .has_sync_failures_for_folder(&self.base.account_id, &inbox.id)
        {
            Ok(has_failures) => has_failures,
            Err(e) => {
                warn!(
                    "Failed to check Inbox sync failures while refreshing IMAP polling baseline for account {} folder {}: {}",
                    self.base.account_id, inbox.remote_id, e
                );
                return false;
            }
        };
        if has_unresolved_failures {
            debug!(
                "Skipping IMAP polling baseline refresh for account {} folder {} because Inbox has unresolved sync failures",
                self.base.account_id, inbox.remote_id
            );
            return false;
        }

        let folder_sync_state = match self
            .base
            .store
            .get_folder_sync_state(&self.base.account_id, &inbox.id)
        {
            Ok(state) => state,
            Err(e) => {
                warn!(
                    "Failed to load local Inbox cursor while refreshing IMAP polling baseline for account {} folder {}: {}",
                    self.base.account_id, inbox.remote_id, e
                );
                return false;
            }
        };
        let cursor = parse_imap_folder_cursor(folder_sync_state.as_deref());

        let local_max_uid = match self
            .base
            .store
            .get_max_remote_id(&self.base.account_id, &inbox.id)
        {
            Ok(remote_id) => remote_id.and_then(|uid| uid.parse::<u32>().ok()),
            Err(e) => {
                warn!(
                    "Failed to load local Inbox max UID while refreshing IMAP polling baseline for account {} folder {}: {}",
                    self.base.account_id, inbox.remote_id, e
                );
                return false;
            }
        };
        let refreshed = apply_local_inbox_uid_baseline(
            last_exists,
            cursor.uidvalidity,
            local_max_uid,
            has_unresolved_failures,
        );
        if refreshed {
            debug!(
                "Refreshed IMAP polling baseline for account {} folder {} to local max UID {}",
                self.base.account_id,
                inbox.remote_id,
                last_exists.map(|state| state.highest_uid).unwrap_or(0)
            );
        }
        refreshed
    }

    fn stored_imap_folder_cursor(&self, folder: &pebble_core::Folder) -> ImapFolderCursor {
        let state = self
            .base
            .store
            .get_folder_sync_state(&self.base.account_id, &folder.id)
            .ok()
            .flatten();
        let mut cursor = parse_imap_folder_cursor(state.as_deref());
        let has_failures = self
            .base
            .store
            .has_sync_failures_for_folder(&self.base.account_id, &folder.id)
            .unwrap_or(false);
        if cursor.last_uid.is_none() && can_advance_imap_folder_cursor(has_failures) {
            cursor.last_uid = self
                .base
                .store
                .get_max_remote_id(&self.base.account_id, &folder.id)
                .ok()
                .flatten()
                .and_then(|s| s.parse::<u32>().ok());
        }
        cursor
    }

    fn is_folder_quarantined(&self, folder: &pebble_core::Folder) -> bool {
        self.stored_imap_folder_cursor(folder).unavailable
    }

    fn quarantine_folder(&self, folder: &pebble_core::Folder, reason: &str) {
        let mut cursor = self.stored_imap_folder_cursor(folder);
        if cursor.unavailable {
            return;
        }
        cursor.unavailable = true;
        cursor.history_complete = true;
        cursor.history_next_sequence = None;
        if let Some(state) = serialize_imap_folder_cursor(&cursor) {
            let _ = self
                .base
                .store
                .set_folder_sync_state(&self.base.account_id, &folder.id, &state);
        }
        warn!(
            "Quarantined unavailable IMAP folder {} ({}) for account {}: {}",
            folder.name, folder.remote_id, self.base.account_id, reason
        );
    }

    fn clear_folder_quarantine(&self, folder: &pebble_core::Folder, cursor: &mut ImapFolderCursor) {
        if !cursor.unavailable {
            return;
        }
        cursor.unavailable = false;
        if let Some(state) = serialize_imap_folder_cursor(cursor) {
            let _ = self
                .base
                .store
                .set_folder_sync_state(&self.base.account_id, &folder.id, &state);
        }
        info!(
            "Restored IMAP folder {} ({}) after a successful status check",
            folder.name, folder.remote_id
        );
    }

    async fn try_imap_folder_cursor_for_sync(
        &self,
        folder: &pebble_core::Folder,
    ) -> Result<ImapFolderCursor> {
        let mut cursor = self.stored_imap_folder_cursor(folder);
        if !should_attempt_imap_remote_folder(folder) || self.is_folder_quarantined(folder) {
            return Ok(cursor);
        }
        let status = match self
            .provider
            .inner()
            .get_mailbox_status(&folder.remote_id)
            .await
        {
            Ok(status) => status,
            Err(error) if is_retryable_imap_connection_error(&error) => {
                warn!(
                    "Mailbox status failed for {} ({}); reconnecting before retry",
                    folder.name, error
                );
                let _ = self.provider.disconnect().await;
                self.provider.connect().await?;
                self.provider
                    .inner()
                    .get_mailbox_status(&folder.remote_id)
                    .await?
            }
            Err(error) => {
                if is_missing_imap_mailbox_error(&error) {
                    self.quarantine_folder(folder, &error.to_string());
                }
                return Err(error);
            }
        };
        self.clear_folder_quarantine(folder, &mut cursor);
        self.prepare_verified_imap_cursor(folder, cursor, status)
    }

    fn prepare_verified_imap_cursor(&self, folder: &Folder, cursor: ImapFolderCursor, status: crate::imap::ImapMailboxStatus) -> Result<ImapFolderCursor> {
        let Some(epoch) = status.uid_validity.filter(|&uid| uid > 0).map(u64::from) else {
            return Err(PebbleError::Sync("IMAP response omitted UIDVALIDITY; local mail left unchanged".into()));
        };
        let previous = cursor.uidvalidity;
        let mut cursor = prepare_imap_folder_cursor_for_status(
            cursor,
            Some(epoch),
            status.highest_modseq,
        );
        if cursor.history_cursor_version < HISTORY_CURSOR_VERSION {
            // Keep last_uid for the fast newest-mail path, but restart the
            // sequence-number backfill. This is deliberately a one-time
            // migration: once persisted as v2, normal incremental sync is
            // unchanged.
            cursor.history_cursor_version = HISTORY_CURSOR_VERSION;
            cursor.history_complete = false;
            cursor.history_next_sequence = (status.exists > 0).then_some(status.exists);
        } else if cursor.history_next_sequence.is_none() && !cursor.history_complete && status.exists > 0 {
            cursor.history_next_sequence = Some(status.exists);
        }
        if let Some(old) = previous.filter(|&old| old != epoch) {
            let state = serde_json::to_string(&cursor).map_err(|e| PebbleError::Internal(e.to_string()))?;
            let retain = !matches!(folder.role, Some(pebble_core::FolderRole::Trash | pebble_core::FolderRole::Spam));
            self.base.store.replace_imap_uid_epoch(&self.base.account_id, &folder.id, old, &state, retain)?;
        }
        Ok(cursor)
    }

    fn persist_imap_folder_cursor_after_sync(
        &self,
        folder: &pebble_core::Folder,
        mut cursor: ImapFolderCursor,
    ) -> Result<()> {
        if !can_advance_imap_folder_cursor(
            self.base
                .store
                .has_sync_failures_for_folder(&self.base.account_id, &folder.id)?,
        ) {
            debug!(
                "Keeping previous IMAP cursor for {} because unresolved sync failures exist",
                folder.name
            );
            return Ok(());
        }

        if let Some(max_uid) = self
            .base
            .store
            .get_max_remote_id(&self.base.account_id, &folder.id)?
            .and_then(|s| s.parse::<u32>().ok())
        {
            cursor.last_uid = Some(max_uid);
        }
        if let Some(state) = serialize_imap_folder_cursor(&cursor) {
            self.base
                .store
                .set_folder_sync_state(&self.base.account_id, &folder.id, &state)?;
        }
        Ok(())
    }

    /// Perform the initial full sync: list folders and fetch all of them.
    pub async fn initial_sync(&self) -> Result<()> {
        info!("Starting initial sync for account {}", self.base.account_id);

        let selected_remote_ids = self
            .base
            .store
            .get_sync_state(&self.base.account_id)?
            .and_then(|state| state.selected_imap_folder_remote_ids)
            .filter(|ids| !ids.is_empty())
            .map(|ids| ids.into_iter().collect::<HashSet<_>>());

        let discovered_folders = self
            .provider
            .inner()
            .list_folders(&self.base.account_id)
            .await?;
        let remote_folders: Vec<_> = discovered_folders
            .into_iter()
            .filter(|folder| {
                should_include_discovered_imap_folder(folder, selected_remote_ids.as_ref())
            })
            .collect();

        if selected_remote_ids.is_some() {
            info!(
                "Applying explicit IMAP folder selection for account {} ({} folders including Inbox)",
                self.base.account_id,
                remote_folders.len()
            );
        }

        for folder in &remote_folders {
            // Upsert folder into store
            let _ = self.base.store.insert_folder(folder);
        }

        // Ensure an Archive folder exists locally (even if the IMAP server doesn't have one)
        let has_archive = remote_folders
            .iter()
            .any(|f| f.role == Some(pebble_core::FolderRole::Archive));
        if !has_archive {
            let archive = pebble_core::Folder {
                id: new_id(),
                account_id: self.base.account_id.clone(),
                remote_id: "__local_archive__".to_string(),
                name: "Archive".to_string(),
                folder_type: pebble_core::FolderType::Folder,
                role: Some(pebble_core::FolderRole::Archive),
                parent_id: None,
                color: None,
                is_system: true,
                sort_order: 3,
            };
            let _ = self.base.store.insert_folder(&archive);
            info!(
                "Created local archive folder for account {}",
                self.base.account_id
            );
        }

        // Re-read folders from DB so we use the actual persisted IDs
        // (insert_folder upserts, so in-memory IDs from list_folders may differ).
        let folders = self.base.store.list_folders(&self.base.account_id)?;

        // Keep user-critical history moving first. Server LIST order is not a
        // useful priority and often places a huge Spam folder before Sent.
        let mut ordered: Vec<&pebble_core::Folder> = folders.iter().collect();
        ordered.sort_by_key(|folder| imap_history_priority(folder));

        let mut first_initial_sync_error = None;
        // Phase 1: every selected server folder gets a small recent batch
        // before any one large mailbox can monopolise the worker.
        for folder in &ordered {
            if should_defer_imap_recent_fetch(folder) {
                info!(
                    "Deferring recent fetch for low-priority folder {} until Inbox and Sent history are available",
                    folder.name
                );
                continue;
            }
            if let Err(e) = self.initial_sync_folder_with_reconnect(folder).await {
                warn!("Initial sync folder {} failed: {}", folder.name, e);
                let is_retryable = is_retryable_imap_connection_error(&e);
                if should_fail_initial_sync_for_folder_error(folder.role.clone(), is_retryable)
                    && first_initial_sync_error.is_none()
                {
                    first_initial_sync_error = Some(e);
                }
            }
        }

        if let Some(e) = first_initial_sync_error {
            return Err(e);
        }

        // Phase 2: start background history backfill for folders that are not
        // history-complete yet. Each folder advances at most
        // HISTORY_BACKFILL_PAGES_PER_RUN pages per run so a huge Sent/Archive
        // mailbox cannot keep the worker (and the "syncing" indicator) busy for
        // hours; the remaining pages are filled by the reconcile ticker loop.
        if let Err(error) = self.backfill_incomplete_history(HISTORY_BACKFILL_PAGES_PER_RUN).await {
            warn!(
                "Initial history backfill pass failed for account {}: {}",
                self.base.account_id, error
            );
        }

        // Synchronize folder deletions right after discovery so folders the
        // user removed from the web client are cleaned up locally without
        // waiting for the next 15-minute reconcile tick.
        if let Err(error) = self.reconcile_imap_folders().await {
            warn!(
                "Initial folder reconciliation failed for account {}: {}",
                self.base.account_id, error
            );
        }

        Ok(())
    }

    /// Compare the server folder list with local folders and remove local
    /// records for IMAP folders that no longer exist on the server (e.g. the
    /// user deleted them from the web client). Local-only system folders are
    /// always preserved. Safe to call periodically: deletions are idempotent.
    async fn reconcile_imap_folders(&self) -> Result<()> {
        // LIST can fail independently from the rest of a sync when an IMAP
        // connection is being recycled. Retry a few times here so a manual
        // collect does not leave the UI on the old folder tree just because
        // the first LIST hit a transient disconnect. Empty responses are
        // retried as well; after the final attempt they remain protected and
        // never trigger local cleanup.
        let mut remote = None;
        let mut last_error = None;
        for attempt in 0..3 {
            match self
                .provider
                .inner()
                .list_folders(&self.base.account_id)
                .await
            {
                Ok(folders) if !folders.is_empty() => {
                    remote = Some(folders);
                    break;
                }
                Ok(_) => {
                    warn!(
                        "Server folder list is empty for account {} (attempt {}/3)",
                        self.base.account_id,
                        attempt + 1
                    );
                }
                Err(error) => {
                    let retryable = is_retryable_imap_connection_error(&error);
                    last_error = Some(error);
                    if !retryable {
                        break;
                    }
                }
            }
            if attempt < 2 {
                tokio::time::sleep(tokio::time::Duration::from_millis(350)).await;
            }
        }
        let remote = match remote {
            Some(folders) => folders,
            None => {
                if let Some(error) = last_error {
                    return Err(error);
                }
                Vec::new()
            }
        };
        // P0 数据保护：服务器返回空文件夹列表时（网络中断 / 服务器异常经常表现为
        // LIST 成功但返回空响应），绝不能删除本地文件夹——否则收件箱、草稿箱等
        // 全部本地文件夹会被清空并进入"no Inbox folder found"的恶性循环。
        if remote.is_empty() {
            warn!(
                "Server folder list is empty for account {}; skipping folder reconciliation to protect local data",
                self.base.account_id
            );
            return Ok(());
        }
        // Reconcile paths before any cleanup. A server-side rename changes
        // remote_id; matching a unique leaf/role preserves the local folder
        // ID and its message memberships instead of creating a new empty row.
        self.base
            .store
            .reconcile_remote_folder_tree(&self.base.account_id, &remote)?;
        self.probe_quarantined_folders().await;
        // 服务器是层级的权威来源：根据（已同步的）remote_id 重建 parent_id，
        // 修复用户在网页邮箱移动文件夹后本地层级与服务器不一致的问题。
        match self
            .base
            .store
            .repair_folder_hierarchy_from_remote_ids(&self.base.account_id)
        {
            Ok(repaired) => info!(
                account_id = %self.base.account_id,
                remote_folders = remote.len(),
                repaired,
                "Reconciled server-authoritative IMAP folder hierarchy"
            ),
            Err(error) => {
            warn!(
                "Failed to repair folder hierarchy for account {}: {}",
                self.base.account_id, error
            );
            }
        }
        Ok(())
    }

    async fn probe_quarantined_folders(&self) {
        let Ok(folders) = self.base.store.list_folders(&self.base.account_id) else {
            return;
        };
        for folder in folders {
            if !self.is_folder_quarantined(&folder) || folder.remote_id.starts_with("__local_") {
                continue;
            }
            match self
                .provider
                .inner()
                .get_mailbox_status(&folder.remote_id)
                .await
            {
                Ok(_) => {
                    let mut cursor = self.stored_imap_folder_cursor(&folder);
                    self.clear_folder_quarantine(&folder, &mut cursor);
                }
                Err(error) if is_missing_imap_mailbox_error(&error) => {}
                Err(error) => warn!(
                    "Unavailable-folder probe failed for {}: {}",
                    folder.remote_id, error
                ),
            }
        }
    }

    /// Continue filling history for folders whose `history_complete` flag is
    /// still false, advancing each folder at most `max_pages_per_folder`
    /// pages per call. Safe to call repeatedly: already-stored UIDs are
    /// skipped, so an interrupted backfill resumes on the next run.
    async fn backfill_incomplete_history(&self, max_pages_per_folder: u32) -> Result<()> {
        let folders = self.base.store.list_folders(&self.base.account_id)?;
        for folder in &folders {
            if !should_attempt_imap_remote_folder(folder) || self.is_folder_quarantined(folder) {
                continue;
            }
            let mut cursor = self.stored_imap_folder_cursor(folder);
            if cursor.history_recovery_paused {
                // A repeated count mismatch means rescanning the same range
                // is not making progress (for example, a server-side UID
                // range that cannot be fetched or a provider that hides
                // messages from SEARCH/FETCH). Probe cheaply and resume only
                // when the mailbox state has materially changed.
                let status = match self
                    .provider
                    .inner()
                    .get_mailbox_status(&folder.remote_id)
                    .await
                {
                    Ok(status) => status,
                    Err(error) => {
                        debug!(
                            "Paused history recovery probe skipped for {}: {}",
                            folder.name, error
                        );
                        continue;
                    }
                };
                let local_count = self
                    .base
                    .store
                    .list_remote_ids_by_folder(&self.base.account_id, &folder.id)
                    .map(|items| items.len() as u64)
                    .unwrap_or(0);
                let unchanged = cursor.history_recovery_server_exists == Some(status.exists)
                    && cursor.history_recovery_local_count == Some(local_count);
                if unchanged {
                    continue;
                }
                info!(
                    "Resuming paused history recovery for {} because mailbox counts changed (local {}, server {})",
                    folder.name, local_count, status.exists
                );
                cursor.history_recovery_paused = false;
                cursor.history_recovery_server_exists = None;
                cursor.history_recovery_local_count = None;
                cursor.history_complete = false;
                cursor.history_next_sequence = (status.exists > 0).then_some(status.exists);
                if let Err(error) = self.persist_imap_folder_cursor_after_sync(folder, cursor) {
                    warn!(
                        "Failed to persist resumed history cursor for folder {}: {}",
                        folder.name, error
                    );
                }
                continue;
            }
            if cursor.history_complete {
                continue;
            }
            info!(
                "History backfill pass for folder {} (max {} pages) account {}",
                folder.name, max_pages_per_folder, self.base.account_id
            );
            match self
                .sync_folder_history_pages(folder, false, Some(max_pages_per_folder))
                .await
            {
                Ok(count) => {
                    let mut cursor = self.stored_imap_folder_cursor(folder);
                    // A page with zero *new* messages is not necessarily the
                    // end: it may simply overlap the recent batch already
                    // stored during initial sync. Completion is determined by
                    // the persisted sequence cursor, never by `count`.
                    let is_done = cursor.history_next_sequence.is_none();
                    if is_done {
                        // 兜底校验：若本地邮件数远少于服务器 exists，说明之前可能
                        // 发生过静默丢失（fetch 失败但游标照常推进），不标记完成，
                        // 重置游标让下轮从头重试，直到数量对齐。
                        let local_count = self
                            .base
                            .store
                            .list_remote_ids_by_folder(&self.base.account_id, &folder.id)
                            .map(|items| items.len() as u64)
                            .unwrap_or(0);
                        let server_exists = self
                            .provider
                            .inner()
                            .get_mailbox_status(&folder.remote_id)
                            .await
                            .map(|status| status.exists as u64)
                            .unwrap_or(0);
                        if server_exists > 0 && local_count < server_exists {
                            let same_gap = cursor.history_recovery_server_exists
                                == Some(server_exists as u32)
                                && cursor.history_recovery_local_count == Some(local_count);
                            if same_gap {
                                warn!(
                                    "History backfill for {} is paused after repeated count mismatch (local {} vs server {}); will probe without rescanning",
                                    folder.name, local_count, server_exists
                                );
                                cursor.history_recovery_paused = true;
                            } else {
                                warn!(
                                    "History backfill finished for {} but local count {} << server exists {}; scheduling one recovery pass",
                                    folder.name, local_count, server_exists
                                );
                                cursor.history_recovery_paused = false;
                                cursor.history_next_sequence = Some(server_exists as u32);
                            }
                            cursor.history_recovery_server_exists = Some(server_exists as u32);
                            cursor.history_recovery_local_count = Some(local_count);
                            cursor.history_complete = false;
                            if cursor.history_recovery_paused {
                                cursor.history_next_sequence = None;
                            }
                            if let Err(error) =
                                self.persist_imap_folder_cursor_after_sync(folder, cursor)
                            {
                                warn!(
                                    "Failed to persist cursor for folder {}: {}",
                                    folder.name, error
                                );
                            }
                            return Ok(());
                        }
                        cursor.history_complete = true;
                        cursor.history_recovery_server_exists = None;
                        cursor.history_recovery_local_count = None;
                        cursor.history_recovery_paused = false;
                        info!(
                            "History backfill completed for folder {} ({} new messages this pass)",
                            folder.name, count
                        );
                    } else {
                        info!(
                            "History backfill progressed for folder {} ({} new messages this pass)",
                            folder.name, count
                        );
                    }
                    if let Err(error) = self.persist_imap_folder_cursor_after_sync(folder, cursor) {
                        warn!(
                            "Failed to persist cursor for folder {}: {}",
                            folder.name, error
                        );
                    }
                }
                Err(error) => {
                    warn!(
                        "History backfill paused for folder {} and will retry on next reconcile: {}",
                        folder.name, error
                    );
                    let _ = self.provider.disconnect().await;
                    if let Err(reconnect_error) = self.provider.connect().await {
                        warn!(
                            "Reconnect after history backfill failure for folder {} failed: {}",
                            folder.name, reconnect_error
                        );
                    }
                }
            }
        }
        Ok(())
    }

    /// 自愈：周期性对账"已标记完成"的文件夹。若本地邮件数远少于服务器 exists
    /// （历史上因网络故障/静默丢失被误标完成），自动复位回填游标并重新拉取。
    /// 对任何用户、任何文件夹都生效，无需人工干预。
    async fn heal_stale_complete_folders(&self) -> Result<()> {
        let folders = self.base.store.list_folders(&self.base.account_id)?;
        for folder in &folders {
            if !should_attempt_imap_remote_folder(folder) || self.is_folder_quarantined(folder) {
                continue;
            }
            let cursor = self.stored_imap_folder_cursor(folder);
            if !cursor.history_complete {
                continue;
            }
            let local_count = self
                .base
                .store
                .list_remote_ids_by_folder(&self.base.account_id, &folder.id)
                .map(|items| items.len() as u64)
                .unwrap_or(0);
            let status = match self
                .provider
                .inner()
                .get_mailbox_status(&folder.remote_id)
                .await
            {
                Ok(status) => status,
                Err(error) => {
                    debug!("Heal check skipped for {}: {}", folder.name, error);
                    continue;
                }
            };
            let server_exists = status.exists as u64;
            if server_exists > 0 && local_count < server_exists.saturating_mul(90) / 100 {
                warn!(
                    "Healing folder {}: local {} vs server exists {}; restarting history backfill",
                    folder.name, local_count, server_exists
                );
                let mut healed = cursor.clone();
                healed.history_complete = false;
                healed.history_next_sequence = Some(status.exists);
                if let Err(error) =
                    self.persist_imap_folder_cursor_after_sync(folder, healed)
                {
                    warn!(
                        "Failed to persist healed cursor for folder {}: {}",
                        folder.name, error
                    );
                }
            }
        }
        Ok(())
    }

    async fn initial_sync_folder_with_reconnect(&self, folder: &pebble_core::Folder) -> Result<()> {
        match self.initial_sync_folder_once(folder).await {
            Ok(()) => Ok(()),
            Err(e)
                if is_missing_imap_mailbox_error(&e)
                    && should_skip_missing_imap_mailbox_during_initial_sync(
                        folder.role.clone(),
                    ) =>
            {
                self.quarantine_folder(folder, &e.to_string());
                debug!(
                    "Skipping unavailable IMAP folder {} ({}) for account {}: {}",
                    folder.name, folder.remote_id, self.base.account_id, e
                );
                Ok(())
            }
            Err(e) if is_retryable_imap_connection_error(&e) => {
                warn!(
                    "IMAP connection failed during initial sync for folder {} account {}; reconnecting before retry: {}",
                    folder.name, self.base.account_id, e
                );
                let _ = self.provider.disconnect().await;
                self.provider.connect().await?;
                self.initial_sync_folder_once(folder).await
            }
            Err(e) => Err(e),
        }
    }

    async fn initial_sync_folder_once(&self, folder: &pebble_core::Folder) -> Result<()> {
        if !should_attempt_imap_remote_folder(folder) || self.is_folder_quarantined(folder) {
            debug!(
                "Skipping local-only IMAP folder {} ({}) during initial sync",
                folder.name, folder.remote_id
            );
            return Ok(());
        }

        let cursor = self.try_imap_folder_cursor_for_sync(folder).await?;
        let since_uid = cursor.last_uid;
        let notify_new = should_notify_imap_startup_fetch(since_uid);
        // Store new headers before attempting MIME downloads. Some IMAP
        // servers close the connection while fetching a large body or
        // attachment; fetching the whole batch first used to make *all* new
        // mail disappear until the next retry. Headers give the user an
        // immediate, reliable cursor and the newest few messages are then
        // hydrated one by one on a best-effort basis.
        let mut count = 0;
        if let Some(uid) = since_uid {
            count += self
                .sync_folder_headers_with_hydration(
                    folder,
                    Some(uid),
                    HISTORY_PAGE_SIZE_FAST,
                    notify_new,
                )
                .await?;
        }
        // A small recent-window scan repairs a stale cursor without issuing
        // another large header request that could compete with new-mail
        // hydration on slow servers.
        count += self
            .sync_folder_headers(folder, None, HISTORY_PAGE_SIZE, notify_new && since_uid.is_none())
            .await?;

        if count > 0 {
            info!(
                "Initial sync: fetched {} messages from {}",
                count, folder.name
            );
        }
        if let Err(e) = self.persist_imap_folder_cursor_after_sync(folder, cursor) {
            warn!("Failed to persist IMAP cursor for {}: {}", folder.name, e);
        }

        Ok(())
    }

    /// Check if a folder is local-only (not backed by IMAP).
    fn is_local_folder(folder: &pebble_core::Folder) -> bool {
        !should_attempt_imap_remote_folder(folder)
    }

    /// Sync a folder: fetch raw messages, parse, compute threads, store.
    /// Returns the number of new messages stored.
    pub async fn sync_folder(
        &self,
        folder: &pebble_core::Folder,
        since_uid: Option<u32>,
        limit: u32,
        notify_new: bool,
    ) -> Result<u32> {
        // Skip local-only folders (not backed by IMAP)
        if Self::is_local_folder(folder) {
            return Ok(0);
        }

        let raw_messages = self
            .provider
            .inner()
            .fetch_messages_raw(&folder.remote_id, since_uid, limit)
            .await?;

        self.store_fetched_messages(folder, raw_messages, notify_new, false)
            .await
    }

    /// Fast sync path: store headers immediately and defer full MIME downloads
    /// until the user opens a message.
    pub async fn sync_folder_headers(
        &self,
        folder: &pebble_core::Folder,
        since_uid: Option<u32>,
        limit: u32,
        notify_new: bool,
    ) -> Result<u32> {
        if Self::is_local_folder(folder) {
            return Ok(0);
        }
        let raw_messages = match self
            .provider
            .inner()
            .fetch_messages_headers(&folder.remote_id, since_uid, limit)
            .await
        {
            Ok(messages) => messages,
            Err(error) if is_retryable_imap_connection_error(&error) => {
                warn!(
                    "Header fetch failed for {} ({}); reconnecting before retry",
                    folder.name, error
                );
                let _ = self.provider.disconnect().await;
                self.provider.connect().await?;
                self.provider
                    .inner()
                    .fetch_messages_headers(&folder.remote_id, since_uid, limit)
                    .await?
            }
            Err(error) => return Err(error),
        };
        self.store_fetched_messages(folder, raw_messages, notify_new, true).await
    }

    /// Fetch incremental headers first, then immediately hydrate the complete
    /// incremental batch (body and attachments) on a dedicated connection. A
    /// failed MIME fetch is non-fatal: the header remains stored and the body
    /// backfill queue retries it later.
    async fn sync_folder_headers_with_hydration(
        &self,
        folder: &pebble_core::Folder,
        since_uid: Option<u32>,
        limit: u32,
        notify_new: bool,
    ) -> Result<u32> {
        if Self::is_local_folder(folder) {
            return Ok(0);
        }

        let raw_messages = match self
            .provider
            .inner()
            .fetch_messages_headers(&folder.remote_id, since_uid, limit)
            .await
        {
            Ok(messages) => messages,
            Err(error) if is_retryable_imap_connection_error(&error) => {
                warn!(
                    "Header fetch failed for {} ({}); reconnecting before retry",
                    folder.name, error
                );
                let _ = self.provider.disconnect().await;
                self.provider.connect().await?;
                self.provider
                    .inner()
                    .fetch_messages_headers(&folder.remote_id, since_uid, limit)
                    .await?
            }
            Err(error) => return Err(error),
        };

        let uids: Vec<u32> = raw_messages
            .iter()
            .map(|(uid, _)| *uid)
            .take(NEW_MESSAGE_HYDRATION_LIMIT)
            .collect();
        let stored = self
            .store_fetched_messages(folder, raw_messages, notify_new, true)
            .await?;

        // Do not await MIME downloads here. A single large message can take
        // the full 45-second body timeout; keeping that wait in the main
        // worker was the reason the UI appeared frozen and later messages
        // were delayed. Use a dedicated connection so live polling remains
        // available for other folders.
        if !uids.is_empty() {
            let base = self.base.clone();
            let provider = Arc::new(self.provider.clone_for_idle());
            let folder = folder.clone();
            tokio::spawn(async move {
                if let Err(error) = provider.connect().await {
                    warn!(
                        "Background MIME hydration connection failed for {} (headers retained): {}",
                        folder.name, error
                    );
                    return;
                }
                for uid in uids {
                    if let Err(error) =
                        Self::hydrate_incremental_message(&base, &provider, &folder, uid).await
                    {
                        warn!(
                            "Best-effort MIME hydration failed for {} UID {} (header retained): {}",
                            folder.name, uid, error
                        );
                    }
                }
                let _ = provider.disconnect().await;
            });
        }

        Ok(stored)
    }

    async fn hydrate_incremental_message(
        base: &SyncWorkerBase,
        provider: &ImapMailProvider,
        folder: &pebble_core::Folder,
        uid: u32,
    ) -> Result<()> {
        let remote_id = uid.to_string();
        let Some(message_id) = base.store.find_message_id_by_remote_in_folder(
            &base.account_id,
            &folder.id,
            &remote_id,
        )? else {
            return Ok(());
        };

        let raw = match provider
            .inner()
            .fetch_message_raw_by_uid(&folder.remote_id, uid)
            .await
        {
            Ok(raw) => raw,
            Err(error) => {
                let _ = base.store.fail_body_download_job(&message_id, &error.to_string());
                return Err(error);
            }
        };
        match Self::hydrate_message_from_raw(base, folder, &message_id, &raw).await {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = base.store.fail_body_download_job(&message_id, &error.to_string());
                Err(error)
            }
        }
    }

    /// 用已下载的原始邮件 bytes 完成 hydrate：解析、写正文、附件落盘、emit。
    /// 由 hydrate_incremental_message（单封）和批量 backfill（chunk 批量）共用。
    async fn hydrate_message_from_raw(
        base: &SyncWorkerBase,
        folder: &pebble_core::Folder,
        message_id: &str,
        raw: &[u8],
    ) -> Result<()> {
        let parsed = parse_raw_email(raw)?;
        let target = base.store.get_message(message_id)?
            .ok_or_else(|| PebbleError::Internal("Body download target missing".into()))?;
        verify_downloaded_message_identity(
            target.message_id_header.as_deref(),
            parsed.message_id_header.as_deref(),
        )?;
        base.store.delete_attachments_by_message(message_id)?;
        persist_message_attachments_async_checked(
            Arc::clone(&base.store),
            base.attachments_dir.clone(),
            message_id.to_string(),
            parsed.attachments,
        )
        .await?;
        // Leave the header-only marker in place until attachment persistence
        // succeeds, so an I/O failure cannot strand a falsely completed body.
        base.store.update_message_content(
            message_id,
            &parsed.body_text,
            &parsed.body_html,
            &parsed.snippet,
            parsed.has_attachments,
            None,
        )?;
        base.store.complete_body_download_job(message_id)?;

        if let Some(mut message) = base.store.get_message(message_id)? {
            message.body_text = parsed.body_text;
            message.body_html_raw = parsed.body_html;
            message.snippet = parsed.snippet;
            message.has_attachments = parsed.has_attachments;
            message.remote_version = None;
            base.emit_message(StoredMessage {
                message,
                folder_ids: vec![folder.id.clone()],
                notify: false,
            });
        }
        Ok(())
    }

    /// Background full-body backfill: hydrate every message that still only
    /// has headers (remote_version = 'headers-only') so that full text and
    /// attachments are downloaded locally. Hydrated messages flow through the
    /// indexing pipeline again, which makes their body searchable.
    ///
    /// Runs on a dedicated connection and is limited to `limit` messages per
    /// pass so large attachments cannot starve live polling. Failures are
    /// skipped and retried on the next pass. Non-IMAP accounts (POP3 etc.)
    /// are skipped because there is no server-side UID fetch path.
    async fn hydrate_incomplete_bodies(&self, limit: u32) -> Result<u32> {
        let account = self
            .base
            .store
            .get_account(&self.base.account_id)?
            .ok_or_else(|| PebbleError::Internal(format!("Account {} missing", self.base.account_id)))?;
        if account.provider != ProviderType::Imap {
            return Ok(0);
        }
        let candidates = self
            .base
            .store
            .claim_body_download_jobs(&self.base.account_id, limit)?;
        if candidates.is_empty() {
            return Ok(0);
        }
        info!(
            account_id = %self.base.account_id,
            count = candidates.len(),
            "Body backfill: hydrating {} header-only messages in background",
            candidates.len()
        );
        let mut done = 0u32;

        // 先过滤掉已被其他路径 hydrate 的（避免重复下载），并解析 UID。
        // 收集 (folder_id, folder_remote_id, message_id, uid) 列表，按文件夹分组，
        // 每个文件夹内用批量 UID FETCH（一次网络往返拿多封），显著加速。
        struct Candidate {
            message_id: String,
            uid: u32,
        }
        let mut by_folder: std::collections::BTreeMap<String, (String, Vec<Candidate>)> =
            std::collections::BTreeMap::new();
        for (message_id, folder_id, folder_remote_id, remote_uid) in &candidates {
            // Historical MOVE/reconcile bugs sometimes left a complete local
            // copy soft-deleted and a newer header-only duplicate visible.
            // Reuse the complete row itself: this is instant, preserves its
            // attachment paths, and avoids downloading bytes already on disk.
            if let Some(restored_id) = self
                .base
                .store
                .restore_complete_local_duplicate(message_id)?
            {
                done += 1;
                info!(
                    "Body backfill restored complete local duplicate {} for header-only row {}",
                    restored_id, message_id
                );
                continue;
            }
            match self.base.store.get_message(message_id)? {
                Some(message) if message.remote_version.as_deref() == Some("headers-only") => {}
                _ => continue,
            }
            let uid = match remote_uid.parse::<u32>() {
                Ok(uid) => uid,
                Err(_) => {
                    warn!(
                        "Body backfill: invalid remote UID {remote_uid} for {message_id}, skipping"
                    );
                    continue;
                }
            };
            by_folder
                .entry(folder_id.clone())
                .or_insert_with(|| (folder_remote_id.clone(), Vec::new()))
                .1
                .push(Candidate {
                    message_id: message_id.clone(),
                    uid,
                });
        }

        if by_folder.is_empty() {
            return Ok(done);
        }
        let provider = Arc::new(self.provider.clone_for_idle());
        provider.connect().await?;

        // 批量失败标记提升到 pass 级：只要有一个文件夹的批量失败（服务器
        // 不支持批量 UID FETCH，如 Zoho），本轮 pass 内所有文件夹都不再试
        // 批量，避免每个文件夹各白等一次超时。批量成功则保持开启。
        // 若进程级已标记"批量不可用"（历史 pass 失败过），直接跳过批量。
        let mut batch_enabled = !BODY_BACKFILL_BATCH_DISABLED.load(std::sync::atomic::Ordering::Relaxed);
        for (_folder_id, (folder_remote_id, items)) in &by_folder {
            // ── 成熟策略（对任何服务器通用，不针对 Zoho）──
            // 第 1 步：一次 UID FETCH (RFC822.SIZE) 批量拿所有候选邮件大小。
            //         响应只有 uid+size 两列，几百封一次命令也不会超时。
            // 第 2 步：按大小分流——
            //   小邮件（≤128KB）→ 批量 BODY.PEEK[]（每批 20 封，总响应约 2.5MB）
            //   大邮件（>128KB）→ 单封分片拉取（1MiB chunk 路径，专为大附件设计）
            // 批量只在真正失败（服务器不支持）时禁用；逐封路径配合
            // last_selected 去重，每封只剩一次 UID FETCH 往返，仍是主流方案。
            let (size_by_uid, sizes_authoritative): (std::collections::HashMap<u32, u32>, bool) = match provider
                .inner()
                .fetch_message_sizes_by_uids(folder_remote_id, &items.iter().map(|c| c.uid).collect::<Vec<_>>())
                .await
            {
                Ok(sizes) => (sizes.into_iter().collect(), true),
                Err(size_error) => {
                    // 拿不到大小（个别服务器限制）→ 全部按大邮件单封分片处理，仍正确。
                    warn!(
                        "Body backfill: fetch sizes failed for folder {folder_remote_id} ({size_error}); falling back to per-message fetch"
                    );
                    (std::collections::HashMap::new(), false)
                }
            };

            // A successful UID FETCH (RFC822.SIZE) response is authoritative:
            // omitted UIDs no longer exist in this mailbox. This most often
            // happens after IMAP MOVE assigned a different UID in the target.
            // Park those jobs instead of hammering the same stale UID forever;
            // the header pass will rebind and wake them when it sees the new UID.
            if sizes_authoritative {
                for candidate in items.iter().filter(|c| !size_by_uid.contains_key(&c.uid)) {
                    let rebound = match self.base.store.get_message(&candidate.message_id)? {
                        Some(message) => match message.message_id_header.as_deref() {
                            Some(header) => match provider
                                .inner()
                                .find_uid_by_message_id(folder_remote_id, header)
                                .await
                            {
                                Ok(Some(destination_uid)) if destination_uid != candidate.uid => self
                                    .base
                                    .store
                                    .rebind_message_remote_id_by_header_in_folder(
                                        &self.base.account_id,
                                        _folder_id,
                                        header,
                                        &destination_uid.to_string(),
                                        None,
                                    )?
                                    .is_some(),
                                Ok(_) => false,
                                Err(error) => {
                                    debug!(
                                        "Destination UID lookup failed for {} in {}: {}",
                                        candidate.message_id, folder_remote_id, error
                                    );
                                    false
                                }
                            },
                            None => false,
                        },
                        None => false,
                    };
                    if rebound {
                        info!(
                            "Body backfill rebound moved message {} in {}; retrying with destination UID",
                            candidate.message_id, folder_remote_id
                        );
                        continue;
                    }
                    let reason = format!(
                        "IMAP UID {} is absent from mailbox {}; waiting for destination UID rebind",
                        candidate.uid, folder_remote_id
                    );
                    let _ = self.base.store.mark_body_download_job_unavailable(
                        &candidate.message_id,
                        &reason,
                    );
                }
            }

            // 小邮件批量（每批 20 封 ≤128KB 的，总响应 ~2.5MB 可控）。
            // batch_enabled 是 pass 级的：任何文件夹批量失败都会禁用整个 pass 的批量。
            const SMALL_THRESHOLD: u32 = 128 * 1024;
            let small: Vec<&Candidate> = items
                .iter()
                .filter(|c| !sizes_authoritative || size_by_uid.contains_key(&c.uid))
                .filter(|c| size_by_uid.get(&c.uid).copied().unwrap_or(u32::MAX) <= SMALL_THRESHOLD)
                .collect();
            for chunk in small.chunks(20) {
                if !batch_enabled {
                    // 批量已在前面文件夹失败过 → 这批小邮件直接逐封分片拉取
                    for candidate in chunk {
                        match self.base.store.get_message(&candidate.message_id)? {
                            Some(message) if message.remote_version.as_deref() == Some("headers-only") => {}
                            _ => continue,
                        }
                        let folder = match self.base.store.get_folder(&_folder_id)? {
                            Some(folder) => folder,
                            None => continue,
                        };
                        match Self::hydrate_incremental_message(
                            &self.base,
                            &provider,
                            &folder,
                            candidate.uid,
                        )
                        .await
                        {
                            Ok(()) => done += 1,
                            Err(error) => {
                                warn!(
                                    "Body backfill: hydrate failed for {} ({error}); retried next pass",
                                    candidate.message_id
                                );
                                let _ = self.base.store.fail_body_download_job(
                                    &candidate.message_id,
                                    &error.to_string(),
                                );
                            }
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    }
                    continue;
                }
                let uids: Vec<u32> = chunk.iter().map(|c| c.uid).collect();
                let raws = match provider
                    .inner()
                    .fetch_messages_raw_by_uids_with_sizes(folder_remote_id, &uids)
                    .await
                {
                    Ok(raws) => raws,
                    Err(batch_error) => {
                        let batch_error_text = batch_error.to_string();
                        let connection_lost = is_retryable_imap_connection_error(&batch_error)
                            || batch_error_text.contains("timed out waiting for connection")
                            || batch_error_text.contains("timed out after");
                        warn!(
                            "Body backfill: batch fetch failed for folder {folder_remote_id} ({batch_error}); disabling batch for this pass and this process, falling back to per-message fetch"
                        );
                        batch_enabled = false;
                        // 进程级记住：该服务器不支持批量，后续 pass 不再尝试。
                        BODY_BACKFILL_BATCH_DISABLED.store(true, std::sync::atomic::Ordering::Relaxed);
                        let failed_ids: Vec<String> = chunk
                            .iter()
                            .map(|candidate| candidate.message_id.clone())
                            .collect();
                        let _ = self.base.store.retry_body_download_jobs(
                            &failed_ids,
                            &format!("batch fetch failed: {batch_error}"),
                        );
                        if connection_lost {
                            let remaining_ids: Vec<String> = candidates
                                .iter()
                                .map(|candidate| candidate.0.clone())
                                .collect();
                            let _ = self.base.store.retry_body_download_jobs(
                                &remaining_ids,
                                &format!("IMAP connection lost during body backfill: {batch_error}"),
                            );
                            let _ = provider.disconnect().await;
                            return Ok(done);
                        }
                        continue;
                    }
                };
                let raw_by_uid: std::collections::HashMap<u32, (Vec<u8>, Option<u32>)> =
                    raws.into_iter().map(|(uid, raw, size)| (uid, (raw, size))).collect();
                for candidate in chunk {
                    let (mut raw, expected_size) = if let Some((raw, size)) = raw_by_uid.get(&candidate.uid) {
                        (raw.clone(), size.or(size_by_uid.get(&candidate.uid).copied()))
                    } else {
                        // Some IMAP servers accept a batch command but omit a
                        // body item. Retry this UID once through the mature
                        // single-message path before classifying the job.
                        let folder = match self.base.store.get_folder(&_folder_id)? {
                            Some(folder) => folder,
                            None => continue,
                        };
                        match provider.inner().fetch_message_raw_by_uid(&folder.remote_id, candidate.uid).await {
                            // The single-message path already verifies the
                            // size from the same FETCH, not the old estimate.
                            Ok(raw) => (raw, None),
                            Err(error) => {
                                let _ = self.base.store.fail_body_download_job(
                                    &candidate.message_id,
                                    &error.to_string(),
                                );
                                continue;
                            }
                        }
                    };
                    if let Err(error) = verify_raw_message_size(
                        candidate.uid,
                        &raw,
                        expected_size,
                    ) {
                        warn!("Body backfill: size changed for {}; fetching this UID with its current RFC822.SIZE ({error})", candidate.message_id);
                        let folder = match self.base.store.get_folder(&_folder_id)? {
                            Some(folder) => folder,
                            None => continue,
                        };
                        // The single-message path verifies against the size
                        // from its own FETCH. Do not reuse stale batch metadata
                        // or accept the original mismatching bytes.
                        match provider.inner().fetch_message_raw_by_uid(&folder.remote_id, candidate.uid).await {
                            Ok(verified) => raw = verified,
                            Err(error) => {
                                let _ = self.base.store.fail_body_download_job(&candidate.message_id, &error.to_string());
                                continue;
                            }
                        }
                    }
                    match self.base.store.get_message(&candidate.message_id)? {
                        Some(message) if message.remote_version.as_deref() == Some("headers-only") => {}
                        _ => continue,
                    }
                    let folder = match self.base.store.get_folder(&_folder_id)? {
                        Some(folder) => folder,
                        None => continue,
                    };
                    match Self::hydrate_message_from_raw(
                        &self.base,
                        &folder,
                        &candidate.message_id,
                        &raw,
                    )
                    .await
                    {
                        Ok(()) => done += 1,
                        Err(error) => {
                            warn!(
                                "Body backfill: hydrate failed for {} ({error}); retried next pass",
                                candidate.message_id
                            );
                            let _ = self.base.store.fail_body_download_job(
                                &candidate.message_id,
                                &error.to_string(),
                            );
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            }

            // 大邮件（或拿不到大小）→ 单封分片拉取（SELECT 已由 last_selected 去重）
            let large: Vec<&Candidate> = items
                .iter()
                .filter(|c| !sizes_authoritative || size_by_uid.contains_key(&c.uid))
                .filter(|c| size_by_uid.get(&c.uid).copied().unwrap_or(u32::MAX) > SMALL_THRESHOLD)
                .collect();
            for candidate in large {
                match self.base.store.get_message(&candidate.message_id)? {
                    Some(message) if message.remote_version.as_deref() == Some("headers-only") => {}
                    _ => continue,
                }
                let folder = match self.base.store.get_folder(&_folder_id)? {
                    Some(folder) => folder,
                    None => continue,
                };
                match Self::hydrate_incremental_message(
                    &self.base,
                    &provider,
                    &folder,
                    candidate.uid,
                )
                .await
                {
                    Ok(()) => done += 1,
                    Err(error) => {
                        warn!(
                            "Body backfill: hydrate failed for {} ({error}); retried next pass",
                            candidate.message_id
                        );
                        let _ = self.base.store.fail_body_download_job(
                            &candidate.message_id,
                            &error.to_string(),
                        );
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        }
        let _ = provider.disconnect().await;
        info!(
            account_id = %self.base.account_id,
            done,
            remaining = candidates.len() as u32 - done,
            "Body backfill pass finished"
        );
        Ok(done)
    }

    /// Backfill the full history of a folder that has no sync cursor yet,
    /// e.g. a folder just re-added to the account's IMAP selection after
    /// being deselected (which clears its local data).
    ///
    /// Pages backwards through the mailbox by sequence number until every
    /// message is stored, so re-selecting a folder recovers more than the
    /// most recent batch. Each page is one SELECT + FETCH round trip on the
    /// same session; the per-page range is recomputed from the latest
    /// EXISTS so late deletions shrink pages gracefully.
    ///
    /// Callers must not persist a cursor when this returns an error: a
    /// partially backfilled folder would otherwise advance `last_uid` past
    /// the gap and incremental sync could never fill it again.
    pub async fn sync_folder_history(
        &self,
        folder: &pebble_core::Folder,
        notify_new: bool,
    ) -> Result<u32> {
        self.sync_folder_history_pages(folder, notify_new, None).await
    }

    /// Backfill folder history, advancing at most `max_pages` pages
    /// (None = full history). Large mailboxes are therefore completed over
    /// multiple runs instead of blocking the worker for hours, which keeps
    /// the account out of a perpetual "syncing" state while the history
    /// still eventually completes in the background.
    async fn sync_folder_history_pages(
        &self,
        folder: &pebble_core::Folder,
        notify_new: bool,
        max_pages: Option<u32>,
    ) -> Result<u32> {
        if Self::is_local_folder(folder) {
            return Ok(0);
        }

        let status = self
            .provider
            .inner()
            .get_mailbox_status(&folder.remote_id)
            .await?;
        let cursor = self.prepare_verified_imap_cursor(folder, self.stored_imap_folder_cursor(folder), status)?;
        let mut next_end = cursor.history_next_sequence.unwrap_or(status.exists);
        let page_limit = max_pages.unwrap_or(u32::MAX) as usize;

        let mut total = 0u32;
        let mut processed = 0u32;
        let mut index = 0usize;
        while index < page_limit && next_end > 0 {
            let end_seq = next_end.min(status.exists);
            let start_seq = end_seq.saturating_sub(HISTORY_PAGE_SIZE_FAST - 1).max(1);
            info!(
                "History sync page {}/{} for {} (sequence {}:{})",
                index + 1,
                page_limit.min(history_page_ranges(end_seq, HISTORY_PAGE_SIZE_FAST).len()),
                folder.name,
                start_seq,
                end_seq
            );
            let raw_messages = self
                .fetch_history_page_with_fallback(folder, start_seq, end_seq)
                .await?;
            // 历史补全只存邮件头（headers-only），正文/附件在打开时按需下载，
            // 避免带附件邮件拖慢整个历史同步。
            let count = self
                .store_fetched_messages(folder, raw_messages, notify_new && index == 0, true)
                .await?;
            total += count;
            processed += end_seq - start_seq + 1;
            info!(
                "History sync page {}/{} stored {} new messages for {} (total {})",
                index + 1,
                page_limit.min(history_page_ranges(end_seq, HISTORY_PAGE_SIZE_FAST).len()),
                count,
                folder.name,
                total
            );
            // 每页完成后上报进度：服务器该文件夹总数 vs 已处理条数，
            // 让状态栏显示"历史同步中 已收 X / 总 Y"。
            self.base.emit_sync_progress(
                "history",
                status.exists,
                processed.min(status.exists),
            );
            next_end = start_seq.saturating_sub(1);
            let mut cursor = self.stored_imap_folder_cursor(folder);
            cursor.history_next_sequence = (next_end > 0).then_some(next_end);
            cursor.history_complete = next_end == 0;
            self.persist_imap_folder_cursor_after_sync(folder, cursor)?;
            index += 1;
        }

        Ok(total)
    }

    /// Fetch one headers-only history page, transparently retrying in small
    /// sub-pages after reconnecting when a server rejects the larger range.
    async fn fetch_history_page_with_fallback(
        &self,
        folder: &pebble_core::Folder,
        start_seq: u32,
        end_seq: u32,
    ) -> Result<Vec<(u32, Vec<u8>)>> {
        match self
            .provider
            .inner()
            .fetch_messages_headers_range(&folder.remote_id, start_seq, end_seq)
            .await
        {
            Ok(msgs) => Ok(msgs),
            Err(e) if is_retryable_imap_connection_error(&e) => {
                warn!(
                    "History page {}:{} for {} timed out ({}); retrying in small pages",
                    start_seq, end_seq, folder.name, e
                );
                let _ = self.provider.disconnect().await;
                self.provider.connect().await?;
                let mut out = Vec::new();
                let mut had_failure = false;
                let mut end = end_seq;
                while end >= start_seq {
                    let start = if end > start_seq + HISTORY_PAGE_SIZE - 1 {
                        end - HISTORY_PAGE_SIZE + 1
                    } else {
                        start_seq
                    };
                    match self
                        .provider
                        .inner()
                        .fetch_messages_headers_range(&folder.remote_id, start, end)
                        .await
                    {
                        Ok(msgs) => out.extend(msgs),
                        Err(e2) => {
                            had_failure = true;
                            warn!(
                                "Small history page {}:{} for {} failed ({}); retrying next pass",
                                start, end, folder.name, e2
                            );
                        }
                    }
                    if start == start_seq {
                        break;
                    }
                    end = start - 1;
                }
                // 小页全部失败：返回错误让回填暂停（游标不推进），下轮再试，
                // 避免"遍历完但一封没存却标记完成"的静默丢失。
                if had_failure {
                    return Err(PebbleError::Network(format!(
                        "History backfill page {start_seq}:{end_seq} for {} failed after small-page retry",
                        folder.name
                    )));
                }
                Ok(out)
            }
            Err(e) => Err(e),
        }
    }

    /// Store a batch of raw fetched messages, resolving threads and
    /// attachments. Returns the number of newly stored messages.
    async fn store_fetched_messages(
        &self,
        folder: &pebble_core::Folder,
        raw_messages: Vec<(u32, Vec<u8>)>,
        notify_new: bool,
        headers_only: bool,
    ) -> Result<u32> {
        if raw_messages.is_empty() {
            return Ok(0);
        }

        // Bulk-check which UIDs already exist to avoid N+1 queries
        let all_remote_ids: Vec<String> = raw_messages
            .iter()
            .map(|(uid, _)| uid.to_string())
            .collect();
        let epoch = self.stored_imap_folder_cursor(folder).uidvalidity.unwrap_or(0);
        if epoch != 0 && self.base.store.has_detached_imap_uid_match(&self.base.account_id, &folder.id, epoch, &all_remote_ids)? {
            let current = self.provider.inner().get_mailbox_status(&folder.remote_id).await?;
            if current.uid_validity.map(u64::from) != Some(epoch) {
                return Err(PebbleError::Sync("IMAP UIDVALIDITY changed during mail fetch; retry next pass".into()));
            }
            self.base.store.restore_visible_history(&self.base.account_id, &folder.id, epoch, &all_remote_ids)?;
        }
        let existing_ids = self
            .base
            .store
            .get_existing_remote_ids_in_folder(&self.base.account_id, &folder.id, &all_remote_ids)
            .unwrap_or_default();
        // Parse all raw messages upfront so we can collect In-Reply-To / References
        // before querying thread mappings (avoids loading the full account mapping).
        let parsed_messages: Vec<(u32, Result<crate::parser::ParsedMessage>)> = raw_messages
            .into_iter()
            .filter(|(uid, _)| {
                let remote_id = uid.to_string();
                if existing_ids.contains(&remote_id) {
                    let _ = self.base.store.clear_sync_failure(
                        &self.base.account_id,
                        &folder.id,
                        &remote_id,
                    );
                    debug!(
                        "Message UID {} already stored in {}, skipping",
                        uid, folder.name
                    );
                    false
                } else {
                    true
                }
            })
            .map(|(uid, raw)| {
                let parsed = parse_raw_email(&raw);
                (uid, parsed)
            })
            .collect();

        // Collect all referenced message-ID headers from this batch.
        let ref_ids = collect_ref_ids_from_parsed(&parsed_messages);

        // Load thread mappings only for the IDs referenced by this batch.
        // This is mutable so we can extend it as we store new messages within the batch,
        // ensuring intra-batch replies find their parent's thread.
        let mut thread_mappings = self
            .base
            .store
            .get_thread_mappings_for_refs(&self.base.account_id, &ref_ids)
            .unwrap_or_default();

        let mut stored_count = 0u32;

        // Build the whole batch before touching SQLite. The old implementation
        // committed one transaction per message, which serialized every
        // header into its own writer lock and made large mailboxes crawl.
        let mut pending: Vec<(u32, Message, Vec<AttachmentData>, String)> = Vec::new();

        for (uid, parse_result) in parsed_messages {
            let remote_id = uid.to_string();

            let parsed = match parse_result {
                Ok(p) => p,
                Err(e) => {
                    let reason = e.to_string();
                    let _ = self.base.store.upsert_sync_failure(
                        &self.base.account_id,
                        &folder.id,
                        &remote_id,
                        "imap",
                        &reason,
                    );
                    warn!("Failed to parse message UID {}: {}", uid, e);
                    continue;
                }
            };

            let now = now_timestamp();

            // Build a temporary message to compute thread_id
            let mut msg = Message {
                id: new_id(),
                account_id: self.base.account_id.clone(),
                remote_id: remote_id.clone(),
                message_id_header: parsed.message_id_header.clone(),
                in_reply_to: parsed.in_reply_to.clone(),
                references_header: parsed.references_header.clone(),
                thread_id: None,
                subject: parsed.subject.clone(),
                snippet: parsed.snippet.clone(),
                from_address: parsed.from_address.clone(),
                from_name: parsed.from_name.clone(),
                to_list: parsed.to_list.clone(),
                cc_list: parsed.cc_list.clone(),
                bcc_list: parsed.bcc_list.clone(),
                body_text: parsed.body_text.clone(),
                body_html_raw: parsed.body_html.clone(),
                has_attachments: parsed.has_attachments,
                // 已发送文件夹（Sent）的消息本来就是已读的，不参与未读计数
                is_read: folder.role == Some(pebble_core::FolderRole::Sent),
                is_starred: false,
                is_draft: false,
                date: parsed.date,
                remote_version: headers_only.then(|| "headers-only".to_string()),
                is_deleted: false,
                deleted_at: None,
                created_at: now,
                updated_at: now,
            };

            let thread_id = compute_thread_id(&msg, &thread_mappings);
            msg.thread_id = Some(thread_id);

            // Update in-memory thread mappings so later messages in this batch
            // can find this message as a thread parent.
            if let (Some(mid), Some(tid)) = (&msg.message_id_header, &msg.thread_id) {
                thread_mappings.insert(mid.clone(), tid.clone());
            }

            pending.push((uid, msg, parsed.attachments, remote_id));
        }

        let batch: Vec<(Message, Vec<String>)> = pending
            .iter()
            .map(|(_, msg, _, _)| (msg.clone(), vec![folder.id.clone()]))
            .collect();

        let (inserted, deferred) = match self.base.store.insert_imap_messages_batch(&batch) {
            Ok(result) => result,
            Err(error) => {
            let reason = error.to_string();
            for (uid, _, _, remote_id) in &pending {
                let _ = self.base.store.upsert_sync_failure(
                    &self.base.account_id,
                    &folder.id,
                    remote_id,
                    "imap",
                    &reason,
                );
                error!("Failed to store message UID {}: {}", uid, error);
            }
            return Ok(0);
            }
        };
        let deferred: HashSet<String> = deferred.into_iter().collect();
        for remote_id in &deferred {
            self.base.store.upsert_sync_failure(&self.base.account_id, &folder.id, &remote_id,
                "imap", "本地发送或移动任务仍在处理，等待任务结束后核对服务器副本")?;
        }
        let inserted: HashSet<String> = inserted.into_iter().collect();

        for (_, msg, attachments, remote_id) in pending {
            if !inserted.contains(&msg.id) {
                if !deferred.contains(&remote_id) {
                    self.base.store.clear_sync_failure(&self.base.account_id, &folder.id, &remote_id)?;
                }
                continue;
            }
            stored_count += 1;
            let _ = self.base.store.clear_sync_failure(
                &self.base.account_id,
                &folder.id,
                &remote_id,
            );

            if !headers_only {
                persist_message_attachments_async(
                    Arc::clone(&self.base.store),
                    self.base.attachments_dir.clone(),
                    msg.id.clone(),
                    attachments,
                ).await;
            }

            // Notify listeners only after the entire SQLite batch is durable.
            self.base.emit_message(StoredMessage {
                message: msg,
                folder_ids: vec![folder.id.clone()],
                notify: notify_new,
            });
        }

        Ok(stored_count)
    }

    /// Poll all folders for new messages since the highest known UID.
    pub async fn poll_new_messages(&self) -> Result<()> {
        self.poll_new_messages_for_scope("poll", ImapPollScope::Realtime)
            .await
    }

    async fn poll_all_new_messages(&self, phase: &str) -> Result<()> {
        self.poll_new_messages_for_scope(phase, ImapPollScope::Full)
            .await
    }

    async fn poll_new_messages_for_scope(&self, phase: &str, scope: ImapPollScope) -> Result<()> {
        self.base.emit_sync_started(phase);
        let result = self.poll_new_messages_inner(scope).await;
        match &result {
            Ok(()) => self.base.emit_sync_completed(phase),
            Err(e) => self.base.emit_sync_error(phase, &e.to_string()),
        }
        result
    }

    async fn poll_new_messages_inner(&self, scope: ImapPollScope) -> Result<()> {
        let folders = self.base.store.list_folders(&self.base.account_id)?;
        if folders.is_empty() {
            return Ok(());
        }

        let mut first_recovered_error = None;
        for folder in folders
            .iter()
            .filter(|folder| should_poll_imap_folder_for_scope(folder, scope))
        {
            if let Some(e) = self.poll_imap_folder_with_reconnect(folder).await {
                if first_recovered_error.is_none() {
                    first_recovered_error = Some(e);
                }
            }
        }

        if let Some(e) = first_recovered_error {
            return Err(e);
        }

        Ok(())
    }

    async fn poll_changed_custom_folders(&self) -> Result<()> {
        let folders = self.base.store.list_folders(&self.base.account_id)?;
        for folder in folders.iter().filter(|folder| should_probe_custom_folder_for_new_mail(folder)) {
            let cursor = self.stored_imap_folder_cursor(folder);
            let Some(last_uid) = cursor.last_uid else {
                // Initial/history synchronization owns mailboxes without a
                // trusted cursor; do not turn old mail into new-mail alerts.
                continue;
            };
            let status = match self.provider.inner().probe_mailbox_status(&folder.remote_id).await {
                Ok(status) => status,
                Err(error) => {
                    debug!("Custom-folder status probe skipped for {}: {}", folder.name, error);
                    continue;
                }
            };
            let uidvalidity_changed = matches!(
                (cursor.uidvalidity, status.uid_validity.map(u64::from)),
                (Some(stored), Some(current)) if stored != current
            );
            let has_new_uid = status.uid_next.is_some_and(|next| next > last_uid.saturating_add(1));
            if uidvalidity_changed || has_new_uid {
                let _ = self.poll_imap_folder_with_reconnect(folder).await;
            }
        }
        Ok(())
    }

    async fn poll_imap_folder_with_reconnect(
        &self,
        folder: &pebble_core::Folder,
    ) -> Option<PebbleError> {
        match self.poll_imap_folder_once(folder).await {
            Ok(()) => None,
            Err(e) if is_missing_imap_mailbox_error(&e) => {
                self.quarantine_folder(folder, &e.to_string());
                debug!(
                    "Skipping unavailable IMAP folder {} ({}) for account {}: {}",
                    folder.name, folder.remote_id, self.base.account_id, e
                );
                None
            }
            Err(e) if is_retryable_imap_connection_error(&e) => {
                warn!(
                    "IMAP connection failed while polling folder {} account {}; reconnecting before retry: {}",
                    folder.name, self.base.account_id, e
                );
                let _ = self.provider.disconnect().await;
                match self.provider.connect().await {
                    Ok(()) => {
                        if let Err(retry_error) = self.poll_imap_folder_once(folder).await {
                            warn!(
                                "Poll retry failed for folder {} account {} after reconnect: {}",
                                folder.name, self.base.account_id, retry_error
                            );
                            self.base.emit_error(
                                "poll",
                                &format!(
                                    "Poll retry failed for folder {}: {}",
                                    folder.name, retry_error
                                ),
                            );
                            if is_retryable_imap_connection_error(&retry_error) {
                                return Some(retry_error);
                            }
                        }
                        None
                    }
                    Err(reconnect_error) => {
                        warn!(
                            "Reconnect failed while polling folder {} account {}: {}",
                            folder.name, self.base.account_id, reconnect_error
                        );
                        Some(reconnect_error)
                    }
                }
            }
            Err(e) => {
                warn!(
                    "Poll failed for folder {} account {}: {}",
                    folder.name, self.base.account_id, e
                );
                self.base.emit_error(
                    "poll",
                    &format!("Poll failed for folder {}: {}", folder.name, e),
                );
                None
            }
        }
    }

    async fn poll_imap_folder_once(&self, folder: &pebble_core::Folder) -> Result<()> {
        if !should_attempt_imap_remote_folder(folder) || self.is_folder_quarantined(folder) {
            debug!(
                "Skipping local-only IMAP folder {} ({}) during poll",
                folder.name, folder.remote_id
            );
            return Ok(());
        }

        let cursor = self.try_imap_folder_cursor_for_sync(folder).await?;
        let since_uid = cursor.last_uid;

        let (count, cursor) = if let Some(uid) = since_uid {
            // 先存头，再逐封尽力补全正文/附件；单封超时不阻塞整批新邮件。
            (self.sync_folder_headers_with_hydration(
                folder,
                Some(uid),
                HISTORY_PAGE_SIZE_FAST,
                true,
            )
                .await?, cursor)
        } else {
            // Folder was just added to the selection (or its cursor was
            // lost): backfill the full history before switching to
            // incremental polls.
            let count = self.sync_folder_history(folder, false).await?;
            (count, self.stored_imap_folder_cursor(folder))
        };
        if count > 0 {
            info!(
                "Polled {} new messages from {} for account {}",
                count, folder.name, self.base.account_id
            );
        }
        if let Err(e) = self.persist_imap_folder_cursor_after_sync(folder, cursor) {
            warn!("Failed to persist IMAP cursor for {}: {}", folder.name, e);
        }

        Ok(())
    }

    /// Reconcile a folder: detect flag changes and changes in visible UIDs.
    ///
    /// When the server supports CONDSTORE (RFC 4551), this method first checks
    /// the mailbox HIGHESTMODSEQ against the stored value. If they match, no
    /// flags have changed and the expensive full flag fetch is skipped entirely.
    /// When they differ (or on the first sync), a full flag fetch is performed
    /// and the new MODSEQ is persisted in the cursor.
    async fn reconcile_folder(&self, folder: &pebble_core::Folder) -> Result<()> {
        match self.reconcile_folder_once(folder).await {
            Ok(()) => Ok(()),
            Err(e) if is_missing_imap_mailbox_error(&e) => {
                self.quarantine_folder(folder, &e.to_string());
                debug!(
                    "Skipping unavailable IMAP folder {} ({}) during reconcile for account {}: {}",
                    folder.name, folder.remote_id, self.base.account_id, e
                );
                Ok(())
            }
            Err(e) if is_retryable_imap_connection_error(&e) => {
                warn!(
                    "IMAP connection failed while reconciling folder {} account {}; reconnecting before retry: {}",
                    folder.name, self.base.account_id, e
                );
                let _ = self.provider.disconnect().await;
                self.provider.connect().await?;
                self.reconcile_folder_once(folder).await
            }
            Err(e) => Err(e),
        }
    }

    async fn reconcile_folder_once(&self, folder: &pebble_core::Folder) -> Result<()> {
        // Skip local-only folders
        if Self::is_local_folder(folder) {
            return Ok(());
        }
        // A reused UID in a new epoch must not inherit the old local body.
        let cursor = self.try_imap_folder_cursor_for_sync(folder).await?;
        let expected_epoch = cursor.uidvalidity;
        self.persist_imap_folder_cursor_after_sync(folder, cursor)?;

        // Step 1: Get local state
        let local_state = self
            .base
            .store
            .list_remote_ids_by_folder(&self.base.account_id, &folder.id)?;

        // Read stored MODSEQ from this folder's cursor.
        let stored_modseq = self
            .stored_imap_folder_cursor(folder)
            .highest_modseq
            .unwrap_or(0);

        // Step 2: Try CONDSTORE optimisation — check HIGHESTMODSEQ
        let condstore_skip = match self
            .provider
            .inner()
            .get_highest_modseq(&folder.remote_id)
            .await
        {
            Ok(Some(server_modseq)) => {
                if reconcile::can_skip_reconcile(stored_modseq, server_modseq) {
                    debug!(
                        "CONDSTORE: HIGHESTMODSEQ unchanged ({}), skipping flag reconcile for {}",
                        server_modseq, folder.name
                    );
                    true
                } else {
                    debug!(
                        "CONDSTORE: HIGHESTMODSEQ changed ({} -> {}), doing full flag reconcile for {}",
                        stored_modseq, server_modseq, folder.name
                    );
                    false
                }
            }
            Ok(None) => {
                // Server does not support CONDSTORE — fall through to full reconcile
                false
            }
            Err(e) => {
                warn!(
                    "CONDSTORE HIGHESTMODSEQ check failed for {}: {}",
                    folder.name, e
                );
                false
            }
        };

        if !condstore_skip {
            // Step 3: Fetch remote flags (with MODSEQ when possible)
            let uids: Vec<u32> = local_state
                .iter()
                .filter_map(|(_, remote_id, _, _, _)| remote_id.parse().ok())
                .collect();

            // Try fetching flags with MODSEQ to update the stored value
            let (remote_flags, new_modseq) = match self
                .provider
                .inner()
                .fetch_flags_with_modseq(&folder.remote_id, &uids)
                .await
            {
                Ok(result) => result,
                Err(e) => {
                    // Fall back to plain flag fetch if MODSEQ fetch fails
                    warn!("fetch_flags_with_modseq failed, falling back: {}", e);
                    let flags = self
                        .provider
                        .inner()
                        .fetch_flags(&folder.remote_id, &uids)
                        .await?;
                    (flags, 0)
                }
            };

            // Step 4: Compute and apply flag diff
            let flag_changes = reconcile::compute_flag_diff(&local_state, &remote_flags);
            if !flag_changes.is_empty() {
                info!(
                    "Applying {} flag changes for folder {}",
                    flag_changes.len(),
                    folder.name
                );
                self.base.store.bulk_update_flags(&flag_changes)?;
            }

            // Step 5: Persist new MODSEQ in cursor if we got one
            if new_modseq > 0 {
                self.update_folder_cursor_modseq(folder, new_modseq);
            }
        }

        // Step 6: Reconcile visibility (CONDSTORE doesn't cover expunges).
        // EXISTS can stay unchanged when one message is expunged and another
        // is added, so compare UID sets whenever local state exists.
        let (inventory, server_uids) = self
            .provider
            .inner()
            .fetch_uid_inventory(&folder.remote_id)
            .await?;
        if should_run_imap_deletion_diff(inventory.exists, local_state.len()) {
            if !valid_imap_uid_inventory(expected_epoch, inventory, &server_uids) {
                return Err(PebbleError::Sync("IMAP inventory changed or was incomplete; local mail left unchanged, retry next pass".into()));
            }
            let epoch = expected_epoch.expect("inventory validated against a known epoch");
            let local_remote_ids: Vec<(String, String)> = local_state
                .iter()
                .map(|(id, rid, _, _, _)| (id.clone(), rid.clone()))
                .collect();
            let absent = reconcile::detect_deletions(&local_remote_ids, &server_uids);
            if !absent.is_empty() {
                if matches!(folder.role, Some(pebble_core::FolderRole::Trash | pebble_core::FolderRole::Spam)) {
                    self.base.store.bulk_soft_delete(&absent)?;
                } else {
                    let absent: HashSet<_> = absent.into_iter().collect();
                    let missing_rows: Vec<_> = local_remote_ids.into_iter().filter(|(id, _)| absent.contains(id)).collect();
                    self.base.store.detach_missing_imap_uids(&self.base.account_id, &folder.id, epoch, &missing_rows)?;
                }
            }
            let mut local_uids: HashSet<u32> = local_state.iter().filter_map(|(_,uid,_,_,_)|uid.parse().ok()).collect();
            if self.base.store.has_detached_imap_uids(&self.base.account_id, &folder.id, epoch)? {
                let visible: Vec<_> = server_uids.iter().filter(|uid| !local_uids.contains(uid)).map(u32::to_string).collect();
                if self.base.store.restore_visible_history(&self.base.account_id, &folder.id, epoch, &visible)? > 0 {
                    local_uids = self.base.store.list_remote_ids_by_folder(&self.base.account_id, &folder.id)?
                        .into_iter().filter_map(|(_,uid,_,_,_)|uid.parse().ok()).collect();
                }
            }
            let missing: Vec<u32> = server_uids.iter().copied().filter(|uid|!local_uids.contains(uid)).take(50).collect();
            if !missing.is_empty() {
                let headers = self.provider.inner().fetch_headers_by_uids(&folder.remote_id, epoch as u32, &missing).await?;
                for uid in missing.iter().filter(|uid|!headers.iter().any(|(found,_)|found==*uid)) {
                    self.base.store.upsert_sync_failure(&self.base.account_id,&folder.id,&uid.to_string(),"imap","UID header missing from repair response")?;
                }
                self.store_fetched_messages(folder, headers, false, true).await?;
            }
        }

        Ok(())
    }

    /// Update the MODSEQ portion of one folder cursor without changing its UID.
    fn update_folder_cursor_modseq(&self, folder: &pebble_core::Folder, new_modseq: u64) {
        let mut cursor = self.stored_imap_folder_cursor(folder);
        cursor.highest_modseq = Some(new_modseq);
        if let Some(state) = serialize_imap_folder_cursor(&cursor) {
            let _ =
                self.base
                    .store
                    .set_folder_sync_state(&self.base.account_id, &folder.id, &state);
        }
    }

    fn spawn_idle_watcher(
        account_id: String,
        idle_provider: Arc<ImapMailProvider>,
        inbox_remote_id: String,
        configured_idle_wait_secs: u64,
        mut stop_rx: watch::Receiver<bool>,
        trigger_tx: mpsc::UnboundedSender<ImapWorkerTrigger>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let idle_wait = tokio::time::Duration::from_secs(
                crate::idle::recommended_idle_wait_secs(configured_idle_wait_secs),
            );
            let mut backoff = SyncBackoff::new();
            let mut connected = false;

            loop {
                if *stop_rx.borrow() {
                    break;
                }

                if backoff.is_circuit_open() {
                    let delay = backoff.current_delay();
                    warn!(
                        "IMAP IDLE watcher circuit open for account {} ({} failures), waiting {:?}",
                        account_id,
                        backoff.failure_count(),
                        delay
                    );
                    match tokio::time::timeout(delay, stop_rx.changed()).await {
                        Ok(Ok(())) if *stop_rx.borrow() => break,
                        _ => {}
                    }
                    continue;
                }

                if !connected {
                    match idle_provider.connect().await {
                        Ok(()) => {
                            connected = true;
                            backoff.record_success();
                        }
                        Err(e) => {
                            warn!(
                                "Failed to connect IMAP IDLE watcher for account {account_id}: {e}"
                            );
                            let delay = backoff.record_failure();
                            match tokio::time::timeout(delay, stop_rx.changed()).await {
                                Ok(Ok(())) if *stop_rx.borrow() => break,
                                _ => {}
                            }
                            continue;
                        }
                    }
                }

                let idle_result = tokio::select! {
                    result = idle_provider.inner().idle_wait(&inbox_remote_id, idle_wait) => Some(result),
                    changed = stop_rx.changed() => {
                        match changed {
                            Ok(()) if *stop_rx.borrow() => None,
                            _ => continue,
                        }
                    }
                };

                let Some(idle_result) = idle_result else {
                    break;
                };

                match idle_result {
                    Ok(crate::idle::IdleEvent::NewMail) => {
                        let _ = trigger_tx.send(ImapWorkerTrigger::ProviderPush);
                        backoff.record_success();
                    }
                    Ok(crate::idle::IdleEvent::Timeout) => {
                        debug!("IMAP IDLE timeout for account {account_id}; re-entering IDLE");
                        backoff.record_success();
                    }
                    Ok(crate::idle::IdleEvent::Error(e)) => {
                        warn!("IMAP IDLE watcher error for account {account_id}: {e}");
                        let _ = idle_provider.disconnect().await;
                        connected = false;
                        let delay = backoff.record_failure();
                        match tokio::time::timeout(delay, stop_rx.changed()).await {
                            Ok(Ok(())) if *stop_rx.borrow() => break,
                            _ => {}
                        }
                    }
                    Err(e) => {
                        warn!("IMAP IDLE watcher failed for account {account_id}: {e}");
                        let _ = idle_provider.disconnect().await;
                        connected = false;
                        let delay = backoff.record_failure();
                        match tokio::time::timeout(delay, stop_rx.changed()).await {
                            Ok(Ok(())) if *stop_rx.borrow() => break,
                            _ => {}
                        }
                    }
                }
            }

            let _ = idle_provider.disconnect().await;
            info!("IMAP IDLE watcher stopped for account {account_id}");
        })
    }

    /// Run the sync worker loop until the stop signal is received.
    pub async fn run(
        &self,
        config: SyncConfig,
        trigger_rx: Option<mpsc::UnboundedReceiver<SyncTrigger>>,
    ) {
        // Connect and do initial sync
        if let Err(e) = self.provider.connect().await {
            error!(
                "Failed to connect for account {}: {}",
                self.base.account_id, e
            );
            self.base
                .emit_error("connection", &format!("Failed to connect: {}", e));
            self.base.emit_sync_error("connection", &e.to_string());
            return;
        }

        self.base.emit_sync_started("initial");
        let initial_sync_succeeded = match self.initial_sync().await {
            Ok(()) => {
                self.base.emit_sync_completed("initial");
                true
            }
            Err(e) => {
                error!(
                    "Initial sync failed for account {}: {}",
                    self.base.account_id, e
                );
                self.base
                    .emit_error("sync", &format!("Initial sync failed: {}", e));
                self.base.emit_sync_error("initial", &e.to_string());
                false
            }
        };

        if config.manual_only() {
            info!("Manual sync completed for account {}", self.base.account_id);
            let _ = self.provider.disconnect().await;
            return;
        }

        // 正文/附件补齐必须与收新邮件、文件夹对账彻底解耦。旧实现把它放在
        // backfill_ticker 分支末尾，前面的 LIST/SELECT 一旦超时，本轮补齐就
        // 永远轮不到；并且等待 40 封完整 MIME 下载会阻塞主同步 select。
        // 每个账号启动一个独立、可停止的后台循环，使用独立 IMAP 连接。
        let body_worker = self.clone();
        tokio::spawn(async move {
            let mut stop_rx = body_worker.stop_rx.clone();
            let mut consecutive_failures = 0u32;
            let mut next_delay = tokio::time::Duration::from_secs(1);
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(next_delay) => {
                        // 全局互斥：同一时间只允许一个账号的正文补齐写数据库，
                        // 避免多账号并发把唯一的写连接占满导致其它操作超时。
                        let lock = BODY_BACKFILL_LOCK
                            .get_or_init(|| tokio::sync::Mutex::new(()))
                            .lock()
                            .await;
                        match body_worker.hydrate_incomplete_bodies(BODY_HYDRATION_BATCH).await {
                            Ok(done) => {
                                consecutive_failures = 0;
                                // 有进度时 3 秒后继续下一轮（原 20 秒，太慢；
                                // 100 封/轮 + 3s ≈ 30+ 封/秒）。已补完时降低
                                // 空轮询频率，避免每 3 秒扫一次数据库。
                                next_delay = tokio::time::Duration::from_secs(if done > 0 { 3 } else { 120 });
                            }
                            Err(error) => {
                                consecutive_failures = consecutive_failures.saturating_add(1);
                                let backoff_secs = 30u64
                                    .saturating_mul(1u64 << consecutive_failures.saturating_sub(1).min(3))
                                    .min(300);
                                next_delay = tokio::time::Duration::from_secs(backoff_secs);
                                warn!(
                                    "Independent body backfill error for account {}: {}; retrying in {}s",
                                    body_worker.base.account_id, error, backoff_secs
                                );
                            }
                        }
                        drop(lock);
                    }
                    changed = stop_rx.changed() => {
                        if changed.is_err() || *stop_rx.borrow() {
                            break;
                        }
                    }
                }
            }
        });

        let poll_policy = imap_poll_policy(&config);
        let reconcile_interval = tokio::time::Duration::from_secs(config.reconcile_interval_secs);

        let mut reconcile_ticker = tokio::time::interval_at(
            tokio::time::Instant::from_std(first_reconcile_deadline(
                Instant::now(),
                reconcile_interval,
            )),
            reconcile_interval,
        );
        reconcile_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        // History backfill advances on its own faster beat (every 2 minutes)
        // so large Sent/Archive mailboxes keep making progress between full
        // 15-minute reconciles, without polling new mail more often.
        let mut backfill_ticker = tokio::time::interval(tokio::time::Duration::from_secs(120));
        backfill_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The account-specific preference has already been resolved into
        // `config`; when absent it contains the global default. Manual mode
        // returned above, so custom folders follow the same active interval.
        let mut custom_folder_ticker = tokio::time::interval(tokio::time::Duration::from_secs(
            custom_folder_poll_interval_secs(&config).unwrap_or(60),
        ));
        custom_folder_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        let supports_idle = self.provider.inner().supports_idle().await;
        if supports_idle {
            info!("IMAP IDLE supported for account {}", self.base.account_id);
            self.base
                .emit_runtime_status(SyncRuntimeStatus::ImapIdleAvailable);
        } else {
            info!(
                "IMAP IDLE not supported for account {}, using polling",
                self.base.account_id
            );
            self.base
                .emit_runtime_status(SyncRuntimeStatus::ImapPollingFallback);
        }

        let supports_condstore = self.provider.inner().supports_condstore().await;
        if supports_condstore {
            info!("CONDSTORE supported for account {}", self.base.account_id);
        } else {
            debug!(
                "CONDSTORE not supported for account {}",
                self.base.account_id
            );
        }

        let mut stop_rx = self.stop_rx.clone();
        let mut last_exists: Option<crate::idle::MailboxUidState> = None;
        let mut backoff = SyncBackoff::new();
        let mut trigger_rx = trigger_rx;
        let mut runtime = RealtimeRuntimeState::new(Duration::from_secs(60), Instant::now());
        let (idle_trigger_tx, mut idle_trigger_rx) = mpsc::unbounded_channel();
        let mut idle_watcher = None;

        if supports_idle {
            match self.base.store.list_folders(&self.base.account_id) {
                Ok(folders) => {
                    if let Some(inbox) = folders
                        .iter()
                        .find(|f| f.role == Some(pebble_core::FolderRole::Inbox))
                    {
                        idle_watcher = Some(Self::spawn_idle_watcher(
                            self.base.account_id.clone(),
                            Arc::clone(&self.idle_provider),
                            inbox.remote_id.clone(),
                            config.poll_interval_secs,
                            self.stop_rx.clone(),
                            idle_trigger_tx.clone(),
                        ));
                    } else {
                        warn!(
                            "IMAP IDLE supported for account {}, but no Inbox folder was available; using polling",
                            self.base.account_id
                        );
                    }
                }
                Err(e) => {
                    warn!(
                        "Failed to load folders before starting IMAP IDLE for account {}: {}; using polling",
                        self.base.account_id, e
                    );
                }
            }
        }
        drop(idle_trigger_tx);
        let mut idle_watcher_active = idle_watcher.is_some();
        let mut polling_baseline_trusted = false;
        if !idle_watcher_active
            && can_seed_imap_polling_baseline_after_startup(initial_sync_succeeded)
        {
            polling_baseline_trusted = self.refresh_inbox_local_uid_baseline(&mut last_exists);
        }

        loop {
            let next_poll_delay =
                poll_policy.next_delay(runtime.context(backoff.failure_count(), Instant::now()));

            tokio::select! {
                _ = custom_folder_ticker.tick() => {
                    if !backoff.is_circuit_open() {
                        if let Err(error) = self.poll_changed_custom_folders().await {
                            warn!("Custom-folder new-mail probe failed for account {}: {}", self.base.account_id, error);
                        }
                    }
                }
                // 历史补全的独立节奏：每 2 分钟推进一次，不等 15 分钟 reconcile。
                _ = backfill_ticker.tick() => {
                    if backoff.is_circuit_open() {
                        continue;
                    }
                    // 自愈：先对账"已标完成但数量不足"的文件夹，复位后重新回填。
                    if let Err(e) = self.heal_stale_complete_folders().await {
                        warn!("Heal tick error for account {}: {}", self.base.account_id, e);
                    }
                    if let Err(e) = self.backfill_incomplete_history(HISTORY_BACKFILL_PAGES_PER_RUN).await {
                        warn!("Backfill tick error for account {}: {}", self.base.account_id, e);
                    }
                    if let Err(e) = self.reconcile_imap_folders().await {
                        warn!("Backfill tick folder sync error for account {}: {}", self.base.account_id, e);
                    }
                    // 正文和附件由独立后台循环补齐；这里不再 await，避免慢邮件
                    // 阻塞实时收信、IDLE、轮询和文件夹对账。
                }
                // 轮询始终作为兜底运行（即使 IDLE watcher 已激活）。
                // 部分服务器（如 Zoho）的 IDLE 不推送新邮件通知，若此时禁用
                // 轮询，新邮件将一直无法自动收到；轮询开销很小（无变化时
                // 只做一次 SELECT 对比）。
                _ = tokio::time::sleep(next_poll_delay) => {
                    if backoff.is_circuit_open() {
                        warn!(
                            "Circuit open for account {} ({} consecutive failures); attempting half-open poll after scheduled delay",
                            self.base.account_id, backoff.failure_count()
                        );
                    }

                    if !polling_baseline_trusted {
                        match self.poll_new_messages().await {
                            Ok(()) => {
                                backoff.record_success();
                                polling_baseline_trusted =
                                    self.refresh_inbox_local_uid_baseline(&mut last_exists);
                            }
                            Err(e) => {
                                warn!("Catch-up poll before IMAP baseline refresh failed for account {}: {}", self.base.account_id, e);
                                self.base.emit_error("poll", &format!("Catch-up poll before IMAP baseline refresh failed: {}", e));
                                backoff.record_failure();
                            }
                        }
                        continue;
                    }

                    // Quick check if mailbox has changes before doing full poll
                    let folders = match self.base.store.list_folders(&self.base.account_id) {
                        Ok(f) => f,
                        Err(_) => {
                            backoff.record_failure();
                            continue;
                        }
                    };
                    if let Some(inbox) = folders.iter().find(|f| f.role == Some(pebble_core::FolderRole::Inbox)) {
                        match crate::idle::check_for_changes_with_idle(self.provider.inner(), &inbox.remote_id, &mut last_exists, false).await {
                            Ok(crate::idle::IdleEvent::NewMail) => {
                                if let Err(e) = self.poll_new_messages().await {
                                    warn!("Poll error for account {}: {}", self.base.account_id, e);
                                    self.base.emit_error("poll", &format!("Poll error: {}", e));
                                    backoff.record_failure();
                                } else {
                                    backoff.record_success();
                                    polling_baseline_trusted =
                                        self.refresh_inbox_local_uid_baseline(&mut last_exists);
                                }
                            }
                            Ok(crate::idle::IdleEvent::Timeout) => {
                                debug!("No changes detected for account {}", self.base.account_id);
                                backoff.record_success();
                            }
                            Ok(crate::idle::IdleEvent::Error(e)) => {
                                warn!("IDLE check error for account {}: {}", self.base.account_id, e);
                                let _ = self.provider.disconnect().await;
                                let recovery_error = match self.provider.connect().await {
                                    Ok(()) => match self.poll_new_messages().await {
                                        Ok(()) => {
                                            polling_baseline_trusted = self
                                                .refresh_inbox_local_uid_baseline(&mut last_exists);
                                            None
                                        }
                                        Err(poll_error) => {
                                            warn!(
                                                "Poll after idle check reconnect failed for account {}: {}",
                                                self.base.account_id, poll_error
                                            );
                                            idle_check_recovery_user_error(
                                                None,
                                                Some(poll_error.to_string()),
                                            )
                                        }
                                    },
                                    Err(reconnect_error) => {
                                        warn!(
                                            "Reconnect after idle check failed for account {}: {}",
                                            self.base.account_id, reconnect_error
                                        );
                                        idle_check_recovery_user_error(
                                            Some(reconnect_error.to_string()),
                                            None,
                                        )
                                    }
                                };
                                if let Some((error_type, message)) = recovery_error {
                                    self.base.emit_error(error_type, &message);
                                    backoff.record_failure();
                                } else {
                                    backoff.record_success();
                                }
                            }
                            Err(e) => {
                                warn!("IDLE check failed for account {}: {}", self.base.account_id, e);
                                self.base.emit_error("idle", &format!("IDLE check failed: {}", e));
                                backoff.record_failure();
                            }
                        }
                    }
                }
                trigger = idle_trigger_rx.recv(), if idle_watcher_active => {
                    match trigger {
                        Some(ImapWorkerTrigger::ProviderPush) => {
                            runtime.record_trigger(SyncTrigger::ProviderPush, Instant::now());
                            if backoff.is_circuit_open() {
                                debug!(
                                    "Ignoring IMAP provider push while circuit is open for account {}",
                                    self.base.account_id
                                );
                                continue;
                            }

                            if let Err(e) = self.poll_new_messages().await {
                                warn!("Provider push poll error for account {}: {}", self.base.account_id, e);
                                self.base.emit_error("poll", &format!("Provider push poll error: {}", e));
                                backoff.record_failure();
                            } else {
                                backoff.record_success();
                            }
                        }
                        None => {
                            warn!(
                                "IMAP IDLE watcher exited for account {}; falling back to polling",
                                self.base.account_id
                            );
                            idle_watcher_active = false;
                            let catch_up_succeeded = match self.poll_new_messages().await {
                                Ok(()) => {
                                    backoff.record_success();
                                    true
                                }
                                Err(e) => {
                                    warn!("Catch-up poll after IMAP IDLE watcher exit failed for account {}: {}", self.base.account_id, e);
                                    self.base.emit_error("poll", &format!("Catch-up poll after IMAP IDLE watcher exit failed: {}", e));
                                    backoff.record_failure();
                                    false
                                }
                            };
                            if can_refresh_imap_polling_baseline_after_idle_fallback(catch_up_succeeded) {
                                polling_baseline_trusted =
                                    self.refresh_inbox_local_uid_baseline(&mut last_exists);
                            } else {
                                polling_baseline_trusted = false;
                            }
                        }
                    }
                }
                trigger = recv_sync_trigger(&mut trigger_rx) => {
                    match trigger {
                        Some(trigger) => {
                            info!("Sync trigger received for account {}: {:?}", self.base.account_id, trigger);
                            runtime.record_trigger(trigger, Instant::now());
                            if !trigger.should_sync_now() {
                                continue;
                            }
                            if backoff.is_circuit_open()
                                && !trigger.bypasses_circuit_backoff()
                            {
                                debug!(
                                    "Ignoring realtime trigger while circuit is open for account {}",
                                    self.base.account_id
                                );
                                continue;
                            }
                            let poll_result = if trigger == SyncTrigger::Manual {
                                self.poll_all_new_messages("manual").await
                            } else {
                                self.poll_new_messages().await
                            };
                            if let Err(e) = poll_result {
                                warn!("Triggered poll error for account {}: {}", self.base.account_id, e);
                                self.base.emit_error("poll", &format!("Triggered poll error: {}", e));
                                backoff.record_failure();
                            } else {
                                backoff.record_success();
                                if !idle_watcher_active {
                                    polling_baseline_trusted =
                                        self.refresh_inbox_local_uid_baseline(&mut last_exists);
                                }
                            }
                            // Manual "收取邮件" also syncs folder deletions from the
                            // server and advances history backfill, so users see
                            // deleted folders disappear and the Sent/Archive
                            // history grow without waiting for the 15-minute tick.
                            if trigger == SyncTrigger::Manual {
                                if let Err(e) = self.reconcile_imap_folders().await {
                                    warn!("Manual folder list sync error for account {}: {}", self.base.account_id, e);
                                }
                                // No guessing a source mailbox by UID: numeric IDs
                                // are valid only in the mailbox that assigned them.
                                if let Err(e) = self
                                    .backfill_incomplete_history(HISTORY_BACKFILL_PAGES_PER_RUN)
                                    .await
                                {
                                    warn!("Manual history backfill error for account {}: {}", self.base.account_id, e);
                                }
                                info!("Manual sync processing finished for account {}", self.base.account_id);
                            }
                        }
                        None => {
                            trigger_rx = None;
                        }
                    }
                }
                _ = reconcile_ticker.tick() => {
                    // Full reconcile: poll new messages + flag diff + deletion detection
                    self.base.emit_sync_started("reconcile");
                    let mut reconcile_failed = false;
                    if let Err(e) = self.poll_new_messages_inner(ImapPollScope::Full).await {
                        warn!("Reconcile poll error for account {}: {}", self.base.account_id, e);
                        self.base.emit_error("reconcile", &format!("Reconcile poll error: {}", e));
                        self.base.emit_sync_error("reconcile", &e.to_string());
                        backoff.record_failure();
                        continue;
                    } else {
                        backoff.record_success();
                        if !idle_watcher_active {
                            polling_baseline_trusted =
                                self.refresh_inbox_local_uid_baseline(&mut last_exists);
                        }
                    }
                    // Sync folder list from the server: remove local records for
                    // folders deleted server-side, and continue history backfill
                    // for folders that are still incomplete.
                    if let Err(e) = self.reconcile_imap_folders().await {
                        warn!("Reconcile folder list error: {}", e);
                        self.base.emit_error("reconcile", &format!("Folder list sync error: {}", e));
                    }
                    if let Err(e) = self.backfill_incomplete_history(HISTORY_BACKFILL_PAGES_PER_RUN).await {
                        warn!("Reconcile history backfill error: {}", e);
                    }
                    let folders = match self.base.store.list_folders(&self.base.account_id) {
                        Ok(f) => f,
                        Err(e) => {
                            warn!("Reconcile list folders error: {}", e);
                            self.base.emit_error("reconcile", &format!("List folders error: {}", e));
                            self.base.emit_sync_error("reconcile", &e.to_string());
                            continue;
                        }
                    };
                    for folder in &folders {
                        if let Err(e) = self.reconcile_folder(folder).await {
                            warn!("Reconcile folder {} error: {}", folder.name, e);
                            self.base.emit_error("reconcile", &format!("Reconcile {} error: {}", folder.name, e));
                            reconcile_failed = true;
                        }
                    }
                    if reconcile_failed {
                        self.base.emit_sync_error("reconcile", "One or more folders failed to reconcile");
                    } else {
                        self.base.emit_sync_completed("reconcile");
                    }
                }
                Ok(()) = stop_rx.changed() => {
                    if *stop_rx.borrow() {
                        info!("Sync worker stopping for account {}", self.base.account_id);
                        break;
                    }
                }
            }
        }

        if let Some(handle) = idle_watcher.take() {
            handle.abort();
        }
        let _ = self.provider.disconnect().await;
        let _ = self.idle_provider.disconnect().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_filename_rejects_windows_reserved_names() {
        assert_eq!(sanitize_filename("CON.txt"), "unnamed_attachment");
        assert_eq!(sanitize_filename("aux"), "unnamed_attachment");
        assert_eq!(sanitize_filename("LPT1.log"), "unnamed_attachment");
    }

    #[test]
    fn test_sanitize_filename_removes_windows_unsafe_characters() {
        assert_eq!(
            sanitize_filename("quarterly:report*final?.pdf"),
            "quarterly_report_final_.pdf",
        );
        assert_eq!(sanitize_filename("report. "), "report");
    }

    #[test]
    fn truncated_batch_mime_is_rejected_before_parsing() {
        let error = verify_raw_message_size(42, b"body only", Some(1024)).unwrap_err();
        assert!(error.to_string().contains("received 9 of 1024 bytes"));
        assert!(verify_raw_message_size(42, &[0; 1024], Some(1024)).is_ok());
        assert!(verify_raw_message_size(42, b"body only", None).is_ok());
    }

    #[test]
    fn downloaded_mime_must_match_the_header_identity() {
        assert!(verify_downloaded_message_identity(Some("<original@example.test>"), Some("<other@example.test>")).is_err());
        assert!(verify_downloaded_message_identity(Some("<original@example.test>"), None).is_err());
        assert!(verify_downloaded_message_identity(Some(" <original@example.test> "), Some("<original@example.test>")).is_ok());
        assert!(verify_downloaded_message_identity(None, None).is_ok());
    }

    #[test]
    fn zero_poll_interval_is_manual_only() {
        let config = SyncConfig {
            poll_interval_secs: 0,
            ..Default::default()
        };

        assert!(config.manual_only());
    }

    #[test]
    fn imap_startup_fetch_notifies_only_when_cursor_exists() {
        assert!(!should_notify_imap_startup_fetch(None));
        assert!(should_notify_imap_startup_fetch(Some(42)));
    }

    #[test]
    fn imap_folder_cursor_roundtrips() {
        let cursor = ImapFolderCursor {
            uidvalidity: Some(1234),
            last_uid: Some(987),
            highest_modseq: Some(4567),
            history_complete: true,
            ..Default::default()
        };

        let json = serde_json::to_string(&cursor).unwrap();
        let decoded: ImapFolderCursor = serde_json::from_str(&json).unwrap();

        assert_eq!(decoded, cursor);
    }

    #[test]
    fn imap_folder_cursor_resets_last_uid_when_uidvalidity_changes() {
        let stored = ImapFolderCursor {
            uidvalidity: Some(1234),
            last_uid: Some(987),
            highest_modseq: Some(4567),
            history_complete: true,
            ..Default::default()
        };

        let prepared = prepare_imap_folder_cursor_for_status(stored, Some(9999), Some(7000));

        assert_eq!(prepared.uidvalidity, Some(9999));
        assert_eq!(prepared.last_uid, None);
        assert_eq!(prepared.highest_modseq, Some(7000));
        assert!(!prepared.history_complete);
    }

    #[test]
    fn imap_folder_cursor_preserves_last_uid_when_uidvalidity_matches() {
        let stored = ImapFolderCursor {
            uidvalidity: Some(1234),
            last_uid: Some(987),
            highest_modseq: Some(4567),
            history_complete: true,
            ..Default::default()
        };

        let prepared = prepare_imap_folder_cursor_for_status(stored, Some(1234), Some(7000));

        assert_eq!(prepared.uidvalidity, Some(1234));
        assert_eq!(prepared.last_uid, Some(987));
        assert_eq!(prepared.highest_modseq, Some(7000));
        assert!(prepared.history_complete);
    }

    #[test]
    fn imap_folder_cursor_does_not_advance_with_unresolved_failures() {
        assert!(!can_advance_imap_folder_cursor(true));
    }

    #[test]
    fn imap_folder_cursor_advances_without_unresolved_failures() {
        assert!(can_advance_imap_folder_cursor(false));
    }

    #[test]
    fn imap_deletion_diff_runs_when_server_and_local_counts_match() {
        assert!(should_run_imap_deletion_diff(2, 2));
    }

    #[test]
    fn imap_inventory_repairs_empty_local_state_when_server_has_mail() {
        assert!(should_run_imap_deletion_diff(10, 0));
        assert!(!should_run_imap_deletion_diff(0, 0));
    }

    #[test]
    fn imap_inventory_requires_matching_epoch_and_a_complete_consistent_uid_set() {
        let status = crate::imap::ImapMailboxStatus { uid_validity: Some(17), uid_next: Some(104), exists: 2, ..Default::default() };
        assert!(valid_imap_uid_inventory(Some(17), status, &[101, 103]));
        assert!(!valid_imap_uid_inventory(Some(18), status, &[101, 103]));
        assert!(!valid_imap_uid_inventory(None, status, &[101, 103]));
        assert!(!valid_imap_uid_inventory(Some(17), status, &[101]));
        assert!(!valid_imap_uid_inventory(Some(17), status, &[101, 101]));
        assert!(!valid_imap_uid_inventory(Some(17), status, &[101, 104]));
    }

    #[test]
    fn imap_polling_fallback_uses_realtime_policy_delays() {
        let config = SyncConfig {
            poll_interval_secs: 60,
            ..Default::default()
        };
        let policy = imap_poll_policy(&config);

        assert_eq!(
            policy.next_delay(crate::realtime_policy::RealtimeContext {
                app_foreground: true,
                recent_activity: true,
                consecutive_failures: 0,
            }),
            std::time::Duration::from_secs(60)
        );
        assert_eq!(
            policy.next_delay(crate::realtime_policy::RealtimeContext {
                app_foreground: false,
                recent_activity: false,
                consecutive_failures: 0,
            }),
            std::time::Duration::from_secs(120)
        );
    }

    #[test]
    fn startup_baseline_seed_requires_successful_initial_sync() {
        assert!(can_seed_imap_polling_baseline_after_startup(true));
        assert!(!can_seed_imap_polling_baseline_after_startup(false));
    }

    #[test]
    fn idle_fallback_baseline_refresh_requires_successful_catch_up() {
        assert!(can_refresh_imap_polling_baseline_after_idle_fallback(true));
        assert!(!can_refresh_imap_polling_baseline_after_idle_fallback(
            false
        ));
    }

    #[test]
    fn imap_polling_baseline_refuses_unresolved_inbox_failures() {
        let mut last_exists = Some(crate::idle::MailboxUidState {
            uidvalidity: Some(42),
            highest_uid: 7,
        });

        let seeded = apply_local_inbox_uid_baseline(&mut last_exists, Some(42), Some(12), true);

        assert!(!seeded);
        assert_eq!(
            last_exists,
            Some(crate::idle::MailboxUidState {
                uidvalidity: Some(42),
                highest_uid: 7,
            })
        );
    }

    #[test]
    fn imap_polling_baseline_seeds_local_max_uid_without_unresolved_inbox_failures() {
        let mut last_exists = Some(crate::idle::MailboxUidState {
            uidvalidity: Some(42),
            highest_uid: 7,
        });

        let seeded = apply_local_inbox_uid_baseline(&mut last_exists, Some(43), Some(12), false);

        assert!(seeded);
        assert_eq!(
            last_exists,
            Some(crate::idle::MailboxUidState {
                uidvalidity: Some(43),
                highest_uid: 12,
            })
        );
    }

    #[test]
    fn imap_polling_baseline_seeds_zero_for_clean_empty_local_inbox() {
        let mut last_exists = Some(crate::idle::MailboxUidState {
            uidvalidity: Some(42),
            highest_uid: 7,
        });

        let seeded = apply_local_inbox_uid_baseline(&mut last_exists, Some(43), None, false);

        assert!(seeded);
        assert_eq!(
            last_exists,
            Some(crate::idle::MailboxUidState {
                uidvalidity: Some(43),
                highest_uid: 0,
            })
        );
    }

    #[test]
    fn inbox_missing_mailbox_is_not_skipped_during_initial_sync() {
        assert!(!should_skip_missing_imap_mailbox_during_initial_sync(Some(
            pebble_core::FolderRole::Inbox
        )));
    }

    #[test]
    fn non_inbox_missing_mailbox_can_be_skipped_during_initial_sync() {
        assert!(should_skip_missing_imap_mailbox_during_initial_sync(Some(
            pebble_core::FolderRole::Sent
        )));
    }

    #[test]
    fn inbox_initial_sync_folder_failure_fails_initial_sync() {
        assert!(should_fail_initial_sync_for_folder_error(
            Some(pebble_core::FolderRole::Inbox),
            false
        ));
    }

    #[test]
    fn non_inbox_non_retryable_initial_sync_folder_failure_does_not_fail_initial_sync() {
        assert!(!should_fail_initial_sync_for_folder_error(
            Some(pebble_core::FolderRole::Sent),
            false
        ));
    }

    #[test]
    fn non_inbox_retryable_initial_sync_folder_failure_does_not_block_inbox_history() {
        assert!(!should_fail_initial_sync_for_folder_error(None, true));
    }

    #[test]
    fn first_reconcile_deadline_is_delayed_by_interval() {
        let now = Instant::now();
        let interval = Duration::from_secs(900);

        assert_eq!(first_reconcile_deadline(now, interval), now + interval);
    }

    #[test]
    fn idle_check_disconnect_does_not_surface_when_recovery_succeeds() {
        let message = idle_check_recovery_user_error(None, None);

        assert!(message.is_none());
    }

    #[test]
    fn idle_check_reconnect_failure_surfaces_connection_error() {
        let message =
            idle_check_recovery_user_error(Some("Network error: os error 10053".to_string()), None);

        assert_eq!(
            message,
            Some((
                "connection",
                "IMAP reconnect after idle check failed: Network error: os error 10053".to_string()
            ))
        );
    }

    #[test]
    fn imap_windows_connection_abort_is_retryable_for_polling() {
        let error = pebble_core::PebbleError::Network(
            "SELECT failed: io: 你的主机中的软件中止了一个已建立的连接。 (os error 10053)"
                .to_string(),
        );

        assert!(is_retryable_imap_connection_error(&error));
    }

    #[test]
    fn imap_chinese_remote_host_forced_close_is_retryable_for_polling() {
        let error = pebble_core::PebbleError::Network(
            "SELECT failed: io: 远程主机强迫关闭了一个现有的连接。 (os error 10054)"
                .to_string(),
        );

        assert!(is_retryable_imap_connection_error(&error));
    }

    #[test]
    fn imap_rustls_unexpected_eof_is_retryable_for_polling() {
        let error = pebble_core::PebbleError::Network(
            "SELECT failed: io: peer closed connection without sending TLS close_notify: https://docs.rs/rustls/latest/rustls/manual/_03_howto/index.html#unexpected-eof"
                .to_string(),
        );

        assert!(is_retryable_imap_connection_error(&error));
    }

    #[test]
    fn imap_missing_folder_select_error_is_not_retryable_for_polling() {
        let error = pebble_core::PebbleError::Network(
            "SELECT failed: no response: code: None, info: Some(\"SELECT Folder not exist\")"
                .to_string(),
        );

        assert!(!is_retryable_imap_connection_error(&error));
    }

    #[test]
    fn imap_missing_folder_select_error_is_detected_for_suppression() {
        let error = pebble_core::PebbleError::Network(
            "SELECT failed: no response: code: None, info: Some(\"SELECT Folder not exist\")"
                .to_string(),
        );

        assert!(is_missing_imap_mailbox_error(&error));
    }

    #[test]
    fn imap_local_archive_is_not_a_remote_sync_target() {
        let folder = pebble_core::Folder {
            id: "folder-1".to_string(),
            account_id: "account-1".to_string(),
            remote_id: "__local_archive__".to_string(),
            name: "Archive".to_string(),
            folder_type: pebble_core::FolderType::Folder,
            role: Some(pebble_core::FolderRole::Archive),
            parent_id: None,
            color: None,
            is_system: true,
            sort_order: 3,
        };

        assert!(!should_attempt_imap_remote_folder(&folder));
    }

    fn test_folder(role: Option<pebble_core::FolderRole>, remote_id: &str) -> pebble_core::Folder {
        pebble_core::Folder {
            id: format!("folder-{remote_id}"),
            account_id: "account-1".to_string(),
            remote_id: remote_id.to_string(),
            name: remote_id.to_string(),
            folder_type: pebble_core::FolderType::Folder,
            role,
            parent_id: None,
            color: None,
            is_system: true,
            sort_order: 0,
        }
    }

    #[test]
    fn imap_realtime_poll_targets_inbox_only() {
        let inbox = test_folder(Some(pebble_core::FolderRole::Inbox), "INBOX");
        let sent = test_folder(Some(pebble_core::FolderRole::Sent), "Sent");
        let spam = test_folder(Some(pebble_core::FolderRole::Spam), "Spam");
        let custom = test_folder(None, "Newsletters");

        assert!(should_poll_imap_folder_for_realtime(&inbox));
        assert!(!should_poll_imap_folder_for_realtime(&sent));
        assert!(!should_poll_imap_folder_for_realtime(&spam));
        assert!(!should_poll_imap_folder_for_realtime(&custom));
    }

    #[test]
    fn explicit_imap_selection_always_includes_inbox() {
        let inbox = test_folder(Some(pebble_core::FolderRole::Inbox), "INBOX");
        let sent = test_folder(Some(pebble_core::FolderRole::Sent), "Sent");
        let custom = test_folder(None, "Newsletters");
        let selected = HashSet::from(["Newsletters".to_string()]);

        assert!(should_include_discovered_imap_folder(
            &inbox,
            Some(&selected)
        ));
        assert!(!should_include_discovered_imap_folder(
            &sent,
            Some(&selected)
        ));
        assert!(should_include_discovered_imap_folder(
            &custom,
            Some(&selected)
        ));
    }

    #[test]
    fn missing_imap_selection_preserves_legacy_all_folder_sync() {
        let sent = test_folder(Some(pebble_core::FolderRole::Sent), "Sent");
        let custom = test_folder(None, "Newsletters");

        assert!(should_include_discovered_imap_folder(&sent, None));
        assert!(should_include_discovered_imap_folder(&custom, None));
    }

    #[test]
    fn history_page_ranges_empty_mailbox_has_no_pages() {
        assert_eq!(history_page_ranges(0, 200), Vec::<(u32, u32)>::new());
    }

    #[test]
    fn history_page_ranges_single_page_when_mailbox_fits() {
        assert_eq!(history_page_ranges(1, 200), vec![(1, 1)]);
        assert_eq!(history_page_ranges(200, 200), vec![(1, 200)]);
    }

    #[test]
    fn history_page_ranges_pages_newest_to_oldest() {
        assert_eq!(history_page_ranges(201, 200), vec![(2, 201), (1, 1)]);
        assert_eq!(
            history_page_ranges(450, 200),
            vec![(251, 450), (51, 250), (1, 50)]
        );
    }

    #[test]
    fn imap_full_poll_targets_all_remote_folders() {
        let inbox = test_folder(Some(pebble_core::FolderRole::Inbox), "INBOX");
        let sent = test_folder(Some(pebble_core::FolderRole::Sent), "Sent");
        let spam = test_folder(Some(pebble_core::FolderRole::Spam), "Spam");
        let custom = test_folder(None, "Newsletters");
        let local = test_folder(Some(pebble_core::FolderRole::Archive), "__local_archive__");

        assert!(should_poll_imap_folder_for_scope(
            &inbox,
            ImapPollScope::Full
        ));
        assert!(should_poll_imap_folder_for_scope(
            &sent,
            ImapPollScope::Full
        ));
        assert!(should_poll_imap_folder_for_scope(
            &spam,
            ImapPollScope::Full
        ));
        assert!(should_poll_imap_folder_for_scope(
            &custom,
            ImapPollScope::Full
        ));
        assert!(!should_poll_imap_folder_for_scope(
            &local,
            ImapPollScope::Full
        ));
    }

    #[test]
    fn custom_new_mail_probe_excludes_system_and_role_folders() {
        let mut custom = test_folder(None, "Customers/Acme");
        custom.is_system = false;
        let mut templates = test_folder(None, "Templates");
        templates.is_system = true;
        let sent = test_folder(Some(pebble_core::FolderRole::Sent), "Sent");

        assert!(should_probe_custom_folder_for_new_mail(&custom));
        assert!(!should_probe_custom_folder_for_new_mail(&templates));
        assert!(!should_probe_custom_folder_for_new_mail(&sent));
    }

    #[test]
    fn custom_folder_probe_inherits_resolved_account_interval() {
        for interval in [3, 15, 60, 300] {
            let config = SyncConfig {
                poll_interval_secs: interval,
                ..SyncConfig::default()
            };
            assert_eq!(custom_folder_poll_interval_secs(&config), Some(interval));
        }
        let manual = SyncConfig {
            poll_interval_secs: 0,
            ..SyncConfig::default()
        };
        assert_eq!(custom_folder_poll_interval_secs(&manual), None);
    }
}
