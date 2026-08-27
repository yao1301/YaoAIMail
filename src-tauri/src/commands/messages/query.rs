use crate::state::AppState;
use pebble_core::{Message, MessageSummary, PebbleError};
use tauri::State;

#[tauri::command]
pub async fn list_messages(
    state: State<'_, AppState>,
    folder_id: String,
    folder_ids: Option<Vec<String>>,
    limit: u32,
    offset: u32,
    cursor_date: Option<i64>,
    cursor_id: Option<String>,
) -> std::result::Result<Vec<MessageSummary>, PebbleError> {
    let store = state.store.clone();
    let cursor = cursor_date.zip(cursor_id);
    tokio::task::spawn_blocking(move || match cursor {
        Some(cursor) => match folder_ids {
            Some(ids) if !ids.is_empty() => store.list_messages_by_folders_cursor(&ids, limit, Some(cursor)),
            _ => store.list_messages_by_folder_cursor(&folder_id, limit, Some(cursor)),
        },
        None => match folder_ids {
            Some(ids) if !ids.is_empty() => store.list_messages_by_folders(&ids, limit, offset),
            _ => store.list_messages_by_folder(&folder_id, limit, offset),
        },
    })
    .await
    .map_err(|e| PebbleError::Internal(format!("Task join error: {e}")))?
}

/// "所有未读"视图：全部账户的未读邮件。
#[tauri::command]
pub async fn list_unread_messages(
    state: State<'_, AppState>,
    limit: u32,
    offset: u32,
) -> std::result::Result<Vec<MessageSummary>, PebbleError> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || store.list_unread_messages(limit, offset))
        .await
        .map_err(|e| PebbleError::Internal(format!("Task join error: {e}")))?
}

#[tauri::command]
pub async fn list_starred_messages(
    state: State<'_, AppState>,
    account_id: String,
    limit: u32,
    offset: u32,
) -> std::result::Result<Vec<MessageSummary>, PebbleError> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || store.list_starred_messages(&account_id, limit, offset))
        .await
        .map_err(|e| PebbleError::Internal(format!("Task join error: {e}")))?
}

#[tauri::command]
pub async fn get_message(
    state: State<'_, AppState>,
    message_id: String,
) -> std::result::Result<Option<Message>, PebbleError> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || store.get_message(&message_id))
        .await
        .map_err(|e| PebbleError::Internal(format!("Task join error: {e}")))?
}

#[tauri::command]
pub async fn get_messages_batch(
    state: State<'_, AppState>,
    message_ids: Vec<String>,
) -> std::result::Result<Vec<Message>, PebbleError> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || store.get_messages_batch(&message_ids))
        .await
        .map_err(|e| PebbleError::Internal(format!("Task join error: {e}")))?
}
