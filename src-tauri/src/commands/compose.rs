use std::path::{Path, PathBuf};

use crate::commands::attachments::{sanitize_stored_filename, stage_local_attachment_records};
use crate::commands::messages::refresh_search_document;
use crate::commands::network::{account_proxy_mode_from_auth_value, resolve_mail_proxy_from_mode};
use crate::commands::oauth::ensure_account_oauth_auth;
use crate::{events, state::AppState};
use pebble_core::traits::{MailTransport, OutgoingMessage};
use pebble_core::{
    new_id, now_timestamp, Account, EmailAddress, Folder, FolderRole, FolderType, Message,
    PebbleError, ProviderType,
};
use pebble_crypto::CryptoService;
use pebble_mail::smtp::{InlineImageData, SentBody, SmtpSender};
use pebble_mail::{SmtpConfig,GmailProvider,OutlookProvider};
use pebble_rules::RuleTrigger;
use pebble_store::Store;
use tauri::{Emitter, State};
use tracing::warn;

/// Validate that all attachment paths are within allowed directories.
pub(crate) fn validate_attachment_paths(
    paths: &[String],
    attachments_dir: &std::path::Path,
) -> std::result::Result<Vec<String>, PebbleError> {
    let mut allowed_dirs: Vec<PathBuf> = vec![attachments_dir.to_path_buf()];

    // Add user home subdirectories (Documents, Downloads, Desktop) and temp dir
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        let home = PathBuf::from(home);
        for sub in &["Documents", "Downloads", "Desktop"] {
            let dir = home.join(sub);
            if dir.exists() {
                allowed_dirs.push(dir);
            }
        }
    }
    if let Ok(tmp) = std::env::temp_dir().canonicalize() {
        allowed_dirs.push(tmp);
    }

    // Canonicalize allowed dirs for consistent comparison
    let allowed_dirs: Vec<PathBuf> = allowed_dirs
        .into_iter()
        .filter_map(|d| std::fs::canonicalize(&d).ok())
        .collect();

    let mut validated = Vec::with_capacity(paths.len());
    for raw_path in paths {
        let canonical = std::fs::canonicalize(raw_path).map_err(|e| {
            PebbleError::Internal(format!("Attachment path not found: {raw_path} ({e})"))
        })?;

        let is_allowed = allowed_dirs.iter().any(|dir| canonical.starts_with(dir));
        if !is_allowed {
            return Err(PebbleError::Internal(format!(
                "Attachment path is outside allowed directories: {}",
                canonical.display()
            )));
        }
        validated.push(canonical.to_string_lossy().into_owned());
    }
    Ok(validated)
}

fn parse_recipients(addresses: Vec<String>) -> Vec<EmailAddress> {
    addresses
        .into_iter()
        .map(|address| EmailAddress {
            name: None,
            address: address.trim().to_string(),
        })
        .filter(|address| !address.address.is_empty())
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocalOutgoingState {
    Sent,
    Queued,
}

fn local_outgoing_folder_spec(
    state: LocalOutgoingState,
) -> (&'static str, &'static str, Option<FolderRole>, i32) {
    match state {
        LocalOutgoingState::Sent => ("__local_sent__", "Sent", Some(FolderRole::Sent), 2),
        LocalOutgoingState::Queued => ("__local_outbox__", "Outbox", None, 3),
    }
}

pub(crate) fn ensure_local_outgoing_folder(
    store: &Store,
    account_id: &str,
    state: LocalOutgoingState,
) -> std::result::Result<Folder, PebbleError> {
    if state == LocalOutgoingState::Sent {
        if let Some(folder) = store.find_folder_by_role(account_id, FolderRole::Sent)? {
            return Ok(folder);
        }
    }

    let (remote_id, name, role, sort_order) = local_outgoing_folder_spec(state);
    if let Some(folder) = store.find_folder_by_name(account_id, name)? {
        return Ok(folder);
    }

    let folder = Folder {
        id: new_id(),
        account_id: account_id.to_string(),
        remote_id: remote_id.to_string(),
        name: name.to_string(),
        folder_type: FolderType::Folder,
        role,
        parent_id: None,
        color: None,
        is_system: true,
        sort_order,
    };
    let id = store.insert_folder(&folder)?;
    Ok(Folder { id, ..folder })
}

pub(crate) fn save_outgoing_message_locally(
    store: &Store,
    account: &Account,
    outgoing: &OutgoingMessage,
    state: LocalOutgoingState,
    attachments_dir: &Path,
    inline_images: &[InlineImageData],
) -> std::result::Result<Message, PebbleError> {
    let folder = ensure_local_outgoing_folder(store, &account.id, state)?;
    let now = now_timestamp();
    let id = new_id();
    let prefix = match state {
        LocalOutgoingState::Sent => "local-sent",
        LocalOutgoingState::Queued => "local-outbox",
    };
    let mut attachments =
        stage_local_attachment_records(attachments_dir, &id, &outgoing.attachment_paths)?;
    // The inline images that went over the wire as multipart/related parts are
    // stored locally too, so the "Sent" copy renders them through the same
    // cid:-resolution path used for received messages.
    attachments.extend(stage_inline_image_records(attachments_dir, &id, inline_images)?);
    let message = Message {
        id: id.clone(),
        account_id: account.id.clone(),
        remote_id: format!("{prefix}-{id}"),
        // 用发送时生成的真实 Message-ID（与 SMTP/服务器 Sent 副本一致），
        // 保证同步去重能匹配，避免"已发送"出现两封。退回默认再生成一个。
        message_id_header: outgoing.message_id.clone()
            .or_else(|| Some(format!("<{id}@pebble.local>"))),
        in_reply_to: outgoing.in_reply_to.clone(),
        references_header: outgoing.in_reply_to.clone(),
        thread_id: None,
        subject: outgoing.subject.clone(),
        snippet: outgoing.body_text.chars().take(200).collect(),
        from_address: outgoing.from.as_ref().map(|v| v.address.clone()).unwrap_or_else(|| account.email.clone()),
        from_name: outgoing.from.as_ref().and_then(|v| v.name.clone()).unwrap_or_else(|| account.display_name.clone()),
        to_list: outgoing.to.clone(),
        cc_list: outgoing.cc.clone(),
        bcc_list: outgoing.bcc.clone(),
        body_text: outgoing.body_text.clone(),
        body_html_raw: outgoing.body_html.clone().unwrap_or_default(),
        has_attachments: !attachments.is_empty(),
        is_read: true,
        is_starred: false,
        is_draft: false,
        date: now,
        remote_version: None,
        is_deleted: false,
        deleted_at: None,
        created_at: now,
        updated_at: now,
    };

    store.replace_message_with_attachments(&message, &[folder.id], &attachments)?;
    Ok(message)
}

/// Persist the inline images that went over the wire as multipart/related
/// parts so the local "Sent" copy can resolve its `cid:` references exactly
/// like received messages do.
pub(crate) fn stage_inline_image_records(
    attachments_root: &Path,
    message_id: &str,
    images: &[InlineImageData],
) -> std::result::Result<Vec<pebble_core::Attachment>, PebbleError> {
    if images.is_empty() {
        return Ok(Vec::new());
    }

    let message_dir = attachments_root.join(message_id);
    std::fs::create_dir_all(&message_dir).map_err(|e| {
        PebbleError::Internal(format!(
            "Failed to create local attachment directory {}: {e}",
            message_dir.display()
        ))
    })?;

    let mut records = Vec::with_capacity(images.len());
    for (index, image) in images.iter().enumerate() {
        let extension = match image.mime_type.rsplit('/').next() {
            Some("jpeg") | Some("jpg") => "jpg",
            Some("png") => "png",
            Some("gif") => "gif",
            Some("webp") => "webp",
            Some("bmp") => "bmp",
            _ => "img",
        };
        let filename = sanitize_stored_filename(&format!("inline-{index}.{extension}"));
        let target = message_dir.join(&filename);
        std::fs::write(&target, &image.bytes).map_err(|e| {
            PebbleError::Internal(format!(
                "Failed to write inline image {}: {e}",
                target.display()
            ))
        })?;

        records.push(pebble_core::Attachment {
            id: pebble_core::new_id(),
            message_id: message_id.to_string(),
            filename,
            mime_type: image.mime_type.clone(),
            size: image.bytes.len().min(i64::MAX as usize) as i64,
            local_path: Some(target.to_string_lossy().to_string()),
            content_id: Some(image.content_id.clone()),
            is_inline: true,
        });
    }

    Ok(records)
}

pub(crate) fn save_outgoing_message_and_refresh_search(
    state: &AppState,
    account: &Account,
    outgoing: &OutgoingMessage,
    outgoing_state: LocalOutgoingState,
    attachments_dir: &Path,
    inline_images: &[InlineImageData],
) -> std::result::Result<Message, PebbleError> {
    let message = save_outgoing_message_locally(
        &state.store,
        account,
        outgoing,
        outgoing_state,
        attachments_dir,
        inline_images,
    )?;
    if outgoing_state == LocalOutgoingState::Sent {
        match crate::commands::rules::apply_rules_to_message_for_trigger(
            &state.store,
            &message,
            RuleTrigger::Send,
        ) {
            Ok(applied) if applied > 0 => tracing::info!(
                message_id = %message.id,
                actions_applied = applied,
                "Applied on-send rules to outgoing message"
            ),
            Ok(_) => {}
            Err(error) => return Err(PebbleError::Internal(format!("邮件已保存，但发送后规则执行失败：{error}"))),
        }
    }
    if let Err(e) = refresh_search_document(state, &message.id) {
        if outgoing_state == LocalOutgoingState::Sent {
            return Err(PebbleError::Internal(format!("邮件已保存，但搜索索引更新失败：{e}")));
        }
        warn!("Failed to index outgoing message {}: {e}", message.id);
    }
    Ok(message)
}

pub(crate) fn outgoing_message_from_stored(
    message: &Message,
    attachment_paths: Vec<String>,
) -> OutgoingMessage {
    OutgoingMessage {
        from: Some(EmailAddress { name: Some(message.from_name.clone()), address: message.from_address.clone() }),
        to: message.to_list.clone(),
        cc: message.cc_list.clone(),
        bcc: message.bcc_list.clone(),
        subject: message.subject.clone(),
        body_text: message.body_text.clone(),
        body_html: if message.body_html_raw.is_empty() {
            None
        } else {
            Some(message.body_html_raw.clone())
        },
        in_reply_to: message.in_reply_to.clone(),
        attachment_paths,
        message_id: message.message_id_header.clone(),
    }
}

pub(crate) fn load_smtp_config(
    store: &Store,
    crypto: &CryptoService,
    account_id: &str,
) -> std::result::Result<SmtpConfig, PebbleError> {
    let encrypted = store.get_auth_data(account_id)?.ok_or_else(|| {
        PebbleError::Internal(format!("No auth data found for account {account_id}"))
    })?;
    let decrypted = crypto.decrypt(&encrypted)?;
    let config: serde_json::Value = serde_json::from_slice(&decrypted)
        .map_err(|e| PebbleError::Internal(format!("Failed to parse decrypted config: {e}")))?;

    let mut smtp_config: SmtpConfig = serde_json::from_value(
        config
            .get("smtp")
            .cloned()
            .ok_or_else(|| PebbleError::Internal("No SMTP config in auth data".to_string()))?,
    )
    .map_err(|e| PebbleError::Internal(format!("Failed to deserialize SMTP config: {e}")))?;

    let proxy_mode = account_proxy_mode_from_auth_value(&config);
    smtp_config.proxy = resolve_mail_proxy_from_mode(crypto, store, proxy_mode, smtp_config.proxy)?;

    Ok(smtp_config)
}

pub(crate) async fn send_imap_smtp_message(
    state: &AppState,
    account: &Account,
    outgoing: &OutgoingMessage,
) -> std::result::Result<(String, SentBody), PebbleError> {
    let smtp_config = load_smtp_config(&state.store, &state.crypto, &account.id)?;

    let sender = SmtpSender::new(
        smtp_config.host,
        smtp_config.port,
        smtp_config.username,
        smtp_config.password,
        smtp_config.security,
        smtp_config.accept_invalid_certs,
        smtp_config.proxy,
    );

    let to = outgoing
        .to
        .iter()
        .map(|addr| addr.address.clone())
        .collect::<Vec<_>>();
    let cc = outgoing
        .cc
        .iter()
        .map(|addr| addr.address.clone())
        .collect::<Vec<_>>();
    let bcc = outgoing
        .bcc
        .iter()
        .map(|addr| addr.address.clone())
        .collect::<Vec<_>>();

    // 生成真实 Message-ID（<时间戳-随机@发件域>），SMTP 头部与本地"已发送"
    // 副本共用同一值，保证同步去重能按 Message-ID 匹配，避免已发送重复两封。
    let domain = account
        .email
        .rsplit_once('@')
        .map(|(_, d)| d.to_string())
        .unwrap_or_else(|| "localhost".to_string());
    let message_id = outgoing.message_id.clone()
        .unwrap_or_else(|| format!("<{}-{}@{}>", now_timestamp(), new_id(), domain));

    let frozen_from = outgoing.from.clone().unwrap_or(EmailAddress { name: Some(account.display_name.clone()), address: account.email.clone() });
    let from_header = pebble_mail::sender::sender_mailbox(&frozen_from)?.to_string();
    let sent_body = tokio::time::timeout(std::time::Duration::from_secs(60), sender
        .send(
            &from_header,
            &to,
            &cc,
            &bcc,
            &outgoing.subject,
            &outgoing.body_text,
            outgoing.body_html.as_deref(),
            outgoing.in_reply_to.as_deref(),
            &outgoing.attachment_paths,
            Some(&message_id),
        )
        ).await.map_err(|_| PebbleError::Network("SMTP 提交超时，发送结果未确认；请先核对已发送或收件方，不要直接重复发送".into()))??;

    Ok((message_id, sent_body))
}

/// Promote the SAME queued message, rather than creating a second Sent row.
pub(crate) fn finalize_queued_smtp_send(
    store: &Store, original: &Message, message_id: String, body: &SentBody,
    attachments_dir: &Path,
) -> Result<(), PebbleError> {
    let sent = ensure_local_outgoing_folder(store, &original.account_id, LocalOutgoingState::Sent)?;
    let mut message = original.clone();
    message.remote_id = format!("local-sent-{}", original.id);
    message.message_id_header = Some(message_id);
    message.body_html_raw = body.html.clone().unwrap_or_default();
    message.updated_at = now_timestamp();
    message.date = now_timestamp();
    let mut attachments = store.list_attachments_by_message(&original.id)?;
    let new_inline = stage_inline_image_records(attachments_dir, &original.id, &body.inline_images)?;
    attachments.retain(|a| !new_inline.iter().any(|b| a.content_id.is_some() && a.content_id == b.content_id));
    attachments.extend(new_inline);
    message.has_attachments = !attachments.is_empty();
    store.replace_message_with_attachments(&message, &[sent.id], &attachments)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendEmailResult {
    pub status: &'static str,
    pub operation_id: Option<String>,
    pub warning: Option<String>,
}

impl SendEmailResult {
    pub(crate) fn sent(warning: Option<String>) -> Self { Self { status: "sent", operation_id: None, warning } }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn send_email(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    account_id: String,
    to: Vec<String>,
    cc: Vec<String>,
    bcc: Vec<String>,
    subject: String,
    body_text: String,
    body_html: Option<String>,
    in_reply_to: Option<String>,
    attachment_paths: Option<Vec<String>>,
) -> std::result::Result<SendEmailResult, PebbleError> {
    let identity_guard = state.account_identity_lock.lock().await;
    let raw_paths = attachment_paths.unwrap_or_default();
    let attachment_paths = if raw_paths.is_empty() {
        raw_paths
    } else {
        validate_attachment_paths(&raw_paths, &state.attachments_dir)?
    };
    let account = state
        .store
        .get_account(&account_id)?
        .ok_or_else(|| PebbleError::Internal(format!("Account not found: {account_id}")))?;

    let outgoing = OutgoingMessage {
        from: Some(super::sender_identity::configured_sender(&state.store, &account)?),
        to: parse_recipients(to.clone()),
        cc: parse_recipients(cc.clone()),
        bcc: parse_recipients(bcc.clone()),
        subject: subject.clone(),
        body_text: body_text.clone(),
        body_html: body_html.clone(),
        in_reply_to: in_reply_to.clone(),
        attachment_paths: attachment_paths.clone(),
        message_id: Some(format!("<{}-{}@{}>", now_timestamp(), new_id(), account.email.rsplit_once('@').map(|(_, d)| d).unwrap_or("localhost"))),
    };

    if outgoing.to.is_empty() { return Err(PebbleError::Validation("至少需要一位收件人".into())); }
    // OAuth APIs already own their Sent copy. Preserve that existing path:
    // Graph sendMail does not return a message ID, so fabricating a second
    // local Sent identity here would introduce duplicates on the next sync.
    if matches!(account.provider,ProviderType::Gmail|ProviderType::Outlook) {
        super::sender_identity::verify_oauth_sender(&state, &account).await?;
        let provider_name=if account.provider==ProviderType::Gmail {"gmail"} else {"outlook"};
        let auth=ensure_account_oauth_auth(&state,&account_id,provider_name).await?;
        let result=match account.provider {
            ProviderType::Gmail=>GmailProvider::new_with_proxy(auth.tokens.access_token,auth.proxy)?.send_message(&outgoing).await,
            ProviderType::Outlook=>OutlookProvider::new_with_proxy(auth.tokens.access_token,account_id.clone(),auth.proxy)?.send_message(&outgoing).await,
            _=>unreachable!(),
        };
        if let Err(error)=result {
            if !matches!(error,PebbleError::Network(_)) {return Err(error);}
            let saved=save_outgoing_message_locally(&state.store,&account,&outgoing,LocalOutgoingState::Queued,&state.attachments_dir,&[])?;
            let warning=format!("发送失败或结果未确认，自动重试已暂停；请核对已发送或收件方后再处理。原因：{error}");
            let id=state.store.insert_held_send(&account.id,&saved.id,
                &serde_json::json!({"provider_account_id":account.id,"remote_id":saved.remote_id,"op":"send","payload":{}}).to_string(),&warning)?;
            let _=app.emit(events::MAIL_PENDING_OPS_CHANGED,());
            return Ok(SendEmailResult{status:"queued",operation_id:Some(id),warning:Some(warning)});
        }
        return Ok(SendEmailResult::sent(None));
    }
    // Body, attachments, Message-ID and ownership are durable before any
    // SMTP call. Immediate SMTP and queued recovery share the same pipeline.
    let saved = save_outgoing_message_locally(&state.store, &account, &outgoing,
        LocalOutgoingState::Queued, &state.attachments_dir, &[])?;
    let operation = state.store.begin_immediate_send(&account.id, &saved.id,
        &serde_json::json!({"provider_account_id":account.id,"remote_id":saved.remote_id,"op":"send","payload":{}}).to_string())?;
    drop(identity_guard); // replay obtains the same guard and rechecks the frozen identity
    Ok(super::pending_mail_ops::submit_claimed_send(&state, &operation, &app).await)
}

/// Persist an outgoing message and let the existing reliable pending-op
/// worker submit it once the requested local timestamp has arrived.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn schedule_email(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    account_id: String,
    to: Vec<String>,
    cc: Vec<String>,
    bcc: Vec<String>,
    subject: String,
    body_text: String,
    body_html: Option<String>,
    in_reply_to: Option<String>,
    attachment_paths: Option<Vec<String>>,
    send_at: i64,
) -> std::result::Result<String, PebbleError> {
    let _identity_guard = state.account_identity_lock.lock().await;
    if send_at <= now_timestamp() + 5 {
        return Err(PebbleError::Validation("定时发送时间必须至少晚于当前 5 秒".to_string()));
    }
    let raw_paths = attachment_paths.unwrap_or_default();
    let attachment_paths = if raw_paths.is_empty() {
        raw_paths
    } else {
        validate_attachment_paths(&raw_paths, &state.attachments_dir)?
    };
    let account = state
        .store
        .get_account(&account_id)?
        .ok_or_else(|| PebbleError::Internal(format!("Account not found: {account_id}")))?;
    let outgoing = OutgoingMessage {
        from: Some(super::sender_identity::configured_sender(&state.store, &account)?),
        to: parse_recipients(to),
        cc: parse_recipients(cc),
        bcc: parse_recipients(bcc),
        subject,
        body_text,
        body_html,
        in_reply_to,
        attachment_paths,
        message_id: None,
    };
    if outgoing.to.is_empty() {
        return Err(PebbleError::Validation("至少需要一位收件人".to_string()));
    }
    let message = save_outgoing_message_and_refresh_search(
        &state,
        &account,
        &outgoing,
        LocalOutgoingState::Queued,
        &state.attachments_dir,
        &[],
    )?;
    let op_id = state.store.insert_pending_mail_op_at(
        &account_id,
        &message.id,
        "send",
        &serde_json::json!({
            "provider_account_id": account_id,
            "remote_id": message.remote_id,
            "op": "send",
            "payload": { "scheduled_at": send_at },
        }).to_string(),
        send_at,
    )?;
    let _ = app.emit(events::MAIL_PENDING_OPS_CHANGED, ());
    Ok(op_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::messages::refresh_search_document_with_store;
    use pebble_core::{now_timestamp, Account, FolderRole, ProviderType};
    use pebble_search::TantivySearch;
    use pebble_store::Store;

    fn test_account() -> Account {
        Account {
            id: "account-1".to_string(),
            email: "sender@example.com".to_string(),
            display_name: "Sender".to_string(),
            color: None,
            provider: ProviderType::Imap,
            created_at: now_timestamp(),
            updated_at: now_timestamp(),
        }
    }

    fn outgoing_message() -> OutgoingMessage {
        OutgoingMessage {
            from: None,
            to: vec![EmailAddress {
                name: None,
                address: "to@example.com".to_string(),
            }],
            cc: vec![],
            bcc: vec![],
            subject: "Queued subject".to_string(),
            body_text: "Plain body".to_string(),
            body_html: Some("<p>HTML body</p>".to_string()),
            in_reply_to: Some("<parent@example.com>".to_string()),
            attachment_paths: vec![],
            message_id: None,
        }
    }

    fn temp_attachments_dir(prefix: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("{prefix}-{}", new_id()))
    }

    #[test]
    fn sent_message_is_saved_to_local_sent_folder_after_send_success() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let attachments_dir = temp_attachments_dir("pebble-sent-attachments");

        let saved = save_outgoing_message_locally(
            &store,
            &account,
            &outgoing_message(),
            LocalOutgoingState::Sent,
            &attachments_dir,
            &[],
        )
        .unwrap();

        let sent = store
            .find_folder_by_role(&account.id, FolderRole::Sent)
            .unwrap()
            .expect("sent folder should be created");
        let folder_ids = store.get_message_folder_ids(&saved.id).unwrap();
        let reloaded = store.get_message(&saved.id).unwrap().unwrap();

        assert_eq!(folder_ids, vec![sent.id]);
        assert_eq!(reloaded.from_address, account.email);
        assert_eq!(reloaded.subject, "Queued subject");
        assert!(reloaded.remote_id.starts_with("local-sent-"));
        assert!(reloaded.is_read);
        assert!(!reloaded.is_draft);

        let _ = std::fs::remove_dir_all(attachments_dir);
    }

    #[test]
    fn retried_smtp_success_promotes_one_message_with_stable_id_and_inline_content() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account(); store.insert_account(&account).unwrap();
        let dir = temp_attachments_dir("pebble-retry-once");
        let saved = save_outgoing_message_locally(&store, &account, &outgoing_message(), LocalOutgoingState::Queued, &dir, &[]).unwrap();
        let outgoing = outgoing_message_from_stored(&saved, vec![]);
        assert_eq!(outgoing.message_id, saved.message_id_header);
        let body = SentBody { html: Some("<img src=\"cid:test-inline\">".into()), inline_images: vec![InlineImageData { content_id: "test-inline".into(), mime_type: "image/png".into(), bytes: vec![1,2,3] }] };
        finalize_queued_smtp_send(&store, &saved, "<stable@example.test>".into(), &body, &dir).unwrap();
        let current = store.get_message(&saved.id).unwrap().unwrap();
        assert_eq!(current.message_id_header.as_deref(), Some("<stable@example.test>"));
        assert_eq!(current.body_html_raw, body.html.unwrap());
        assert_eq!(store.list_attachments_by_message(&saved.id).unwrap().len(), 1);
        let sent = store.find_folder_by_role(&account.id, FolderRole::Sent).unwrap().unwrap();
        assert_eq!(store.get_message_folder_ids(&saved.id).unwrap(), vec![sent.id]);
        assert_eq!(store.list_message_ids_by_account(&account.id).unwrap(), vec![saved.id.clone()]);
        // Only the test-created inline file is removed; no real profile paths.
        std::fs::remove_file(dir.join(&saved.id).join("inline-0.png")).unwrap();
        std::fs::remove_dir(dir.join(&saved.id)).unwrap(); std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn failed_send_is_saved_to_local_outbox_folder_for_retry() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let attachments_dir = temp_attachments_dir("pebble-outbox-attachments");

        let saved = save_outgoing_message_locally(
            &store,
            &account,
            &outgoing_message(),
            LocalOutgoingState::Queued,
            &attachments_dir,
            &[],
        )
        .unwrap();

        let outbox = store
            .find_folder_by_name(&account.id, "Outbox")
            .unwrap()
            .expect("outbox folder should be created");
        let folder_ids = store.get_message_folder_ids(&saved.id).unwrap();

        assert_eq!(outbox.remote_id, "__local_outbox__");
        assert!(outbox.role.is_none());
        assert_eq!(folder_ids, vec![outbox.id]);
        assert!(saved.remote_id.starts_with("local-outbox-"));

        let _ = std::fs::remove_dir_all(attachments_dir);
    }

    #[test]
    fn sender_identity_queue_is_frozen_and_reassignment_is_blocked() {
        let store=Store::open_in_memory().unwrap(); let account=test_account(); store.insert_account(&account).unwrap();
        store.update_account_with_sender(&account.id,&account.email,"Local label",None,Some("Public Team")).unwrap();
        let mut outgoing=outgoing_message(); outgoing.from=Some(super::super::sender_identity::configured_sender(&store,&account).unwrap());
        let dir=temp_attachments_dir("sender-identity");
        let saved=save_outgoing_message_locally(&store,&account,&outgoing,LocalOutgoingState::Queued,&dir,&[]).unwrap();
        store.update_account_with_sender(&account.id,&account.email,"Renamed",None,Some("New Team")).unwrap();
        let current=store.get_account(&account.id).unwrap().unwrap();
        super::super::sender_identity::validate_queued_sender(&current,&saved).unwrap();
        assert_eq!(outgoing_message_from_stored(&saved,vec![]).from.unwrap().name.as_deref(),Some("Public Team"));
        store.update_account(&account.id,"other@example.com","Renamed",None).unwrap();
        assert!(super::super::sender_identity::validate_queued_sender(&store.get_account(&account.id).unwrap().unwrap(),&saved).is_err());
        let mut wrong_owner=saved.clone(); wrong_owner.account_id="other-account".into();
        assert!(super::super::sender_identity::validate_queued_sender(&current,&wrong_owner).is_err());
        let mut legacy=saved; legacy.from_address.clear();
        assert!(super::super::sender_identity::validate_queued_sender(&current,&legacy).is_err());
    }

    #[test]
    fn locally_saved_outgoing_message_can_be_added_to_search_index() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let attachments_dir = temp_attachments_dir("pebble-outgoing-search");
        let search = TantivySearch::open_in_memory().unwrap();

        let saved = save_outgoing_message_locally(
            &store,
            &account,
            &outgoing_message(),
            LocalOutgoingState::Sent,
            &attachments_dir,
            &[],
        )
        .unwrap();
        refresh_search_document_with_store(&store, &search, &saved.id).unwrap();

        let hits = search.search("Queued", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message_id, saved.id);

        let _ = std::fs::remove_dir_all(attachments_dir);
    }

    #[test]
    fn locally_saved_outgoing_message_uses_staged_attachment_copy() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let base = temp_attachments_dir("pebble-outgoing-stage");
        let source_dir = base.join("source");
        let attachments_dir = base.join("attachments");
        std::fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("report.txt");
        std::fs::write(&source, b"payload").unwrap();

        let mut outgoing = outgoing_message();
        outgoing.attachment_paths = vec![source.to_string_lossy().to_string()];

        let saved = save_outgoing_message_locally(
            &store,
            &account,
            &outgoing,
            LocalOutgoingState::Queued,
            &attachments_dir,
            &[],
        )
        .unwrap();
        let attachments = store.list_attachments_by_message(&saved.id).unwrap();

        assert_eq!(attachments.len(), 1);
        let staged_path = attachments[0].local_path.as_ref().unwrap();
        assert_ne!(staged_path.as_str(), source.to_string_lossy().as_ref());
        assert!(std::path::Path::new(staged_path).starts_with(&attachments_dir));
        assert_eq!(std::fs::read(staged_path).unwrap(), b"payload");

        std::fs::remove_file(&source).unwrap();
        assert_eq!(std::fs::read(staged_path).unwrap(), b"payload");

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn compose_attachment_upload_stages_browser_file_bytes_under_attachments_dir() {
        let attachments_dir = temp_attachments_dir("pebble-compose-upload");
        let staged = stage_compose_attachment_bytes(
            &attachments_dir,
            "..\\quarterly:report?.txt",
            b"payload",
        )
        .unwrap();

        let canonical_attachments_dir = attachments_dir.canonicalize().unwrap();
        assert!(staged.starts_with(&canonical_attachments_dir));
        assert_eq!(std::fs::read(&staged).unwrap(), b"payload");
        assert_eq!(
            staged.file_name().and_then(|name| name.to_str()),
            Some("quarterly_report_.txt")
        );

        let _ = std::fs::remove_dir_all(attachments_dir);
    }

    #[test]
    fn staged_browser_attachment_preserves_original_filename_in_local_record() {
        let base = temp_attachments_dir("pebble-compose-upload-name");
        let attachments_dir = base.join("attachments");
        let staged =
            stage_compose_attachment_bytes(&attachments_dir, "report.pdf", b"payload").unwrap();

        let records = stage_local_attachment_records(
            &attachments_dir,
            "message-1",
            &[staged.to_string_lossy().to_string()],
        )
        .unwrap();

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].filename, "report.pdf");

        let _ = std::fs::remove_dir_all(base);
    }
}

pub(crate) fn stage_compose_attachment_bytes(
    attachments_dir: &Path,
    filename: &str,
    bytes: &[u8],
) -> std::result::Result<PathBuf, PebbleError> {
    let staging_dir = attachments_dir.join("compose_staging");
    std::fs::create_dir_all(&staging_dir).map_err(|e| {
        PebbleError::Internal(format!(
            "Failed to create compose attachment staging directory {}: {e}",
            staging_dir.display()
        ))
    })?;
    let canonical_staging_dir = staging_dir.canonicalize().map_err(|e| {
        PebbleError::Internal(format!(
            "Failed to resolve compose attachment staging directory {}: {e}",
            staging_dir.display()
        ))
    })?;
    let safe_filename = sanitize_stored_filename(filename);
    let staged_dir = canonical_staging_dir.join(new_id());
    std::fs::create_dir_all(&staged_dir).map_err(|e| {
        PebbleError::Internal(format!(
            "Failed to create compose attachment staging directory {}: {e}",
            staged_dir.display()
        ))
    })?;
    let staged_path = staged_dir.join(safe_filename);
    std::fs::write(&staged_path, bytes).map_err(|e| {
        PebbleError::Internal(format!(
            "Failed to stage compose attachment {}: {e}",
            staged_path.display()
        ))
    })?;
    Ok(staged_path)
}

#[tauri::command]
pub async fn stage_compose_attachment(
    state: State<'_, AppState>,
    filename: String,
    bytes: Vec<u8>,
) -> std::result::Result<String, PebbleError> {
    let staged = stage_compose_attachment_bytes(&state.attachments_dir, &filename, &bytes)?;
    Ok(staged.to_string_lossy().into_owned())
}
