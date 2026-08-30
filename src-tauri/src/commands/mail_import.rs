use crate::state::AppState;
use pebble_core::{new_id, Message, PebbleError};
use pebble_mail::{parser::{parse_raw_email, AttachmentData}, persist_message_attachments};
use serde::Serialize;
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};

static CANCELLED_IMPORTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cancelled_imports() -> &'static Mutex<HashSet<String>> {
    CANCELLED_IMPORTS.get_or_init(|| Mutex::new(HashSet::new()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailImportProgress {
    pub task_id: String,
    pub processed: usize,
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    pub current_file: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailImportReport {
    pub task_id: String,
    pub processed: usize,
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    pub cancelled: bool,
    pub errors: Vec<String>,
}

struct PendingImport {
    message: Message,
    attachments: Vec<AttachmentData>,
}

fn is_cancelled(task_id: &str) -> bool {
    cancelled_imports()
        .lock()
        .map(|items| items.contains(task_id))
        .unwrap_or(false)
}

fn imported_message(account_id: &str, parsed: &pebble_mail::parser::ParsedMessage, is_draft: bool) -> Message {
    let now = chrono::Utc::now().timestamp();
    let id = new_id();
    Message {
        id: id.clone(),
        account_id: account_id.to_string(),
        remote_id: format!("import:{id}"),
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
        is_read: true,
        is_starred: false,
        is_draft,
        date: if parsed.date > 0 { parsed.date } else { now },
        remote_version: Some("local-import".to_string()),
        is_deleted: false,
        deleted_at: None,
        created_at: now,
        updated_at: now,
    }
}

fn push_raw_message(
    raw: &[u8],
    account_id: &str,
    is_draft: bool,
    pending: &mut Vec<PendingImport>,
) -> Result<(), String> {
    let parsed = parse_raw_email(raw).map_err(|e| e.to_string())?;
    if parsed.subject.is_empty()
        && parsed.from_address.is_empty()
        && parsed.to_list.is_empty()
        && parsed.body_text.is_empty()
        && parsed.body_html.is_empty()
    {
        return Err("文件中没有可识别的邮件内容".to_string());
    }
    let message = imported_message(account_id, &parsed, is_draft);
    pending.push(PendingImport { message, attachments: parsed.attachments });
    Ok(())
}

fn flush_pending(
    state: &AppState,
    folder_id: &str,
    pending: &mut Vec<PendingImport>,
    report: &mut MailImportReport,
) -> Result<(), String> {
    if pending.is_empty() {
        return Ok(());
    }
    let headers: Vec<String> = pending
        .iter()
        .filter_map(|item| item.message.message_id_header.clone())
        .collect();
    let existing = state
        .store
        .get_existing_message_ids(&pending[0].message.account_id, &headers)
        .map_err(|e| e.to_string())?;
    let mut seen = HashSet::new();
    let mut accepted = Vec::new();
    for item in pending.drain(..) {
        let duplicate = item
            .message
            .message_id_header
            .as_ref()
            .is_some_and(|id| existing.contains(id) || !seen.insert(id.clone()));
        if duplicate {
            report.skipped += 1;
        } else {
            accepted.push(item);
        }
    }
    let rows: Vec<(Message, Vec<String>)> = accepted
        .iter()
        .map(|item| (item.message.clone(), vec![folder_id.to_string()]))
        .collect();
    state.store.insert_messages_batch(&rows).map_err(|e| e.to_string())?;
    for item in accepted {
        persist_message_attachments(
            &state.store,
            &state.attachments_dir,
            &item.message.id,
            item.attachments,
        );
        report.imported += 1;
    }
    Ok(())
}

fn import_mbox<F>(path: &Path, mut on_message: F) -> Result<(), String>
where
    F: FnMut(&[u8]) -> Result<(), String>,
{
    let file = File::open(path).map_err(|e| format!("无法打开文件：{e}"))?;
    let mut reader = BufReader::with_capacity(128 * 1024, file);
    let mut line = Vec::new();
    let mut message = Vec::new();
    let mut saw_separator = false;
    loop {
        line.clear();
        let count = reader.read_until(b'\n', &mut line).map_err(|e| format!("读取 MBOX 失败：{e}"))?;
        if count == 0 {
            break;
        }
        if line.starts_with(b"From ") {
            if saw_separator && !message.is_empty() {
                on_message(&message)?;
                message.clear();
            }
            saw_separator = true;
            continue;
        }
        if saw_separator {
            if line.starts_with(b">From ") {
                message.extend_from_slice(&line[1..]);
            } else {
                message.extend_from_slice(&line);
            }
        }
    }
    if saw_separator && !message.is_empty() {
        on_message(&message)?;
    }
    if !saw_separator {
        return Err("不是可识别的 MBOX 文件".to_string());
    }
    Ok(())
}

fn collect_eml_files(root: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else { return; };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_eml_files(&path, output);
        } else if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("eml")) {
            output.push(path);
        }
    }
}

#[tauri::command]
pub fn choose_mail_import_files() -> Vec<String> {
    rfd::FileDialog::new()
        .set_title("选择要导入的 EML 或 MBOX 邮件")
        .add_filter("邮件文件", &["eml", "mbox"])
        .pick_files()
        .unwrap_or_default()
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

#[tauri::command]
pub fn choose_eml_import_folder() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("选择包含 EML 邮件的文件夹")
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn cancel_mail_import(task_id: String) {
    if let Ok(mut items) = cancelled_imports().lock() {
        items.insert(task_id);
    }
}

#[tauri::command]
pub async fn import_mail_files(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    account_id: String,
    folder_id: String,
    paths: Vec<String>,
) -> Result<MailImportReport, PebbleError> {
    let folder = state
        .store
        .get_folder(&folder_id)?
        .ok_or_else(|| PebbleError::Validation("目标邮件夹不存在".to_string()))?;
    if folder.account_id != account_id {
        return Err(PebbleError::Validation("目标邮件夹不属于所选账户".to_string()));
    }
    let is_draft = folder.role == Some(pebble_core::FolderRole::Drafts);
    let state = state.inner().clone();
    let result_task_id = task_id.clone();
    tokio::task::spawn_blocking(move || {
        let mut report = MailImportReport {
            task_id: result_task_id.clone(),
            processed: 0,
            imported: 0,
            skipped: 0,
            failed: 0,
            cancelled: false,
            errors: Vec::new(),
        };
        let mut files = Vec::new();
        for raw_path in paths {
            let path = PathBuf::from(raw_path);
            if path.is_dir() {
                collect_eml_files(&path, &mut files);
            } else {
                files.push(path);
            }
        }
        let mut pending = Vec::with_capacity(100);
        for path in files {
            if is_cancelled(&result_task_id) {
                report.cancelled = true;
                break;
            }
            let current_file = path.file_name().and_then(|name| name.to_str()).unwrap_or("邮件文件").to_string();
            let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase();
            let mut process_raw = |raw: &[u8]| {
                report.processed += 1;
                match push_raw_message(raw, &account_id, is_draft, &mut pending) {
                    Ok(()) => {}
                    Err(error) => {
                        report.failed += 1;
                        if report.errors.len() < 100 {
                            report.errors.push(format!("{current_file}：{error}"));
                        }
                    }
                }
                if pending.len() >= 100 {
                    flush_pending(&state, &folder_id, &mut pending, &mut report)?;
                }
                let _ = app.emit("mail-import-progress", MailImportProgress {
                    task_id: result_task_id.clone(),
                    processed: report.processed,
                    imported: report.imported,
                    skipped: report.skipped,
                    failed: report.failed,
                    current_file: current_file.clone(),
                });
                if is_cancelled(&result_task_id) {
                    return Err("__cancelled__".to_string());
                }
                Ok(())
            };
            let file_result = if extension == "mbox" {
                import_mbox(&path, &mut process_raw)
            } else if extension == "eml" {
                std::fs::read(&path)
                    .map_err(|e| format!("无法读取文件：{e}"))
                    .and_then(|bytes| process_raw(&bytes))
            } else {
                Err("不支持的文件格式".to_string())
            };
            if let Err(error) = file_result {
                if error == "__cancelled__" {
                    report.cancelled = true;
                    break;
                }
                report.failed += 1;
                if report.errors.len() < 100 {
                    report.errors.push(format!("{current_file}：{error}"));
                }
            }
        }
        flush_pending(&state, &folder_id, &mut pending, &mut report)
            .map_err(PebbleError::Storage)?;
        if let Ok(mut items) = cancelled_imports().lock() {
            items.remove(&result_task_id);
        }
        Ok(report)
    })
    .await
    .map_err(|e| PebbleError::Internal(format!("导入任务异常结束：{e}")))?
}
