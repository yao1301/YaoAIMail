use pebble_core::{Account, PebbleError, ProviderType, Result};
use rusqlite::{self, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::Store;

/// Typed view over an account's `sync_state` JSON blob.
///
/// The column itself remains a flexible JSON object on disk (so provider
/// implementations can tuck their own bookkeeping under `extra` without a
/// migration), but every known field has an explicit name and type here.
/// Callers should go through [`Store::get_sync_state`] and
/// [`Store::update_sync_state`] rather than parsing raw JSON, so that
/// read-modify-write cycles don't clobber sibling fields by accident.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncState {
    /// Provider slug as persisted: `"gmail"`, `"outlook"`, `"imap"`, or `"pop3"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,

    /// Last sync cursor — opaque to the store; interpreted by the provider
    /// (e.g. IMAP UID + modseq, Gmail historyId, Outlook deltaLink).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync_cursor: Option<String>,

    /// Legacy inline IMAP config, present on accounts that predate the move
    /// of credentials into `auth_data`. New accounts should not populate it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap: Option<serde_json::Value>,

    /// Legacy inline SMTP config, same provenance as `imap`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smtp: Option<serde_json::Value>,

    /// Explicit IMAP mailbox selection, stored as provider remote IDs.
    ///
    /// `None` preserves the legacy behaviour of syncing every selectable
    /// mailbox. `Some(...)` enables account-level selection; Inbox is always
    /// included by the IMAP worker even when it is absent from this list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_imap_folder_remote_ids: Option<Vec<String>>,

    /// Any fields we don't yet model — preserved verbatim on write so
    /// round-tripping through [`Store::update_sync_state`] never drops data.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl SyncState {
    /// Parse a `sync_state` JSON string into a typed `SyncState`.
    /// An empty or `None` column is treated as [`SyncState::default`].
    pub fn from_json_opt(raw: Option<&str>) -> Result<Self> {
        match raw {
            None => Ok(Self::default()),
            Some(s) if s.trim().is_empty() => Ok(Self::default()),
            Some(s) => serde_json::from_str(s)
                .map_err(|e| PebbleError::Storage(format!("Invalid sync_state JSON: {e}"))),
        }
    }

    /// Serialize back to the JSON string format stored in the DB.
    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string(self)
            .map_err(|e| PebbleError::Storage(format!("Failed to serialize sync_state: {e}")))
    }
}

fn provider_to_str(p: &ProviderType) -> &'static str {
    match p {
        ProviderType::Imap => "imap",
        ProviderType::Pop3 => "pop3",
        ProviderType::Gmail => "gmail",
        ProviderType::Outlook => "outlook",
    }
}

fn str_to_provider(s: &str) -> ProviderType {
    match s {
        "pop3" => ProviderType::Pop3,
        "gmail" => ProviderType::Gmail,
        "outlook" => ProviderType::Outlook,
        _ => ProviderType::Imap,
    }
}

impl Store {
    pub fn insert_account(&self, account: &Account) -> Result<()> {
        self.with_write(|conn| {
            conn.execute(
                "INSERT INTO accounts (id, email, display_name, color, provider, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    account.id,
                    account.email,
                    account.display_name,
                    account.color.as_deref(),
                    provider_to_str(&account.provider),
                    account.created_at,
                    account.updated_at,
                ],
            )?;
            Ok(())
        })
    }

    pub fn update_account(
        &self,
        id: &str,
        email: &str,
        display_name: &str,
        color: Option<&str>,
    ) -> Result<()> {
        self.update_account_with_sender(id, email, display_name, color, None)
    }

    /// Outgoing name is separate from the local label. Legacy names are frozen
    /// before the first rename, preserving the sender users previously chose.
    pub fn account_sender_name(&self, id: &str) -> Result<String> {
        let account = self.get_account(id)?.ok_or_else(|| PebbleError::Validation("账号不存在".into()))?;
        Ok(self.get_sync_state(id)?.and_then(|s| s.extra.get("sender_name").and_then(|v| v.as_str()).map(str::to_owned))
            .unwrap_or(account.display_name))
    }

    /// A provider subject remains bound even if a mailbox address is recycled.
    pub fn bind_oauth_sender_identity(&self, id: &str, verified_email: &str, subject: &str) -> Result<()> {
        if subject.trim().is_empty() || verified_email.trim().is_empty() { return Err(PebbleError::Validation("授权邮箱身份不完整".into())); }
        self.with_write(|conn| {
            let (email,provider,raw):(String,String,Option<String>)=conn.query_row("SELECT email,provider,sync_state FROM accounts WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
            if !matches!(provider.as_str(),"gmail"|"outlook") || !email.trim().eq_ignore_ascii_case(verified_email.trim()) {
                return Err(PebbleError::Validation("账号已变化，请核对授权邮箱".into()));
            }
            let mut sync=SyncState::from_json_opt(raw.as_deref())?;
            if let Some(old)=sync.extra.get("sender_oauth_subject").and_then(|v|v.as_str()) {
                if old!=subject { return Err(PebbleError::Validation("授权属于另一个邮箱身份，请重新连接原账号".into())); }
                return Ok(());
            }
            sync.extra.insert("sender_oauth_subject".into(),serde_json::Value::String(subject.to_owned()));
            conn.execute("UPDATE accounts SET sync_state=?1 WHERE id=?2",rusqlite::params![sync.to_json()?,id])?;
            Ok(())
        })
    }

    pub fn update_account_with_sender(&self, id: &str, email: &str, display_name: &str, color: Option<&str>, sender_name: Option<&str>) -> Result<()> {
        self.with_write(|conn| {
            let (old_email, old_name, provider, raw): (String,String,String,Option<String>) = conn.query_row(
                "SELECT email,display_name,provider,sync_state FROM accounts WHERE id=?1", [id],
                |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
            if matches!(provider.as_str(), "gmail" | "outlook") && !old_email.trim().eq_ignore_ascii_case(email.trim()) {
                return Err(PebbleError::Validation("授权邮箱地址不能直接修改，请重新添加账号".into()));
            }
            let mut sync = SyncState::from_json_opt(raw.as_deref())?;
            let name = sender_name.map(str::to_owned).or_else(|| sync.extra.get("sender_name").and_then(|v| v.as_str()).map(str::to_owned)).unwrap_or(old_name);
            if name.chars().any(char::is_control) || email.chars().any(char::is_control) {
                return Err(PebbleError::Validation("发件身份不能包含控制字符".into()));
            }
            sync.extra.insert("sender_name".into(), serde_json::Value::String(name.trim().to_owned()));
            let now = pebble_core::now_timestamp();
            conn.execute(
                "UPDATE accounts SET email = ?1, display_name = ?2, color = ?3, updated_at = ?4, sync_state=?6 WHERE id = ?5",
                rusqlite::params![email.trim(), display_name, color, now, id, sync.to_json()?],
            )?;
            Ok(())
        })
    }

    pub fn get_account(&self, id: &str) -> Result<Option<Account>> {
        self.with_read(|conn| {
            let result = conn
                .query_row(
                    "SELECT id, email, display_name, color, provider, created_at, updated_at
                     FROM accounts WHERE id = ?1",
                    rusqlite::params![id],
                    |row| {
                        Ok(Account {
                            id: row.get(0)?,
                            email: row.get(1)?,
                            display_name: row.get(2)?,
                            color: row.get(3)?,
                            provider: str_to_provider(&row.get::<_, String>(4)?),
                            created_at: row.get(5)?,
                            updated_at: row.get(6)?,
                        })
                    },
                )
                .optional()?;
            Ok(result)
        })
    }

    pub fn list_accounts(&self) -> Result<Vec<Account>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, email, display_name, color, provider, created_at, updated_at
                     FROM accounts ORDER BY created_at ASC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(Account {
                    id: row.get(0)?,
                    email: row.get(1)?,
                    display_name: row.get(2)?,
                    color: row.get(3)?,
                    provider: str_to_provider(&row.get::<_, String>(4)?),
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })?;
            let mut accounts = Vec::new();
            for row in rows {
                accounts.push(row?);
            }
            Ok(accounts)
        })
    }

    pub fn delete_account(&self, id: &str) -> Result<()> {
        self.with_write(|conn| {
            conn.execute("DELETE FROM accounts WHERE id = ?1", rusqlite::params![id])?;
            Ok(())
        })
    }

    pub fn update_account_sync_state(&self, account_id: &str, sync_state: &str) -> Result<()> {
        self.with_write(|conn| {
            conn.execute(
                "UPDATE accounts SET sync_state = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![sync_state, pebble_core::now_timestamp(), account_id],
            )?;
            Ok(())
        })
    }

    pub fn get_account_sync_state(&self, account_id: &str) -> Result<Option<String>> {
        self.with_read(|conn| {
            let result = conn.query_row(
                "SELECT sync_state FROM accounts WHERE id = ?1",
                rusqlite::params![account_id],
                |row| row.get::<_, Option<String>>(0),
            )?;
            Ok(result)
        })
    }

    /// Read the `sync_state` column as a typed [`SyncState`].
    ///
    /// Missing column or empty string returns [`SyncState::default`]. The
    /// account must exist; a missing account row returns `Ok(None)`.
    pub fn get_sync_state(&self, account_id: &str) -> Result<Option<SyncState>> {
        self.with_read(|conn| {
            let row: Option<Option<String>> = conn
                .query_row(
                    "SELECT sync_state FROM accounts WHERE id = ?1",
                    rusqlite::params![account_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?;
            match row {
                None => Ok(None),
                Some(raw) => Ok(Some(SyncState::from_json_opt(raw.as_deref())?)),
            }
        })
    }

    /// Read-modify-write the `sync_state` column safely.
    ///
    /// The closure receives the current state (default if missing) and may
    /// mutate any fields; unknown fields in `extra` are preserved so we
    /// never drop data we don't yet model. Runs inside a single write txn.
    pub fn update_sync_state<F>(&self, account_id: &str, f: F) -> Result<()>
    where
        F: FnOnce(&mut SyncState),
    {
        self.with_write(|conn| {
            let current: Option<String> = conn
                .query_row(
                    "SELECT sync_state FROM accounts WHERE id = ?1",
                    rusqlite::params![account_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();
            let mut state = SyncState::from_json_opt(current.as_deref())?;
            f(&mut state);
            let new_json = state.to_json()?;
            let now = pebble_core::now_timestamp();
            conn.execute(
                "UPDATE accounts SET sync_state = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![new_json, now, account_id],
            )?;
            Ok(())
        })
    }

    /// Get the sync cursor for an account. Thin wrapper over [`get_sync_state`].
    pub fn get_sync_cursor(&self, account_id: &str) -> Result<Option<String>> {
        Ok(self
            .get_sync_state(account_id)?
            .and_then(|s| s.last_sync_cursor))
    }

    /// Set the sync cursor in the sync_state JSON without clobbering other fields.
    pub fn set_sync_cursor(&self, account_id: &str, cursor: &str) -> Result<()> {
        self.update_sync_state(account_id, |s| {
            s.last_sync_cursor = Some(cursor.to_string());
        })
    }

    pub fn get_folder_sync_state(
        &self,
        account_id: &str,
        folder_id: &str,
    ) -> Result<Option<String>> {
        self.with_read(|conn| {
            let state = conn
                .query_row(
                    "SELECT state FROM folder_sync_state
                     WHERE account_id = ?1 AND folder_id = ?2",
                    rusqlite::params![account_id, folder_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            Ok(state)
        })
    }

    pub fn set_folder_sync_state(
        &self,
        account_id: &str,
        folder_id: &str,
        state: &str,
    ) -> Result<()> {
        self.with_write(|conn| {
            conn.execute(
                "INSERT INTO folder_sync_state (account_id, folder_id, state, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(account_id, folder_id) DO UPDATE SET
                    state = excluded.state,
                    updated_at = excluded.updated_at",
                rusqlite::params![account_id, folder_id, state, pebble_core::now_timestamp()],
            )?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod cursor_tests {
    use crate::Store;
    use pebble_core::*;

    fn test_account() -> Account {
        Account {
            id: new_id(),
            email: "test@example.com".to_string(),
            display_name: "Test".to_string(),
            color: None,
            provider: ProviderType::Imap,
            created_at: now_timestamp(),
            updated_at: now_timestamp(),
        }
    }

    #[test]
    fn test_set_and_get_sync_cursor() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();

        store.set_sync_cursor(&account.id, "12345").unwrap();
        let cursor = store.get_sync_cursor(&account.id).unwrap();
        assert_eq!(cursor, Some("12345".to_string()));
    }

    #[test]
    fn test_get_sync_cursor_returns_none() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();

        let cursor = store.get_sync_cursor(&account.id).unwrap();
        assert!(cursor.is_none());
    }

    #[test]
    fn sender_identity_survives_local_rename_and_cursor_updates() {
        let store=Store::open_in_memory().unwrap(); let account=test_account(); store.insert_account(&account).unwrap();
        store.set_sync_cursor(&account.id,"cursor-1").unwrap();
        store.update_account(&account.id,&account.email,"Local label",None).unwrap();
        assert_eq!(store.account_sender_name(&account.id).unwrap(),account.display_name);
        store.update_account_with_sender(&account.id,&account.email,"Another label",None,Some("Public Team")).unwrap();
        store.set_sync_cursor(&account.id,"cursor-2").unwrap();
        assert_eq!(store.account_sender_name(&account.id).unwrap(),"Public Team");
        assert_eq!(store.get_sync_cursor(&account.id).unwrap().as_deref(),Some("cursor-2"));
        assert!(store.update_account_with_sender(&account.id,&account.email,"Bad",None,Some("Bad\r\nBcc: injected@example.com")).is_err());
        assert_eq!(store.account_sender_name(&account.id).unwrap(),"Public Team");
    }

    #[test]
    fn sender_identity_oauth_mailbox_cannot_be_reassigned_by_editing_label() {
        let store=Store::open_in_memory().unwrap(); let mut account=test_account(); account.provider=ProviderType::Gmail; store.insert_account(&account).unwrap();
        assert!(store.update_account(&account.id,"other@example.com","Label",None).is_err());
        assert_eq!(store.get_account(&account.id).unwrap().unwrap().email,account.email);
    }

    #[test]
    fn sender_identity_oauth_subject_is_bound_without_clobbering_sync_state() {
        let store=Store::open_in_memory().unwrap(); let mut account=test_account();account.provider=ProviderType::Outlook;store.insert_account(&account).unwrap();
        store.set_sync_cursor(&account.id,"cursor").unwrap();
        assert!(store.bind_oauth_sender_identity(&account.id,&account.email,"").is_err());
        store.bind_oauth_sender_identity(&account.id,&account.email,"provider-subject-1").unwrap();
        store.bind_oauth_sender_identity(&account.id,&account.email,"provider-subject-1").unwrap();
        assert!(store.bind_oauth_sender_identity(&account.id,&account.email,"provider-subject-2").is_err());
        assert!(store.bind_oauth_sender_identity(&account.id,"other@example.com","provider-subject-1").is_err());
        store.update_account(&account.id,&account.email,"Private Label",None).unwrap();
        assert_eq!(store.get_sync_cursor(&account.id).unwrap().as_deref(),Some("cursor"));
        assert_eq!(store.get_sync_state(&account.id).unwrap().unwrap().extra["sender_oauth_subject"],"provider-subject-1");
    }

    #[test]
    fn test_set_cursor_preserves_other_fields() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();

        // Set initial sync_state with some data
        store
            .update_account_sync_state(&account.id, r#"{"provider":"imap","foo":"bar"}"#)
            .unwrap();

        // Set cursor
        store.set_sync_cursor(&account.id, "999").unwrap();

        // Verify cursor is set
        let cursor = store.get_sync_cursor(&account.id).unwrap();
        assert_eq!(cursor, Some("999".to_string()));

        // Verify other fields preserved
        let state = store.get_account_sync_state(&account.id).unwrap().unwrap();
        let value: serde_json::Value = serde_json::from_str(&state).unwrap();
        assert_eq!(value["foo"], "bar");
        assert_eq!(value["provider"], "imap");
    }

    #[test]
    fn test_account_color_is_persisted_and_updated() {
        let store = Store::open_in_memory().unwrap();
        let mut account = test_account();
        account.color = Some("#22c55e".to_string());
        store.insert_account(&account).unwrap();

        let loaded = store.get_account(&account.id).unwrap().unwrap();
        assert_eq!(loaded.color.as_deref(), Some("#22c55e"));

        store
            .update_account(
                &account.id,
                "renamed@example.com",
                "Renamed",
                Some("#f97316"),
            )
            .unwrap();

        let updated = store.get_account(&account.id).unwrap().unwrap();
        assert_eq!(updated.email, "renamed@example.com");
        assert_eq!(updated.color.as_deref(), Some("#f97316"));
    }
}

#[cfg(test)]
mod folder_sync_state_tests {
    use crate::Store;
    use pebble_core::*;

    fn test_account() -> Account {
        Account {
            id: new_id(),
            email: "test@example.com".to_string(),
            display_name: "Test".to_string(),
            color: None,
            provider: ProviderType::Imap,
            created_at: now_timestamp(),
            updated_at: now_timestamp(),
        }
    }

    fn test_folder(account_id: &str, remote_id: &str, role: FolderRole, sort_order: i32) -> Folder {
        Folder {
            id: new_id(),
            account_id: account_id.to_string(),
            remote_id: remote_id.to_string(),
            name: remote_id.to_string(),
            folder_type: FolderType::Folder,
            role: Some(role),
            parent_id: None,
            color: None,
            is_system: true,
            sort_order,
        }
    }

    #[test]
    fn folder_sync_state_is_scoped_by_account_and_folder() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let inbox = test_folder(&account.id, "INBOX", FolderRole::Inbox, 0);
        let sent = test_folder(&account.id, "Sent", FolderRole::Sent, 1);
        store.insert_folder(&inbox).unwrap();
        store.insert_folder(&sent).unwrap();

        store
            .set_folder_sync_state(&account.id, &inbox.id, r#"{"last_uid":10}"#)
            .unwrap();
        store
            .set_folder_sync_state(&account.id, &sent.id, r#"{"last_uid":20}"#)
            .unwrap();

        assert_eq!(
            store.get_folder_sync_state(&account.id, &inbox.id).unwrap(),
            Some(r#"{"last_uid":10}"#.to_string())
        );
        assert_eq!(
            store.get_folder_sync_state(&account.id, &sent.id).unwrap(),
            Some(r#"{"last_uid":20}"#.to_string())
        );
    }

    #[test]
    fn folder_sync_state_returns_none_when_missing() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let inbox = test_folder(&account.id, "INBOX", FolderRole::Inbox, 0);
        store.insert_folder(&inbox).unwrap();

        assert_eq!(
            store.get_folder_sync_state(&account.id, &inbox.id).unwrap(),
            None
        );
    }
}
