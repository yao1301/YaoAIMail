use pebble_core::{Folder, FolderRole, FolderType, PebbleError, Result};
use rusqlite::{params, OptionalExtension};
use std::collections::{BTreeSet, HashMap, HashSet};

use crate::{accounts::SyncState, Store};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImapFolderSelectionChange {
    /// Messages whose folder membership changed and whose search documents
    /// therefore need to be refreshed.
    pub affected_message_ids: Vec<String>,
    /// Messages that no longer belong to any folder and were physically
    /// removed along with their attachment records.
    pub deleted_message_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FolderDeleteChange {
    /// Messages whose folder membership changed and whose search documents
    /// therefore need to be refreshed.
    pub affected_message_ids: Vec<String>,
    /// Messages that no longer belong to any folder and were physically
    /// removed along with their attachment records.
    pub deleted_message_ids: Vec<String>,
}

fn folder_type_to_str(ft: &FolderType) -> &'static str {
    match ft {
        FolderType::Folder => "folder",
        FolderType::Label => "label",
        FolderType::Category => "category",
    }
}

fn str_to_folder_type(s: &str) -> FolderType {
    match s {
        "label" => FolderType::Label,
        "category" => FolderType::Category,
        _ => FolderType::Folder,
    }
}

fn folder_role_to_str(role: &FolderRole) -> &'static str {
    match role {
        FolderRole::Inbox => "inbox",
        FolderRole::Sent => "sent",
        FolderRole::Drafts => "drafts",
        FolderRole::Trash => "trash",
        FolderRole::Archive => "archive",
        FolderRole::Spam => "spam",
    }
}

fn str_to_folder_role(s: &str) -> Option<FolderRole> {
    match s {
        "inbox" => Some(FolderRole::Inbox),
        "sent" => Some(FolderRole::Sent),
        "drafts" => Some(FolderRole::Drafts),
        "trash" => Some(FolderRole::Trash),
        "archive" => Some(FolderRole::Archive),
        "spam" => Some(FolderRole::Spam),
        _ => None,
    }
}

impl Store {
    /// Upsert a folder. Returns the effective database id (the existing row's id
    /// when the folder already exists, or `folder.id` for a new insert).
    pub fn insert_folder(&self, folder: &Folder) -> Result<String> {
        self.with_write(|conn| {
            // Upsert: if a folder with the same (account_id, remote_id) exists,
            // update server-owned metadata instead of creating a duplicate.
            // `sort_order` is a local presentation preference: IMAP LIST does
            // not define a user mailbox order, so a discovery refresh must
            // never overwrite an order chosen by drag-and-drop.
            let existing: Option<String> = conn
                .query_row(
                    "SELECT id FROM folders WHERE account_id = ?1 AND remote_id = ?2",
                    rusqlite::params![folder.account_id, folder.remote_id],
                    |row| row.get(0),
                )
                .optional()?;

            if let Some(existing_id) = existing {
                conn.execute(
                    "UPDATE folders SET name = ?1, folder_type = ?2, role = ?3
                     WHERE id = ?4",
                    rusqlite::params![
                        folder.name,
                        folder_type_to_str(&folder.folder_type),
                        folder.role.as_ref().map(folder_role_to_str),
                        existing_id,
                    ],
                )?;
                Ok(existing_id)
            } else {
                conn.execute(
                    "INSERT INTO folders (id, account_id, remote_id, name, folder_type, role, parent_id, color, is_system, sort_order)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    rusqlite::params![
                        folder.id,
                        folder.account_id,
                        folder.remote_id,
                        folder.name,
                        folder_type_to_str(&folder.folder_type),
                        folder.role.as_ref().map(folder_role_to_str),
                        folder.parent_id,
                        folder.color,
                        folder.is_system as i32,
                        folder.sort_order,
                    ],
                )?;
                Ok(folder.id.clone())
            }
        })
    }

    pub fn find_folder_by_role(
        &self,
        account_id: &str,
        role: FolderRole,
    ) -> Result<Option<Folder>> {
        let role_str = folder_role_to_str(&role);
        self.with_read(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT id, account_id, remote_id, name, folder_type, role, parent_id, color, is_system, sort_order
                     FROM folders WHERE account_id = ?1 AND role = ?2 LIMIT 1",
                )?;
            let result = stmt
                .query_row(params![account_id, role_str], |row| {
                    let role_val: Option<String> = row.get(5)?;
                    let is_system: i32 = row.get(8)?;
                    Ok(Folder {
                        id: row.get(0)?,
                        account_id: row.get(1)?,
                        remote_id: row.get(2)?,
                        name: row.get(3)?,
                        folder_type: str_to_folder_type(&row.get::<_, String>(4)?),
                        role: role_val.and_then(|s| str_to_folder_role(&s)),
                        parent_id: row.get(6)?,
                        color: row.get(7)?,
                        is_system: is_system != 0,
                        sort_order: row.get(9)?,
                    })
                })
                .optional()?;
            Ok(result)
        })
    }

    pub fn get_folder(&self, folder_id: &str) -> Result<Option<Folder>> {
        self.with_read(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT id, account_id, remote_id, name, folder_type, role, parent_id, color, is_system, sort_order
                     FROM folders WHERE id = ?1",
                )?;
            let result = stmt
                .query_row(params![folder_id], |row| {
                    let role_val: Option<String> = row.get(5)?;
                    let is_system: i32 = row.get(8)?;
                    Ok(Folder {
                        id: row.get(0)?,
                        account_id: row.get(1)?,
                        remote_id: row.get(2)?,
                        name: row.get(3)?,
                        folder_type: str_to_folder_type(&row.get::<_, String>(4)?),
                        role: role_val.and_then(|s| str_to_folder_role(&s)),
                        parent_id: row.get(6)?,
                        color: row.get(7)?,
                        is_system: is_system != 0,
                        sort_order: row.get(9)?,
                    })
                })
                .optional()?;
            Ok(result)
        })
    }

    /// Update a folder's display name and remote id, typically after a
    /// server-side RENAME. Remote folders keep `is_system` untouched so the
    /// sync layer can still recognize system mailboxes.
    pub fn update_folder_name_and_remote_id(
        &self,
        folder_id: &str,
        name: &str,
        remote_id: &str,
    ) -> Result<()> {
        self.with_write(|conn| {
            conn.execute(
                "UPDATE folders SET name = ?1, remote_id = ?2 WHERE id = ?3",
                params![name, remote_id, folder_id],
            )?;
            Ok(())
        })
    }

    /// Update a folder's sort order only (used when renumbering siblings
    /// after a drag-and-drop reorder).
    pub fn update_folder_sort_order(&self, folder_id: &str, sort_order: i64) -> Result<()> {
        self.with_write(|conn| {
            conn.execute(
                "UPDATE folders SET sort_order = ?1 WHERE id = ?2",
                params![sort_order, folder_id],
            )?;
            Ok(())
        })
    }

    /// Update a folder's parent, sort order, display name and remote path in
    /// one go (used by drag-and-drop reordering / re-parenting).
    pub fn update_folder_position_and_remote_id(
        &self,
        folder_id: &str,
        parent_id: Option<&str>,
        sort_order: i64,
        name: &str,
        remote_id: &str,
    ) -> Result<()> {
        self.with_write(|conn| {
            conn.execute(
                "UPDATE folders SET parent_id = ?1, sort_order = ?2, name = ?3, remote_id = ?4 WHERE id = ?5",
                params![parent_id, sort_order, name, remote_id, folder_id],
            )?;
            Ok(())
        })
    }

    /// Rewrite the remote paths for a renamed folder and its descendants in
    /// one transaction. IMAP represents nesting in the mailbox path; changing
    /// only the dragged row leaves every child pointing at the old subtree.
    pub fn rewrite_folder_subtree_remote_ids(
        &self,
        account_id: &str,
        old_prefix: &str,
        new_prefix: &str,
        delimiter: &str,
    ) -> Result<usize> {
        if old_prefix.is_empty() || new_prefix.is_empty() || delimiter.is_empty() {
            return Ok(0);
        }
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            let mut stmt = tx.prepare(
                "SELECT id, remote_id FROM folders
                 WHERE account_id = ?1 AND remote_id = ?2
                    OR account_id = ?1 AND remote_id LIKE ?3",
            )?;
            let prefix = format!("{old_prefix}{delimiter}%");
            let rows = stmt.query_map(params![account_id, old_prefix, prefix], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            let folders: Vec<(String, String)> = rows.collect::<rusqlite::Result<_>>()?;
            drop(stmt);
            let mut changed = 0usize;
            for (folder_id, remote_id) in folders {
                let replacement = if remote_id == old_prefix {
                    new_prefix.to_string()
                } else {
                    format!("{new_prefix}{}", &remote_id[old_prefix.len()..])
                };
                tx.execute(
                    "UPDATE folders SET remote_id = ?1 WHERE id = ?2",
                    params![replacement, folder_id],
                )?;
                changed += 1;
            }
            tx.commit()?;
            Ok(changed)
        })
    }

    pub fn find_folder_by_name(&self, account_id: &str, name: &str) -> Result<Option<Folder>> {
        let lower = name.to_lowercase();
        let folders = self.list_folders(account_id)?;
        Ok(folders.into_iter().find(|f| f.name.to_lowercase() == lower))
    }

    pub fn delete_folder_by_remote_id(&self, account_id: &str, remote_id: &str) -> Result<()> {
        self.with_write(|conn| {
            conn.execute(
                "DELETE FROM folders WHERE account_id = ?1 AND remote_id = ?2",
                rusqlite::params![account_id, remote_id],
            )?;
            Ok(())
        })
    }

    /// Delete a folder by id together with its message membership. Messages
    /// that no longer belong to any folder are physically removed so no
    /// orphaned rows (or attachments) remain.
    pub fn delete_folder_by_id(&self, folder_id: &str) -> Result<FolderDeleteChange> {
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            let message_ids: Vec<String> = {
                let mut stmt =
                    tx.prepare("SELECT message_id FROM message_folders WHERE folder_id = ?1")?;
                let rows = stmt.query_map(params![folder_id], |row| row.get::<_, String>(0))?;
                let mut ids = Vec::new();
                for row in rows {
                    ids.push(row?);
                }
                ids
            };

            tx.execute(
                "DELETE FROM message_folders WHERE folder_id = ?1",
                params![folder_id],
            )?;
            tx.execute("DELETE FROM folders WHERE id = ?1", params![folder_id])?;

            let mut deleted_message_ids = Vec::new();
            for message_id in &message_ids {
                let remaining: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM message_folders WHERE message_id = ?1",
                    params![message_id],
                    |row| row.get(0),
                )?;
                if remaining == 0 {
                    tx.execute("DELETE FROM messages WHERE id = ?1", params![message_id])?;
                    deleted_message_ids.push(message_id.clone());
                }
            }
            tx.commit()?;
            Ok(FolderDeleteChange {
                affected_message_ids: message_ids,
                deleted_message_ids,
            })
        })
    }

    pub fn list_folders(&self, account_id: &str) -> Result<Vec<Folder>> {
        self.with_read(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, account_id, remote_id, name, folder_type, role, parent_id, color, is_system, sort_order
                     FROM folders WHERE account_id = ?1 ORDER BY sort_order ASC",
                )?;
            let rows = stmt
                .query_map(rusqlite::params![account_id], |row| {
                    let role_str: Option<String> = row.get(5)?;
                    let is_system: i32 = row.get(8)?;
                    Ok(Folder {
                        id: row.get(0)?,
                        account_id: row.get(1)?,
                        remote_id: row.get(2)?,
                        name: row.get(3)?,
                        folder_type: str_to_folder_type(&row.get::<_, String>(4)?),
                        role: role_str.and_then(|s| str_to_folder_role(&s)),
                        parent_id: row.get(6)?,
                        color: row.get(7)?,
                        is_system: is_system != 0,
                        sort_order: row.get(9)?,
                    })
                })?;
            let mut folders = Vec::new();
            for row in rows {
                folders.push(row?);
            }
            Ok(folders)
        })
    }

    /// Rebuild local parent links from the authoritative IMAP mailbox paths.
    /// IMAP servers commonly return flattened names such as `Sales/Europe` or
    /// `Sales.Europe`; older imports stored those rows with a null parent_id,
    /// which made the client tree disagree with the server after restart.
    pub fn repair_folder_hierarchy_from_remote_ids(&self, account_id: &str) -> Result<usize> {
        let folders = self.list_folders(account_id)?;
        let remote_to_id: HashMap<&str, &str> = folders
            .iter()
            .filter(|folder| !folder.remote_id.starts_with("__local_"))
            .map(|folder| (folder.remote_id.as_str(), folder.id.as_str()))
            .collect();
        let repairs: Vec<(String, Option<String>)> = folders
            .iter()
            .filter(|folder| !folder.remote_id.starts_with("__local_"))
            .map(|folder| {
                let mut best_parent: Option<(&str, &str)> = None;
                for (candidate_path, candidate_id) in &remote_to_id {
                    if *candidate_path == folder.remote_id || candidate_path.is_empty() {
                        continue;
                    }
                    let remainder = folder.remote_id.strip_prefix(*candidate_path);
                    // Exactly one hierarchy delimiter must sit between the
                    // complete parent path and the child name.
                    if let Some(remainder) = remainder {
                        if remainder.chars().count() > 1 {
                            let mut chars = remainder.chars();
                            let delimiter = chars.next().unwrap_or('/');
                            if !delimiter.is_alphanumeric()
                                && best_parent.map_or(true, |(best, _)| candidate_path.len() > best.len())
                            {
                                best_parent = Some((candidate_path, candidate_id));
                            }
                        }
                    }
                }
                (folder.id.clone(), best_parent.map(|(_, id)| id.to_string()))
            })
            .filter(|(id, parent_id)| {
                folders.iter().find(|folder| folder.id == *id).map_or(false, |folder| folder.parent_id != *parent_id)
            })
            .collect();
        if repairs.is_empty() {
            return Ok(0);
        }
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            for (folder_id, parent_id) in &repairs {
                tx.execute(
                    "UPDATE folders SET parent_id = ?1 WHERE id = ?2",
                    params![parent_id, folder_id],
                )?;
            }
            tx.commit()?;
            Ok(repairs.len())
        })
    }

    /// Reconcile authoritative server folder paths without deleting local
    /// data. Exact remote-id matches are updated normally; a path rename is
    /// adopted only when the leaf name and role identify exactly one local
    /// folder, preserving its ID and message memberships.
    pub fn reconcile_remote_folder_tree(
        &self,
        account_id: &str,
        remote_folders: &[Folder],
    ) -> Result<()> {
        if remote_folders.is_empty() {
            return Ok(());
        }
        fn leaf(value: &str) -> &str {
            value
                .rsplit(|ch| matches!(ch, '/' | '.' | '\\'))
                .next()
                .unwrap_or(value)
        }
        fn is_direct_child(parent: &str, child: &str) -> bool {
            let Some(remainder) = child.strip_prefix(parent) else {
                return false;
            };
            let mut chars = remainder.chars();
            let Some(separator) = chars.next() else {
                return false;
            };
            if !matches!(separator, '/' | '.' | '\\') {
                return false;
            }
            let child_name: String = chars.collect();
            !child_name.is_empty()
                && !child_name
                    .chars()
                    .any(|ch| matches!(ch, '/' | '.' | '\\'))
        }

        let local = self.list_folders(account_id)?;
        let mut used = HashSet::new();
        for remote in remote_folders {
            let exact = local
                .iter()
                .find(|folder| folder.remote_id == remote.remote_id)
                .map(|folder| folder.id.clone());
            let remote_child_leaves: HashSet<String> = remote_folders
                .iter()
                .filter(|child| is_direct_child(&remote.remote_id, &child.remote_id))
                .map(|child| leaf(&child.name).to_ascii_lowercase())
                .collect();
            let rename_candidate = || {
                let candidates: Vec<&Folder> = local
                    .iter()
                    .filter(|folder| {
                        !used.contains(&folder.id)
                            && !folder.remote_id.starts_with("__local_")
                            && exact.as_deref() != Some(folder.id.as_str())
                            && folder.role == remote.role
                            && (leaf(&folder.name).eq_ignore_ascii_case(leaf(&remote.name))
                                || (!remote_child_leaves.is_empty()
                                    && {
                                        let local_child_leaves: HashSet<String> = local
                                            .iter()
                                            .filter(|child| {
                                                is_direct_child(
                                                    &folder.remote_id,
                                                    &child.remote_id,
                                                )
                                            })
                                            .map(|child| leaf(&child.name).to_ascii_lowercase())
                                            .collect();
                                        local_child_leaves == remote_child_leaves
                                    }))
                    })
                    .collect();
                (candidates.len() == 1).then(|| candidates[0].id.clone())
            };

            // A previous sync may have already inserted the new remote path,
            // while all messages are still attached to the old local row. In
            // that case the exact row is an empty duplicate. Prefer the row
            // containing messages so folder identity and local data survive
            // the server-side rename. Delete only that proven-empty duplicate.
            let (matched, empty_duplicate) = if let (Some(exact_id), Some(candidate_id)) =
                (exact.clone(), rename_candidate())
            {
                let (exact_count, candidate_count) = self.with_read(|conn| {
                    let exact_count: i64 = conn.query_row(
                        "SELECT COUNT(*) FROM message_folders WHERE folder_id = ?1",
                        params![exact_id],
                        |row| row.get(0),
                    )?;
                    let candidate_count: i64 = conn.query_row(
                        "SELECT COUNT(*) FROM message_folders WHERE folder_id = ?1",
                        params![candidate_id],
                        |row| row.get(0),
                    )?;
                    Ok((exact_count, candidate_count))
                })?;
                if exact_count == 0 && candidate_count > 0 {
                    (candidate_id, Some(exact_id))
                } else {
                    (exact_id, None)
                }
            } else if let Some(exact_id) = exact {
                (exact_id, None)
            } else if let Some(candidate_id) = rename_candidate() {
                (candidate_id, None)
            } else {
                (String::new(), None)
            };

            if !matched.is_empty() {
                let folder_id = matched;
                used.insert(folder_id.clone());
                self.with_write(|conn| {
                    conn.execute(
                        // Keep the existing local sort_order. Remote folder
                        // enumeration is authoritative for identity and path,
                        // but not for this client's visual ordering.
                        "UPDATE folders SET remote_id = ?1, name = ?2, folder_type = ?3,
                         role = ?4, is_system = ?5 WHERE id = ?6",
                        params![
                            remote.remote_id,
                            remote.name,
                            folder_type_to_str(&remote.folder_type),
                            remote.role.as_ref().map(folder_role_to_str),
                            remote.is_system as i32,
                            folder_id,
                        ],
                    )?;
                    if let Some(empty_id) = empty_duplicate.as_deref() {
                        let remaining: i64 = conn.query_row(
                            "SELECT COUNT(*) FROM message_folders WHERE folder_id = ?1",
                            params![empty_id],
                            |row| row.get(0),
                        )?;
                        if remaining == 0 {
                            conn.execute(
                                "DELETE FROM folders WHERE id = ?1 AND account_id = ?2",
                                params![empty_id, account_id],
                            )?;
                        }
                    }
                    Ok(())
                })?;
            } else {
                // New server folders are safe to add. Unmatched local rows
                // are deliberately retained until a later explicit cleanup.
                self.insert_folder(remote)?;
            }
        }
        self.repair_folder_hierarchy_from_remote_ids(account_id)?;
        Ok(())
    }

    /// Atomically persist an explicit IMAP mailbox selection, upsert the
    /// selected remote folders, and remove local data for deselected remote
    /// folders. Local-only folders (whose remote ID starts with `__local_`) are
    /// intentionally retained.
    pub fn apply_imap_folder_selection(
        &self,
        account_id: &str,
        remote_folders: &[Folder],
        selected_remote_ids: &[String],
    ) -> Result<ImapFolderSelectionChange> {
        if remote_folders
            .iter()
            .any(|folder| folder.account_id != account_id)
        {
            return Err(PebbleError::Validation(
                "IMAP folder selection contains a folder for another account".to_string(),
            ));
        }

        let mut selected_ordered = Vec::with_capacity(selected_remote_ids.len());
        let mut seen = HashSet::with_capacity(selected_remote_ids.len());
        for remote_id in selected_remote_ids {
            if seen.insert(remote_id.clone()) {
                selected_ordered.push(remote_id.clone());
            }
        }
        let selected: HashSet<String> = selected_ordered.iter().cloned().collect();

        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;

            let raw_sync_state: Option<Option<String>> = tx
                .query_row(
                    "SELECT sync_state FROM accounts WHERE id = ?1",
                    params![account_id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(raw_sync_state) = raw_sync_state else {
                return Err(PebbleError::Internal(format!(
                    "Account not found: {account_id}"
                )));
            };
            let mut sync_state = SyncState::from_json_opt(raw_sync_state.as_deref())?;
            sync_state.selected_imap_folder_remote_ids = Some(selected_ordered);
            let sync_state_json = sync_state.to_json()?;

            for folder in remote_folders
                .iter()
                .filter(|folder| selected.contains(&folder.remote_id))
            {
                let existing_id: Option<String> = tx
                    .query_row(
                        "SELECT id FROM folders WHERE account_id = ?1 AND remote_id = ?2",
                        params![account_id, folder.remote_id],
                        |row| row.get(0),
                    )
                    .optional()?;

                if let Some(existing_id) = existing_id {
                    tx.execute(
                        "UPDATE folders
                         SET name = ?1, folder_type = ?2, role = ?3, parent_id = ?4,
                             color = ?5, is_system = ?6
                         WHERE id = ?7",
                        params![
                            folder.name,
                            folder_type_to_str(&folder.folder_type),
                            folder.role.as_ref().map(folder_role_to_str),
                            folder.parent_id,
                            folder.color,
                            folder.is_system as i32,
                            existing_id,
                        ],
                    )?;
                } else {
                    tx.execute(
                        "INSERT INTO folders
                         (id, account_id, remote_id, name, folder_type, role,
                          parent_id, color, is_system, sort_order)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                        params![
                            folder.id,
                            account_id,
                            folder.remote_id,
                            folder.name,
                            folder_type_to_str(&folder.folder_type),
                            folder.role.as_ref().map(folder_role_to_str),
                            folder.parent_id,
                            folder.color,
                            folder.is_system as i32,
                            folder.sort_order,
                        ],
                    )?;
                }
            }

            let stored_remote_folders = {
                let mut stmt = tx.prepare(
                    "SELECT id, remote_id FROM folders
                     WHERE account_id = ?1",
                )?;
                let rows = stmt.query_map(params![account_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;
                let mut folders = Vec::new();
                for row in rows {
                    folders.push(row?);
                }
                folders
            };

            let removed_folder_ids: Vec<String> = stored_remote_folders
                .into_iter()
                .filter(|(_, remote_id)| {
                    !remote_id.starts_with("__local_") && !selected.contains(remote_id)
                })
                .map(|(id, _)| id)
                .collect();
            let mut affected_message_ids = BTreeSet::new();

            for folder_id in &removed_folder_ids {
                let message_ids = {
                    let mut stmt =
                        tx.prepare("SELECT message_id FROM message_folders WHERE folder_id = ?1")?;
                    let rows = stmt.query_map(params![folder_id], |row| row.get::<_, String>(0))?;
                    let mut ids = Vec::new();
                    for row in rows {
                        ids.push(row?);
                    }
                    ids
                };
                affected_message_ids.extend(message_ids);

                // Delete the junction rows explicitly so cleanup remains
                // correct even on a connection where SQLite FK cascades were
                // not enabled by an older application build.
                tx.execute(
                    "DELETE FROM message_folders WHERE folder_id = ?1",
                    params![folder_id],
                )?;
                tx.execute("DELETE FROM folders WHERE id = ?1", params![folder_id])?;
            }

            let mut deleted_message_ids = Vec::new();
            for message_id in &affected_message_ids {
                let remaining_folder_count: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM message_folders WHERE message_id = ?1",
                    params![message_id],
                    |row| row.get(0),
                )?;
                if remaining_folder_count == 0 {
                    tx.execute("DELETE FROM messages WHERE id = ?1", params![message_id])?;
                    deleted_message_ids.push(message_id.clone());
                }
            }

            tx.execute(
                "UPDATE accounts SET sync_state = ?1, updated_at = ?2 WHERE id = ?3",
                params![sync_state_json, pebble_core::now_timestamp(), account_id],
            )?;

            tx.commit()?;
            Ok(ImapFolderSelectionChange {
                affected_message_ids: affected_message_ids.into_iter().collect(),
                deleted_message_ids,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pebble_core::{now_timestamp, Account, EmailAddress, Message, ProviderType};

    fn account() -> Account {
        let now = now_timestamp();
        Account {
            id: "account-1".to_string(),
            email: "user@example.com".to_string(),
            display_name: "User".to_string(),
            color: None,
            provider: ProviderType::Imap,
            created_at: now,
            updated_at: now,
        }
    }

    fn folder(account_id: &str, id: &str, remote_id: &str, role: Option<FolderRole>) -> Folder {
        Folder {
            id: id.to_string(),
            account_id: account_id.to_string(),
            remote_id: remote_id.to_string(),
            name: remote_id.to_string(),
            folder_type: FolderType::Folder,
            role,
            parent_id: None,
            color: None,
            is_system: true,
            sort_order: 0,
        }
    }

    fn message(account_id: &str, id: &str, remote_id: &str) -> Message {
        let now = now_timestamp();
        Message {
            id: id.to_string(),
            account_id: account_id.to_string(),
            remote_id: remote_id.to_string(),
            message_id_header: None,
            in_reply_to: None,
            references_header: None,
            thread_id: None,
            subject: id.to_string(),
            snippet: String::new(),
            from_address: "sender@example.com".to_string(),
            from_name: "Sender".to_string(),
            to_list: vec![EmailAddress {
                name: None,
                address: "user@example.com".to_string(),
            }],
            cc_list: vec![],
            bcc_list: vec![],
            body_text: String::new(),
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
    fn remote_folder_refresh_never_overwrites_local_drag_order() {
        let store = Store::open_in_memory().unwrap();
        let account = account();
        store.insert_account(&account).unwrap();

        let mut alpha = folder(&account.id, "folder-alpha", "Alpha", None);
        alpha.is_system = false;
        alpha.sort_order = 10;
        let mut beta = folder(&account.id, "folder-beta", "Beta", None);
        beta.is_system = false;
        beta.sort_order = 20;
        store.insert_folder(&alpha).unwrap();
        store.insert_folder(&beta).unwrap();

        // Simulate the user dragging Beta before Alpha.
        store.update_folder_sort_order(&beta.id, 0).unwrap();
        store.update_folder_sort_order(&alpha.id, 1).unwrap();

        // All common discovery paths receive provider defaults rather than a
        // real server-side display order. None may erase the local preference.
        let mut remote_alpha = folder(&account.id, "fresh-alpha", "Alpha", None);
        remote_alpha.is_system = false;
        remote_alpha.sort_order = 100;
        let mut remote_beta = folder(&account.id, "fresh-beta", "Beta", None);
        remote_beta.is_system = false;
        remote_beta.sort_order = 100;

        store.insert_folder(&remote_alpha).unwrap();
        assert_eq!(store.get_folder(&alpha.id).unwrap().unwrap().sort_order, 1);

        store
            .reconcile_remote_folder_tree(
                &account.id,
                &[remote_alpha.clone(), remote_beta.clone()],
            )
            .unwrap();
        assert_eq!(store.get_folder(&beta.id).unwrap().unwrap().sort_order, 0);
        assert_eq!(store.get_folder(&alpha.id).unwrap().unwrap().sort_order, 1);

        store
            .apply_imap_folder_selection(
                &account.id,
                &[remote_alpha, remote_beta],
                &["Alpha".to_string(), "Beta".to_string()],
            )
            .unwrap();
        assert_eq!(store.get_folder(&beta.id).unwrap().unwrap().sort_order, 0);
        assert_eq!(store.get_folder(&alpha.id).unwrap().unwrap().sort_order, 1);
    }

    #[test]
    fn applying_imap_selection_adds_and_removes_folders_and_cleans_orphans() {
        let store = Store::open_in_memory().unwrap();
        let account = account();
        store.insert_account(&account).unwrap();
        store
            .update_account_sync_state(
                &account.id,
                r#"{"provider":"imap","custom_setting":"preserved"}"#,
            )
            .unwrap();

        let inbox = folder(
            &account.id,
            "folder-inbox",
            "INBOX",
            Some(FolderRole::Inbox),
        );
        let removed = folder(&account.id, "folder-projects", "Projects", None);
        let local_archive = folder(
            &account.id,
            "folder-local-archive",
            "__local_archive__",
            Some(FolderRole::Archive),
        );
        store.insert_folder(&inbox).unwrap();
        store.insert_folder(&removed).unwrap();
        store.insert_folder(&local_archive).unwrap();

        let removed_only = message(&account.id, "message-removed", "100");
        let shared = message(&account.id, "message-shared", "101");
        store
            .insert_message(&removed_only, std::slice::from_ref(&removed.id))
            .unwrap();
        store
            .insert_message(&shared, &[removed.id.clone(), inbox.id.clone()])
            .unwrap();

        let fresh_inbox = folder(
            &account.id,
            "fresh-inbox-id",
            "INBOX",
            Some(FolderRole::Inbox),
        );
        let fresh_removed = folder(&account.id, "fresh-project-id", "Projects", None);
        let fresh_added = folder(&account.id, "fresh-team-id", "Team", None);
        let change = store
            .apply_imap_folder_selection(
                &account.id,
                &[fresh_inbox, fresh_removed, fresh_added],
                &["INBOX".to_string(), "Team".to_string()],
            )
            .unwrap();

        assert_eq!(
            change.affected_message_ids,
            vec!["message-removed".to_string(), "message-shared".to_string()]
        );
        assert_eq!(
            change.deleted_message_ids,
            vec!["message-removed".to_string()]
        );
        assert!(store.get_message("message-removed").unwrap().is_none());
        assert!(store.get_message("message-shared").unwrap().is_some());
        assert_eq!(
            store.get_message_folder_ids("message-shared").unwrap(),
            vec![inbox.id]
        );

        let stored_remote_ids: HashSet<String> = store
            .list_folders(&account.id)
            .unwrap()
            .into_iter()
            .map(|folder| folder.remote_id)
            .collect();
        assert_eq!(
            stored_remote_ids,
            HashSet::from([
                "INBOX".to_string(),
                "Team".to_string(),
                "__local_archive__".to_string(),
            ])
        );

        let state = store.get_sync_state(&account.id).unwrap().unwrap();
        assert_eq!(
            state.selected_imap_folder_remote_ids,
            Some(vec!["INBOX".to_string(), "Team".to_string()])
        );
        assert_eq!(
            state.extra.get("custom_setting"),
            Some(&serde_json::Value::String("preserved".to_string()))
        );
    }
}
