use crate::state::AppState;
use pebble_core::{Attachment, PebbleError};
use std::path::{Path, PathBuf};
use tauri::{Emitter, State};

fn attachment_relative_tail(stored_path: &Path) -> Option<PathBuf> {
    let components = stored_path.components().collect::<Vec<_>>();
    let marker = components.iter().position(|component| {
        component.as_os_str().to_string_lossy().eq_ignore_ascii_case("attachments")
    })?;
    let mut tail = PathBuf::new();
    for component in components.into_iter().skip(marker + 1) {
        match component {
            std::path::Component::Normal(value) => tail.push(value),
            _ => return None,
        }
    }
    (!tail.as_os_str().is_empty()).then_some(tail)
}

fn resolve_attachment_file(attachments_dir: &Path, stored_path: &str) -> Result<(PathBuf, bool), PebbleError> {
    let allowed_root = attachments_dir
        .canonicalize()
        .map_err(|error| PebbleError::Internal(format!("Attachment directory is unavailable: {error}")))?;
    let original = Path::new(stored_path);
    if let Ok(canonical) = original.canonicalize() {
        if canonical.starts_with(&allowed_root) && canonical.is_file() {
            return Ok((canonical, false));
        }
    }
    let tail = attachment_relative_tail(original)
        .ok_or_else(|| PebbleError::Internal("Attachment file not available: stored path cannot be relocated".to_string()))?;
    let relocated = allowed_root.join(tail).canonicalize()
        .map_err(|error| PebbleError::Internal(format!("Attachment file not available: {error}")))?;
    if !relocated.starts_with(&allowed_root) || !relocated.is_file() {
        return Err(PebbleError::Validation("Attachment path is outside the local attachment directory".to_string()));
    }
    Ok((relocated, true))
}

pub(crate) fn resolve_and_repair_attachment_path(state: &AppState, attachment: &Attachment) -> Result<PathBuf, PebbleError> {
    let stored_path = attachment.local_path.as_deref()
        .ok_or_else(|| PebbleError::Internal("Attachment file not available".to_string()))?;
    let (resolved, relocated) = resolve_attachment_file(&state.attachments_dir, stored_path)?;
    if relocated {
        state.store.update_attachment_local_path(&attachment.id, &resolved.to_string_lossy())?;
    }
    Ok(resolved)
}

fn is_windows_reserved_name(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_uppercase().as_str(),
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

/// Validate that save_to path is within a safe directory (user's home).
///
/// This is the security gate for attachment writes: it *rejects* suspicious
/// paths rather than normalizing them. The FE helper at `src/lib/sanitizeFilename.ts`
/// covers the complementary UX role of cleaning up suggested defaults; it is
/// not a substitute for this check. Keep the character sets below in sync with
/// the FE when they change.
fn validate_save_path(save_to: &str) -> Result<(), PebbleError> {
    let path = Path::new(save_to);
    let canonical = path
        .parent()
        .and_then(|p| p.canonicalize().ok())
        .ok_or_else(|| PebbleError::Internal("Invalid save directory".to_string()))?;

    // Ensure no path traversal components in the filename
    let filename = path
        .file_name()
        .ok_or_else(|| PebbleError::Internal("No filename specified".to_string()))?;
    let filename_str = filename.to_string_lossy();
    if filename_str.contains("..") || filename_str.contains('/') || filename_str.contains('\\') {
        return Err(PebbleError::Internal(
            "Invalid filename in save path".to_string(),
        ));
    }
    if filename_str.ends_with(' ') || filename_str.ends_with('.') {
        return Err(PebbleError::Validation(
            "Filename cannot end with a dot or space".to_string(),
        ));
    }
    if filename_str
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return Err(PebbleError::Validation(
            "Filename contains characters unsupported on Windows".to_string(),
        ));
    }
    if filename_str.chars().any(|c| (c as u32) < 0x20) {
        return Err(PebbleError::Validation(
            "Filename contains control characters".to_string(),
        ));
    }
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    if is_windows_reserved_name(stem) {
        return Err(PebbleError::Validation(
            "Filename is reserved on Windows".to_string(),
        ));
    }

    // Ensure parent directory actually exists and is absolute
    if !canonical.is_absolute() {
        return Err(PebbleError::Internal(
            "Save path must be absolute".to_string(),
        ));
    }

    Ok(())
}

fn copy_attachment_file_safely<F>(
    source: &Path,
    save_path: &Path,
    mut on_progress: F,
) -> Result<PathBuf, PebbleError>
where
    F: FnMut(u64, u64),
{
    use std::io::{Read, Write};

    let mut src_file = std::fs::File::open(source)
        .map_err(|e| PebbleError::Internal(format!("Failed to open source: {e}")))?;
    let total_bytes = src_file
        .metadata()
        .map_err(|e| PebbleError::Internal(format!("Failed to read file metadata: {e}")))?
        .len();

    let (actual_save_path, mut dst_file) = create_unique_target(save_path)?;

    let mut buf = [0u8; 8192];
    let mut bytes_copied: u64 = 0;
    let copy_result: std::result::Result<(), PebbleError> = (|| {
        loop {
            let n = src_file
                .read(&mut buf)
                .map_err(|e| PebbleError::Internal(format!("Read error: {e}")))?;
            if n == 0 {
                break;
            }
            dst_file
                .write_all(&buf[..n])
                .map_err(|e| PebbleError::Internal(format!("Write error: {e}")))?;
            bytes_copied += n as u64;
            on_progress(bytes_copied, total_bytes);
        }
        dst_file
            .sync_all()
            .map_err(|e| PebbleError::Internal(format!("Failed to flush file: {e}")))?;
        Ok(())
    })();

    if let Err(e) = copy_result {
        drop(dst_file);
        let _ = std::fs::remove_file(&actual_save_path);
        return Err(e);
    }

    Ok(actual_save_path)
}

fn create_unique_target(save_path: &Path) -> Result<(PathBuf, std::fs::File), PebbleError> {
    const MAX_UNIQUE_ATTEMPTS: u32 = 1000;

    for attempt in 0..MAX_UNIQUE_ATTEMPTS {
        let candidate = unique_save_path(save_path, attempt);
        // create_new refuses to follow or replace an existing target, including
        // a symlink planted after path validation and before the file is opened.
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(PebbleError::Internal(format!(
                    "Failed to create target file: {e}"
                )))
            }
        }
    }

    Err(PebbleError::Validation(
        "Could not choose an unused filename for attachment download".to_string(),
    ))
}

fn unique_save_path(save_path: &Path, attempt: u32) -> PathBuf {
    if attempt == 0 {
        return save_path.to_path_buf();
    }

    let parent = save_path.parent().unwrap_or_else(|| Path::new(""));
    let stem = save_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let extension = save_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();

    parent.join(format!("{stem} ({attempt}){extension}"))
}

pub(crate) fn sanitize_stored_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    if base == "." || base == ".." {
        return "attachment".to_string();
    }

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
    let trimmed = sanitized
        .trim()
        .trim_matches(|c: char| c == '.' || c == ' ');

    if trimmed.is_empty() {
        return "attachment".to_string();
    }

    let stem = Path::new(trimmed)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if is_windows_reserved_name(stem) {
        return "attachment".to_string();
    }

    trimmed.to_string()
}

pub(crate) fn stage_local_attachment_records(
    attachments_root: &Path,
    message_id: &str,
    source_paths: &[String],
) -> Result<Vec<Attachment>, PebbleError> {
    if source_paths.is_empty() {
        return Ok(Vec::new());
    }

    let message_dir = attachments_root.join(message_id);
    std::fs::create_dir_all(&message_dir).map_err(|e| {
        PebbleError::Internal(format!(
            "Failed to create local attachment directory {}: {e}",
            message_dir.display()
        ))
    })?;

    let mut records = Vec::with_capacity(source_paths.len());
    let canonical_message_dir = message_dir.canonicalize().map_err(|e| {
        PebbleError::Internal(format!(
            "Failed to resolve local attachment directory {}: {e}",
            message_dir.display()
        ))
    })?;
    for source in source_paths {
        let source_path = Path::new(source);
        let source_metadata = std::fs::metadata(source_path).map_err(|e| {
            PebbleError::Internal(format!(
                "Attachment source file not available: {source} ({e})"
            ))
        })?;
        if !source_metadata.is_file() {
            return Err(PebbleError::Validation(format!(
                "Attachment source is not a file: {source}"
            )));
        }

        let filename = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .map(sanitize_stored_filename)
            .unwrap_or_else(|| "attachment".to_string());
        let canonical_source = source_path.canonicalize().map_err(|e| {
            PebbleError::Internal(format!("Failed to resolve attachment source {source}: {e}"))
        })?;
        let staged_path = if canonical_source.starts_with(&canonical_message_dir) {
            canonical_source
        } else {
            let target = message_dir.join(&filename);
            copy_attachment_file_safely(source_path, &target, |_copied, _total| {})?
        };
        let size = std::fs::metadata(&staged_path)
            .map(|metadata| metadata.len().min(i64::MAX as u64) as i64)
            .unwrap_or(0);

        records.push(Attachment {
            id: pebble_core::new_id(),
            message_id: message_id.to_string(),
            filename,
            mime_type: "application/octet-stream".to_string(),
            size,
            local_path: Some(staged_path.to_string_lossy().to_string()),
            content_id: None,
            is_inline: false,
        });
    }

    Ok(records)
}

#[tauri::command]
pub async fn list_attachments(
    state: State<'_, AppState>,
    message_id: String,
) -> std::result::Result<Vec<Attachment>, PebbleError> {
    state.store.list_attachments_by_message(&message_id)
}

#[tauri::command]
pub async fn get_attachment_path(
    state: State<'_, AppState>,
    attachment_id: String,
) -> std::result::Result<Option<String>, PebbleError> {
    let Some(att) = state.store.get_attachment(&attachment_id)? else { return Ok(None); };
    Ok(Some(resolve_and_repair_attachment_path(&state, &att)?.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn get_attachment_drag_icon_path(
    state: State<'_, AppState>,
) -> std::result::Result<String, PebbleError> {
    let system_dir = state.attachments_dir.join(".system");
    std::fs::create_dir_all(&system_dir)
        .map_err(|error| PebbleError::Internal(format!("Cannot create attachment UI directory: {error}")))?;
    let icon_path = system_dir.join("drag-icon.png");
    if !icon_path.is_file() {
        std::fs::write(&icon_path, include_bytes!("../../icons/icon.png"))
            .map_err(|error| PebbleError::Internal(format!("Cannot create attachment drag icon: {error}")))?;
    }
    Ok(icon_path.to_string_lossy().to_string())
}

/// Read a previously downloaded attachment's raw bytes (used when dragging an
/// attachment into the AI writing context box). The file must live inside the
/// local attachments directory; returns its name, MIME type and raw bytes.
#[tauri::command]
pub async fn read_attachment_file(
    state: State<'_, AppState>,
    attachment_id: String,
) -> std::result::Result<serde_json::Value, PebbleError> {
    let attachment = state
        .store
        .get_attachment(&attachment_id)?
        .ok_or_else(|| PebbleError::Internal("Attachment not found".to_string()))?;
    let canonical = resolve_and_repair_attachment_path(&state, &attachment)?;
    let bytes = std::fs::read(&canonical)
        .map_err(|error| PebbleError::Internal(format!("Failed to read attachment: {error}")))?;
    Ok(serde_json::json!({
        "name": attachment.filename,
        "mime_type": attachment.mime_type,
        "bytes": bytes,
    }))
}

#[tauri::command]
pub async fn open_attachment(
    state: State<'_, AppState>,
    attachment_id: String,
) -> std::result::Result<(), PebbleError> {
    let attachment = state
        .store
        .get_attachment(&attachment_id)?
        .ok_or_else(|| PebbleError::Internal("Attachment not found".to_string()))?;
    let canonical = resolve_and_repair_attachment_path(&state, &attachment)?;
    opener::open(&canonical)
        .map_err(|error| PebbleError::Internal(format!("Failed to open attachment: {error}")))
}

#[tauri::command]
pub async fn download_attachment(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    attachment_id: String,
    save_to: String,
) -> std::result::Result<String, PebbleError> {
    let att = state
        .store
        .get_attachment(&attachment_id)?
        .ok_or_else(|| PebbleError::Internal("Attachment not found".to_string()))?;
    // Validate save path to prevent path traversal
    validate_save_path(&save_to)?;

    let source = resolve_and_repair_attachment_path(&state, &att)?.to_string_lossy().to_string();

    let att_id = attachment_id.clone();
    // Use spawn_blocking to avoid blocking the async executor on large files
    let actual_path_result = tokio::task::spawn_blocking(move || {
        let source_path = std::path::Path::new(&source);
        let save_path = std::path::Path::new(&save_to);
        copy_attachment_file_safely(source_path, save_path, |bytes_copied, total_bytes| {
            let _ = app.emit(
                "attachment:download-progress",
                serde_json::json!({
                    "attachment_id": att_id,
                    "bytes_copied": bytes_copied,
                    "total_bytes": total_bytes,
                }),
            );
        })
    })
    .await
    .map_err(|e| PebbleError::Internal(format!("Copy task failed: {e}")))?;

    let actual_path = match actual_path_result {
        Ok(path) => path,
        Err(e) => {
            tracing::warn!(
                attachment_id = %attachment_id,
                filename = %att.filename,
                error = %e,
                "Attachment download failed"
            );
            return Err(e);
        }
    };

    tracing::info!(
        attachment_id = %attachment_id,
        filename = %att.filename,
        save_path = %actual_path.display(),
        "Attachment downloaded"
    );

    Ok(actual_path.to_string_lossy().to_string())
}

fn resolve_local_attachment_paths(
    state: &AppState,
    attachment_ids: &[String],
) -> Result<Vec<(String, PathBuf)>, PebbleError> {
    if attachment_ids.is_empty() {
        return Err(PebbleError::Validation("未选择附件".to_string()));
    }
    attachment_ids
        .iter()
        .map(|id| {
            let attachment = state
                .store
                .get_attachment(id)?
                .ok_or_else(|| PebbleError::Internal("Attachment not found".to_string()))?;
            let canonical = resolve_and_repair_attachment_path(state, &attachment)?;
            Ok((sanitize_stored_filename(&attachment.filename), canonical))
        })
        .collect()
}

#[tauri::command]
pub async fn save_attachments_as(
    state: State<'_, AppState>,
    attachment_ids: Vec<String>,
) -> Result<Vec<String>, PebbleError> {
    let items = resolve_local_attachment_paths(&state, &attachment_ids)?;
    if items.len() == 1 {
        let (filename, source) = &items[0];
        let target = rfd::FileDialog::new()
            .set_file_name(filename)
            .save_file()
            .ok_or_else(|| PebbleError::Validation("已取消保存附件".to_string()))?;
        validate_save_path(&target.to_string_lossy())?;
        let saved = copy_attachment_file_safely(source, &target, |_copied, _total| {})?;
        return Ok(vec![saved.to_string_lossy().to_string()]);
    }

    let folder = rfd::FileDialog::new()
        .set_title("选择附件保存文件夹")
        .pick_folder()
        .ok_or_else(|| PebbleError::Validation("已取消保存附件".to_string()))?;
    let mut saved = Vec::with_capacity(items.len());
    for (filename, source) in items {
        let target = folder.join(filename);
        validate_save_path(&target.to_string_lossy())?;
        saved.push(copy_attachment_file_safely(&source, &target, |_copied, _total| {})?
            .to_string_lossy()
            .to_string());
    }
    Ok(saved)
}

#[cfg(windows)]
fn windows_shell_path(path: &Path) -> PathBuf {
    let display = path.to_string_lossy();
    if let Some(rest) = display.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = display.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

#[cfg(windows)]
fn copy_files_to_windows_clipboard(paths: &[PathBuf]) -> Result<(), PebbleError> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::System::Com::IDataObject;
    use windows::Win32::System::Ole::{OleFlushClipboard, OleInitialize, OleSetClipboard, OleUninitialize};
    use windows::Win32::UI::Shell::{
        Common::ITEMIDLIST, BHID_DataObject, ILCreateFromPathW, ILFree,
        SHCreateShellItemArrayFromIDLists,
    };

    // canonicalize() deliberately returns verbatim (\\?\) paths on Windows.
    // They are ideal for filesystem I/O but Shell PIDL parsing expects the
    // ordinary drive-letter or UNC spelling.
    let owned_paths = paths.iter().map(|path| windows_shell_path(path)).collect::<Vec<_>>();
    std::thread::spawn(move || -> Result<(), String> {
        unsafe { OleInitialize(None) }.map_err(|error| format!("无法初始化系统剪贴板：{error}"))?;

        let result = (|| -> Result<(), String> {
            let mut pidls: Vec<*mut ITEMIDLIST> = Vec::with_capacity(owned_paths.len());
            for path in &owned_paths {
                let wide = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<_>>();
                let pidl = unsafe { ILCreateFromPathW(PCWSTR::from_raw(wide.as_ptr())) };
                if pidl.is_null() {
                    for allocated in pidls.drain(..) {
                        unsafe { ILFree(Some(allocated)) };
                    }
                    return Err("Windows 无法识别附件文件路径".to_string());
                }
                pidls.push(pidl);
            }

            let pidl_refs = pidls.iter().map(|pidl| (*pidl).cast_const()).collect::<Vec<_>>();
            let shell_items = unsafe { SHCreateShellItemArrayFromIDLists(&pidl_refs) };
            for pidl in pidls {
                unsafe { ILFree(Some(pidl)) };
            }
            let shell_items = shell_items.map_err(|error| format!("无法创建 Windows 文件对象：{error}"))?;
            let data_object: IDataObject = unsafe { shell_items.BindToHandler(None, &BHID_DataObject) }
                .map_err(|error| format!("无法创建资源管理器剪贴板对象：{error}"))?;
            unsafe { OleSetClipboard(&data_object) }
                .map_err(|error| format!("无法写入系统剪贴板：{error}"))?;
            unsafe { OleFlushClipboard() }
                .map_err(|error| format!("无法保存系统剪贴板内容：{error}"))?;
            Ok(())
        })();

        unsafe { OleUninitialize() };
        result
    })
    .join()
    .map_err(|_| PebbleError::Internal("系统剪贴板线程异常退出".to_string()))?
    .map_err(PebbleError::Internal)
}

#[tauri::command]
pub async fn copy_attachments_to_clipboard(
    state: State<'_, AppState>,
    attachment_ids: Vec<String>,
) -> Result<(), PebbleError> {
    let items = resolve_local_attachment_paths(&state, &attachment_ids)?;
    #[cfg(windows)]
    { return copy_files_to_windows_clipboard(&items.into_iter().map(|(_, path)| path).collect::<Vec<_>>()); }
    #[cfg(not(windows))]
    {
        let _ = items;
        Err(PebbleError::Validation("当前系统暂不支持复制文件到系统剪贴板".to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn converts_verbatim_paths_for_windows_shell() {
        assert_eq!(windows_shell_path(Path::new(r"\\?\C:\TestData\attachments\file.pdf")), PathBuf::from(r"C:\TestData\attachments\file.pdf"));
        assert_eq!(windows_shell_path(Path::new(r"\\?\UNC\server\share\file.pdf")), PathBuf::from(r"\\server\share\file.pdf"));
    }

    #[test]
    fn relocates_an_attachment_from_an_old_profile_root() {
        let unique = pebble_core::new_id();
        let base = std::env::temp_dir().join(format!("pebble-attachment-relocate-{unique}"));
        let root = base.join("attachments");
        let actual = root.join("message-1").join("history.pdf");
        std::fs::create_dir_all(actual.parent().unwrap()).expect("attachment dir");
        std::fs::write(&actual, b"history").expect("attachment write");
        let old = PathBuf::from("D:\\OldProfile\\attachments\\message-1\\history.pdf");

        let (resolved, relocated) = resolve_attachment_file(&root, &old.to_string_lossy()).expect("relocate");

        assert!(relocated);
        assert_eq!(resolved, actual.canonicalize().unwrap());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn relocation_rejects_parent_directory_components() {
        let unique = pebble_core::new_id();
        let base = std::env::temp_dir().join(format!("pebble-attachment-traversal-{unique}"));
        let root = base.join("attachments");
        std::fs::create_dir_all(&root).expect("attachment dir");
        let old = PathBuf::from("D:\\OldProfile\\attachments\\..\\outside.txt");

        assert!(resolve_attachment_file(&root, &old.to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn copy_attachment_file_safely_uses_unique_target_when_requested_name_exists() {
        let unique = pebble_core::new_id();
        let base = std::env::temp_dir().join(format!("pebble-attachment-copy-{unique}"));
        std::fs::create_dir_all(&base).expect("test dir");
        let source = base.join("source.txt");
        let target = base.join("target.txt");
        std::fs::write(&source, b"new content").expect("source write");
        std::fs::write(&target, b"existing content").expect("target write");

        let actual = copy_attachment_file_safely(&source, &target, |_copied, _total| {})
            .expect("existing targets should get a unique filename");

        assert_eq!(
            std::fs::read(&target).expect("target read"),
            b"existing content"
        );
        assert_ne!(actual, target);
        assert_eq!(
            actual.file_name().and_then(|name| name.to_str()),
            Some("target (1).txt")
        );
        assert_eq!(
            std::fs::read(actual).expect("unique target read"),
            b"new content"
        );

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn stage_local_attachment_records_copies_sources_into_message_attachment_dir() {
        let unique = pebble_core::new_id();
        let base = std::env::temp_dir().join(format!("pebble-attachment-stage-{unique}"));
        let source_dir = base.join("source");
        let attachments_root = base.join("attachments");
        std::fs::create_dir_all(&source_dir).expect("source dir");
        let source = source_dir.join("report.txt");
        std::fs::write(&source, b"payload").expect("source write");

        let records = stage_local_attachment_records(
            &attachments_root,
            "message-1",
            &[source.to_string_lossy().to_string()],
        )
        .expect("local attachment should be staged");

        assert_eq!(records.len(), 1);
        let staged_path = records[0]
            .local_path
            .as_ref()
            .map(PathBuf::from)
            .expect("record should point at staged file");
        assert_ne!(staged_path, source);
        assert!(staged_path.starts_with(attachments_root.join("message-1")));
        assert_eq!(
            std::fs::read(&staged_path).expect("staged read"),
            b"payload"
        );

        std::fs::remove_file(&source).expect("remove original");
        let target = base.join("downloaded.txt");
        copy_attachment_file_safely(&staged_path, &target, |_copied, _total| {})
            .expect("download should use staged copy, not the original file");
        assert_eq!(std::fs::read(target).expect("downloaded read"), b"payload");

        let _ = std::fs::remove_dir_all(base);
    }
}
