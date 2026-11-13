//! Workbench scheduling only persists intent; pending_mail_ops owns delivery.
//!
//! The UI must preview this exact draft revision and reuse checkSendGuard plus
//! its existing warn/block override confirmation before invoking scheduling.
//! This API does not turn a warning into an implicit override or call an LLM.
//! Register both commands and the Store module in the parent integration.
use crate::{events, state::AppState};
use pebble_core::PebbleError;
use tauri::{Emitter, State};

#[tauri::command]
pub async fn send_saved_draft(app:tauri::AppHandle,state:State<'_,AppState>,account_id:String,draft_id:String,expected_updated_at:i64)->Result<String,PebbleError> {
    validate_saved_draft(&state,&account_id,&draft_id)?;
    let store=state.store.clone();
    let op_id=tokio::task::spawn_blocking(move||store.send_saved_draft(&account_id,&draft_id,expected_updated_at)).await
        .map_err(|error|PebbleError::Internal(format!("草稿发送入队失败：{error}")))??;
    let _=app.emit(events::MAIL_PENDING_OPS_CHANGED,());
    Ok(op_id)
}

fn validate_saved_draft(state:&AppState,account_id:&str,draft_id:&str)->Result<(),PebbleError>{
    let draft=state.store.get_message(draft_id)?.ok_or_else(||PebbleError::Validation("草稿已不存在".into()))?;
    if draft.account_id!=account_id || !draft.is_draft || draft.is_deleted {return Err(PebbleError::Validation("请选择当前账户未删除的草稿".into()));}
    if draft.remote_version.as_deref()==Some("headers-only") {return Err(PebbleError::Validation("草稿正文尚未下载，请先打开草稿完成下载".into()));}
    if draft.body_text.trim().is_empty() && draft.body_html_raw.trim().is_empty(){return Err(PebbleError::Validation("草稿正文为空，请先编辑后发送".into()));}
    super::workbench_actions::validate_item(&pebble_store::workbench_drafts::WorkbenchDraftItem{
        key:"saved-draft-validation".into(),to:draft.to_list.iter().map(|a|a.address.clone()).collect(),
        cc:draft.cc_list.iter().map(|a|a.address.clone()).collect(),bcc:draft.bcc_list.iter().map(|a|a.address.clone()).collect(),
        subject:draft.subject.clone(),body_text:draft.body_text.clone(),body_html:None,
    })?;
    let attachments=state.store.list_attachments_by_message(draft_id)?;
    if draft.has_attachments && attachments.is_empty(){return Err(PebbleError::Validation("草稿附件信息不完整，请先打开核对".into()));}
    for attachment in attachments {
        let path=super::attachments::resolve_and_repair_attachment_path(state,&attachment)?.to_string_lossy().to_string();
        super::compose::validate_attachment_paths(&[path],&state.attachments_dir)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn schedule_workbench_draft(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    account_id: String,
    draft_id: String,
    expected_updated_at: i64,
    send_at: i64,
) -> Result<String, PebbleError> {
    let draft=state.store.get_message(&draft_id)?.ok_or_else(||PebbleError::Validation("草稿已不存在".into()))?;
    if draft.account_id!=account_id || !draft.is_draft {return Err(PebbleError::Validation("请重新选择当前账户的本地草稿".into()));}
    super::workbench_actions::validate_item(&pebble_store::workbench_drafts::WorkbenchDraftItem{
        key:"schedule-validation".into(),to:draft.to_list.iter().map(|a|a.address.clone()).collect(),
        cc:draft.cc_list.iter().map(|a|a.address.clone()).collect(),bcc:draft.bcc_list.iter().map(|a|a.address.clone()).collect(),
        subject:draft.subject.clone(),body_text:draft.body_text.clone(),body_html:None,
    })?;
    for attachment in state.store.list_attachments_by_message(&draft_id)? {
        let path=attachment.local_path.ok_or_else(||PebbleError::Validation("附件尚未下载，请先在写信窗口核对".into()))?;
        if !std::path::Path::new(&path).is_file(){return Err(PebbleError::Validation("附件本地文件不存在，请先在写信窗口核对".into()));}
        super::compose::validate_attachment_paths(&[path],&state.attachments_dir)?;
    }
    let store = state.store.clone();
    let op_id = tokio::task::spawn_blocking(move || {
        store.schedule_workbench_draft(&account_id, &draft_id, expected_updated_at, send_at)
    }).await.map_err(|error| PebbleError::Internal(format!("定时发送任务执行失败：{error}")))??;
    // Event delivery is best effort after commit; failure must not turn a
    // successful enqueue into an apparent failure inviting a second schedule.
    let _ = app.emit(events::MAIL_PENDING_OPS_CHANGED, ());
    Ok(op_id)
}

#[tauri::command]
pub async fn cancel_workbench_schedule(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    account_id: String,
    operation_id: String,
) -> Result<String, PebbleError> {
    let store = state.store.clone();
    let draft_id = tokio::task::spawn_blocking(move || {
        store.cancel_workbench_schedule(&account_id, &operation_id)
    }).await.map_err(|error| PebbleError::Internal(format!("取消定时任务执行失败：{error}")))??;
    let _ = app.emit(events::MAIL_PENDING_OPS_CHANGED, ());
    Ok(draft_id)
}
