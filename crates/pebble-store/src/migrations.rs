use pebble_core::{build_snippet, PebbleError, Result};
use rusqlite::{Connection, OptionalExtension};
use std::collections::HashSet;

// Keep this in sync with the last migration below. The project already has
// V16-V18 migrations; leaving this at 15 makes version bookkeeping report a
// stale schema and makes future migration behavior ambiguous.
const CURRENT_VERSION: u32 = 22;
const ACCOUNT_COLOR_PRESETS: [&str; 12] = [
    "#0ea5e9", "#22c55e", "#f59e0b", "#8b5cf6", "#f43f5e", "#14b8a6", "#6366f1", "#f97316",
    "#06b6d4", "#ec4899", "#84cc16", "#3b82f6",
];

fn get_schema_version(conn: &Connection) -> u32 {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap_or(0)
}

fn set_schema_version(conn: &Connection, version: u32) -> Result<()> {
    conn.pragma_update(None, "user_version", version)
        .map_err(|e| PebbleError::Storage(format!("Failed to set schema version: {e}")))
}

fn is_valid_account_color(color: &str) -> bool {
    color.len() == 7
        && color.as_bytes()[0] == b'#'
        && color.as_bytes()[1..].iter().all(|b| b.is_ascii_hexdigit())
}

fn derive_account_color(seed: &str) -> String {
    let mut hash = 0u32;
    for byte in seed.bytes() {
        hash = hash.wrapping_mul(31).wrapping_add(byte as u32);
    }
    ACCOUNT_COLOR_PRESETS[(hash as usize) % ACCOUNT_COLOR_PRESETS.len()].to_string()
}

fn backfill_account_colors(conn: &Connection) -> Result<()> {
    let accounts = {
        let mut stmt =
            conn.prepare("SELECT id, color FROM accounts ORDER BY created_at ASC, id ASC")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;
        let mut accounts = Vec::new();
        for row in rows {
            accounts.push(row?);
        }
        accounts
    };

    let mut used_colors: HashSet<String> = accounts
        .iter()
        .filter_map(|(_, color)| color.as_deref())
        .filter(|color| is_valid_account_color(color))
        .map(str::to_ascii_lowercase)
        .collect();

    for (id, color) in accounts {
        if color.as_deref().is_some_and(is_valid_account_color) {
            continue;
        }

        let selected = ACCOUNT_COLOR_PRESETS
            .iter()
            .find(|candidate| !used_colors.contains(**candidate))
            .map(|color| (*color).to_string())
            .unwrap_or_else(|| derive_account_color(&id));
        used_colors.insert(selected.clone());
        conn.execute(
            "UPDATE accounts SET color = ?1 WHERE id = ?2",
            rusqlite::params![selected, id],
        )?;
    }

    Ok(())
}

fn accounts_provider_check_allows_pop3(conn: &Connection) -> Result<bool> {
    let sql: String = conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'",
        [],
        |row| row.get(0),
    )?;
    Ok(sql.contains("'pop3'"))
}

fn rebuild_accounts_with_pop3_provider(conn: &Connection) -> Result<()> {
    if conn
        .prepare("SELECT auth_data FROM accounts LIMIT 0")
        .is_err()
    {
        conn.execute_batch("ALTER TABLE accounts ADD COLUMN auth_data BLOB;")
            .map_err(|e| {
                PebbleError::Storage(format!("Migration V12 auth_data column failed: {e}"))
            })?;
    }
    if conn
        .prepare("SELECT sync_state FROM accounts LIMIT 0")
        .is_err()
    {
        conn.execute_batch("ALTER TABLE accounts ADD COLUMN sync_state TEXT;")
            .map_err(|e| {
                PebbleError::Storage(format!("Migration V12 sync_state column failed: {e}"))
            })?;
    }

    conn.execute_batch(
        "CREATE TABLE accounts_new (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            display_name TEXT NOT NULL DEFAULT '',
            color TEXT,
            provider TEXT NOT NULL CHECK(provider IN ('imap', 'pop3', 'gmail', 'outlook')),
            auth_data BLOB,
            sync_state TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        INSERT INTO accounts_new (id, email, display_name, color, provider, auth_data, sync_state, created_at, updated_at)
            SELECT id, email, display_name, color, provider, auth_data, sync_state, created_at, updated_at
            FROM accounts;
        DROP TABLE accounts;
        ALTER TABLE accounts_new RENAME TO accounts;",
    )
    .map_err(|e| PebbleError::Storage(format!("Migration V12 failed: {e}")))?;
    Ok(())
}

fn rebuild_snippets(conn: &Connection) -> Result<()> {
    let mut stmt = match conn.prepare("SELECT id, body_text, body_html_raw FROM messages") {
        Ok(s) => s,
        Err(_) => return Ok(()),
    };
    let rows: Vec<(String, String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| PebbleError::Storage(format!("V13 query failed: {e}")))?
        .filter_map(|r| r.ok())
        .collect();

    let mut update = conn
        .prepare("UPDATE messages SET snippet = ?1 WHERE id = ?2")
        .map_err(|e| PebbleError::Storage(format!("V13 prepare update failed: {e}")))?;
    for (id, body_text, body_html) in &rows {
        let new_snippet = build_snippet(body_text, body_html);
        update
            .execute(rusqlite::params![new_snippet, id])
            .map_err(|e| PebbleError::Storage(format!("V13 update failed: {e}")))?;
    }
    Ok(())
}

pub fn run_migrations(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    conn.execute_batch("PRAGMA synchronous=NORMAL;")?;

    conn.execute_batch("PRAGMA foreign_keys=ON;")?;

    conn.execute_batch("PRAGMA busy_timeout=5000;")?;

    let version = get_schema_version(conn);

    // Each migration is wrapped in a transaction so that the DDL and version
    // update are atomic; a crash mid-migration won't leave an inconsistent state.

    if version < 1 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V1 begin failed: {e}")))?;
        tx.execute_batch(SCHEMA_V1)
            .map_err(|e| PebbleError::Storage(format!("Migration V1 failed: {e}")))?;
        set_schema_version(&tx, 1)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V1 commit failed: {e}")))?;
    }

    if version < 2 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V2 begin failed: {e}")))?;
        let has_content_id: bool = tx
            .prepare("SELECT content_id FROM attachments LIMIT 0")
            .is_ok();
        if !has_content_id {
            tx.execute_batch(
                "ALTER TABLE attachments ADD COLUMN content_id TEXT;
                 ALTER TABLE attachments ADD COLUMN is_inline INTEGER NOT NULL DEFAULT 0;",
            )
            .map_err(|e| PebbleError::Storage(format!("Migration V2 failed: {e}")))?;
        }
        set_schema_version(&tx, 2)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V2 commit failed: {e}")))?;
    }

    if version < 3 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V3 begin failed: {e}")))?;
        tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_messages_account_remote ON messages(account_id, remote_id);
             CREATE INDEX IF NOT EXISTS idx_snoozed_unsnoozed_at ON snoozed_messages(unsnoozed_at);
             CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_account_remote ON folders(account_id, remote_id);"
        )
        .map_err(|e| PebbleError::Storage(format!("Migration V3 failed: {e}")))?;
        set_schema_version(&tx, 3)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V3 commit failed: {e}")))?;
    }

    if version < 4 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V4 begin failed: {e}")))?;
        tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_message_folders_folder_id ON message_folders(folder_id);
             CREATE INDEX IF NOT EXISTS idx_messages_account_starred ON messages(account_id, is_starred) WHERE is_starred = 1 AND is_deleted = 0;
             CREATE INDEX IF NOT EXISTS idx_messages_thread_date ON messages(thread_id, date) WHERE thread_id IS NOT NULL AND is_deleted = 0;"
        )
        .map_err(|e| PebbleError::Storage(format!("Migration V4 failed: {e}")))?;
        set_schema_version(&tx, 4)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V4 commit failed: {e}")))?;
    }

    if version < 5 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V5 begin failed: {e}")))?;
        tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_mf_folder_message ON message_folders(folder_id, message_id);",
        )
        .map_err(|e| PebbleError::Storage(format!("Migration V5 failed: {e}")))?;
        set_schema_version(&tx, 5)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V5 commit failed: {e}")))?;
    }

    // V6: search_pending table for crash-recovery of the search index
    if version < 6 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V6 begin failed: {e}")))?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS search_pending (
                 message_id TEXT PRIMARY KEY,
                 operation TEXT NOT NULL CHECK(operation IN ('index', 'remove')),
                 created_at INTEGER NOT NULL
             );",
        )
        .map_err(|e| PebbleError::Storage(format!("Migration V6 failed: {e}")))?;
        set_schema_version(&tx, 6)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V6 commit failed: {e}")))?;
    }

    if version < 7 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V7 begin failed: {e}")))?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS folder_sync_state (
                 account_id TEXT NOT NULL,
                 folder_id TEXT NOT NULL,
                 state TEXT NOT NULL,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY (account_id, folder_id),
                 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
                 FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE
             );",
        )
        .map_err(|e| PebbleError::Storage(format!("Migration V7 failed: {e}")))?;
        set_schema_version(&tx, 7)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V7 commit failed: {e}")))?;
    }

    if version < 8 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V8 begin failed: {e}")))?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS sync_failures (
                 account_id TEXT NOT NULL,
                 folder_id TEXT NOT NULL,
                 remote_id TEXT NOT NULL,
                 provider TEXT NOT NULL,
                 reason TEXT NOT NULL,
                 attempts INTEGER NOT NULL DEFAULT 1,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY (account_id, folder_id, remote_id),
                 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
                 FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS idx_sync_failures_folder
                 ON sync_failures(account_id, folder_id);",
        )
        .map_err(|e| PebbleError::Storage(format!("Migration V8 failed: {e}")))?;
        set_schema_version(&tx, 8)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V8 commit failed: {e}")))?;
    }

    if version < 9 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V9 begin failed: {e}")))?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS pending_mail_ops (
                 id TEXT PRIMARY KEY,
                 account_id TEXT NOT NULL,
                 message_id TEXT NOT NULL,
                 op_type TEXT NOT NULL,
                 payload_json TEXT NOT NULL,
                 status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'failed', 'done')),
                 attempts INTEGER NOT NULL DEFAULT 0,
                 last_error TEXT,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_pending_mail_ops_account_status
                 ON pending_mail_ops(account_id, status, updated_at);",
        )
        .map_err(|e| PebbleError::Storage(format!("Migration V9 failed: {e}")))?;
        set_schema_version(&tx, 9)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V9 commit failed: {e}")))?;
    }

    if version < 10 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V10 begin failed: {e}")))?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS secure_user_data (
                 key TEXT PRIMARY KEY,
                 value BLOB NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             ALTER TABLE pending_mail_ops ADD COLUMN next_retry_at INTEGER;
             CREATE INDEX IF NOT EXISTS idx_pending_mail_ops_retry
                 ON pending_mail_ops(status, next_retry_at, updated_at);",
        )
        .map_err(|e| PebbleError::Storage(format!("Migration V10 failed: {e}")))?;
        set_schema_version(&tx, 10)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V10 commit failed: {e}")))?;
    }

    if version < 11 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V11 begin failed: {e}")))?;
        let has_color: bool = tx.prepare("SELECT color FROM accounts LIMIT 0").is_ok();
        if !has_color {
            tx.execute_batch("ALTER TABLE accounts ADD COLUMN color TEXT;")
                .map_err(|e| PebbleError::Storage(format!("Migration V11 failed: {e}")))?;
        }
        backfill_account_colors(&tx)?;
        set_schema_version(&tx, CURRENT_VERSION)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V11 commit failed: {e}")))?;
    }

    if version < 12 {
        conn.execute_batch("PRAGMA foreign_keys=OFF;")
            .map_err(|e| PebbleError::Storage(format!("Migration V12 disable FK failed: {e}")))?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V12 begin failed: {e}")))?;
        if !accounts_provider_check_allows_pop3(&tx)? {
            rebuild_accounts_with_pop3_provider(&tx)?;
        }
        set_schema_version(&tx, CURRENT_VERSION)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V12 commit failed: {e}")))?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(|e| PebbleError::Storage(format!("Migration V12 enable FK failed: {e}")))?;
        let fk_violations: i64 = conn
            .query_row("PRAGMA foreign_key_check", [], |_| Ok(1))
            .optional()
            .map_err(|e| PebbleError::Storage(format!("Migration V12 FK check failed: {e}")))?
            .unwrap_or(0);
        if fk_violations != 0 {
            return Err(PebbleError::Storage(
                "Migration V12 introduced foreign key violations".to_string(),
            ));
        }
    }

    // V13: rebuild snippets to strip leaked HTML/CSS from previews
    if version < 13 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V13 begin failed: {e}")))?;
        rebuild_snippets(&tx)?;
        set_schema_version(&tx, CURRENT_VERSION)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V13 commit failed: {e}")))?;
    }

    // V14: enforce at most one LIVE row per (account_id, remote_id). The legacy
    // idx_messages_account_remote index was non-unique, so a soft-delete followed
    // by a re-sync that re-fetched the same remote_id inserted a second row
    // (tombstone + new live copy). Deduplicate existing live rows first, then
    // replace the index with a partial UNIQUE index scoped to is_deleted = 0 so
    // tombstones (is_deleted = 1) can still coexist with a fresh live copy.
    if version < 14 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V14 begin failed: {e}")))?;
        // The messages table always exists in production (created in SCHEMA_V1).
        // Guard the dedup/index so the migration is a no-op on the minimal
        // schemas used by migration unit tests that omit messages — and is
        // harmless if a future store variant lacks it.
        let messages_count: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='messages'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if messages_count > 0 {
            tx.execute_batch(
                "DELETE FROM messages
                 WHERE is_deleted = 0
                   AND id NOT IN (
                     SELECT MIN(id) FROM messages WHERE is_deleted = 0 GROUP BY account_id, remote_id
                   );
                 DROP INDEX IF EXISTS idx_messages_account_remote;
                 CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_account_remote_unique
                   ON messages(account_id, remote_id) WHERE is_deleted = 0;",
            )
            .map_err(|e| PebbleError::Storage(format!("Migration V14 failed: {e}")))?;
        }
        set_schema_version(&tx, 14)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V14 commit failed: {e}")))?;
    }

    // V15: IMAP UIDs are unique only inside one mailbox. The V14 account-wide
    // unique index caused different folders (for example INBOX and Sent) to
    // collide whenever they reused the same UID. Keep a normal lookup index;
    // folder-scoped deduplication is handled through message_folders.
    if version < 15 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V15 begin failed: {e}")))?;
        tx.execute_batch(
            "DROP INDEX IF EXISTS idx_messages_account_remote_unique;
             DROP INDEX IF EXISTS idx_messages_account_remote;
             CREATE INDEX IF NOT EXISTS idx_messages_account_remote
               ON messages(account_id, remote_id);",
        )
        .map_err(|e| PebbleError::Storage(format!("Migration V15 failed: {e}")))?;
        set_schema_version(&tx, 15)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V15 commit failed: {e}")))?;
    }

    // V16: 附件按需下载——attachments 加 remote_part（IMAP BODY part 路径）。
    // 大邮件不再整体拉取（45s 超时），正文与附件分离：附件元数据先入库
    // （local_path 为空），点击时按 remote_part 从服务器拉取该 part。
    if version < 16 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V16 begin failed: {e}")))?;
        let has_remote_part: bool = tx
            .prepare("SELECT remote_part FROM attachments LIMIT 0")
            .is_ok();
        if !has_remote_part {
            tx.execute_batch("ALTER TABLE attachments ADD COLUMN remote_part TEXT;")
                .map_err(|e| PebbleError::Storage(format!("Migration V16 failed: {e}")))?;
        }
        set_schema_version(&tx, 16)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V16 commit failed: {e}")))?;
    }

    if version < 17 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V17 begin failed: {e}")))?;
        // 修复历史 bug：IMAP 文件夹发现曾把文件夹一律硬编码 is_system=1，
        // 导致用户自定义文件夹（客户分类、项目分类、废纸子文件夹等）
        // 被当成系统文件夹，右键菜单无法删除/重命名。
        // 只有带系统角色（inbox/sent/trash 等）的文件夹才算系统文件夹。
        tx.execute_batch("UPDATE folders SET is_system = 0 WHERE is_system = 1 AND role IS NULL;")
            .map_err(|e| PebbleError::Storage(format!("Migration V17 failed: {e}")))?;
        set_schema_version(&tx, 17)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V17 commit failed: {e}")))?;
    }

    if version < 18 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V18 begin failed: {e}")))?;
        // 规则按账号管理：rules 表加 account_id 列（NULL=所有账号兼容旧数据），
        // 同步新增 trigger_when 字段（暂存 JSON 文本，类型由前端定义）。
        let has_account_id: bool = tx
            .prepare("SELECT account_id FROM rules LIMIT 0")
            .is_ok();
        if !has_account_id {
            tx.execute_batch("ALTER TABLE rules ADD COLUMN account_id TEXT;")
                .map_err(|e| PebbleError::Storage(format!("Migration V18 failed: {e}")))?;
        }
        let has_trigger_when: bool = tx
            .prepare("SELECT trigger_when FROM rules LIMIT 0")
            .is_ok();
        if !has_trigger_when {
            tx.execute_batch("ALTER TABLE rules ADD COLUMN trigger_when TEXT NOT NULL DEFAULT '[]';")
                .map_err(|e| PebbleError::Storage(format!("Migration V18 trigger_when failed: {e}")))?;
        }
        tx.execute_batch("CREATE INDEX IF NOT EXISTS idx_rules_account_id ON rules(account_id);")
            .map_err(|e| PebbleError::Storage(format!("Migration V18 index failed: {e}")))?;
        set_schema_version(&tx, 18)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V18 commit failed: {e}")))?;
    }

    // V19: durable full-body hydration queue. The old implementation inferred
    // pending work from messages.remote_version = 'headers-only'. Keep that
    // field for compatibility, but persist attempts, priority and retry time
    // so a restart cannot lose the download backlog or repeatedly hammer a
    // failing mailbox.
    if version < 19 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V19 begin failed: {e}")))?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS body_download_jobs (
                message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
                account_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                priority INTEGER NOT NULL DEFAULT 100,
                attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt_at INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_body_jobs_ready
                ON body_download_jobs(account_id, status, priority, next_attempt_at);
            INSERT OR IGNORE INTO body_download_jobs
                (message_id, account_id, status, priority, attempts, next_attempt_at, created_at, updated_at)
                SELECT id, account_id, 'pending', 100, 0, 0, created_at, updated_at
                FROM messages
                WHERE remote_version = 'headers-only' AND is_deleted = 0;",
        )
        .map_err(|e| PebbleError::Storage(format!("Migration V19 failed: {e}")))?;
        set_schema_version(&tx, 19)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V19 commit failed: {e}")))?;
    }

    // V20: reply annotation runs for every visible message page. Index the
    // lookup columns so opening a large folder does not scan the whole table.
    if version < 20 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V20 begin failed: {e}")))?;
        tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_messages_account_in_reply_to
             ON messages(account_id, in_reply_to)
             WHERE is_deleted = 0 AND is_draft = 0;",
        )
        .map_err(|e| PebbleError::Storage(format!("Migration V20 failed: {e}")))?;
        set_schema_version(&tx, 20)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V20 commit failed: {e}")))?;
    }

    // V21: IMAP MOVE assigns a new UID in the destination mailbox. A
    // composite Message-ID lookup lets sync cheaply rebind locally moved
    // messages to that destination UID and collapse legacy duplicate rows.
    if version < 21 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V21 begin failed: {e}")))?;
        tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_messages_account_message_id_live
             ON messages(account_id, message_id_header)
             WHERE is_deleted = 0 AND message_id_header IS NOT NULL;",
        )
        .map_err(|e| PebbleError::Storage(format!("Migration V21 failed: {e}")))?;
        set_schema_version(&tx, 21)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V21 commit failed: {e}")))?;
    }

    // V22: old workers could leave body jobs active after their message was
    // soft-deleted or hydrated through another path. They were harmless but
    // made diagnostics noisy and could be reclaimed after a restart.
    if version < 22 {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PebbleError::Storage(format!("Migration V22 begin failed: {e}")))?;
        tx.execute_batch(
            "UPDATE body_download_jobs
             SET status = 'done', updated_at = unixepoch()
             WHERE message_id IN (
               SELECT id FROM messages
               WHERE is_deleted = 1 OR remote_version IS NULL OR remote_version <> 'headers-only'
             );",
        )
        .map_err(|e| PebbleError::Storage(format!("Migration V22 failed: {e}")))?;
        set_schema_version(&tx, 22)?;
        tx.commit()
            .map_err(|e| PebbleError::Storage(format!("Migration V22 commit failed: {e}")))?;
    }

    Ok(())
}

const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    color TEXT,
    provider TEXT NOT NULL CHECK(provider IN ('imap', 'pop3', 'gmail', 'outlook')),
    auth_data BLOB,
    sync_state TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    name TEXT NOT NULL,
    folder_type TEXT NOT NULL CHECK(folder_type IN ('folder', 'label', 'category')),
    role TEXT CHECK(role IN ('inbox', 'sent', 'drafts', 'trash', 'archive', 'spam')),
    parent_id TEXT,
    color TEXT,
    is_system INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_folders_account ON folders(account_id);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    message_id_header TEXT,
    in_reply_to TEXT,
    references_header TEXT,
    thread_id TEXT,
    subject TEXT NOT NULL DEFAULT '',
    snippet TEXT NOT NULL DEFAULT '',
    from_address TEXT NOT NULL DEFAULT '',
    from_name TEXT NOT NULL DEFAULT '',
    to_list TEXT NOT NULL DEFAULT '[]',
    cc_list TEXT NOT NULL DEFAULT '[]',
    bcc_list TEXT NOT NULL DEFAULT '[]',
    body_text TEXT NOT NULL DEFAULT '',
    body_html_raw TEXT NOT NULL DEFAULT '',
    has_attachments INTEGER NOT NULL DEFAULT 0,
    is_read INTEGER NOT NULL DEFAULT 0,
    is_starred INTEGER NOT NULL DEFAULT 0,
    is_draft INTEGER NOT NULL DEFAULT 0,
    date INTEGER NOT NULL,
    raw_headers TEXT,
    remote_version TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date);
CREATE INDEX IF NOT EXISTS idx_messages_message_id_header ON messages(message_id_header);

CREATE TABLE IF NOT EXISTS message_folders (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, folder_id)
);

CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    filename TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    local_path TEXT,
    content_id TEXT,
    is_inline INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS labels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#808080',
    is_system INTEGER NOT NULL DEFAULT 0,
    rule_id TEXT
);

CREATE TABLE IF NOT EXISTS message_labels (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, label_id)
);

CREATE TABLE IF NOT EXISTS kanban_cards (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    column_name TEXT NOT NULL CHECK(column_name IN ('todo', 'waiting', 'done')),
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snoozed_messages (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    snoozed_at INTEGER NOT NULL,
    unsnoozed_at INTEGER NOT NULL,
    return_to TEXT NOT NULL DEFAULT 'inbox'
);

CREATE TABLE IF NOT EXISTS trusted_senders (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    trust_type TEXT NOT NULL CHECK(trust_type IN ('images', 'all')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, email)
);

CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    conditions TEXT NOT NULL DEFAULT '{}',
    actions TEXT NOT NULL DEFAULT '[]',
    is_enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS translate_config (
    id TEXT PRIMARY KEY DEFAULT 'active',
    provider_type TEXT NOT NULL CHECK(provider_type IN ('deeplx', 'deepl', 'generic_api', 'llm')),
    config TEXT NOT NULL DEFAULT '{}',
    is_enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_v11_adds_account_color_and_sets_schema_version() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE accounts (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                provider TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            PRAGMA user_version = 10;",
        )
        .unwrap();

        run_migrations(&conn).unwrap();

        let version: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_VERSION);
        conn.prepare("SELECT color FROM accounts LIMIT 0")
            .expect("accounts.color should exist after V11");
    }

    #[test]
    fn migration_v14_dedups_live_rows_and_enforces_partial_unique_index() {
        let conn = Connection::open_in_memory().unwrap();
        // Minimal messages shape at the V13 boundary: only the columns V14
        // touches. run_migrations from user_version=13 runs just the V14 block.
        conn.execute_batch(
            "CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                account_id TEXT NOT NULL,
                remote_id TEXT NOT NULL,
                is_deleted INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX idx_messages_account_remote ON messages(account_id, remote_id);
            PRAGMA user_version = 13;",
        )
        .unwrap();

        // Two LIVE duplicates of the same remote message, one tombstone for it,
        // and one unrelated live row.
        conn.execute_batch(
            "INSERT INTO messages (id, account_id, remote_id, is_deleted) VALUES
                ('m-dup-a', 'acct', 'UID:42', 0),
                ('m-dup-b', 'acct', 'UID:42', 0),
                ('m-tomb',  'acct', 'UID:42', 1),
                ('m-other', 'acct', 'UID:99', 0);",
        )
        .unwrap();

        run_migrations(&conn).unwrap();

        let version: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_VERSION);

        // Duplicate live rows collapse to one; the tombstone survives; the
        // unrelated live row is untouched.
        let live_42: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE account_id='acct' AND remote_id='UID:42' AND is_deleted=0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(live_42, 1, "duplicate live rows should be collapsed to one");

        let tomb_survives: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE id='m-tomb'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tomb_survives, 1, "tombstone must not be removed by dedup");

        // Partial unique index: a second LIVE row with the same key is rejected,
        // but an additional tombstone (is_deleted=1) is still allowed.
        let dup_live = conn.execute(
            "INSERT INTO messages (id, account_id, remote_id, is_deleted) VALUES ('m-extra','acct','UID:42',0)",
            [],
        );
        assert!(
            dup_live.is_err(),
            "second live row must be rejected by the partial unique index"
        );

        let dup_tomb = conn.execute(
            "INSERT INTO messages (id, account_id, remote_id, is_deleted) VALUES ('m-tomb2','acct','UID:42',1)",
            [],
        );
        assert!(
            dup_tomb.is_ok(),
            "additional tombstone must be allowed alongside one live row"
        );
    }

    #[test]
    fn migration_v11_backfills_existing_account_colors() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE accounts (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                provider TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO accounts (id, email, display_name, provider, created_at, updated_at)
            VALUES
                ('account-1', 'one@example.com', 'One', 'gmail', 1, 1),
                ('account-2', 'two@example.com', 'Two', 'gmail', 2, 2);
            PRAGMA user_version = 10;",
        )
        .unwrap();

        run_migrations(&conn).unwrap();

        let mut stmt = conn
            .prepare("SELECT color FROM accounts ORDER BY created_at ASC")
            .unwrap();
        let colors = stmt
            .query_map([], |row| row.get::<_, Option<String>>(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            colors,
            vec![Some("#0ea5e9".to_string()), Some("#22c55e".to_string())]
        );
    }

    #[test]
    fn migration_v12_allows_pop3_provider_without_breaking_foreign_keys() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
            CREATE TABLE accounts (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                color TEXT,
                provider TEXT NOT NULL CHECK(provider IN ('imap', 'gmail', 'outlook')),
                auth_data BLOB,
                sync_state TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE folders (
                id TEXT PRIMARY KEY,
                account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                remote_id TEXT NOT NULL,
                name TEXT NOT NULL,
                folder_type TEXT NOT NULL CHECK(folder_type IN ('folder', 'label', 'category')),
                role TEXT CHECK(role IN ('inbox', 'sent', 'drafts', 'trash', 'archive', 'spam')),
                parent_id TEXT,
                color TEXT,
                is_system INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO accounts (id, email, display_name, color, provider, created_at, updated_at)
                VALUES ('account-1', 'one@example.com', 'One', '#0ea5e9', 'imap', 1, 1);
            INSERT INTO folders (id, account_id, remote_id, name, folder_type, role, is_system, sort_order)
                VALUES ('folder-1', 'account-1', 'INBOX', 'Inbox', 'folder', 'inbox', 1, 0);
            PRAGMA user_version = 11;",
        )
        .unwrap();

        run_migrations(&conn).unwrap();

        let version: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_VERSION);
        conn.execute(
            "INSERT INTO accounts (id, email, display_name, provider, created_at, updated_at)
                VALUES ('account-2', 'two@example.com', 'Two', 'pop3', 2, 2)",
            [],
        )
        .expect("accounts.provider should accept pop3 after V12");
        let folder_account: String = conn
            .query_row(
                "SELECT account_id FROM folders WHERE id = 'folder-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(folder_account, "account-1");
        let fk_issue = conn
            .query_row("PRAGMA foreign_key_check", [], |_| Ok(()))
            .optional()
            .unwrap();
        assert!(fk_issue.is_none());
    }
}
