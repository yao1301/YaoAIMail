//! Search indexing + rule-application pipeline.
//!
//! Receives newly stored messages from the sync worker, indexes them in
//! Tantivy, and applies rule-engine actions. Split out of `sync_cmd.rs`
//! so the sync lifecycle and the indexing pipeline can evolve independently.

use crate::commands::notifications;
use crate::commands::pending_mail_ops::queue_pending_mail_op;
use crate::events;
use crate::state::AppState;
use pebble_core::{FolderRole, PebbleError};
use pebble_rules::{RuleEngine, RuleTrigger};
use pebble_search::TantivySearch;
use pebble_store::Store;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::mpsc;
use tracing::{error, info, warn};

#[cfg(any(
    windows,
    all(not(windows), not(target_os = "linux"), not(target_os = "macos"))
))]
use tauri_plugin_notification::NotificationExt;

#[cfg(any(target_os = "linux", windows))]
const NOTIFICATION_OPEN_ACTION: &str = "open";

/// Rebuild the search index from all messages in the store.
///
/// Iterates messages per account (not per folder) so that a Gmail message
/// tagged with multiple labels is indexed exactly once, with all of its
/// folder IDs attached in a single call.
pub fn do_reindex(store: &Store, search: &TantivySearch) -> std::result::Result<u32, PebbleError> {
    search.clear_index()?;

    let accounts = store.list_accounts()?;
    let mut count: u32 = 0;
    let batch_size = 200u32;

    for account in &accounts {
        let mut offset = 0u32;
        loop {
            let messages = store.list_full_messages_by_account(&account.id, batch_size, offset)?;
            if messages.is_empty() {
                break;
            }

            let ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
            let folder_map = store.get_message_folder_ids_batch(&ids)?;

            let batch: Vec<_> = messages
                .iter()
                .map(|msg| {
                    let folder_ids = folder_map.get(&msg.id).cloned().unwrap_or_default();
                    (msg.clone(), folder_ids)
                })
                .collect();
            let batch_len = batch.len() as u32;
            if let Err(e) = search.index_messages_batch(&batch) {
                warn!("Failed to index batch of {} messages: {}", batch_len, e);
            } else {
                count += batch_len;
            }

            offset += messages.len() as u32;
            if (messages.len() as u32) < batch_size {
                break;
            }
        }
    }

    search.commit()?;
    info!("Reindexed {} messages", count);
    Ok(count)
}

/// Receive newly stored messages from the sync worker and index them for search.
/// Also emits `mail:new` events to notify the frontend, and applies rule engine actions.
/// Batches messages and commits periodically for efficiency.
fn new_mail_event_payload(stored: &pebble_mail::StoredMessage) -> serde_json::Value {
    serde_json::json!({
        "account_id": stored.message.account_id,
        "message_id": stored.message.id,
        "folder_ids": stored.folder_ids,
        "thread_id": stored.message.thread_id,
        "subject": stored.message.subject,
        "from": stored.message.from_address,
        "received_at": stored.message.date,
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SyncedMailKind { Incoming, Sent, FiledSent, Other }

fn synced_mail_kind(store: &Store, stored: &pebble_mail::StoredMessage) -> pebble_core::Result<SyncedMailKind> {
    let folders = store.list_folders(&stored.message.account_id)?;
    let mut custom = false;
    let mut inbox = false;
    for folder in folders.iter().filter(|folder| stored.folder_ids.contains(&folder.id)) {
        match folder.role {
            Some(FolderRole::Sent) => return Ok(SyncedMailKind::Sent),
            Some(FolderRole::Inbox) => inbox = true,
            None if !folder.is_system => custom = true,
            _ => {}
        }
    }
    if inbox { return Ok(SyncedMailKind::Incoming); }
    if custom {
        return Ok(if store.has_outgoing_copy(&stored.message)? { SyncedMailKind::FiledSent } else { SyncedMailKind::Incoming });
    }
    Ok(SyncedMailKind::Other)
}

fn is_new_incoming(kind: SyncedMailKind, stored: &pebble_mail::StoredMessage) -> bool {
    kind == SyncedMailKind::Incoming && stored.notify
        && !stored.message.is_read && !stored.message.is_deleted && !stored.message.is_draft
}

#[cfg(test)]
fn should_send_new_mail_notification(store: &Store, stored: &pebble_mail::StoredMessage) -> pebble_core::Result<bool> {
    Ok(is_new_incoming(synced_mail_kind(store, stored)?, stored))
}

fn new_mail_notification_title(account: Option<&pebble_core::Account>) -> String {
    let Some(account) = account else { return "新邮件".into(); };
    let name = account.display_name.trim();
    let email = account.email.trim();
    if name.is_empty() || name.eq_ignore_ascii_case(email) {
        format!("新邮件 · {email}")
    } else {
        format!("新邮件 · {name} · {email}")
    }
}

fn new_mail_notification_body(stored: &pebble_mail::StoredMessage) -> String {
    let sender = if stored.message.from_name.trim().is_empty() {
        stored.message.from_address.trim()
    } else {
        stored.message.from_name.trim()
    };
    let subject = stored.message.subject.trim();

    match (sender.is_empty(), subject.is_empty()) {
        (true, true) => "New message".to_string(),
        (true, false) => subject.to_string(),
        (false, true) => sender.to_string(),
        (false, false) => format!("{sender}: {subject}"),
    }
}

fn notification_open_payload(account_id: &str, message_id: &str) -> serde_json::Value {
    serde_json::json!({
        "account_id": account_id,
        "message_id": message_id,
    })
}

#[cfg(any(target_os = "linux", windows))]
fn is_notification_open_action(action: &str) -> bool {
    matches!(action, "default" | NOTIFICATION_OPEN_ACTION)
}

fn open_message_from_notification(app: &tauri::AppHandle, account_id: &str, message_id: &str) {
    notifications::clear_attention_indicator(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit(
        events::MAIL_NOTIFICATION_OPEN,
        notification_open_payload(account_id, message_id),
    );
}

#[cfg(any(
    windows,
    all(not(windows), not(target_os = "linux"), not(target_os = "macos"))
))]
fn show_default_new_mail_notification(app: &tauri::AppHandle, title: &str, body: &str) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn show_linux_new_mail_notification(
    app: &tauri::AppHandle,
    title: &str,
    body: &str,
    account_id: &str,
    message_id: &str,
) -> Result<(), String> {
    notifications::ensure_notification_environment(app)?;

    let mut notification = notify_rust::Notification::new();
    notification
        .summary(title)
        .body(body)
        .appname("YaoAIMail")
        .auto_icon()
        .action("default", "Open");

    let handle = notification.show().map_err(|e| e.to_string())?;
    let app_handle = app.clone();
    let account_id = account_id.to_string();
    let message_id = message_id.to_string();

    std::thread::Builder::new()
        .name("pebble-notification-open".to_string())
        .spawn(move || {
            handle.wait_for_action(|action| {
                if is_notification_open_action(action) {
                    open_message_from_notification(&app_handle, &account_id, &message_id);
                }
            });
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn is_macos_notification_open_response(
    response: &mac_notification_sys::NotificationResponse,
) -> bool {
    matches!(
        response,
        mac_notification_sys::NotificationResponse::Click
            | mac_notification_sys::NotificationResponse::ActionButton(_)
    )
}

#[cfg(target_os = "macos")]
fn show_macos_new_mail_notification(
    app: &tauri::AppHandle,
    title: &str,
    body: &str,
    account_id: &str,
    message_id: &str,
) -> Result<(), String> {
    notifications::ensure_notification_environment(app)?;

    let app_handle = app.clone();
    let account_id = account_id.to_string();
    let message_id = message_id.to_string();
    let title = title.to_string();
    let body = body.to_string();
    let app_id = if tauri::is_dev() {
        "com.apple.Terminal".to_string()
    } else {
        app.config().identifier.clone()
    };

    std::thread::Builder::new()
        .name("pebble-notification-open".to_string())
        .spawn(move || {
            let _ = mac_notification_sys::set_application(&app_id);
            let mut notification = mac_notification_sys::Notification::new();
            notification
                .title(&title)
                .message(&body)
                .main_button(mac_notification_sys::MainButton::SingleAction("Open"))
                .wait_for_click(true);

            match notification.send() {
                Ok(response) if is_macos_notification_open_response(&response) => {
                    open_message_from_notification(&app_handle, &account_id, &message_id);
                }
                Ok(_) => {}
                Err(e) => warn!("Failed to show clickable macOS notification: {e}"),
            }
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn show_windows_new_mail_notification(
    app: &tauri::AppHandle,
    title: &str,
    body: &str,
    account_id: &str,
    message_id: &str,
) -> Result<(), String> {
    notifications::ensure_notification_environment(app)?;
    let app_handle = app.clone();
    let account_id = account_id.to_string();
    let message_id = message_id.to_string();
    tauri_winrt_notification::Toast::new(&notifications::windows_notification_app_id(app))
        .title(title)
        .text1(body)
        .duration(tauri_winrt_notification::Duration::Short)
        .add_button("Open", NOTIFICATION_OPEN_ACTION)
        .on_activated(move |action| {
            if action
                .as_deref()
                .map(is_notification_open_action)
                .unwrap_or(true)
            {
                open_message_from_notification(&app_handle, &account_id, &message_id);
            }
            Ok(())
        })
        .show()
        .map_err(|e| format!("{e:?}"))
}

fn show_new_mail_notification(
    app: &tauri::AppHandle,
    title: &str,
    stored: &pebble_mail::StoredMessage,
) -> Result<(), String> {
    let body = new_mail_notification_body(stored);

    #[cfg(windows)]
    {
        let version = windows_version::OsVersion::current();
        if version.major == 6 && version.minor == 1 {
            // Windows 7 has no actionable WinRT toast. The notification plugin's
            // windows7-compat path uses a native balloon without loading the
            // unsupported packaged-app notification APIs.
            return show_default_new_mail_notification(app, title, &body);
        }
        match show_windows_new_mail_notification(
            app,
            title,
            &body,
            &stored.message.account_id,
            &stored.message.id,
        ) {
            Ok(()) => Ok(()),
            Err(e) => {
                warn!("Failed to show clickable Windows notification, falling back: {e}");
                show_default_new_mail_notification(app, title, &body)
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        show_linux_new_mail_notification(app, title, &body, &stored.message.account_id, &stored.message.id)
    }

    #[cfg(target_os = "macos")]
    {
        show_macos_new_mail_notification(app, title, &body, &stored.message.account_id, &stored.message.id)
    }

    #[cfg(all(not(windows), not(target_os = "linux"), not(target_os = "macos")))]
    {
        show_default_new_mail_notification(app, title, &body)
    }
}

fn maybe_send_new_mail_notification(
    app: &tauri::AppHandle,
    store: &Store,
    stored: &pebble_mail::StoredMessage,
) {
    // 托盘徽章：有新邮件就亮（不依赖通知开关，用户要求"只要有新邮件图标就有提示"）
    notifications::mark_attention_indicator(app);

    let notifications_enabled = app
        .try_state::<AppState>()
        .is_some_and(|state| state.notifications_enabled.load(Ordering::SeqCst));

    if !notifications_enabled {
        return;
    }

    let account = store.get_account(&stored.message.account_id).ok().flatten();
    let title = new_mail_notification_title(account.as_ref());
    if let Err(e) = show_new_mail_notification(app, &title, stored) {
        warn!("Failed to show new mail notification: {e}");
    }
}

pub async fn index_new_messages(
    search: &Arc<TantivySearch>,
    store: &Arc<Store>,
    rx: &mut mpsc::UnboundedReceiver<pebble_mail::StoredMessage>,
    app: Option<tauri::AppHandle>,
) {
    const COMMIT_BATCH_SIZE: u32 = 50;
    const COMMIT_IDLE_SECS: u64 = 2;

    // Rules are reloaded at each batch boundary so edits made mid-sync take
    // effect within ~20 messages (or ~2s idle) rather than waiting for the
    // next full sync session.
    let load_engine = |store: &Arc<Store>, account_id: &str| -> Option<RuleEngine> {
        match store.list_rules(account_id) {
            Ok(rules) if !rules.is_empty() => Some(RuleEngine::new(&rules)),
            Ok(_) => None,
            Err(e) => {
                warn!("Failed to load rules: {e}");
                None
            }
        }
    };
    // Keep one compiled engine per account. Loading `list_rules("")` once
    // for the whole process made every message walk every account's rules.
    // Account-local engines also make the ownership boundary explicit.
    let mut engines: HashMap<String, Option<RuleEngine>> = HashMap::new();

    // Recover index work left behind by a previous crash or failed Tantivy
    // commit before consuming new mail. The durable queue prevents a locally
    // stored body from becoming permanently unsearchable.
    if let Err(error) = recover_pending_search_index(store, search) {
        error!("Failed to recover pending search index work: {error}");
    }

    let mut pending = 0u32;
    let mut pending_index: Vec<(pebble_core::Message, Vec<String>)> = Vec::new();
    loop {
        let stored = match tokio::time::timeout(
            tokio::time::Duration::from_secs(COMMIT_IDLE_SECS),
            rx.recv(),
        )
        .await
        {
            Ok(Some(stored)) => stored,
            Ok(None) => break,
            Err(_) => {
                if pending > 0 {
                    if !pending_index.is_empty() {
                        if let Err(e) = flush_pending_index(store, search, &mut pending_index) {
                            error!("Failed to batch index messages after idle flush: {}", e);
                        }
                    }
                    if let Err(e) = search.commit() {
                        error!("Failed to commit search index after idle flush: {}", e);
                    }
                    pending = 0;
                }
                // Idle — take the opportunity to refresh rules.
                engines.clear();
                continue;
            }
        };

        let kind = synced_mail_kind(store, &stored).unwrap_or_else(|error| {
            warn!("Failed to classify synced message: {error}");
            SyncedMailKind::Other
        });
        if let Some(ref app) = app {
            let is_new = is_new_incoming(kind, &stored);
            let event = if is_new { events::MAIL_NEW } else { events::MAIL_MESSAGES_CHANGED };
            let _ = app.emit(event, new_mail_event_payload(&stored));
            if is_new { maybe_send_new_mail_notification(app, store, &stored); }
        }

        let account_id = stored.message.account_id.clone();
        let engine = engines
            .entry(account_id.clone())
            .or_insert_with(|| load_engine(store, &account_id));
        let trigger = match kind {
            SyncedMailKind::Sent => Some(RuleTrigger::Send),
            SyncedMailKind::FiledSent => None, // Sync echo of a send already filed into a mixed folder.
            SyncedMailKind::Incoming | SyncedMailKind::Other => Some(RuleTrigger::Receive),
        };
        if let (Some(engine), Some(trigger)) = (engine.as_ref(), trigger) {
            let actions = engine.evaluate_for_trigger(&stored.message, trigger);
            for action in actions {
                if let Err(e) = apply_rule_action(
                    store,
                    &stored.message.account_id,
                    &stored.message.id,
                    &action,
                ) {
                    warn!("Rule action failed for message {}: {e}", stored.message.id);
                }
            }
        }

        let message_id = stored.message.id.clone();
        let latest_message = match store.get_message(&message_id) {
            Ok(message) => message,
            Err(e) => {
                warn!(
                    "Failed to reload message {} before indexing: {}",
                    message_id, e
                );
                continue;
            }
        };

        match latest_message {
            Some(message) if !message.is_deleted => {
                let folder_ids = match store.get_message_folder_ids(&message_id) {
                    Ok(folder_ids) => folder_ids,
                    Err(e) => {
                        warn!(
                            "Failed to load folders for indexed message {}: {}",
                            message_id, e
                        );
                        continue;
                    }
                };

                if folder_ids.is_empty() {
                    if let Err(e) = search.remove_message(&message_id) {
                        warn!(
                            "Failed to remove folderless search document {}: {}",
                            message_id, e
                        );
                        continue;
                    }
                } else {
                    pending_index.push((message, folder_ids));
                }
            }
            Some(_) | None => {
                if let Err(e) = search.remove_message(&message_id) {
                    warn!(
                        "Failed to remove stale search document {}: {}",
                        message_id, e
                    );
                    continue;
                }
            }
        }
        pending += 1;

        if pending >= COMMIT_BATCH_SIZE {
            if !pending_index.is_empty() {
                if let Err(e) = flush_pending_index(store, search, &mut pending_index) {
                    error!("Failed to batch index messages: {}", e);
                }
            }
            if let Err(e) = search.commit() {
                error!("Failed to commit search index: {}", e);
            }
            pending = 0;
            engines.clear();
        }
    }

    if pending > 0 {
        if !pending_index.is_empty() {
            if let Err(e) = flush_pending_index(store, search, &mut pending_index) {
                error!("Failed to batch index messages on close: {}", e);
            }
        }
        if let Err(e) = search.commit() {
            error!("Failed to commit search index on close: {}", e);
        }
    }
}

fn flush_pending_index(
    store: &Store,
    search: &TantivySearch,
    batch: &mut Vec<(pebble_core::Message, Vec<String>)>,
) -> pebble_core::Result<()> {
    if batch.is_empty() {
        return Ok(());
    }
    search.index_messages_batch(batch)?;
    let ids: Vec<String> = batch.iter().map(|(message, _)| message.id.clone()).collect();
    store.clear_search_pending(&ids)?;
    batch.clear();
    Ok(())
}

fn recover_pending_search_index(store: &Store, search: &TantivySearch) -> pebble_core::Result<()> {
    let pending = store.list_search_pending()?;
    if pending.is_empty() {
        return Ok(());
    }
    info!(count = pending.len(), "Recovering durable search index tasks");
    for chunk in pending.chunks(100) {
        let ids: Vec<String> = chunk.iter().map(|(id, _)| id.clone()).collect();
        let messages = store.get_messages_batch(&ids)?;
        let message_map: HashMap<String, pebble_core::Message> =
            messages.into_iter().map(|message| (message.id.clone(), message)).collect();
        let folder_map = store.get_message_folder_ids_batch(&ids)?;
        let mut upserts = Vec::new();
        let mut completed = Vec::new();
        for (id, operation) in chunk {
            if operation == "remove" {
                search.remove_message(id)?;
                completed.push(id.clone());
            } else if let Some(message) = message_map.get(id) {
                if message.is_deleted {
                    search.remove_message(id)?;
                } else if let Some(folder_ids) = folder_map.get(id) {
                    upserts.push((message.clone(), folder_ids.clone()));
                }
                completed.push(id.clone());
            }
        }
        if !upserts.is_empty() {
            search.index_messages_batch(&upserts)?;
        }
        if !completed.is_empty() {
            store.clear_search_pending(&completed)?;
        }
    }
    search.commit()?;
    Ok(())
}

/// Apply a single rule action to a message.
fn apply_rule_action(
    store: &Store,
    account_id: &str,
    message_id: &str,
    action: &pebble_rules::types::RuleAction,
) -> pebble_core::Result<()> {
    use pebble_rules::types::RuleAction;
    match action {
        RuleAction::MarkRead => {
            if queue_remote_rule_action(store, account_id, message_id, action)? {
                info!("Rule: queued remote mark-read for message {}", message_id);
                return Ok(());
            }
            store.update_message_flags(message_id, Some(true), None)?;
            info!("Rule: marked message {} as read", message_id);
        }
        RuleAction::Archive => {
            if queue_remote_rule_action(store, account_id, message_id, action)? {
                info!("Rule: queued remote archive for message {}", message_id);
                return Ok(());
            }
            if let Some(archive_folder) =
                store.find_folder_by_role(account_id, pebble_core::FolderRole::Archive)?
            {
                store.move_message_to_folder(message_id, &archive_folder.id)?;
                info!(
                    "Rule: archived message {} to folder {}",
                    message_id, archive_folder.name
                );
            } else {
                store.soft_delete_message(message_id)?;
                info!(
                    "Rule: archived (soft-deleted) message {} (no archive folder)",
                    message_id
                );
            }
        }
        RuleAction::AddLabel(label) => {
            store.add_label(message_id, label)?;
            info!("Rule: added label '{}' to message {}", label, message_id);
        }
        RuleAction::MoveToFolder(folder_ref) => {
            if queue_remote_rule_action(store, account_id, message_id, action)? {
                info!(
                    "Rule: queued remote move for message {} to folder '{}'",
                    message_id, folder_ref
                );
                return Ok(());
            }
            // 优先按 folder_id 查找（前端 UI 传 id，准确）；失败时回退按 name 查找
            // （兼容旧规则数据库中存的字符串是 name 而非 id 的情况）。
            let target_folder = match store.get_folder(folder_ref) {
                Ok(Some(folder)) => Some(folder),
                _ => store.find_folder_by_name(account_id, folder_ref)?,
            };
            if let Some(target_folder) = target_folder {
                store.move_message_to_folder(message_id, &target_folder.id)?;
                info!(
                    "Rule: moved message {} to folder '{}'",
                    message_id, target_folder.name
                );
            } else {
                warn!(
                    "Rule: target folder '{}' not found for account {}",
                    folder_ref, account_id
                );
            }
        }
        RuleAction::SetKanbanColumn(column) => {
            let now = pebble_core::now_timestamp();
            let card = pebble_core::KanbanCard {
                message_id: message_id.to_string(),
                column: column.clone(),
                position: 0,
                created_at: now,
                updated_at: now,
            };
            store.upsert_kanban_card(&card)?;
            info!(
                "Rule: added message {} to kanban column {:?}",
                message_id, column
            );
        }
    }
    Ok(())
}

fn queue_remote_rule_action(
    store: &Store,
    account_id: &str,
    message_id: &str,
    action: &pebble_rules::types::RuleAction,
) -> pebble_core::Result<bool> {
    use crate::commands::gmail_labels::gmail_move_label_delta;
    use pebble_core::{FolderRole, ProviderType};
    use pebble_rules::types::RuleAction;

    let Some(account) = store.get_account(account_id)? else {
        return Ok(false);
    };
    let Some(message) = store.get_message(message_id)? else {
        return Ok(false);
    };
    if account.provider == ProviderType::Pop3 {
        return Ok(false);
    }
    let source_folder = store
        .get_message_folder_ids(message_id)?
        .into_iter()
        .next()
        .and_then(|folder_id| {
            store
                .list_folders(account_id)
                .ok()?
                .into_iter()
                .find(|folder| folder.id == folder_id)
        });

    match action {
        RuleAction::MarkRead => {
            if pebble_store::local_messages::is_local_message_id(&message.remote_id) {
                return Ok(false);
            }
            if account.provider == ProviderType::Imap
                && source_folder
                    .as_ref()
                    .is_some_and(|folder| folder.remote_id.starts_with("__local_"))
            {
                return Ok(false);
            }

            let mut payload = json!({
                "is_read": true,
                "is_starred": null,
            });
            if account.provider == ProviderType::Gmail {
                payload["add_labels"] = json!([]);
                payload["remove_labels"] = json!(["UNREAD"]);
            }
            if let Some(folder) = source_folder.as_ref() {
                payload["folder_remote_id"] = json!(folder.remote_id);
            }
            queue_pending_mail_op(store, &message, "update_flags", payload)?;
            Ok(true)
        }
        RuleAction::Archive => {
            let archive_folder = store.find_folder_by_role(account_id, FolderRole::Archive)?;
            if let Some(archive) = archive_folder.as_ref() {
                if archive.remote_id.starts_with("__local_") {
                    return Ok(false);
                }
            } else if account.provider != ProviderType::Gmail {
                return Ok(false);
            }

            let mut payload = json!({
                "source_folder_id": source_folder.as_ref().map(|folder| folder.id.as_str()),
                "source_folder_remote_id": source_folder.as_ref().map(|folder| folder.remote_id.as_str()),
                "target_folder_id": archive_folder.as_ref().map(|folder| folder.id.as_str()),
                "target_folder_remote_id": archive_folder.as_ref().map(|folder| folder.remote_id.as_str()),
            });
            if account.provider == ProviderType::Gmail {
                payload["add_labels"] = json!([]);
                payload["remove_labels"] = json!(["INBOX"]);
            }
            queue_pending_mail_op(store, &message, "archive", payload)?;
            Ok(true)
        }
        RuleAction::MoveToFolder(folder_ref) => {
            let Some(target_folder) = store
                .get_folder(folder_ref)?
                .filter(|folder| folder.account_id == account_id)
                .or(store.find_folder_by_name(account_id, folder_ref)?)
            else {
                return Ok(false);
            };
            if target_folder.remote_id.starts_with("__local_") {
                return Ok(false);
            }

            let mut payload = json!({
                "source_folder_id": source_folder.as_ref().map(|folder| folder.id.as_str()),
                "source_folder_remote_id": source_folder.as_ref().map(|folder| folder.remote_id.as_str()),
                "target_folder_id": target_folder.id.as_str(),
                "target_folder_remote_id": target_folder.remote_id.as_str(),
            });
            if account.provider == ProviderType::Gmail {
                let delta = gmail_move_label_delta(
                    source_folder
                        .as_ref()
                        .map(|folder| folder.remote_id.as_str()),
                    &target_folder.remote_id,
                    target_folder.role,
                );
                payload["add_labels"] = json!(delta.add_labels);
                payload["remove_labels"] = json!(delta.remove_labels);
            }
            queue_pending_mail_op(store, &message, "move_to_folder", payload)?;
            Ok(true)
        }
        RuleAction::AddLabel(_) | RuleAction::SetKanbanColumn(_) => Ok(false),
    }
}

#[cfg(test)]
mod rule_writeback_tests {
    #[cfg(any(target_os = "linux", windows))]
    use super::is_notification_open_action;
    use super::{
        apply_rule_action, new_mail_event_payload, notification_open_payload,
        should_send_new_mail_notification,
    };
    use pebble_core::*;
    use pebble_rules::types::RuleAction;
    use pebble_store::pending_ops::PendingMailOpStatus;
    use pebble_store::Store;
    use serde_json::Value;

    fn test_account() -> Account {
        let now = now_timestamp();
        Account {
            id: new_id(),
            email: "test@example.com".to_string(),
            display_name: "Test".to_string(),
            color: None,
            provider: ProviderType::Gmail,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn new_mail_event_payload_includes_folder_and_thread_contract() {
        let message = Message {
            id: "message-1".to_string(),
            account_id: "account-1".to_string(),
            remote_id: "remote-1".to_string(),
            message_id_header: None,
            in_reply_to: None,
            references_header: None,
            thread_id: Some("thread-1".to_string()),
            subject: "Hello".to_string(),
            snippet: "snippet".to_string(),
            from_address: "sender@example.com".to_string(),
            from_name: "Sender".to_string(),
            to_list: vec![],
            cc_list: vec![],
            bcc_list: vec![],
            body_text: String::new(),
            body_html_raw: String::new(),
            has_attachments: false,
            is_read: false,
            is_starred: false,
            is_draft: false,
            date: 1_700_000_000,
            remote_version: None,
            is_deleted: false,
            deleted_at: None,
            created_at: 1_700_000_000,
            updated_at: 1_700_000_000,
        };
        let stored = pebble_mail::StoredMessage {
            message,
            folder_ids: vec!["folder-inbox".to_string()],
            notify: true,
        };

        let payload = new_mail_event_payload(&stored);

        assert_eq!(payload["account_id"], "account-1");
        assert_eq!(payload["message_id"], "message-1");
        assert_eq!(payload["folder_ids"], serde_json::json!(["folder-inbox"]));
        assert_eq!(payload["thread_id"], "thread-1");
        assert_eq!(payload["subject"], "Hello");
        assert_eq!(payload["from"], "sender@example.com");
        assert_eq!(payload["received_at"], 1_700_000_000);
    }

    fn test_folder(account_id: &str) -> Folder {
        Folder {
            id: new_id(),
            account_id: account_id.to_string(),
            remote_id: "INBOX".to_string(),
            name: "Inbox".to_string(),
            folder_type: FolderType::Folder,
            role: Some(FolderRole::Inbox),
            parent_id: None,
            color: None,
            is_system: true,
            sort_order: 0,
        }
    }

    fn test_label(account_id: &str, remote_id: &str, name: &str) -> Folder {
        Folder {
            id: new_id(),
            account_id: account_id.to_string(),
            remote_id: remote_id.to_string(),
            name: name.to_string(),
            folder_type: FolderType::Label,
            role: None,
            parent_id: None,
            color: None,
            is_system: false,
            sort_order: 0,
        }
    }

    fn test_message(account_id: &str) -> Message {
        let now = now_timestamp();
        Message {
            id: new_id(),
            account_id: account_id.to_string(),
            remote_id: "remote-123".to_string(),
            message_id_header: None,
            in_reply_to: None,
            references_header: None,
            thread_id: None,
            subject: "Test".to_string(),
            snippet: "test".to_string(),
            from_address: "from@example.com".to_string(),
            from_name: "From".to_string(),
            to_list: vec![],
            cc_list: vec![],
            bcc_list: vec![],
            body_text: "body".to_string(),
            body_html_raw: String::new(),
            has_attachments: false,
            is_read: false,
            is_starred: false,
            is_draft: false,
            date: now,
            remote_version: None,
            is_deleted: false,
            deleted_at: None,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn initial_sync_messages_do_not_trigger_new_mail_notifications() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let folder = test_folder(&account.id);
        store.insert_folder(&folder).unwrap();
        let message = test_message(&account.id);
        let stored = pebble_mail::StoredMessage {
            message,
            folder_ids: vec![folder.id],
            notify: false,
        };

        assert!(!should_send_new_mail_notification(&store, &stored).unwrap());
    }

    #[test]
    fn realtime_inbox_messages_trigger_new_mail_notifications() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let folder = test_folder(&account.id);
        store.insert_folder(&folder).unwrap();
        let message = test_message(&account.id);
        let stored = pebble_mail::StoredMessage {
            message,
            folder_ids: vec![folder.id],
            notify: true,
        };

        assert!(should_send_new_mail_notification(&store, &stored).unwrap());
    }

    #[test]
    fn realtime_custom_folder_messages_trigger_new_mail_notifications() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let mut folder = test_folder(&account.id);
        folder.remote_id = "Customers/Acme".to_string();
        folder.name = "Acme".to_string();
        folder.role = None;
        folder.is_system = false;
        store.insert_folder(&folder).unwrap();
        let stored = pebble_mail::StoredMessage {
            message: test_message(&account.id),
            folder_ids: vec![folder.id],
            notify: true,
        };

        assert!(should_send_new_mail_notification(&store, &stored).unwrap());
    }

    #[test]
    fn filed_outgoing_mail_does_not_alert_but_a_separate_inbox_delivery_can() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let inbox = test_folder(&account.id);
        let mut sent = test_folder(&account.id);
        sent.remote_id = "Sent".into();
        sent.role = Some(FolderRole::Sent);
        let custom = test_label(&account.id, "Projects", "Projects");
        for folder in [&inbox, &sent, &custom] { store.insert_folder(folder).unwrap(); }
        let mut sent_message = test_message(&account.id);
        sent_message.message_id_header = Some("<outbound@example.test>".into());
        store.insert_message(&sent_message, &[sent.id.clone()]).unwrap();
        let mut stored = pebble_mail::StoredMessage { message: sent_message, folder_ids: vec![sent.id, custom.id.clone()], notify: true };
        assert!(!should_send_new_mail_notification(&store, &stored).unwrap());
        stored.folder_ids = vec![custom.id];
        assert!(!should_send_new_mail_notification(&store, &stored).unwrap());
        stored.folder_ids = vec![inbox.id];
        assert!(should_send_new_mail_notification(&store, &stored).unwrap());
    }

    #[test]
    fn notification_open_payload_identifies_clicked_message_account() {
        let payload = notification_open_payload("account-2", "message-1");

        assert_eq!(payload["account_id"], "account-2");
        assert_eq!(payload["message_id"], "message-1");
    }

    #[cfg(any(target_os = "linux", windows))]
    #[test]
    fn notification_open_action_accepts_desktop_clicks_only() {
        assert!(is_notification_open_action("default"));
        assert!(is_notification_open_action("open"));
        assert!(!is_notification_open_action("__closed"));
        assert!(!is_notification_open_action("dismissed"));
    }

    #[test]
    fn rule_mark_read_for_remote_account_queues_pending_op_before_local_commit() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let folder = test_folder(&account.id);
        store.insert_folder(&folder).unwrap();
        let message = test_message(&account.id);
        store.insert_message(&message, &[folder.id]).unwrap();

        apply_rule_action(&store, &account.id, &message.id, &RuleAction::MarkRead).unwrap();

        let reloaded = store.get_message(&message.id).unwrap().unwrap();
        assert!(!reloaded.is_read);
        let ops = store.list_pending_mail_ops(&account.id).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].op_type, "update_flags");
        assert_eq!(ops[0].status, PendingMailOpStatus::Pending);
    }

    #[test]
    fn rule_mark_read_for_pop3_account_commits_locally_without_pending_op() {
        let store = Store::open_in_memory().unwrap();
        let mut account = test_account();
        account.provider = ProviderType::Pop3;
        store.insert_account(&account).unwrap();
        let folder = test_folder(&account.id);
        store.insert_folder(&folder).unwrap();
        let message = test_message(&account.id);
        store.insert_message(&message, &[folder.id]).unwrap();

        apply_rule_action(&store, &account.id, &message.id, &RuleAction::MarkRead).unwrap();

        let reloaded = store.get_message(&message.id).unwrap().unwrap();
        assert!(reloaded.is_read);
        let ops = store.list_pending_mail_ops(&account.id).unwrap();
        assert!(ops.is_empty());
    }

    #[test]
    fn rule_move_to_folder_from_gmail_label_removes_source_label() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let source = test_label(&account.id, "Label_A", "Label A");
        let target = test_label(&account.id, "Label_B", "Label B");
        store.insert_folder(&source).unwrap();
        store.insert_folder(&target).unwrap();
        let message = test_message(&account.id);
        store.insert_message(&message, &[source.id]).unwrap();

        apply_rule_action(
            &store,
            &account.id,
            &message.id,
            &RuleAction::MoveToFolder("Label B".to_string()),
        )
        .unwrap();

        let ops = store.list_pending_mail_ops(&account.id).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].op_type, "move_to_folder");
        let payload: Value = serde_json::from_str(&ops[0].payload_json).unwrap();
        let payload = &payload["payload"];
        assert_eq!(
            payload["add_labels"],
            serde_json::json!(["Label_B"]),
            "payload: {payload}"
        );
        assert_eq!(
            payload["remove_labels"],
            serde_json::json!(["Label_A"]),
            "payload: {payload}"
        );
    }
}
