//! 邮件导出：把一封邮件重建为 .eml 文件。
//! - build_forward_eml：生成临时 .eml（用于"作为附件转发"）
//! - export_message_eml：弹保存对话框导出 .eml

use crate::state::AppState;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Body, Mailbox, MultiPart, SinglePart};
use pebble_core::{PebbleError, Result};
use tauri::State;

fn mailbox(name: &str, address: &str) -> Result<Mailbox> {
    let address = address
        .trim()
        .parse()
        .map_err(|e| PebbleError::Internal(format!("邮件地址无效 '{}': {e}", address.trim())))?;
    let name = name.trim();
    Ok(Mailbox::new((!name.is_empty()).then(|| name.to_string()), address))
}

fn plain_part(body: &str) -> SinglePart {
    SinglePart::builder().content_type(ContentType::TEXT_PLAIN).body(body.to_string())
}

fn message_body(msg: &pebble_core::Message) -> MultiPart {
    if msg.body_html_raw.trim().is_empty() {
        MultiPart::alternative().singlepart(plain_part(&msg.body_text))
    } else {
        MultiPart::alternative()
            .singlepart(plain_part(&msg.body_text))
            .singlepart(
                SinglePart::builder()
                    .content_type(ContentType::TEXT_HTML)
                    .body(msg.body_html_raw.clone()),
            )
    }
}

/// Rebuild a complete RFC822 message from the local MIME representation.
/// HTML, inline images and regular attachments are all retained.
fn build_eml(
    msg: &pebble_core::Message,
    attachments: &[pebble_core::Attachment],
) -> Result<Vec<u8>> {
    let mut builder = lettre::Message::builder()
        .from(mailbox(&msg.from_name, &msg.from_address)?)
        .subject(&msg.subject);
    if msg.date > 0 {
        builder = builder.date(
            std::time::UNIX_EPOCH + std::time::Duration::from_secs(msg.date as u64),
        );
    }
    if let Some(message_id) = msg.message_id_header.as_ref().filter(|id| !id.trim().is_empty()) {
        builder = builder.message_id(Some(message_id.clone()));
    }
    if let Some(in_reply_to) = msg.in_reply_to.as_ref().filter(|id| !id.trim().is_empty()) {
        builder = builder.in_reply_to(in_reply_to.clone());
    }
    if let Some(references) = msg.references_header.as_ref().filter(|id| !id.trim().is_empty()) {
        builder = builder.references(references.clone());
    }
    for address in &msg.to_list {
        builder = builder.to(mailbox(address.name.as_deref().unwrap_or(""), &address.address)?);
    }
    for address in &msg.cc_list {
        builder = builder.cc(mailbox(address.name.as_deref().unwrap_or(""), &address.address)?);
    }
    for address in &msg.bcc_list {
        builder = builder.bcc(mailbox(address.name.as_deref().unwrap_or(""), &address.address)?);
    }

    let mut mixed = MultiPart::mixed().multipart(message_body(msg));
    for attachment in attachments {
        let path = attachment.local_path.as_ref().ok_or_else(|| {
            PebbleError::Internal(format!("附件文件不可用：{}", attachment.filename))
        })?;
        let bytes = std::fs::read(path).map_err(|e| {
            PebbleError::Internal(format!("无法读取附件 {}：{e}", attachment.filename))
        })?;
        let content_type = ContentType::parse(&attachment.mime_type)
            .unwrap_or(ContentType::parse("application/octet-stream").expect("valid MIME"));
        let part = if attachment.is_inline {
            Attachment::new_inline(
                attachment.content_id.clone().unwrap_or_else(|| attachment.filename.clone()),
            )
            .body(Body::new(bytes), content_type)
        } else {
            Attachment::new(attachment.filename.clone()).body(Body::new(bytes), content_type)
        };
        mixed = mixed.singlepart(part);
    }
    builder
        .multipart(mixed)
        .map(|message| message.formatted())
        .map_err(|e| PebbleError::Internal(format!("生成 EML 失败：{e}")))
}

async fn load_message(
    state: &AppState,
    message_id: &str,
) -> Result<pebble_core::Message> {
    let store = state.store.clone();
    let id = message_id.to_string();
    tokio::task::spawn_blocking(move || store.get_message(&id))
        .await
        .map_err(|e| PebbleError::Internal(format!("读取邮件失败: {e}")))?
        .map_err(|e| PebbleError::Internal(format!("读取邮件失败: {e}")))?
        .ok_or_else(|| PebbleError::Internal("邮件不存在".to_string()))
}

/// 生成临时 .eml 文件（用于"作为附件转发"），返回文件绝对路径。
#[tauri::command]
pub async fn build_forward_eml(
    state: State<'_, AppState>,
    message_id: String,
) -> std::result::Result<String, PebbleError> {
    let msg = load_message(&state, &message_id).await?;
    let attachments = state.store.list_attachments_by_message(&message_id)?;
    let eml = build_eml(&msg, &attachments)?;
    let dir = std::env::temp_dir().join("pebble-forward");
    std::fs::create_dir_all(&dir)
        .map_err(|e| PebbleError::Internal(format!("创建临时目录失败: {e}")))?;
    let path = dir.join(format!("{}.eml", msg.id));
    std::fs::write(&path, eml)
        .map_err(|e| PebbleError::Internal(format!("写入临时文件失败: {e}")))?;
    Ok(path.to_string_lossy().to_string())
}

/// 弹保存对话框导出 .eml，返回保存路径。
#[tauri::command]
pub async fn export_message_eml(
    state: State<'_, AppState>,
    message_id: String,
) -> std::result::Result<String, PebbleError> {
    let msg = load_message(&state, &message_id).await?;
    let attachments = state.store.list_attachments_by_message(&message_id)?;
    let eml = build_eml(&msg, &attachments)?;
    let suggested = {
        let mut name = msg.subject.trim().replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
        if name.is_empty() {
            name = "邮件".to_string();
        }
        format!("{name}.eml")
    };
    let file = rfd::FileDialog::new()
        .set_title("导出邮件为 .eml")
        .set_file_name(&suggested)
        .add_filter("EML 邮件", &["eml"])
        .save_file();
    let Some(path) = file else {
        return Err(PebbleError::Validation("已取消".to_string()));
    };
    std::fs::write(&path, eml)
        .map_err(|e| PebbleError::Internal(format!("写入文件失败: {e}")))?;
    Ok(path.to_string_lossy().to_string())
}

/// 用系统默认程序打开本地文件（草稿附件查看用）。
#[tauri::command]
pub fn open_local_file(path: String) -> std::result::Result<(), String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    opener::open(&path).map_err(|e| format!("打开文件失败: {e}"))
}

/// 在系统文件管理器中定位文件（Windows: 资源管理器选中该文件；macOS: Finder 揭示）。
#[tauri::command]
pub fn show_in_folder(path: String) -> std::result::Result<(), String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    let p = std::path::Path::new(&path);
    let dir = p.parent().unwrap_or(p);
    let file_name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
    #[cfg(target_os = "windows")]
    {
        // Windows: explorer /select,"path" 打开父目录并选中文件
        let arg = if file_name.is_empty() {
            format!("\"{}\"", dir.display())
        } else {
            format!("/select,\"{}\"", p.display())
        };
        std::process::Command::new("explorer.exe")
            .arg(&arg)
            .spawn()
            .map_err(|e| format!("打开文件管理器失败: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("打开 Finder 失败: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        opener::open(dir).map_err(|e| format!("打开文件管理器失败: {e}"))?;
    }
    Ok(())
}

/// 读取本地文件并返回 base64（用于把附件插入邮件正文等场景）。
#[tauri::command]
pub fn read_file_as_base64(path: String) -> std::result::Result<String, String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}
