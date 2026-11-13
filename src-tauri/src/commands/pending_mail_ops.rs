use crate::{events, state::AppState};
use std::collections::{HashMap, HashSet};

use pebble_core::traits::{FolderProvider, LabelProvider, MailTransport};
use pebble_core::{FolderRole, Message, PebbleError, ProviderType};
use pebble_store::pending_ops::{PendingMailOp, PendingMailOpsSummary};
use pebble_store::Store;
use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager, State};
use tracing::{debug, warn};

use super::compose::{self, LocalOutgoingState};
use super::messages::{
    connect_gmail, connect_imap, connect_outlook, find_folder_by_role, find_message_folder,
    refresh_search_document, remove_search_documents,
};

const WORKER_INTERVAL_SECS: u64 = 30;
const WORKER_BATCH_LIMIT: i64 = 100;

async fn rebind_imap_destination_uid(
    state: &AppState,
    imap: &pebble_mail::ImapProvider,
    message: &pebble_core::Message,
    target_remote_id: &str,
) -> std::result::Result<(), PebbleError> {
    let Some(message_id_header) = message.message_id_header.as_deref().filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };
    let destination_uid = imap
        .find_uid_by_message_id(target_remote_id, message_id_header)
        .await?
        .ok_or_else(|| {
            PebbleError::Sync(format!(
                "Destination UID for moved message {} is not visible yet",
                message.id
            ))
        })?;
    persist_imap_destination_uid(state, message, target_remote_id, destination_uid)?;
    Ok(())
}

fn persist_imap_destination_uid(
    state: &AppState,
    message: &pebble_core::Message,
    target_remote_id: &str,
    destination_uid: u32,
) -> std::result::Result<(), PebbleError> {
    let target_folder = state
        .store
        .list_folders(&message.account_id)?
        .into_iter()
        .find(|folder| folder.remote_id == target_remote_id)
        .ok_or_else(|| {
            PebbleError::Internal(format!(
                "Destination folder {target_remote_id} is missing locally"
            ))
        })?;
    let Some(message_id_header) = message.message_id_header.as_deref() else {
        state
            .store
            .update_remote_id(&message.id, &destination_uid.to_string())?;
        return Ok(());
    };
    let canonical = state
        .store
        .reconcile_moved_message_by_header(
            &message.account_id,
            &target_folder.id,
            message_id_header,
            &destination_uid.to_string(),
            Some(&message.id),
        )?
        .ok_or_else(|| {
            PebbleError::Internal(format!(
                "Moved message {} is missing from local destination folder",
                message.id
            ))
        })?;
    if canonical != message.id {
        debug!(
            original_message_id = %message.id,
            canonical_message_id = %canonical,
            "completed moved-message reconciliation using a replacement local row"
        );
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingMailOpsSummaryResponse {
    pub pending_count: i64,
    pub in_progress_count: i64,
    pub failed_count: i64,
    pub total_active_count: i64,
    pub last_error: Option<String>,
    pub updated_at: Option<i64>,
    pub last_error_operation_id: Option<String>,
    pub last_error_account_id: Option<String>,
    pub last_error_op_type: Option<String>,
}

impl From<PendingMailOpsSummary> for PendingMailOpsSummaryResponse {
    fn from(value: PendingMailOpsSummary) -> Self {
        Self {
            pending_count: value.pending_count,
            in_progress_count: value.in_progress_count,
            failed_count: value.failed_count,
            total_active_count: value.total_active_count,
            last_error: value.last_error,
            updated_at: value.updated_at,
            last_error_operation_id: value.last_error_operation_id,
            last_error_account_id: value.last_error_account_id,
            last_error_op_type: value.last_error_op_type,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingMailOpResponse {
    pub id: String,
    pub account_id: String,
    pub message_id: String,
    pub op_type: String,
    pub status: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub next_retry_at: Option<i64>,
    pub server_accepted: bool,
    pub dismissed: bool,
    pub duplicate_submission: bool,
    pub workbench_schedule: bool,
}

impl From<PendingMailOp> for PendingMailOpResponse {
    fn from(value: PendingMailOp) -> Self {
        let workbench_schedule=serde_json::from_str::<Value>(&value.payload_json).ok()
            .is_some_and(|v|v.get("workbench_schedule").and_then(Value::as_bool)==Some(true));
        let server_accepted = serde_json::from_str::<Value>(&value.payload_json).ok()
            .and_then(|v| v.get("provider_accepted").cloned())
            .is_some_and(|v| v.as_i64() == Some(1) || v.as_bool() == Some(true));
        Self {
            duplicate_submission: serde_json::from_str::<Value>(&value.payload_json).ok()
                .is_some_and(|v|v.get("duplicate_submission").is_some_and(|v|v.as_i64()==Some(1)||v.as_bool()==Some(true))),
            dismissed: serde_json::from_str::<Value>(&value.payload_json).ok()
                .is_some_and(|v|v.get("dismissed_at").is_some()),
            server_accepted,
            workbench_schedule,
            id: value.id,
            account_id: value.account_id,
            message_id: value.message_id,
            op_type: value.op_type,
            status: value.status.as_str().to_string(),
            attempts: value.attempts,
            last_error: value.last_error,
            created_at: value.created_at,
            updated_at: value.updated_at,
            next_retry_at: value.next_retry_at,
        }
    }
}

#[tauri::command]
pub fn get_pending_mail_ops_summary(
    state: State<'_, AppState>,
    account_id: Option<String>,
) -> std::result::Result<PendingMailOpsSummaryResponse, PebbleError> {
    state
        .store
        .pending_mail_ops_summary(account_id.as_deref())
        .map(Into::into)
}

#[tauri::command]
pub fn list_pending_mail_ops(
    state: State<'_, AppState>,
    account_id: Option<String>,
    limit: Option<i64>,
) -> std::result::Result<Vec<PendingMailOpResponse>, PebbleError> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    state
        .store
        .list_active_pending_mail_ops(account_id.as_deref(), limit)
        .map(|ops| ops.into_iter().map(Into::into).collect())
}

pub fn queue_pending_mail_op(
    store: &Store,
    message: &Message,
    op_type: &str,
    payload: Value,
) -> std::result::Result<String, PebbleError> {
    let payload = serde_json::json!({
        "provider_account_id": message.account_id,
        "remote_id": message.remote_id,
        "op": op_type,
        "payload": payload,
    });
    store.insert_pending_mail_op(
        &message.account_id,
        &message.id,
        op_type,
        &payload.to_string(),
    )
}

pub async fn run_pending_mail_ops_worker(app: tauri::AppHandle) {
    let mut interval =
        tokio::time::interval(tokio::time::Duration::from_secs(WORKER_INTERVAL_SECS));
    {
        let state = app.state::<AppState>();
        if let Err(e) = state.store.reset_in_progress_pending_mail_ops() {
            warn!("Failed to reset interrupted pending mail ops: {e}");
        }
        if let Err(e) = state.store.retire_local_flag_retries() {
            warn!("Failed to retire obsolete local flag retries: {e}");
        }
    }

    loop {
        interval.tick().await;
        let state = app.state::<AppState>();
        if let Err(e) = process_pending_mail_ops(&state, Some(&app)).await {
            warn!("Pending mail op worker pass failed: {e}");
        }
    }
}

pub async fn process_pending_mail_ops(
    state: &AppState,
    app: Option<&tauri::AppHandle>,
) -> std::result::Result<usize, PebbleError> {
    let ops = state
        .store
        .list_retryable_pending_mail_ops(WORKER_BATCH_LIMIT)?;
    let mut changed = false;
    let mut completed = 0usize;
    // Reuse one authenticated IMAP session per account for the whole pass.
    // Rule runs can enqueue hundreds of moves; reconnecting for every message
    // turns a small batch into minutes of TLS/login overhead.
    let mut imap_connections: HashMap<String, pebble_mail::ImapProvider> = HashMap::new();

    for op in ops {
        if !state.store.try_claim_pending_mail_op(&op.id)? { continue; }
        changed = true;

        let result = replay_pending_mail_op(state, &op, &mut imap_connections).await;
        let result = if op.op_type == "send" { result.and_then(|_|state.store.mark_pending_mail_op_done(&op.id)) } else { result };
        match result {
            Ok(()) => {
                if op.op_type != "send" { state.store.mark_pending_mail_op_done(&op.id)?; }
                completed += 1;
            }
            Err(e) if op.op_type == "send" => {
                let accepted = serde_json::from_str::<Value>(&op.payload_json).ok()
                    .and_then(|v|v.get("provider_accepted").cloned()).is_some_and(|v|v.as_i64()==Some(1)||v.as_bool()==Some(true));
                // The replay may just have recorded acceptance; re-read through the store.
                let accepted = accepted || state.store.send_was_accepted(&op.id)?;
                let message = if accepted {format!("发件服务器已接受邮件，本地归档或规则未完成；只重试后处理，不会再次发送。原因：{e}")}
                    else {format!("发送失败或结果未确认，自动重试已暂停。请先核对已发送及收件方，再手动重试。原因：{e}")};
                state.store.hold_failed_send(&op.id, &message)?;
                if let Some(app) = app {
                    let _ = app.emit("mail:operation-error", serde_json::json!({"operation_id":op.id,"account_id":op.account_id,"op_type":"send","message":message}));
                }
                warn!("Pending send {} held for manual review", op.id);
            }
            Err(ref e) if is_permanent_error(e) => {
                if let Some(app) = app {
                    let _ = app.emit("mail:operation-error", serde_json::json!({"operation_id":op.id,"account_id":op.account_id,"op_type":op.op_type,"message":e.to_string()}));
                }
                state.store.mark_pending_mail_op_done(&op.id)?;
                warn!(
                    "Pending mail op {} permanently failed (non-retryable): {e}",
                    op.id
                );
                completed += 1;
            }
            Err(e) => {
                state
                    .store
                    .mark_pending_mail_op_failed(&op.id, &e.to_string())?;
                warn!("Pending mail op {} retry failed: {e}", op.id);
                if let Some(app) = app {
                    let _ = app.emit("mail:operation-error", serde_json::json!({"operation_id":op.id,"account_id":op.account_id,"op_type":op.op_type,"message":e.to_string()}));
                }
            }
        }
    }

    for provider in imap_connections.into_values() {
        let _ = provider.disconnect().await;
    }

    if changed {
        emit_pending_ops_changed(app);
    }
    Ok(completed)
}

fn is_permanent_error(e: &PebbleError) -> bool {
    matches!(
        e,
        PebbleError::Auth(_) | PebbleError::UnsupportedProvider(_)
    )
}

#[tauri::command]
pub fn dismiss_failed_pending_mail_ops(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    account_id: Option<String>,
) -> std::result::Result<u64, PebbleError> {
    let dismissed = state
        .store
        .dismiss_failed_pending_mail_ops(account_id.as_deref())?;
    if dismissed > 0 {
        emit_pending_ops_changed(Some(&app));
    }
    Ok(dismissed)
}

#[tauri::command]
pub fn retry_pending_send_once(state: State<'_, AppState>, app: tauri::AppHandle, operation_id: String) -> Result<(), PebbleError> {
    state.store.retry_failed_send_once(&operation_id)?;
    emit_pending_ops_changed(Some(&app));
    Ok(())
}

#[tauri::command]
pub fn retry_pending_send_postprocessing(state: State<'_, AppState>, app: tauri::AppHandle, operation_id: String) -> Result<(), PebbleError> {
    state.store.retry_send_postprocessing(&operation_id)?;
    emit_pending_ops_changed(Some(&app)); Ok(())
}

#[tauri::command]
pub fn confirm_pending_send_delivered(state: State<'_, AppState>, app: tauri::AppHandle, account_id: String, operation_id: String) -> Result<(), PebbleError> {
    let op=state.store.list_pending_mail_ops(&account_id)?.into_iter().find(|op|op.id==operation_id&&op.op_type=="send")
        .ok_or_else(||PebbleError::Validation("此账户没有对应待发任务".into()))?;
    let payload:Value=serde_json::from_str(&op.payload_json).map_err(|e|PebbleError::Validation(e.to_string()))?;
    if payload.get("duplicate_submission").and_then(Value::as_i64)!=Some(1) {
        compose::ensure_local_outgoing_folder(&state.store,&account_id,LocalOutgoingState::Sent)?;
    }
    let duplicate=payload.get("duplicate_of_message_id").and_then(Value::as_str);
    state.store.confirm_pending_send_delivered(&operation_id,duplicate)?;
    emit_pending_ops_changed(Some(&app));
    if let Err(error)=refresh_search_document(state.inner(),&op.message_id) {
        warn!("Confirmed send resolved, search index still pending: {error}");
        let _=app.emit("mail:operation-error",serde_json::json!({"operation_id":op.id,"account_id":op.account_id,"op_type":"index","message":format!("待发记录已结束，搜索索引尚未更新，已保留索引恢复任务：{error}")}));
    }
    Ok(())
}

fn emit_pending_ops_changed(app: Option<&tauri::AppHandle>) {
    if let Some(app) = app {
        let _ = app.emit(events::MAIL_PENDING_OPS_CHANGED, ());
    }
}

async fn replay_pending_mail_op(
    state: &AppState,
    op: &PendingMailOp,
    imap_connections: &mut HashMap<String, pebble_mail::ImapProvider>,
) -> std::result::Result<(), PebbleError> {
    let _identity_guard = if op.op_type == "send" { Some(state.account_identity_lock.lock().await) } else { None };
    let Some(message) = state.store.get_message(&op.message_id)? else {
        debug!("Pending mail op {} skipped because message is gone", op.id);
        return Ok(());
    };
    if op.op_type == "send" && message.is_deleted { return Ok(()); }
    let Some(account) = state.store.get_account(&op.account_id)? else {
        debug!("Pending mail op {} skipped because account is gone", op.id);
        return Ok(());
    };
    let payload = op_payload(op);
    let imap_sent_rule_move = account.provider == ProviderType::Imap
        && op.op_type == "move_to_folder"
        && message.remote_id.starts_with("local-sent-")
        && message.message_id_header.as_deref().is_some_and(|value| !value.trim().is_empty())
        && match payload.as_ref().ok().and_then(|payload| string_field(payload, "source_folder_id")) {
            Some(id) => state.store.get_folder(&id)?.is_some_and(|folder| {
                folder.account_id == op.account_id && folder.role == Some(FolderRole::Sent)
                    && !folder.remote_id.starts_with("__local_")
            }),
            None => false,
        };

    // Imported/local messages do not have a provider-side identifier. Older
    // builds queued remote flag/move operations for them anyway, which can
    // never succeed and caused an ever-growing "remote writes" counter.
    // Local state was already applied when the action was initiated, so the
    // safe recovery is to acknowledge the impossible remote replay.
    if op.op_type != "send" && !imap_sent_rule_move
        && pebble_store::local_messages::is_local_message_id(&message.remote_id)
    {
        if matches!(op.op_type.as_str(), "delete" | "delete_permanent") {
            apply_pending_local_commit(&state.store, op)?;
            refresh_after_pending_commit(state, op)?;
        }
        debug!(
            "Pending mail op {} completed locally because message {} has no remote id",
            op.id, message.id
        );
        return Ok(());
    }

    // A locally saved ID in an old flag request remains invalid even if the
    // message now has a verified server ID.
    if op.op_type == "update_flags"
        && serde_json::from_str::<Value>(&op.payload_json)
            .ok()
            .and_then(|value| string_field(&value, "remote_id"))
            .as_deref()
            .is_some_and(pebble_store::local_messages::is_local_message_id)
    {
        return Ok(());
    }

    let payload = payload?;
    let mut imap_move_committed = false;
    let source_cleanup_account=(op.op_type=="send").then(||account.clone());
    match op.op_type.as_str() {
        "update_flags" => {
            let is_read = optional_bool(&payload, "is_read");
            let is_starred = optional_bool(&payload, "is_starred");
            replay_remote_update_flags(
                state,
                account.provider,
                &message,
                &payload,
                is_read,
                is_starred,
            )
            .await?;
        }
        "archive" => {
            replay_remote_archive(state, account.provider, &message, &payload).await?;
        }
        "unarchive" | "restore" => {
            replay_remote_restore(state, account.provider, &message, &payload).await?;
        }
        "delete" => {
            replay_remote_delete(state, account.provider, &message, &payload, false).await?;
        }
        "delete_permanent" => {
            replay_remote_delete(state, account.provider, &message, &payload, true).await?;
        }
        "move_to_folder" => {
            if account.provider == ProviderType::Imap {
                if !imap_connections.contains_key(&account.id) {
                    let provider = connect_imap(state, &account.id).await?;
                    imap_connections.insert(account.id.clone(), provider);
                }
                let imap = imap_connections
                    .get(&account.id)
                    .expect("IMAP connection inserted above");
                replay_remote_move_to_folder(
                    state,
                    account.provider,
                    &message,
                    &payload,
                    Some(imap),
                )
                .await?;
                // IMAP's reconciliation has already bound the destination.
                // It may have retired the original row in favor of a complete
                // copy. Applying the generic move would resurrect that row.
                imap_move_committed = message.message_id_header.as_deref()
                    .is_some_and(|value| !value.trim().is_empty());
            } else {
                replay_remote_move_to_folder(
                    state,
                    account.provider,
                    &message,
                    &payload,
                    None,
                )
                .await?;
            }
        }
        "send" => {
            let root: Value = serde_json::from_str(&op.payload_json).map_err(|e|PebbleError::Internal(e.to_string()))?;
            let accepted = root.get("provider_accepted").is_some_and(|v|v.as_i64()==Some(1)||v.as_bool()==Some(true));
            if accepted {
                // A receipt gates the transport stage. Postprocessing retries
                // must never submit SMTP/API send a second time.
                if message.remote_id.starts_with("local-outbox-") {
                    let header = root.get("submitted_message_id").and_then(Value::as_str)
                        .filter(|s|!s.is_empty()).ok_or_else(||PebbleError::Validation("发送回执缺少Message-ID，需要核对，未重新发送".into()))?;
                    let body = pebble_mail::smtp::SentBody {html:Some(message.body_html_raw.clone()),inline_images:Vec::new()};
                    compose::finalize_queued_smtp_send(&state.store,&message,header.into(),&body,&state.attachments_dir)?;
                }
            } else {
                replay_remote_send(state, account.provider.clone(), &account, &message, &op.id).await?;
            }
        }
        other => {
            return Err(PebbleError::Internal(format!(
                "Unsupported pending mail op type: {other}"
            )));
        }
    }

    let stages: Value = serde_json::from_str(&op.payload_json).map_err(|e|PebbleError::Internal(e.to_string()))?;
    let done = |name: &str| stages.get(name).and_then(Value::as_i64)==Some(1);
    if !imap_move_committed && (op.op_type != "send" || !done("local_sent_committed")) {
        apply_pending_local_commit(&state.store, op)?;
        if op.op_type=="send" {state.store.record_send_completion_stage(&op.id,"local_sent_committed")?;}
    }
    if op.op_type == "send" && !done("send_rules_applied") {
        if let Some(message) = state.store.get_message(&op.message_id)? {
            super::rules::apply_rules_to_message_for_trigger(&state.store, &message, pebble_rules::RuleTrigger::Send)
                .map_err(|error|PebbleError::Internal(format!("服务器已接受邮件，但发送后规则执行失败，请勿重复发送：{error}")))?;
        }
        state.store.record_send_completion_stage(&op.id,"send_rules_applied")?;
    }
    if !imap_move_committed && (op.op_type!="send" || !done("send_index_updated")) {
        refresh_after_pending_commit(state, op)?;
        if op.op_type=="send" {state.store.record_send_completion_stage(&op.id,"send_index_updated")?;}
    }
    if op.op_type == "send" && !done("source_draft_cleaned") {
        cleanup_submitted_source_draft(state,source_cleanup_account.as_ref().expect("send account captured"),&stages).await
            .map_err(|error|PebbleError::Internal(format!("服务器已接受邮件，原远端草稿清理失败；不要重复发送，请在草稿箱核对旧副本：{error}")))?;
        state.store.record_send_completion_stage(&op.id,"source_draft_cleaned")?;
    }
    Ok(())
}

/// Same durable state machine for a user's immediate send and worker recovery.
/// Once transport was attempted, do not return a generic error that leaves the
/// editor's Send button appearing safe to press again.
pub(crate) async fn submit_claimed_send(state: &AppState, op: &PendingMailOp, app: &tauri::AppHandle) -> compose::SendEmailResult {
    let mut connections = HashMap::new();
    let result = replay_pending_mail_op(state, op, &mut connections).await
        .and_then(|_| state.store.mark_pending_mail_op_done(&op.id));
    let result = match result {
        Ok(()) => compose::SendEmailResult::sent(None),
        Err(error) => {
            let accepted = state.store.send_was_accepted(&op.id).unwrap_or(false);
            let mut warning = if accepted { format!("服务器已接受邮件，归档或后续处理尚未完成；只会继续后处理，不会再次发送。原因：{error}") }
                else { format!("发送失败或结果未确认，自动重试已暂停；请核对已发送或收件方后再处理。原因：{error}") };
            if let Err(persist) = state.store.hold_failed_send(&op.id, &warning) {
                warning.push_str(&format!("；记录后续状态失败：{persist}。请勿重复发送。"));
            }
            let _ = app.emit("mail:operation-error",serde_json::json!({"operation_id":op.id,"account_id":op.account_id,"op_type":"send","message":warning}));
            compose::SendEmailResult { status: if accepted { "sent" } else { "queued" }, operation_id:Some(op.id.clone()),warning:Some(warning) }
        }
    };
    emit_pending_ops_changed(Some(app));
    result
}

/// Only after delivery acceptance/local Sent commit. This must never resubmit mail.
async fn cleanup_submitted_source_draft(state:&AppState,account:&pebble_core::Account,payload:&Value)->Result<(),PebbleError>{
    let Some(source)=payload.get("source_draft").filter(|value|value.is_object()) else{return Ok(());};
    if payload.get("send_saved_draft").and_then(Value::as_bool)!=Some(true){return Err(PebbleError::Validation("远端草稿清理缺少对应发送标记".into()));}
    let remote=source.get("remote_id").and_then(Value::as_str).filter(|s|!s.is_empty()).ok_or_else(||PebbleError::Validation("原草稿远端编号缺失".into()))?;
    match account.provider {
        ProviderType::Gmail=>{connect_gmail(state,&account.id).await?.trash_message(remote).await?;}
        ProviderType::Outlook=>{connect_outlook(state,&account.id).await?.trash_message(remote).await?;}
        ProviderType::Imap=>{
            let folder=source.get("folder_remote_id").and_then(Value::as_str).ok_or_else(||PebbleError::Validation("原草稿文件夹缺失".into()))?;
            let header=source.get("message_id_header").and_then(Value::as_str).filter(|s|!s.is_empty()).ok_or_else(||PebbleError::Validation("原远端草稿缺少Message-ID，未冒险删除服务器副本".into()))?;
            let trash=state.store.find_folder_by_role(&account.id,FolderRole::Trash)?.ok_or_else(||PebbleError::Validation("未找到废纸篓，原远端草稿已保留".into()))?;
            let imap=connect_imap(state,&account.id).await?;
            let result=async {
                // Resolve by the original Message-ID, not a possibly stale UID.
                if let Some(uid)=imap.find_uid_by_message_id(folder,header).await? {imap.move_message(folder,uid,&trash.remote_id).await?;}
                Ok::<(),PebbleError>(())
            }.await;
            let _=imap.disconnect().await;result?;
        }
        ProviderType::Pop3=>return Err(PebbleError::Validation("POP3不支持清理远端草稿，副本已保留".into())),
    }
    Ok(())
}

async fn replay_remote_update_flags(
    state: &AppState,
    provider_type: ProviderType,
    message: &pebble_core::Message,
    payload: &Value,
    is_read: Option<bool>,
    is_starred: Option<bool>,
) -> std::result::Result<(), PebbleError> {
    match provider_type {
        ProviderType::Gmail => {
            let add = string_array(payload, "add_labels").unwrap_or_else(|| {
                let mut labels = Vec::new();
                if is_read == Some(false) {
                    labels.push("UNREAD".to_string());
                }
                if is_starred == Some(true) {
                    labels.push("STARRED".to_string());
                }
                labels
            });
            let remove = string_array(payload, "remove_labels").unwrap_or_else(|| {
                let mut labels = Vec::new();
                if is_read == Some(true) {
                    labels.push("UNREAD".to_string());
                }
                if is_starred == Some(false) {
                    labels.push("STARRED".to_string());
                }
                labels
            });
            if add.is_empty() && remove.is_empty() {
                return Ok(());
            }
            connect_gmail(state, &message.account_id)
                .await?
                .modify_labels(&message.remote_id, &add, &remove)
                .await
        }
        ProviderType::Outlook => {
            let provider = connect_outlook(state, &message.account_id).await?;
            if let Some(read) = is_read {
                provider
                    .update_read_status(&message.remote_id, read)
                    .await?;
            }
            if let Some(starred) = is_starred {
                provider
                    .update_flag_status(&message.remote_id, starred)
                    .await?;
            }
            Ok(())
        }
        ProviderType::Imap => {
            let folder_remote_id = string_field(payload, "folder_remote_id")
                .or_else(|| {
                    find_message_folder(state, &message.id, &message.account_id)
                        .ok()
                        .map(|folder| folder.remote_id)
                })
                .ok_or_else(|| {
                    PebbleError::Internal("Pending update_flags has no IMAP folder".to_string())
                })?;
            let uid = message
                .remote_id
                .parse::<u32>()
                .map_err(|e| PebbleError::Internal(format!("Invalid IMAP UID: {e}")))?;
            let imap = connect_imap(state, &message.account_id).await?;
            let result = imap
                .set_flags(&folder_remote_id, uid, is_read, is_starred)
                .await;
            let _ = imap.disconnect().await;
            result
        }
        ProviderType::Pop3 => Ok(()),
    }
}

async fn replay_remote_archive(
    state: &AppState,
    provider_type: ProviderType,
    message: &pebble_core::Message,
    payload: &Value,
) -> std::result::Result<(), PebbleError> {
    match provider_type {
        ProviderType::Gmail => {
            let add = string_array(payload, "add_labels").unwrap_or_default();
            let remove =
                string_array(payload, "remove_labels").unwrap_or_else(|| vec!["INBOX".to_string()]);
            connect_gmail(state, &message.account_id)
                .await?
                .modify_labels(&message.remote_id, &add, &remove)
                .await
        }
        ProviderType::Outlook => {
            let target_remote_id =
                target_folder_remote_id(state, message, payload, FolderRole::Archive)?;
            let new_remote_id = connect_outlook(state, &message.account_id)
                .await?
                .move_message(&message.remote_id, &target_remote_id)
                .await?;
            state.store.update_remote_id(&message.id, &new_remote_id)?;
            Ok(())
        }
        ProviderType::Imap => {
            let source_remote_id = source_folder_remote_id(state, message, payload)?;
            let target_remote_id =
                target_folder_remote_id(state, message, payload, FolderRole::Archive)?;
            let uid = parse_uid(message)?;
            let imap = connect_imap(state, &message.account_id).await?;
            let result = imap
                .move_message_with_dedup(
                    &source_remote_id,
                    uid,
                    &target_remote_id,
                    message.message_id_header.as_deref(),
                )
                .await;
            let result = match result {
                Ok(()) => rebind_imap_destination_uid(
                    state,
                    &imap,
                    message,
                    &target_remote_id,
                )
                .await,
                Err(error) => Err(error),
            };
            let _ = imap.disconnect().await;
            result
        }
        ProviderType::Pop3 => Ok(()),
    }
}

async fn replay_remote_restore(
    state: &AppState,
    provider_type: ProviderType,
    message: &pebble_core::Message,
    payload: &Value,
) -> std::result::Result<(), PebbleError> {
    match provider_type {
        ProviderType::Gmail => {
            let current_folder = find_message_folder(state, &message.id, &message.account_id).ok();
            let provider = connect_gmail(state, &message.account_id).await?;
            if current_folder
                .as_ref()
                .is_some_and(|folder| folder.role == Some(FolderRole::Trash))
            {
                provider.untrash_message(&message.remote_id).await
            } else {
                provider
                    .modify_labels(&message.remote_id, &["INBOX".to_string()], &[])
                    .await
            }
        }
        ProviderType::Outlook => {
            let new_remote_id =
                if let Some(target_remote_id) = string_field(payload, "target_folder_remote_id") {
                    connect_outlook(state, &message.account_id)
                        .await?
                        .move_message(&message.remote_id, &target_remote_id)
                        .await?
                } else {
                    connect_outlook(state, &message.account_id)
                        .await?
                        .restore_message(&message.remote_id)
                        .await?
                };
            state.store.update_remote_id(&message.id, &new_remote_id)?;
            Ok(())
        }
        ProviderType::Imap => {
            let source_remote_id = source_folder_remote_id(state, message, payload)?;
            let target_remote_id =
                target_folder_remote_id(state, message, payload, FolderRole::Inbox)?;
            let uid = parse_uid(message)?;
            let imap = connect_imap(state, &message.account_id).await?;
            let result = imap
                .move_message_with_dedup(
                    &source_remote_id,
                    uid,
                    &target_remote_id,
                    message.message_id_header.as_deref(),
                )
                .await;
            let result = match result {
                Ok(()) => rebind_imap_destination_uid(
                    state,
                    &imap,
                    message,
                    &target_remote_id,
                )
                .await,
                Err(error) => Err(error),
            };
            let _ = imap.disconnect().await;
            result
        }
        ProviderType::Pop3 => Ok(()),
    }
}

async fn replay_remote_delete(
    state: &AppState,
    provider_type: ProviderType,
    message: &pebble_core::Message,
    payload: &Value,
    permanent: bool,
) -> std::result::Result<(), PebbleError> {
    match provider_type {
        ProviderType::Gmail => {
            let provider = connect_gmail(state, &message.account_id).await?;
            if permanent {
                provider
                    .delete_message_permanently(&message.remote_id)
                    .await
            } else {
                provider.trash_message(&message.remote_id).await
            }
        }
        ProviderType::Outlook => {
            let provider = connect_outlook(state, &message.account_id).await?;
            if permanent {
                provider
                    .delete_message_permanently(&message.remote_id)
                    .await
            } else {
                let new_remote_id = provider.trash_message(&message.remote_id).await?;
                state.store.update_remote_id(&message.id, &new_remote_id)?;
                Ok(())
            }
        }
        ProviderType::Imap => {
            let source_remote_id = source_folder_remote_id(state, message, payload)?;
            let uid = parse_uid(message)?;
            let imap = connect_imap(state, &message.account_id).await?;
            let mut moved_target: Option<String> = None;
            let result = if permanent {
                imap.delete_message(&source_remote_id, uid).await
            } else if let Some(trash_remote_id) = string_field(payload, "trash_folder_remote_id")
                .or_else(|| {
                    find_folder_by_role(state, &message.account_id, FolderRole::Trash)
                        .ok()
                        .map(|folder| folder.remote_id)
                })
            {
                if trash_remote_id == source_remote_id {
                    imap.delete_message(&source_remote_id, uid).await
                } else {
                    moved_target = Some(trash_remote_id.clone());
                    imap.move_message_with_dedup(
                        &source_remote_id,
                        uid,
                        &trash_remote_id,
                        message.message_id_header.as_deref(),
                    )
                    .await
                }
            } else {
                imap.delete_message(&source_remote_id, uid).await
            };
            let result = match (result, moved_target.as_deref()) {
                (Ok(()), Some(target_remote_id)) => {
                    rebind_imap_destination_uid(state, &imap, message, target_remote_id).await
                }
                (result, _) => result,
            };
            let _ = imap.disconnect().await;
            result
        }
        ProviderType::Pop3 => Ok(()),
    }
}

/// Locate the message by Message-ID before moving it. IMAP UIDs are scoped to
/// a mailbox, and a locally moved row may still carry its old source UID.
/// Returning `None` means no server move is needed. The destination either
/// already holds the copy, or an SMTP-only local Sent copy has no server UID.
async fn locate_imap_move_source(
    state: &AppState,
    imap: &pebble_mail::ImapProvider,
    message: &pebble_core::Message,
    payload: &Value,
    target_remote_id: &str,
) -> std::result::Result<Option<(String, u32)>, PebbleError> {
    let Some(message_id_header) = message
        .message_id_header
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(Some((
            source_folder_remote_id(state, message, payload)?,
            parse_uid(message)?,
        )));
    };

    if let Some(destination_uid) = imap
        .find_uid_by_message_id(target_remote_id, message_id_header)
        .await?
    {
        persist_imap_destination_uid(
            state,
            message,
            target_remote_id,
            destination_uid,
        )?;
        return Ok(None);
    }

    if message.remote_id.starts_with("local-sent-") {
        // A rule already filed the local Sent copy. The server may save a Sent
        // copy independently. Only look in the recorded Sent folder so an
        // actual self-delivery with the same Message-ID cannot be moved.
        let source = source_folder_remote_id(state, message, payload)?;
        return Ok(imap.find_uid_by_message_id(&source, message_id_header).await?
            .map(|uid| (source, uid)));
    }

    let account = state.store.get_account(&message.account_id)?;
    let sent_first = account
        .as_ref()
        .is_some_and(|account| message.from_address.eq_ignore_ascii_case(&account.email));
    let mut folders = state.store.list_folders(&message.account_id)?;
    folders.sort_by_key(|folder| {
        if sent_first && folder.role == Some(FolderRole::Sent) {
            0
        } else if !sent_first && folder.role == Some(FolderRole::Inbox) {
            0
        } else if matches!(folder.role, Some(FolderRole::Inbox | FolderRole::Sent)) {
            1
        } else if folder.role == Some(FolderRole::Archive) {
            2
        } else if folder.role.is_none() {
            3
        } else {
            4
        }
    });

    let mut candidates = Vec::new();
    if let Ok(source) = source_folder_remote_id(state, message, payload) {
        candidates.push(source);
    }
    candidates.extend(folders.into_iter().map(|folder| folder.remote_id));
    let mut seen = HashSet::new();
    for candidate in candidates {
        if candidate == target_remote_id
            || candidate.starts_with("__local_")
            || !seen.insert(candidate.clone())
        {
            continue;
        }
        match imap
            .find_uid_by_message_id(&candidate, message_id_header)
            .await
        {
            Ok(Some(uid)) => return Ok(Some((candidate, uid))),
            Ok(None) => {}
            Err(error) => {
                debug!(
                    "Skipping IMAP source candidate {} for moved message {}: {}",
                    candidate, message.id, error
                );
            }
        }
    }

    Err(PebbleError::Sync(format!(
        "Cannot locate message {} in any source mailbox by Message-ID",
        message.id
    )))
}

async fn replay_remote_move_to_folder(
    state: &AppState,
    provider_type: ProviderType,
    message: &pebble_core::Message,
    payload: &Value,
    shared_imap: Option<&pebble_mail::ImapProvider>,
) -> std::result::Result<(), PebbleError> {
    match provider_type {
        ProviderType::Gmail => {
            let add = string_array(payload, "add_labels").unwrap_or_else(|| {
                string_field(payload, "target_folder_remote_id")
                    .into_iter()
                    .collect()
            });
            let remove =
                string_array(payload, "remove_labels").unwrap_or_else(|| vec!["INBOX".to_string()]);
            connect_gmail(state, &message.account_id)
                .await?
                .modify_labels(&message.remote_id, &add, &remove)
                .await
        }
        ProviderType::Outlook => {
            let target_remote_id =
                target_folder_remote_id(state, message, payload, FolderRole::Inbox)?;
            let new_remote_id = connect_outlook(state, &message.account_id)
                .await?
                .move_message(&message.remote_id, &target_remote_id)
                .await?;
            state.store.update_remote_id(&message.id, &new_remote_id)?;
            Ok(())
        }
        ProviderType::Imap => {
            let target_remote_id =
                target_folder_remote_id(state, message, payload, FolderRole::Inbox)?;
            let owned_imap = if shared_imap.is_none() {
                Some(connect_imap(state, &message.account_id).await?)
            } else {
                None
            };
            let imap = shared_imap
                .or(owned_imap.as_ref())
                .expect("shared or owned IMAP connection");
            let result = match locate_imap_move_source(
                state,
                imap,
                message,
                payload,
                &target_remote_id,
            )
            .await?
            {
                None => Ok(()),
                Some((source_remote_id, uid)) => {
                    imap.move_message_with_dedup(
                        &source_remote_id,
                        uid,
                        &target_remote_id,
                        message.message_id_header.as_deref(),
                    )
                    .await?;
                    rebind_imap_destination_uid(state, imap, message, &target_remote_id).await
                }
            };
            if let Some(imap) = owned_imap {
                let _ = imap.disconnect().await;
            }
            result
        }
        ProviderType::Pop3 => Ok(()),
    }
}

async fn replay_remote_send(
    state: &AppState,
    provider_type: ProviderType,
    account: &pebble_core::Account,
    message: &pebble_core::Message,
    operation_id: &str,
) -> std::result::Result<(), PebbleError> {
    super::sender_identity::validate_queued_sender(account, message)?;
    let attachment_paths = state
        .store
        .list_attachments_by_message(&message.id)?
        .into_iter()
        .filter_map(|attachment| attachment.local_path)
        .collect::<Vec<_>>();
    let outgoing = compose::outgoing_message_from_stored(message, attachment_paths);

    match provider_type {
        ProviderType::Gmail => {
            super::sender_identity::verify_oauth_sender(state, account).await?;
            connect_gmail(state, &account.id)
                .await?
                .send_message(&outgoing)
                .await?;
            state.store.record_send_acceptance(operation_id, message.message_id_header.as_deref().unwrap_or(""))?;
            Ok(())
        }
        ProviderType::Outlook => {
            super::sender_identity::verify_oauth_sender(state, account).await?;
            connect_outlook(state, &account.id)
                .await?
                .send_message(&outgoing)
                .await?;
            state.store.record_send_acceptance(operation_id, message.message_id_header.as_deref().unwrap_or(""))?;
            Ok(())
        }
        ProviderType::Imap | ProviderType::Pop3 => {
            // 重试发送也用统一 Message-ID，成功后再存"已发送"副本时保持一致。
            // 存档 HTML 用线上真实版本（data: 已换成 cid:），并保存内嵌图片附件记录。
            let (message_id, sent_body) =
                compose::send_imap_smtp_message(state, account, &outgoing).await?;
            state.store.record_send_acceptance(operation_id, &message_id)
                .map_err(|e| PebbleError::Internal(format!("服务器已接受邮件，但发送回执保存失败，请勿重复发送：{e}")))?;
            compose::finalize_queued_smtp_send(&state.store, message, message_id, &sent_body, &state.attachments_dir)
                .map_err(|e| PebbleError::Internal(format!("服务器已接受邮件，但本地存档失败，请勿重复发送：{e}")))?;
            Ok(())
        }
    }
}

fn apply_pending_local_commit(
    store: &Store,
    op: &PendingMailOp,
) -> std::result::Result<(), PebbleError> {
    let payload = op_payload(op)?;
    match op.op_type.as_str() {
        "update_flags" => {
            store.update_message_flags(
                &op.message_id,
                optional_bool(&payload, "is_read"),
                optional_bool(&payload, "is_starred"),
            )?;
        }
        "archive" => {
            if let Some(folder_id) = string_field(&payload, "target_folder_id")
                .or_else(|| string_field(&payload, "archive_folder_id"))
                .or_else(|| {
                    store
                        .find_folder_by_role(&op.account_id, FolderRole::Archive)
                        .ok()
                        .flatten()
                        .map(|folder| folder.id)
                })
            {
                store.move_message_to_folder(&op.message_id, &folder_id)?;
            } else {
                store.soft_delete_message(&op.message_id)?;
            }
        }
        "unarchive" | "restore" => {
            let folder_id = string_field(&payload, "target_folder_id")
                .or_else(|| {
                    store
                        .find_folder_by_role(&op.account_id, FolderRole::Inbox)
                        .ok()
                        .flatten()
                        .map(|folder| folder.id)
                })
                .ok_or_else(|| PebbleError::Internal("No restore target folder".to_string()))?;
            store.move_message_to_folder(&op.message_id, &folder_id)?;
        }
        "delete" => {
            if let Some(trash_folder_id) = string_field(&payload, "trash_folder_id") {
                let current = store
                    .get_message_folder_ids(&op.message_id)?
                    .into_iter()
                    .next();
                if current.as_deref() != Some(trash_folder_id.as_str()) {
                    store.move_message_to_folder(&op.message_id, &trash_folder_id)?;
                } else {
                    store.soft_delete_message(&op.message_id)?;
                }
            } else if let Some(trash) =
                store.find_folder_by_role(&op.account_id, FolderRole::Trash)?
            {
                store.move_message_to_folder(&op.message_id, &trash.id)?;
            } else {
                store.soft_delete_message(&op.message_id)?;
            }
        }
        "delete_permanent" => {
            store.hard_delete_messages(std::slice::from_ref(&op.message_id))?;
        }
        "move_to_folder" => {
            let folder_id = string_field(&payload, "target_folder_id")
                .ok_or_else(|| PebbleError::Internal("No move target folder".to_string()))?;
            store.move_message_to_folder(&op.message_id, &folder_id)?;
        }
        "send" => {
            let sent = compose::ensure_local_outgoing_folder(
                store,
                &op.account_id,
                LocalOutgoingState::Sent,
            )?;
            store.commit_accepted_send_archive(&op.id, &sent.id)?;
        }
        other => {
            return Err(PebbleError::Internal(format!(
                "Unsupported pending mail op type: {other}"
            )));
        }
    }
    Ok(())
}

fn refresh_after_pending_commit(
    state: &AppState,
    op: &PendingMailOp,
) -> std::result::Result<(), PebbleError> {
    if op.op_type == "delete_permanent" {
        remove_search_documents(state, std::slice::from_ref(&op.message_id))
    } else {
        refresh_search_document(state, &op.message_id)
    }
}

fn op_payload(op: &PendingMailOp) -> std::result::Result<Value, PebbleError> {
    let value: Value = serde_json::from_str(&op.payload_json)
        .map_err(|e| PebbleError::Internal(format!("Invalid pending op payload: {e}")))?;
    Ok(value.get("payload").cloned().unwrap_or(value))
}

fn string_field(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn optional_bool(payload: &Value, key: &str) -> Option<bool> {
    payload.get(key).and_then(Value::as_bool)
}

fn string_array(payload: &Value, key: &str) -> Option<Vec<String>> {
    payload.get(key).and_then(|value| {
        value.as_array().map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
    })
}

fn source_folder_remote_id(
    state: &AppState,
    message: &pebble_core::Message,
    payload: &Value,
) -> std::result::Result<String, PebbleError> {
    string_field(payload, "source_folder_remote_id")
        .or_else(|| {
            find_message_folder(state, &message.id, &message.account_id)
                .ok()
                .map(|folder| folder.remote_id)
        })
        .ok_or_else(|| PebbleError::Internal("No source folder for pending op".to_string()))
}

fn target_folder_remote_id(
    state: &AppState,
    message: &pebble_core::Message,
    payload: &Value,
    fallback_role: FolderRole,
) -> std::result::Result<String, PebbleError> {
    string_field(payload, "target_folder_remote_id")
        .or_else(|| string_field(payload, "archive_folder_remote_id"))
        .or_else(|| string_field(payload, "trash_folder_remote_id"))
        .or_else(|| {
            string_field(payload, "target_folder_id")
                .or_else(|| string_field(payload, "archive_folder_id"))
                .and_then(|folder_id| {
                    state
                        .store
                        .list_folders(&message.account_id)
                        .ok()?
                        .into_iter()
                        .find(|folder| folder.id == folder_id)
                        .map(|folder| folder.remote_id)
                })
        })
        .or_else(|| {
            find_folder_by_role(state, &message.account_id, fallback_role)
                .ok()
                .map(|folder| folder.remote_id)
        })
        .ok_or_else(|| PebbleError::Internal("No target folder for pending op".to_string()))
}

fn parse_uid(message: &pebble_core::Message) -> std::result::Result<u32, PebbleError> {
    message
        .remote_id
        .parse::<u32>()
        .map_err(|e| PebbleError::Internal(format!("Invalid IMAP UID: {e}")))
}

#[cfg(test)]
mod tests {
    use super::apply_pending_local_commit;
    use pebble_core::*;
    use pebble_store::Store;

    #[tokio::test]
    async fn accepted_send_recovers_after_restart_and_postprocessing_failure_without_any_credentials() {
        for provider in [ProviderType::Gmail, ProviderType::Imap] {
            let store = Store::open_in_memory().unwrap();
            let mut account = test_account(); account.provider = provider; store.insert_account(&account).unwrap();
            let mut outbox = test_folder(&account.id,FolderRole::Sent,"__local_outbox__","Outbox"); outbox.role=None; store.insert_folder(&outbox).unwrap();
            let mut message = test_message(&account.id); message.remote_id=format!("local-outbox-{}",message.id); message.message_id_header=Some("<accepted@example.test>".into());
            store.insert_message(&message,&[outbox.id]).unwrap();
            let op = store.begin_immediate_send(&account.id,&message.id,r#"{"payload":{}}"#).unwrap();
            store.record_send_acceptance(&op.id,"<accepted@example.test>").unwrap();
            store.reset_in_progress_pending_mail_ops().unwrap();
            // A broken filing rule fails AFTER local Sent commit. No SMTP/API
            // credentials exist, so an accidental retransmission cannot pass.
            let rule=Rule{id:new_id(),name:"Unavailable filing destination".into(),priority:0,conditions:r#"{"operator":"and","conditions":[]}"#.into(),actions:r#"[{"type":"MoveToFolder","value":"missing-fixture-folder"}]"#.into(),is_enabled:true,account_id:account.id.clone(),trigger_when:r#"["on_send"]"#.into(),created_at:now_timestamp(),updated_at:now_timestamp()};
            store.insert_rule(&rule).unwrap();
            let root = std::env::temp_dir().join(format!("pebble-send-recovery-{}",new_id())); std::fs::create_dir_all(&root).unwrap();
            std::fs::write(root.join("portable-key"),format!("PEBBLE-PORTABLE-KEY-V1\n{}\n","07".repeat(32))).unwrap();
            let crypto=pebble_crypto::CryptoService::init_for_profile(&root).unwrap();
            let (stop,_)=std::sync::mpsc::channel();
            let state=crate::state::AppState::new(store,pebble_search::TantivySearch::open_in_memory().unwrap(),crypto,stop,root.join("attachments"));
            assert_eq!(super::process_pending_mail_ops(&state,None).await.unwrap(),0);
            assert!(state.store.send_was_accepted(&op.id).unwrap());
            assert!(state.store.retry_failed_send_once(&op.id).is_err());
            assert_eq!(state.store.get_message(&message.id).unwrap().unwrap().body_text,message.body_text);
            state.store.delete_rule(&rule.id).unwrap();
            state.store.reset_in_progress_pending_mail_ops().unwrap();
            assert_eq!(state.store.list_pending_mail_ops(&account.id).unwrap().iter().find(|v|v.id==op.id).unwrap().attempts,1);
            state.store.retry_send_postprocessing(&op.id).unwrap();
            assert_eq!(super::process_pending_mail_ops(&state,None).await.unwrap(),1);
            assert_eq!(super::process_pending_mail_ops(&state,None).await.unwrap(),0);
            assert_eq!(state.store.list_message_ids_by_account(&account.id).unwrap(),vec![message.id]);
            assert_eq!(state.store.pending_mail_ops_summary(Some(&account.id)).unwrap().total_active_count,0);
            drop(state); assert!(root.starts_with(std::env::temp_dir())); std::fs::remove_dir_all(root).unwrap();
        }
    }

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

    fn test_folder(account_id: &str, role: FolderRole, remote_id: &str, name: &str) -> Folder {
        Folder {
            id: new_id(),
            account_id: account_id.to_string(),
            remote_id: remote_id.to_string(),
            name: name.to_string(),
            folder_type: FolderType::Folder,
            role: Some(role),
            parent_id: None,
            color: None,
            is_system: true,
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
    fn local_commit_replays_archived_pending_op_after_remote_success() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let inbox = test_folder(&account.id, FolderRole::Inbox, "INBOX", "Inbox");
        let archive = test_folder(&account.id, FolderRole::Archive, "ARCHIVE", "Archive");
        store.insert_folder(&inbox).unwrap();
        store.insert_folder(&archive).unwrap();
        let message = test_message(&account.id);
        store
            .insert_message(&message, std::slice::from_ref(&inbox.id))
            .unwrap();

        let op_id = store
            .insert_pending_mail_op(
                &account.id,
                &message.id,
                "archive",
                &serde_json::json!({
                    "remote_id": message.remote_id,
                    "op": "archive",
                    "payload": {
                        "source_folder_id": inbox.id,
                        "target_folder_id": archive.id,
                    }
                })
                .to_string(),
            )
            .unwrap();
        let op = store.list_pending_mail_ops(&account.id).unwrap().remove(0);

        apply_pending_local_commit(&store, &op).unwrap();

        let folder_ids = store.get_message_folder_ids(&message.id).unwrap();
        assert_eq!(folder_ids, vec![archive.id]);
        store.mark_pending_mail_op_done(&op_id).unwrap();
    }
}
