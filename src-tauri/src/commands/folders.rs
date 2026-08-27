use crate::state::AppState;
use pebble_core::{new_id, Folder, FolderRole, FolderType, PebbleError, ProviderType};
use pebble_mail::should_hide_outlook_folder;
use serde::Serialize;
use std::collections::HashSet;
use tauri::State;
use tracing::{error, info};

#[derive(Debug, Clone, Serialize)]
pub struct ImapSyncFolderSettings {
    pub folders: Vec<Folder>,
    pub selected_remote_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BodyBackfillStat {
    pub account_id: String,
    /// 该账号还有多少封只有邮件头（正文+附件尚未下载到本地）。
    pub remaining: u32,
}

/// 各账号正文/附件下载进度（用于前端显示"全文下载中"提示）。
#[tauri::command]
pub async fn get_body_backfill_stats(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<BodyBackfillStat>, PebbleError> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || {
        let accounts = store.list_accounts()?;
        let mut out = Vec::new();
        for account in accounts {
            let remaining = store.count_header_only_messages(&account.id)?;
            out.push(BodyBackfillStat {
                account_id: account.id,
                remaining,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| PebbleError::Internal(format!("Task join error: {e}")))?
}

fn provider_folders_have_arrived(folders: &[Folder]) -> bool {
    folders
        .iter()
        .any(|folder| !folder.remote_id.starts_with("__local_"))
}

fn should_seed_local_archive(folders: &[Folder]) -> bool {
    let has_archive = folders
        .iter()
        .any(|folder| folder.role == Some(FolderRole::Archive));

    provider_folders_have_arrived(folders) && !has_archive
}

fn should_hide_stored_outlook_folder(folder: &Folder) -> bool {
    folder.role.is_none()
        && !folder.remote_id.starts_with("__local_")
        && should_hide_outlook_folder(Some(&folder.name), None)
}

fn filter_display_folders(provider: Option<&ProviderType>, folders: Vec<Folder>) -> Vec<Folder> {
    if !matches!(provider, Some(ProviderType::Outlook)) {
        return folders;
    }

    folders
        .into_iter()
        .filter(|folder| !should_hide_stored_outlook_folder(folder))
        .collect()
}

#[tauri::command]
pub async fn list_folders(
    state: State<'_, AppState>,
    account_id: String,
) -> std::result::Result<Vec<Folder>, PebbleError> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || {
        if let Err(error) = store.repair_folder_hierarchy_from_remote_ids(&account_id) {
            tracing::warn!(account_id = %account_id, %error, "Failed to repair local folder hierarchy");
        }
        let provider = store
            .get_account(&account_id)?
            .map(|account| account.provider);
        let folders = store.list_folders(&account_id)?;

        if !provider_folders_have_arrived(&folders) {
            return Ok(Vec::new());
        }

        // Ensure a local archive folder exists after provider folders have arrived.
        // During first OAuth sign-in, folders may still be syncing; returning an
        // empty list lets the sidebar keep its placeholder folders instead of
        // caching a misleading "Archive only" account.
        if should_seed_local_archive(&folders) {
            let archive = Folder {
                id: new_id(),
                account_id: account_id.clone(),
                remote_id: "__local_archive__".to_string(),
                name: "Archive".to_string(),
                folder_type: FolderType::Folder,
                role: Some(FolderRole::Archive),
                parent_id: None,
                color: None,
                is_system: true,
                sort_order: 3,
            };
            let _ = store.insert_folder(&archive);
            let folders = store.list_folders(&account_id)?;
            return Ok(filter_display_folders(provider.as_ref(), folders));
        }

        Ok(filter_display_folders(provider.as_ref(), folders))
    })
    .await
    .map_err(|e| PebbleError::Internal(format!("Task join error: {e}")))?
}

async fn discover_imap_folders(
    state: &AppState,
    account_id: &str,
) -> std::result::Result<Vec<Folder>, PebbleError> {
    let account = state
        .store
        .get_account(account_id)?
        .ok_or_else(|| PebbleError::Internal(format!("Account not found: {account_id}")))?;
    if account.provider != ProviderType::Imap {
        return Err(PebbleError::UnsupportedProvider(
            "Folder selection is currently available for IMAP accounts".to_string(),
        ));
    }

    let provider = crate::commands::messages::connect_imap(state, account_id).await?;
    let result = provider.list_folders(account_id).await;
    if let Err(error) = provider.disconnect().await {
        tracing::debug!(
            "Failed to disconnect IMAP folder discovery session for account {account_id}: {error}"
        );
    }
    result
}

fn selected_remote_ids_for_settings(
    folders: &[Folder],
    configured: Option<Vec<String>>,
) -> Vec<String> {
    let configured = configured.map(|ids| ids.into_iter().collect::<HashSet<_>>());
    folders
        .iter()
        .filter(|folder| {
            folder.role == Some(FolderRole::Inbox)
                || folder.remote_id.eq_ignore_ascii_case("INBOX")
                || configured
                    .as_ref()
                    .is_none_or(|selected| selected.contains(&folder.remote_id))
        })
        .map(|folder| folder.remote_id.clone())
        .collect()
}

#[tauri::command]
pub async fn get_imap_sync_folders(
    state: State<'_, AppState>,
    account_id: String,
) -> std::result::Result<ImapSyncFolderSettings, PebbleError> {
    let folders = discover_imap_folders(&state, &account_id).await?;
    let configured = state
        .store
        .get_sync_state(&account_id)?
        .and_then(|sync_state| sync_state.selected_imap_folder_remote_ids)
        .filter(|ids| !ids.is_empty());
    let selected_remote_ids = selected_remote_ids_for_settings(&folders, configured);

    Ok(ImapSyncFolderSettings {
        folders,
        selected_remote_ids,
    })
}

#[tauri::command]
pub async fn update_imap_sync_folders(
    state: State<'_, AppState>,
    account_id: String,
    selected_remote_ids: Vec<String>,
) -> std::result::Result<ImapSyncFolderSettings, PebbleError> {
    // Refresh LIST when saving as well as when opening the picker. This avoids
    // persisting stale or fabricated remote IDs when the server changed while
    // the account dialog was open.
    let folders = discover_imap_folders(&state, &account_id).await?;
    let available_remote_ids: HashSet<&str> = folders
        .iter()
        .map(|folder| folder.remote_id.as_str())
        .collect();
    let unknown_remote_ids: Vec<&str> = selected_remote_ids
        .iter()
        .map(String::as_str)
        .filter(|remote_id| !available_remote_ids.contains(remote_id))
        .collect();
    if !unknown_remote_ids.is_empty() {
        return Err(PebbleError::Validation(format!(
            "Unknown IMAP folders: {}",
            unknown_remote_ids.join(", ")
        )));
    }

    let requested: HashSet<&str> = selected_remote_ids.iter().map(String::as_str).collect();
    let effective_selected_remote_ids: Vec<String> = folders
        .iter()
        .filter(|folder| {
            folder.role == Some(FolderRole::Inbox)
                || folder.remote_id.eq_ignore_ascii_case("INBOX")
                || requested.contains(folder.remote_id.as_str())
        })
        .map(|folder| folder.remote_id.clone())
        .collect();
    if !folders.iter().any(|folder| {
        folder.role == Some(FolderRole::Inbox) || folder.remote_id.eq_ignore_ascii_case("INBOX")
    }) {
        return Err(PebbleError::Validation(
            "The IMAP server did not return an Inbox folder".to_string(),
        ));
    }

    let store = state.store.clone();
    let account_id_for_store = account_id.clone();
    let folders_for_store = folders.clone();
    let selected_for_store = effective_selected_remote_ids.clone();
    let change = tokio::task::spawn_blocking(move || {
        store.apply_imap_folder_selection(
            &account_id_for_store,
            &folders_for_store,
            &selected_for_store,
        )
    })
    .await
    .map_err(|error| PebbleError::Internal(format!("Task join error: {error}")))??;

    if let Err(error) =
        crate::commands::messages::refresh_search_documents(&state, &change.affected_message_ids)
    {
        tracing::warn!(
            "Failed to refresh search documents after changing IMAP folders for account {account_id}: {error}"
        );
    }

    let attachments_dir = state.attachments_dir.clone();
    let deleted_message_ids = change.deleted_message_ids;
    if let Err(error) = tokio::task::spawn_blocking(move || {
        for message_id in deleted_message_ids {
            let message_dir = attachments_dir.join(&message_id);
            if message_dir.exists() {
                if let Err(error) = std::fs::remove_dir_all(&message_dir) {
                    tracing::warn!(
                        "Failed to remove attachments for deselected-folder message {message_id}: {error}"
                    );
                }
            }
        }
    })
    .await
    {
        tracing::warn!(
            "Attachment cleanup task failed after changing IMAP folders for account {account_id}: {error}"
        );
    }

    Ok(ImapSyncFolderSettings {
        folders,
        selected_remote_ids: effective_selected_remote_ids,
    })
}

fn validate_custom_folder_name(name: &str) -> std::result::Result<(), PebbleError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(PebbleError::Validation("文件夹名称不能为空".to_string()));
    }
    if name.contains('/') {
        return Err(PebbleError::Validation(
            "文件夹名称不能包含 / 字符".to_string(),
        ));
    }
    Ok(())
}

/// Create a new mailbox on the IMAP server and register it locally.
/// POP3 / 其他无服务器文件夹概念的账号：创建仅本地的文件夹（用于本地整理，
/// 不同步服务器，remote_id 以 `__local_` 开头，同步 reconcile 会跳过）。
/// `parent_folder_id` 可选：传入则在父文件夹下创建子文件夹
/// （IMAP 服务器路径为 `父路径/名称`，如 Trash/111 式层级；本地则记 parent_id）。
#[tauri::command]
pub async fn create_folder(
    state: State<'_, AppState>,
    account_id: String,
    name: String,
    parent_folder_id: Option<String>,
) -> std::result::Result<Folder, PebbleError> {
    info!(
        account_id = %account_id, name = %name, parent = ?parent_folder_id,
        "create_folder: received"
    );
    validate_custom_folder_name(&name)?;
    let account = state
        .store
        .get_account(&account_id)?
        .ok_or_else(|| PebbleError::Internal(format!("Account not found: {account_id}")))?;
    let name = name.trim().to_string();

    // 解析父文件夹并校验归属
    let parent = match parent_folder_id {
        Some(parent_id) => {
            let parent = state.store.get_folder(&parent_id)?.ok_or_else(|| {
                PebbleError::Validation("父文件夹不存在或已被删除".to_string())
            })?;
            if parent.account_id != account_id {
                return Err(PebbleError::Validation(
                    "父文件夹不属于当前账号".to_string(),
                ));
            }
            Some(parent)
        }
        None => None,
    };

    let is_imap = account.provider == ProviderType::Imap;
    let folder = if is_imap {
        // 服务器上的层级路径：子文件夹 = 父 remote_id + "/" + 名称（Trash/111 式）
        let remote_id = match &parent {
            Some(parent) => format!("{}/{}", parent.remote_id, name),
            None => name.clone(),
        };
        let provider = crate::commands::messages::connect_imap(&state, &account_id).await?;
        info!(
            account_id = %account_id, remote_id = %remote_id,
            "create_folder: IMAP connected, sending CREATE"
        );
        provider.create_folder(&remote_id).await.map_err(|err| {
            error!(
                account_id = %account_id, remote_id = %remote_id, error = %err,
                "create_folder: IMAP CREATE failed"
            );
            err
        })?;
        info!(account_id = %account_id, remote_id = %remote_id, "create_folder: IMAP CREATE ok");
        if let Err(error) = provider.disconnect().await {
            tracing::debug!(
                "Failed to disconnect IMAP session after creating folder for account {account_id}: {error}"
            );
        }
        Folder {
            id: new_id(),
            account_id: account_id.clone(),
            remote_id,
            name,
            folder_type: FolderType::Folder,
            role: None,
            parent_id: parent.map(|item| item.id),
            color: None,
            is_system: false,
            sort_order: 100,
        }
    } else {
        // POP3 等账号：无服务器文件夹，创建本地文件夹（仅本机整理用）。
        let local_id = new_id();
        info!(
            account_id = %account_id, name = %name,
            "create_folder: non-IMAP account, creating local folder"
        );
        Folder {
            id: local_id.clone(),
            account_id: account_id.clone(),
            remote_id: format!("__local_{local_id}"),
            name,
            folder_type: FolderType::Folder,
            role: None,
            parent_id: parent.map(|item| item.id),
            color: None,
            is_system: false,
            sort_order: 100,
        }
    };
    state.store.insert_folder(&folder)?;
    info!(account_id = %account_id, folder_id = %folder.id, "create_folder: saved locally");
    Ok(folder)
}

/// Move a custom folder: change its level (new_parent_folder_id) and its
/// position among siblings (after_folder_id). Works for both IMAP and POP3
/// local folders:
/// - IMAP remote folders are RENAMEd on the server to the new hierarchical
///   path (parent path + short name), so the change is not overwritten by the
///   next folder discovery.
/// - POP3 / local (`__local_*`) folders only update the local database.
/// Guards against cycles (cannot drop a folder into itself or its own
/// descendants). Returns the account's full folder list for the frontend.
#[tauri::command]
pub async fn move_folder(
    state: State<'_, AppState>,
    account_id: String,
    folder_id: String,
    new_parent_folder_id: Option<String>,
    after_folder_id: Option<String>,
) -> std::result::Result<Vec<Folder>, PebbleError> {
    let mut folder = state
        .store
        .get_folder(&folder_id)?
        .ok_or_else(|| PebbleError::Validation("文件夹不存在或已被删除".to_string()))?;
    if folder.account_id != account_id {
        return Err(PebbleError::Validation("文件夹不属于当前账号".to_string()));
    }
    if folder.role.is_some() || folder.is_system {
        return Err(PebbleError::Validation("系统文件夹不能移动".to_string()));
    }
    // A same-parent drag changes only this client's presentation order.
    // IMAP has no standard command for persisting mailbox display order, so
    // this path must not perform LIST/RENAME or let LIST overwrite it later.
    let hierarchy_change_requested = folder.parent_id != new_parent_folder_id;

    let account = state.store.get_account(&account_id)?.ok_or_else(|| {
        PebbleError::Internal(format!("Account not found: {account_id}"))
    })?;

    // Reconcile before validating cycles. If the previous drag already
    // succeeded on the server but the local tree was stale, validating first
    // would incorrectly reject the retry as a move into its own descendant.
    if hierarchy_change_requested
        && account.provider == ProviderType::Imap
        && !folder.remote_id.starts_with("__local_")
    {
        let provider = crate::commands::messages::connect_imap(&state, &account_id).await?;
        match provider.list_folders(&account_id).await {
            Ok(remote_folders) if !remote_folders.is_empty() => {
                state
                    .store
                    .reconcile_remote_folder_tree(&account_id, &remote_folders)?;
                folder = state
                    .store
                    .get_folder(&folder_id)?
                    .ok_or_else(|| PebbleError::Validation("拖动的文件夹已被服务器更新，请刷新后重试".to_string()))?;
            }
            Ok(_) => {
                tracing::warn!(account_id = %account_id, "move_folder: preflight server LIST was empty; using local tree conservatively");
            }
            Err(error) => {
                tracing::warn!(account_id = %account_id, %error, "move_folder: preflight server LIST failed; using local tree conservatively");
            }
        }
        let _ = provider.disconnect().await;
    }

    // Preflight reconciliation may reveal that an idempotent retry already
    // has the requested parent on the server.
    let hierarchy_changed = folder.parent_id != new_parent_folder_id;

    // 解析新父文件夹 + 防环（不能拖到自己或自己的子孙下面）
    let new_parent = match &new_parent_folder_id {
        Some(parent_id) => {
            let parent = state.store.get_folder(parent_id)?.ok_or_else(|| {
                PebbleError::Validation("目标文件夹不存在或已被删除".to_string())
            })?;
            if parent.account_id != account_id {
                return Err(PebbleError::Validation(
                    "目标文件夹不属于当前账号".to_string(),
                ));
            }
            if parent.id == folder.id {
                return Err(PebbleError::Validation(
                    "不能把文件夹拖到自身下面".to_string(),
                ));
            }
            if is_folder_descendant(&state, &parent.id, &folder.id)? {
                return Err(PebbleError::Validation(
                    "不能把文件夹拖到自己的子文件夹下面".to_string(),
                ));
            }
            Some(parent)
        }
        None => None,
    };

    // after 位置校验：必须与目标层级同级，且不是被拖文件夹自己
    if let Some(after_id) = &after_folder_id {
        if after_id == &folder_id {
            return Err(PebbleError::Validation("插入位置无效".to_string()));
        }
        let after = state.store.get_folder(after_id)?.ok_or_else(|| {
            PebbleError::Validation("插入位置文件夹不存在".to_string())
        })?;
        if after.account_id != account_id || after.parent_id != new_parent_folder_id {
            return Err(PebbleError::Validation(
                "插入位置与目标层级不一致".to_string(),
            ));
        }
    }

    // 读取服务器声明的层级分隔符。多数服务器是 "/"，但也有使用 "."
    // 的实现；硬编码会造成客户端与服务器树不一致。
    let hierarchy_delimiter = if hierarchy_changed
        && account.provider == ProviderType::Imap
        && !folder.remote_id.starts_with("__local_")
    {
        let provider = crate::commands::messages::connect_imap(&state, &account_id).await?;
        let delimiter = provider.hierarchy_delimiter().await.unwrap_or_else(|_| "/".to_string());
        let _ = provider.disconnect().await;
        delimiter
    } else {
        "/".to_string()
    };

    // 新服务器路径：短名 + 父路径。
    let (new_remote_id, display_name) = if hierarchy_changed {
        let short_name = folder
            .remote_id
            .rsplit(hierarchy_delimiter.as_str())
            .next()
            .unwrap_or(&folder.remote_id)
            .to_string();
        let remote_id = match &new_parent {
            Some(parent) => format!("{}{}{}", parent.remote_id, hierarchy_delimiter, short_name),
            None => short_name,
        };
        let name = folder
            .name
            .rsplit(hierarchy_delimiter.as_str())
            .next()
            .unwrap_or(&folder.name)
            .to_string();
        (remote_id, name)
    } else {
        (folder.remote_id.clone(), folder.name.clone())
    };

    // IMAP 远程文件夹：先在服务器 RENAME（路径变化时才需要）
    if !folder.remote_id.starts_with("__local_") && folder.remote_id != new_remote_id {
        if account.provider == ProviderType::Imap {
            info!(
                account_id = %account_id,
                from = %folder.remote_id,
                to = %new_remote_id,
                "move_folder: sending IMAP RENAME to server"
            );
            let provider = crate::commands::messages::connect_imap(&state, &account_id).await?;
            match provider
                .rename_folder(&folder.remote_id, &new_remote_id)
                .await
            {
                Ok(()) => {
                    info!(
                        account_id = %account_id,
                        from = %folder.remote_id,
                        to = %new_remote_id,
                        "move_folder: IMAP RENAME ok on server"
                    );
                }
                Err(err) => {
                    let msg = err.to_string();
                    let lower = msg.to_lowercase();
                    // 源文件夹不存在时不能直接认定成功：它也可能已被另一轮同步
                    // 移到别处。只有重新 LIST 后确认目标路径真实存在，才按幂等
                    // 成功处理，避免本地 parent_id 与服务器层级分叉。
                    if lower.contains("nonexistent")
                        || lower.contains("does not exist")
                        || lower.contains("no such mailbox")
                    {
                        let destination_exists = provider
                            .list_folders(&account_id)
                            .await
                            .map(|folders| folders.iter().any(|item| item.remote_id == new_remote_id))
                            .unwrap_or(false);
                        if destination_exists {
                            info!(
                                account_id = %account_id,
                                from = %folder.remote_id,
                                to = %new_remote_id,
                                error = %msg,
                                "move_folder: source absent but destination confirmed; treating as idempotent success"
                            );
                        } else {
                            error!(
                                account_id = %account_id,
                                from = %folder.remote_id,
                                to = %new_remote_id,
                                error = %msg,
                                "move_folder: source absent and destination not found; refusing local-only update"
                            );
                            let _ = provider.disconnect().await;
                            return Err(PebbleError::Network(format!(
                                "服务器未确认文件夹已移动到目标位置，请刷新文件夹后重试：{msg}"
                            )));
                        }
                    } else {
                        error!(
                            account_id = %account_id,
                            from = %folder.remote_id,
                            to = %new_remote_id,
                            error = %err,
                            "move_folder: IMAP RENAME failed"
                        );
                        let _ = provider.disconnect().await;
                        return Err(err);
                    }
                }
            }
            if let Err(error) = provider.disconnect().await {
                tracing::debug!(
                    "Failed to disconnect IMAP session after moving folder for account {account_id}: {error}"
                )
            } else {
                tracing::debug!(
                    "Disconnected IMAP session after moving folder for account {account_id}"
                );
            }
        } else {
            info!(
                account_id = %account_id,
                from = %folder.remote_id,
                to = %new_remote_id,
                "move_folder: non-IMAP account, skipping server RENAME (local only)"
            );
        }
    } else if folder.remote_id.starts_with("__local_") {
        info!(
            account_id = %account_id,
            folder_id = %folder_id,
            "move_folder: local-only folder, no server operation"
        );
    }

    // Keep the entire local subtree aligned with the new IMAP path. Without
    // this, children retain the old remote path and the next LIST/repair pass
    // can reconstruct a different hierarchy than the server displays.
    if !folder.remote_id.starts_with("__local_") && folder.remote_id != new_remote_id {
        state.store.rewrite_folder_subtree_remote_ids(
            &account_id,
            &folder.remote_id,
            &new_remote_id,
            &hierarchy_delimiter,
        )?;
        state
            .store
            .repair_folder_hierarchy_from_remote_ids(&account_id)?;
    }

    // 重排目标层级：把 folder 插到 after 之后（after 为 None 插到最前），全体重新编号
    let all_folders = state.store.list_folders(&account_id)?;
    let mut siblings: Vec<&Folder> = all_folders
        .iter()
        .filter(|item| item.id != folder_id && item.parent_id == new_parent_folder_id)
        .collect();
    siblings.sort_by(|a, b| {
        a.sort_order
            .cmp(&b.sort_order)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.id.cmp(&b.id))
    });
    let insert_index = match &after_folder_id {
        Some(after_id) => siblings
            .iter()
            .position(|item| item.id == *after_id)
            .map(|index| index + 1)
            .unwrap_or(siblings.len()),
        None => 0,
    };
    let mut new_order: Vec<&Folder> = Vec::with_capacity(siblings.len() + 1);
    new_order.extend_from_slice(&siblings[..insert_index]);
    new_order.push(&folder);
    new_order.extend_from_slice(&siblings[insert_index..]);
    for (index, item) in new_order.iter().enumerate() {
        let index = index as i64;
        if item.id == folder_id {
            state.store.update_folder_position_and_remote_id(
                &folder_id,
                new_parent_folder_id.as_deref(),
                index,
                &display_name,
                &new_remote_id,
            )?;
        } else {
            state.store.update_folder_sort_order(&item.id, index)?;
        }
    }

    info!(
        account_id = %account_id,
        folder_id = %folder_id,
        parent = ?new_parent_folder_id,
        remote_id = %new_remote_id,
        "move_folder: reordered"
    );

    // The server is authoritative after a successful RENAME. Re-list and
    // reconcile before returning so the sidebar cannot retain a stale parent
    // relationship from its pre-drag cache.
    if hierarchy_changed
        && account.provider == ProviderType::Imap
        && !new_remote_id.starts_with("__local_")
    {
        if let Ok(provider) = crate::commands::messages::connect_imap(&state, &account_id).await {
            match provider.list_folders(&account_id).await {
                Ok(remote_folders) if !remote_folders.is_empty() => {
                    // Some IMAP servers acknowledge RENAME before LIST has
                    // caught up. Never let that short-lived old LIST roll a
                    // successful local move back to the previous parent.
                    let destination_confirmed = remote_folders
                        .iter()
                        .any(|item| item.remote_id == new_remote_id);
                    let source_still_present = folder.remote_id != new_remote_id
                        && remote_folders
                            .iter()
                            .any(|item| item.remote_id == folder.remote_id);
                    if folder.remote_id == new_remote_id
                        || (destination_confirmed && !source_still_present)
                    {
                        state
                            .store
                            .reconcile_remote_folder_tree(&account_id, &remote_folders)?;
                        let _ = state
                            .store
                            .repair_folder_hierarchy_from_remote_ids(&account_id)?;
                    } else {
                        tracing::warn!(
                            account_id = %account_id,
                            from = %folder.remote_id,
                            to = %new_remote_id,
                            "move_folder: final LIST has not confirmed RENAME; retaining local committed hierarchy"
                        );
                    }
                }
                Ok(_) => {
                    tracing::warn!(
                        account_id = %account_id,
                        "move_folder: final server LIST was empty; retaining the committed local tree"
                    );
                }
                Err(error) => {
                    tracing::warn!(
                        account_id = %account_id,
                        %error,
                        "move_folder: final server LIST failed; retaining the committed local tree"
                    );
                }
            }
            let _ = provider.disconnect().await;
        }
    }
    state.store.list_folders(&account_id)
}

/// 判断 `ancestor_id` 是否在从 `start_id` 向上的父链上（即 start 是 ancestor 的子孙）。
/// 用于防环：新父文件夹不能是被拖文件夹的子孙。
fn is_folder_descendant(
    state: &AppState,
    ancestor_id: &str,
    start_id: &str,
) -> std::result::Result<bool, PebbleError> {
    let mut current: Option<String> = Some(start_id.to_string());
    while let Some(id) = current {
        if id == ancestor_id {
            return Ok(true);
        }
        let folder = state.store.get_folder(&id)?;
        current = folder.and_then(|item| item.parent_id);
    }
    Ok(false)
}

/// Rename a custom folder both on the server (IMAP) and in local storage.
#[tauri::command]
pub async fn rename_folder(
    state: State<'_, AppState>,
    account_id: String,
    folder_id: String,
    new_name: String,
) -> std::result::Result<Folder, PebbleError> {
    validate_custom_folder_name(&new_name)?;
    let folder = state
        .store
        .get_folder(&folder_id)?
        .ok_or_else(|| PebbleError::Validation("文件夹不存在或已被删除".to_string()))?;
    if folder.account_id != account_id {
        return Err(PebbleError::Validation("文件夹不属于当前账号".to_string()));
    }
    if folder.role.is_some() || folder.is_system {
        return Err(PebbleError::Validation("系统文件夹不能重命名".to_string()));
    }
    let new_name = new_name.trim().to_string();
    if folder.remote_id.starts_with("__local_") {
        // Local-only folder: rename in the database only.
        state
            .store
            .update_folder_name_and_remote_id(&folder_id, &new_name, &folder.remote_id)?;
    } else {
        let account = state
            .store
            .get_account(&account_id)?
            .ok_or_else(|| PebbleError::Internal(format!("Account not found: {account_id}")))?;
        if account.provider != ProviderType::Imap {
            return Err(PebbleError::Validation(
                "当前账号类型暂不支持重命名文件夹，仅支持 IMAP 账号".to_string(),
            ));
        }
        let provider = crate::commands::messages::connect_imap(&state, &account_id).await?;
        provider.rename_folder(&folder.remote_id, &new_name).await?;
        if let Err(error) = provider.disconnect().await {
            tracing::debug!(
                "Failed to disconnect IMAP session after renaming folder for account {account_id}: {error}"
            );
        }
        state
            .store
            .update_folder_name_and_remote_id(&folder_id, &new_name, &new_name)?;
    }
    state
        .store
        .get_folder(&folder_id)?
        .ok_or_else(|| PebbleError::Internal("Folder disappeared after rename".to_string()))
}

/// Delete a custom folder. IMAP folders are deleted on the server first; the
/// local folder, its message membership and orphaned messages are then removed.
#[tauri::command]
pub async fn delete_folder(
    state: State<'_, AppState>,
    account_id: String,
    folder_id: String,
) -> std::result::Result<Vec<Folder>, PebbleError> {
    let folder = state
        .store
        .get_folder(&folder_id)?
        .ok_or_else(|| PebbleError::Validation("文件夹不存在或已被删除".to_string()))?;
    if folder.account_id != account_id {
        return Err(PebbleError::Validation("文件夹不属于当前账号".to_string()));
    }
    if folder.role.is_some() || folder.is_system {
        return Err(PebbleError::Validation("系统文件夹不能删除".to_string()));
    }

    if !folder.remote_id.starts_with("__local_") {
        let account = state
            .store
            .get_account(&account_id)?
            .ok_or_else(|| PebbleError::Internal(format!("Account not found: {account_id}")))?;
        if account.provider == ProviderType::Imap {
            let provider = crate::commands::messages::connect_imap(&state, &account_id).await?;
            provider.delete_folder(&folder.remote_id).await?;
            if let Err(error) = provider.disconnect().await {
                tracing::debug!(
                    "Failed to disconnect IMAP session after deleting folder for account {account_id}: {error}"
                );
            }
        }
    }

    // Remove the folder from the explicit IMAP sync selection so a later
    // discovery does not resurrect it locally.
    if let Some(mut sync_state) = state.store.get_sync_state(&account_id)? {
        if let Some(selected) = sync_state.selected_imap_folder_remote_ids.as_mut() {
            selected.retain(|id| id != &folder.remote_id);
        }
        state
            .store
            .update_account_sync_state(&account_id, &sync_state.to_json()?)?;
    }

    let change = state.store.delete_folder_by_id(&folder_id)?;
    if let Err(error) =
        crate::commands::messages::refresh_search_documents(&state, &change.affected_message_ids)
    {
        tracing::warn!(
            "Failed to refresh search documents after deleting folder {folder_id}: {error}"
        );
    }
    for message_id in &change.deleted_message_ids {
        if let Err(error) = state.search.remove_message(message_id) {
            tracing::warn!(
                "Failed to remove deleted message {message_id} from search index: {error}"
            );
        }
    }
    if let Err(error) = state.search.commit() {
        tracing::warn!("Failed to commit search index after folder delete: {error}");
    }

    let attachments_dir = state.attachments_dir.clone();
    let deleted_message_ids = change.deleted_message_ids;
    if let Err(error) = tokio::task::spawn_blocking(move || {
        for message_id in deleted_message_ids {
            let message_dir = attachments_dir.join(&message_id);
            if message_dir.exists() {
                if let Err(error) = std::fs::remove_dir_all(&message_dir) {
                    tracing::warn!(
                        "Failed to remove attachments for deleted message {message_id}: {error}"
                    );
                }
            }
        }
    })
    .await
    {
        tracing::warn!("Attachment cleanup task failed after folder delete: {error}");
    }

    state.store.list_folders(&account_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(role: FolderRole, remote_id: &str) -> Folder {
        Folder {
            id: new_id(),
            account_id: "account-1".to_string(),
            remote_id: remote_id.to_string(),
            name: remote_id.to_string(),
            folder_type: FolderType::Folder,
            role: Some(role),
            parent_id: None,
            color: None,
            is_system: true,
            sort_order: 0,
        }
    }

    #[test]
    fn archive_seed_waits_until_provider_folders_exist() {
        assert!(!provider_folders_have_arrived(&[]));
        assert!(!provider_folders_have_arrived(&[folder(
            FolderRole::Archive,
            "__local_archive__"
        )]));
        assert!(provider_folders_have_arrived(&[folder(
            FolderRole::Inbox,
            "INBOX"
        )]));

        assert!(!should_seed_local_archive(&[]));
        assert!(!should_seed_local_archive(&[folder(
            FolderRole::Sent,
            "__local_outbox__"
        )]));
        assert!(should_seed_local_archive(&[folder(
            FolderRole::Inbox,
            "INBOX"
        )]));
        assert!(!should_seed_local_archive(&[folder(
            FolderRole::Archive,
            "__local_archive__"
        )]));
    }

    #[test]
    fn display_filter_hides_outlook_service_folders_but_keeps_local_outbox() {
        let mut conversation_history = folder(FolderRole::Inbox, "conversation-history-id");
        conversation_history.role = None;
        conversation_history.name = "对话历史记录".to_string();

        let mut remote_outbox = folder(FolderRole::Inbox, "remote-outbox-id");
        remote_outbox.role = None;
        remote_outbox.name = "发件箱".to_string();

        let mut local_outbox = folder(FolderRole::Inbox, "__local_outbox__");
        local_outbox.role = None;
        local_outbox.name = "Outbox".to_string();

        let inbox = folder(FolderRole::Inbox, "inbox-id");
        let filtered = filter_display_folders(
            Some(&pebble_core::ProviderType::Outlook),
            vec![
                conversation_history,
                remote_outbox,
                local_outbox.clone(),
                inbox.clone(),
            ],
        );

        assert_eq!(
            filtered
                .iter()
                .map(|folder| folder.remote_id.as_str())
                .collect::<Vec<_>>(),
            vec!["__local_outbox__", "inbox-id"]
        );
    }

    #[test]
    fn explicit_imap_folder_settings_keep_inbox_selected() {
        let inbox = folder(FolderRole::Inbox, "INBOX");
        let sent = folder(FolderRole::Sent, "Sent");
        let mut custom = folder(FolderRole::Archive, "Newsletters");
        custom.role = None;

        let selected = selected_remote_ids_for_settings(
            &[inbox, sent, custom],
            Some(vec!["Newsletters".to_string()]),
        );

        assert_eq!(
            selected,
            vec!["INBOX".to_string(), "Newsletters".to_string()]
        );
    }

    #[test]
    fn legacy_imap_folder_settings_select_every_discovered_folder() {
        let inbox = folder(FolderRole::Inbox, "INBOX");
        let sent = folder(FolderRole::Sent, "Sent");

        assert_eq!(
            selected_remote_ids_for_settings(&[inbox, sent], None),
            vec!["INBOX".to_string(), "Sent".to_string()]
        );
    }
}
