use crate::state::AppState;
use crate::commands::messages::{connect_imap, find_message_folder, refresh_search_document};
use pebble_core::{Message, PebbleError, PrivacyMode, RenderedHtml, TrustType};
use pebble_mail::parser::parse_raw_email;
use pebble_mail::persist_message_attachments;
use pebble_privacy::PrivacyGuard;
use pebble_store::Store;
use tauri::{AppHandle, Emitter, State};

/// 打开 headers-only 邮件：立即返回邮件头（不等待 IMAP），后台异步补全正文，
/// 补全成功后 emit "message:hydrated" 供前端刷新。失败不阻塞打开、不报错，
/// 只记录日志，下次打开或再次触发时自动重试。
async fn hydrate_header_only_message(
    state: &AppState,
    app: &AppHandle,
    message: Message,
) -> std::result::Result<Message, PebbleError> {
    if message.remote_version.as_deref() != Some("headers-only") {
        return Ok(message);
    }
    let message_id = message.id.clone();
    // 防同一封邮件并发重复拉取
    {
        let mut hydrating = state.hydrating_messages.lock().await;
        if hydrating.contains(&message_id) {
            return Ok(message);
        }
        hydrating.insert(message_id.clone());
    }
    let state_clone = state.clone();
    let app_clone = app.clone();
    tokio::spawn(async move {
        let result: std::result::Result<(), PebbleError> = (async {
            let mut msg = state_clone
                .store
                .get_message(&message_id)?
                .ok_or_else(|| PebbleError::Internal(format!("Message {message_id} disappeared")))?;
            hydrate_message_body(&state_clone, &mut msg).await
        })
        .await;
        {
            let mut hydrating = state_clone.hydrating_messages.lock().await;
            hydrating.remove(&message_id);
        }
        match result {
            Ok(()) => {
                tracing::info!("Hydrated message {message_id}");
                let _ = app_clone.emit("message:hydrated", message_id);
            }
            Err(error) => {
                tracing::warn!(
                    "Background hydration failed for {} (headers retained; will retry on next open): {}",
                    message_id, error
                );
                // 通知前端正文加载失败，避免正文区永远停留在"加载中"；
                // 前端收到后显示失败提示，用户可点击重试。
                let _ = app_clone.emit("message:hydrate-failed", message_id);
            }
        }
    });
    Ok(message)
}

async fn hydrate_message_body(
    state: &AppState,
    message: &mut Message,
) -> std::result::Result<(), PebbleError> {
    let folder = find_message_folder(state, &message.id, &message.account_id)?;
    let uid = message.remote_id.parse::<u32>()
        .map_err(|_| PebbleError::Internal(format!("Invalid remote UID: {}", message.remote_id)))?;
    let provider = connect_imap(state, &message.account_id).await?;

    // 大邮件根治：fetch_message_raw_by_uid 内部按 1 MiB 分块拉取
    // （RFC 3501 BODY.PEEK[]<offset.length>），单块永不超时，
    // 附件随完整 MIME 一起完整下载到本地——不做"按需下载"。
    let raw = provider
        .fetch_message_raw_by_uid(&folder.remote_id, uid)
        .await?;
    let _ = provider.disconnect().await;
    let parsed = parse_raw_email(&raw)?;
    message.body_text = parsed.body_text.clone();
    message.body_html_raw = parsed.body_html.clone();
    message.snippet = parsed.snippet.clone();
    message.has_attachments = parsed.has_attachments;
    message.remote_version = None;
    state.store.update_message_content(
        &message.id,
        &message.body_text,
        &message.body_html_raw,
        &message.snippet,
        message.has_attachments,
        None,
    )?;
    persist_message_attachments(
        &state.store,
        &state.attachments_dir,
        &message.id,
        parsed.attachments,
    );
    let _ = refresh_search_document(state, &message.id);
    Ok(())
}

#[tauri::command]
pub async fn get_rendered_html(
    app: AppHandle,
    state: State<'_, AppState>,
    message_id: String,
    privacy_mode: PrivacyMode,
) -> std::result::Result<RenderedHtml, PebbleError> {
    let state_ref = state.inner();
    let message = state_ref.store.get_message(&message_id)?
        .ok_or_else(|| PebbleError::Internal(format!("Message not found: {message_id}")))?;
    let message = hydrate_header_only_message(state_ref, &app, message).await?;
    let store = state_ref.store.clone();
    tokio::task::spawn_blocking(move || {
        let effective_mode = resolve_privacy_mode(&store, &message, privacy_mode)?;
        let guard = PrivacyGuard::new();
        Ok(guard.render_message_html(&message.body_html_raw, &message.body_text, &effective_mode))
    })
    .await
    .map_err(|e| PebbleError::Internal(format!("Task join error: {e}")))?
}

#[tauri::command]
pub async fn get_message_with_html(
    app: AppHandle,
    state: State<'_, AppState>,
    message_id: String,
    privacy_mode: PrivacyMode,
) -> std::result::Result<Option<(Message, RenderedHtml)>, PebbleError> {
    let state_ref = state.inner();
    let message = match state_ref.store.get_message(&message_id)? {
        Some(message) => Some(hydrate_header_only_message(state_ref, &app, message).await?),
        None => None,
    };
    let store = state_ref.store.clone();
    tokio::task::spawn_blocking(move || {
        let message = match message {
            Some(m) => m,
            None => return Ok(None),
        };

        let effective_mode = resolve_privacy_mode(&store, &message, privacy_mode)?;
        let guard = PrivacyGuard::new();
        let rendered =
            guard.render_message_html(&message.body_html_raw, &message.body_text, &effective_mode);
        Ok(Some((message, rendered)))
    })
    .await
    .map_err(|e| PebbleError::Internal(format!("Task join error: {e}")))?
}

#[tauri::command]
pub async fn is_trusted_sender(
    state: State<'_, AppState>,
    account_id: String,
    email: String,
) -> std::result::Result<bool, PebbleError> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || Ok(store.is_trusted_sender(&account_id, &email)?.is_some()))
        .await
        .map_err(|e| PebbleError::Internal(format!("Task join error: {e}")))?
}

fn resolve_privacy_mode(
    store: &Store,
    message: &Message,
    privacy_mode: PrivacyMode,
) -> std::result::Result<PrivacyMode, PebbleError> {
    match privacy_mode {
        PrivacyMode::Strict | PrivacyMode::LoadOnce => {
            match store.is_trusted_sender(&message.account_id, &message.from_address)? {
                Some(TrustType::All) => Ok(PrivacyMode::TrustSender(message.from_address.clone())),
                Some(TrustType::Images) => Ok(PrivacyMode::LoadOnce),
                None => Ok(privacy_mode),
            }
        }
        PrivacyMode::TrustSender(_) | PrivacyMode::Off => Ok(privacy_mode),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pebble_core::{
        new_id, now_timestamp, Account, EmailAddress, Folder, FolderRole, FolderType, Message,
        ProviderType, TrustType, TrustedSender,
    };

    fn make_account(id: &str) -> Account {
        let now = now_timestamp();
        Account {
            id: id.to_string(),
            email: "me@example.com".to_string(),
            display_name: "Me".to_string(),
            color: None,
            provider: ProviderType::Imap,
            created_at: now,
            updated_at: now,
        }
    }

    fn make_message(account_id: &str, from_address: &str) -> Message {
        let now = now_timestamp();
        Message {
            id: new_id(),
            account_id: account_id.to_string(),
            remote_id: "remote-1".to_string(),
            message_id_header: None,
            in_reply_to: None,
            references_header: None,
            thread_id: Some("thread-1".to_string()),
            subject: "Subject".to_string(),
            snippet: "Snippet".to_string(),
            from_address: from_address.to_string(),
            from_name: "Trusted".to_string(),
            to_list: vec![EmailAddress {
                name: None,
                address: "me@example.com".to_string(),
            }],
            cc_list: vec![],
            bcc_list: vec![],
            body_text: "Body".to_string(),
            body_html_raw: "<p>Body</p>".to_string(),
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

    fn make_folder(account_id: &str) -> Folder {
        Folder {
            id: new_id(),
            account_id: account_id.to_string(),
            remote_id: "INBOX".to_string(),
            name: "Inbox".to_string(),
            role: Some(FolderRole::Inbox),
            folder_type: FolderType::Folder,
            parent_id: None,
            color: None,
            is_system: true,
            sort_order: 0,
        }
    }

    fn store_with_trusted_sender(trust_type: TrustType) -> (Store, Message) {
        let store = Store::open_in_memory().unwrap();
        let account = make_account("account-1");
        store.insert_account(&account).unwrap();
        let folder = make_folder(&account.id);
        store.insert_folder(&folder).unwrap();
        let message = make_message(&account.id, "trusted@example.com");
        store.insert_message(&message, &[folder.id]).unwrap();
        store
            .trust_sender(&TrustedSender {
                account_id: account.id,
                email: "trusted@example.com".to_string(),
                trust_type,
                created_at: now_timestamp(),
            })
            .unwrap();
        (store, message)
    }

    #[test]
    fn all_trusted_sender_overrides_relaxed_mode() {
        let (store, message) = store_with_trusted_sender(TrustType::All);

        let mode = resolve_privacy_mode(&store, &message, PrivacyMode::LoadOnce).unwrap();

        assert!(
            matches!(mode, PrivacyMode::TrustSender(sender) if sender == "trusted@example.com")
        );
    }
}
