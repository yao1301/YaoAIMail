//! 邮件导出：把一封邮件重建为 .eml 文件。
//! - build_forward_eml：生成临时 .eml（用于"作为附件转发"）
//! - export_message_eml：弹保存对话框导出 .eml

use crate::state::AppState;
use pebble_core::{PebbleError, Result};
use std::fmt::Write;
use tauri::State;

fn address_str(name: &str, address: &str) -> String {
    let name = name.trim();
    let address = address.trim();
    if name.is_empty() {
        address.to_string()
    } else {
        format!("{name} <{address}>")
    }
}

/// Rebuild an RFC822 .eml from the stored message. Attachments are omitted
/// (body text kept) so forwarding stays lightweight; the original can always
/// be re-exported from the web client.
fn build_eml(msg: &pebble_core::Message) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "From: {}", address_str(&msg.from_name, &msg.from_address));
    if !msg.to_list.is_empty() {
        let tos: Vec<String> = msg
            .to_list
            .iter()
            .map(|a| address_str(a.name.as_deref().unwrap_or(""), &a.address))
            .collect();
        let _ = writeln!(out, "To: {}", tos.join(", "));
    }
    if !msg.cc_list.is_empty() {
        let ccs: Vec<String> = msg
            .cc_list
            .iter()
            .map(|a| address_str(a.name.as_deref().unwrap_or(""), &a.address))
            .collect();
        let _ = writeln!(out, "Cc: {}", ccs.join(", "));
    }
    if !msg.bcc_list.is_empty() {
        let bccs: Vec<String> = msg
            .bcc_list
            .iter()
            .map(|a| address_str(a.name.as_deref().unwrap_or(""), &a.address))
            .collect();
        let _ = writeln!(out, "Bcc: {}", bccs.join(", "));
    }
    let _ = writeln!(out, "Subject: {}", msg.subject);
    let _ = writeln!(out, "Date: {}", rfc2822_date(msg.date));
    if let Some(mid) = &msg.message_id_header {
        if !mid.trim().is_empty() {
            let _ = writeln!(out, "Message-ID: {}", mid.trim());
        }
    }
    if let Some(refs) = &msg.references_header {
        if !refs.trim().is_empty() {
            let _ = writeln!(out, "References: {}", refs.trim());
        }
    }
    let _ = writeln!(out, "MIME-Version: 1.0");
    let _ = writeln!(out, "Content-Type: text/plain; charset=utf-8");
    let _ = writeln!(out, "Content-Transfer-Encoding: 8bit");
    let _ = writeln!(out);
    let _ = writeln!(out, "{}", msg.body_text);
    out
}

fn rfc2822_date(ts: i64) -> String {
    use chrono::{DateTime, Utc};
    DateTime::<Utc>::from_timestamp(ts, 0)
        .map(|dt| dt.format("%a, %d %b %Y %H:%M:%S +0000").to_string())
        .unwrap_or_default()
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
    let eml = build_eml(&msg);
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
    let eml = build_eml(&msg);
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
