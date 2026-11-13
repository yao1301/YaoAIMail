use pebble_core::{Folder, Message, PebbleError, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::json;

use crate::{local_messages::is_local_message_id, Store};

pub const MAX_PENDING_MAIL_OP_ATTEMPTS: i64 = 8;
const BASE_RETRY_DELAY_SECS: i64 = 60;
const MAX_RETRY_DELAY_SECS: i64 = 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingMailOpStatus {
    Pending,
    InProgress,
    Failed,
    Done,
}

impl PendingMailOpStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Failed => "failed",
            Self::Done => "done",
        }
    }
}

fn status_from_str(value: &str) -> Result<PendingMailOpStatus> {
    match value {
        "pending" => Ok(PendingMailOpStatus::Pending),
        "in_progress" => Ok(PendingMailOpStatus::InProgress),
        "failed" => Ok(PendingMailOpStatus::Failed),
        "done" => Ok(PendingMailOpStatus::Done),
        other => Err(PebbleError::Storage(format!(
            "Invalid pending mail op status: {other}"
        ))),
    }
}

fn pending_mail_retry_delay_secs(attempts: i64) -> i64 {
    let exponent = attempts.saturating_sub(1).clamp(0, 10) as u32;
    BASE_RETRY_DELAY_SECS
        .saturating_mul(2_i64.saturating_pow(exponent))
        .min(MAX_RETRY_DELAY_SECS)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingMailOp {
    pub id: String,
    pub account_id: String,
    pub message_id: String,
    pub op_type: String,
    pub payload_json: String,
    pub status: PendingMailOpStatus,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub next_retry_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingMailOpsSummary {
    pub pending_count: i64,
    pub in_progress_count: i64,
    pub failed_count: i64,
    pub total_active_count: i64,
    pub last_error: Option<String>,
    pub updated_at: Option<i64>,
    pub last_error_operation_id: Option<String>,
    pub last_error_account_id: Option<String>,
    pub last_error_op_type: Option<String>,
}

impl Store {
    pub fn send_was_accepted(&self, id: &str) -> Result<bool> {
        self.with_read(|conn| Ok(conn.query_row("SELECT coalesce(json_extract(payload_json,'$.provider_accepted'),0)=1
            FROM pending_mail_ops WHERE id=?1 AND op_type='send'",[id],|r|r.get(0)).optional()?.unwrap_or(false)))
    }
    pub fn record_send_completion_stage(&self, id: &str, stage: &str) -> Result<()> {
        if !matches!(stage,"local_sent_committed"|"send_rules_applied"|"send_index_updated"|"source_draft_cleaned") {
            return Err(PebbleError::Validation("Unknown send completion stage".into()));
        }
        self.with_write(|conn| {
            if conn.execute("UPDATE pending_mail_ops SET payload_json=json_set(payload_json,?1,1),updated_at=?2
                WHERE id=?3 AND op_type='send' AND status='in_progress' AND coalesce(json_extract(payload_json,'$.provider_accepted'),0)=1",
                params![format!("$.{stage}"),pebble_core::now_timestamp(),id])? != 1 {
                return Err(PebbleError::Validation("发送后处理阶段没有有效回执或任务已变化".into()));
            }
            Ok(())
        })
    }
    /// Commit a rule-generated local move and its remote outbox records in one
    /// SQLite transaction. A crash can therefore leave either both changes or
    /// neither change, but never a locally moved message with no server work.
    pub fn move_rule_messages_to_folder_with_outbox(
        &self,
        messages: &[Message],
        source: &Folder,
        target: &Folder,
    ) -> Result<u32> {
        if messages.is_empty() {
            return Ok(0);
        }
        if source.account_id != target.account_id {
            return Err(PebbleError::Validation(
                "Rule move source and target belong to different accounts".to_string(),
            ));
        }
        let needs_remote = !source.remote_id.starts_with("__local_")
            && !target.remote_id.starts_with("__local_");
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            let now = pebble_core::now_timestamp();
            let mut changed = 0u32;
            for message in messages {
                if message.account_id != source.account_id {
                    return Err(PebbleError::Validation(format!(
                        "Rule move message {} belongs to a different account",
                        message.id
                    )));
                }
                tx.execute(
                    "DELETE FROM message_folders WHERE message_id = ?1",
                    params![message.id],
                )?;
                tx.execute(
                    "INSERT OR IGNORE INTO message_folders (message_id, folder_id) VALUES (?1, ?2)",
                    params![message.id, target.id],
                )?;
                changed += tx.execute(
                    "UPDATE messages
                     SET is_deleted = 0, deleted_at = NULL, updated_at = ?1
                     WHERE id = ?2",
                    params![now, message.id],
                )? as u32;
                tx.execute(
                    "INSERT OR REPLACE INTO search_pending (message_id, operation, created_at)
                     VALUES (?1, 'index', ?2)",
                    params![message.id, now],
                )?;

                if needs_remote {
                    let payload = json!({
                        "provider_account_id": message.account_id,
                        "remote_id": message.remote_id,
                        "op": "move_to_folder",
                        "payload": {
                            "source_folder_id": source.id,
                            "source_folder_remote_id": source.remote_id,
                            "target_folder_id": target.id,
                            "target_folder_remote_id": target.remote_id,
                            "add_labels": [target.remote_id],
                            "remove_labels": [source.remote_id],
                        }
                    });
                    tx.execute(
                        "INSERT INTO pending_mail_ops
                            (id, account_id, message_id, op_type, payload_json, status,
                             attempts, last_error, created_at, updated_at)
                         VALUES (?1, ?2, ?3, 'move_to_folder', ?4, 'pending', 0, NULL, ?5, ?5)",
                        params![
                            pebble_core::new_id(),
                            message.account_id,
                            message.id,
                            payload.to_string(),
                            now,
                        ],
                    )?;
                }
            }
            tx.commit()?;
            Ok(changed)
        })
    }

    pub fn insert_pending_mail_op(
        &self,
        account_id: &str,
        message_id: &str,
        op_type: &str,
        payload_json: &str,
    ) -> Result<String> {
        self.with_write(|conn| {
            let id = pebble_core::new_id();
            let now = pebble_core::now_timestamp();
            conn.execute(
                "INSERT INTO pending_mail_ops
                    (id, account_id, message_id, op_type, payload_json, status, attempts, last_error, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, ?7, ?7)",
                params![
                    id,
                    account_id,
                    message_id,
                    op_type,
                    payload_json,
                    PendingMailOpStatus::Pending.as_str(),
                    now,
                ],
            )?;
            Ok(id)
        })
    }

    /// Insert an operation that must not be replayed before `not_before`.
    /// Used by scheduled send; ordinary pending operations keep NULL here.
    pub fn insert_pending_mail_op_at(
        &self,
        account_id: &str,
        message_id: &str,
        op_type: &str,
        payload_json: &str,
        not_before: i64,
    ) -> Result<String> {
        self.with_write(|conn| {
            let id = pebble_core::new_id();
            let now = pebble_core::now_timestamp();
            conn.execute(
                "INSERT INTO pending_mail_ops
                    (id, account_id, message_id, op_type, payload_json, status, attempts, last_error, created_at, updated_at, next_retry_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, ?7, ?7, ?8)",
                params![
                    id,
                    account_id,
                    message_id,
                    op_type,
                    payload_json,
                    PendingMailOpStatus::Pending.as_str(),
                    now,
                    not_before,
                ],
            )?;
            Ok(id)
        })
    }

    /// Queue a rule-generated folder move for remote replay. Rule execution
    /// updates the local view first for responsiveness, but IMAP/Gmail/
    /// Outlook must receive the same move instead of silently diverging.
    pub fn enqueue_rule_move_to_folder(
        &self,
        account_id: &str,
        message_id: &str,
        remote_message_id: &str,
        source_folder_id: &str,
        source_folder_remote_id: &str,
        target_folder_id: &str,
        target_folder_remote_id: &str,
    ) -> Result<String> {
        let payload = json!({
            "provider_account_id": account_id,
            "remote_id": remote_message_id,
            "op": "move_to_folder",
            "payload": {
                "source_folder_id": source_folder_id,
                "source_folder_remote_id": source_folder_remote_id,
                "target_folder_id": target_folder_id,
                "target_folder_remote_id": target_folder_remote_id,
                "add_labels": [target_folder_remote_id],
                "remove_labels": [source_folder_remote_id],
            }
        });
        self.insert_pending_mail_op(
            account_id,
            message_id,
            "move_to_folder",
            &payload.to_string(),
        )
    }

    pub fn list_pending_mail_ops(&self, account_id: &str) -> Result<Vec<PendingMailOp>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, account_id, message_id, op_type, payload_json, status,
                        attempts, last_error, created_at, updated_at, next_retry_at
                 FROM pending_mail_ops
                 WHERE account_id = ?1
                 ORDER BY updated_at ASC",
            )?;
            let rows = stmt.query_map(params![account_id], |row| {
                let status: String = row.get(5)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    status,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, Option<i64>>(10)?,
                ))
            })?;

            let mut ops = Vec::new();
            for row in rows {
                let (
                    id,
                    account_id,
                    message_id,
                    op_type,
                    payload_json,
                    status,
                    attempts,
                    last_error,
                    created_at,
                    updated_at,
                    next_retry_at,
                ) = row?;
                ops.push(PendingMailOp {
                    id,
                    account_id,
                    message_id,
                    op_type,
                    payload_json,
                    status: status_from_str(&status)?,
                    attempts,
                    last_error,
                    created_at,
                    updated_at,
                    next_retry_at,
                });
            }
            Ok(ops)
        })
    }

    pub fn list_active_pending_mail_ops(
        &self,
        account_id: Option<&str>,
        limit: i64,
    ) -> Result<Vec<PendingMailOp>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, account_id, message_id, op_type, payload_json, status,
                        attempts, last_error, created_at, updated_at, next_retry_at
                 FROM pending_mail_ops
                 WHERE status != 'done'
                   AND (?1 IS NULL OR account_id = ?1)
                 ORDER BY updated_at DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![account_id, limit.max(1)], |row| {
                let status: String = row.get(5)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    status,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, Option<i64>>(10)?,
                ))
            })?;

            let mut ops = Vec::new();
            for row in rows {
                let (
                    id,
                    account_id,
                    message_id,
                    op_type,
                    payload_json,
                    status,
                    attempts,
                    last_error,
                    created_at,
                    updated_at,
                    next_retry_at,
                ) = row?;
                ops.push(PendingMailOp {
                    id,
                    account_id,
                    message_id,
                    op_type,
                    payload_json,
                    status: status_from_str(&status)?,
                    attempts,
                    last_error,
                    created_at,
                    updated_at,
                    next_retry_at,
                });
            }
            Ok(ops)
        })
    }

    pub fn list_retryable_pending_mail_ops(&self, limit: i64) -> Result<Vec<PendingMailOp>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, account_id, message_id, op_type, payload_json, status,
                        attempts, last_error, created_at, updated_at, next_retry_at
                 FROM pending_mail_ops
                 WHERE (
                        status = 'pending'
                        AND (next_retry_at IS NULL OR next_retry_at <= ?3)
                    )
                    OR (
                        status = 'failed'
                        AND attempts < ?2
                        AND (next_retry_at IS NULL OR next_retry_at <= ?3)
                    )
                 ORDER BY updated_at ASC
                 LIMIT ?1",
            )?;
            let now = pebble_core::now_timestamp();
            let rows =
                stmt.query_map(params![limit, MAX_PENDING_MAIL_OP_ATTEMPTS, now], |row| {
                    let status: String = row.get(5)?;
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        status,
                        row.get::<_, i64>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, i64>(8)?,
                        row.get::<_, i64>(9)?,
                        row.get::<_, Option<i64>>(10)?,
                    ))
                })?;

            let mut ops = Vec::new();
            for row in rows {
                let (
                    id,
                    account_id,
                    message_id,
                    op_type,
                    payload_json,
                    status,
                    attempts,
                    last_error,
                    created_at,
                    updated_at,
                    next_retry_at,
                ) = row?;
                ops.push(PendingMailOp {
                    id,
                    account_id,
                    message_id,
                    op_type,
                    payload_json,
                    status: status_from_str(&status)?,
                    attempts,
                    last_error,
                    created_at,
                    updated_at,
                    next_retry_at,
                });
            }
            Ok(ops)
        })
    }

    pub fn pending_mail_ops_summary(
        &self,
        account_id: Option<&str>,
    ) -> Result<PendingMailOpsSummary> {
        self.with_read(|conn| {
            let (pending_count, in_progress_count, failed_count, updated_at): (
                i64,
                i64,
                i64,
                Option<i64>,
            ) = conn.query_row(
                "SELECT
                    COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0),
                    MAX(updated_at)
                 FROM pending_mail_ops
                 WHERE status != 'done' AND json_extract(payload_json,'$.dismissed_at') IS NULL
                   AND (?1 IS NULL OR account_id = ?1)",
                params![account_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;

            let failure = conn
                .query_row(
                    "SELECT last_error, id, account_id, op_type
                     FROM pending_mail_ops
                     WHERE status = 'failed' AND json_extract(payload_json,'$.dismissed_at') IS NULL
                       AND last_error IS NOT NULL
                       AND (?1 IS NULL OR account_id = ?1)
                     ORDER BY updated_at DESC, id DESC
                     LIMIT 1",
                    params![account_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
                )
                .optional()?;
            let (last_error, last_error_operation_id, last_error_account_id, last_error_op_type) = match failure {
                Some((error, id, account, op_type)) => (Some(error), Some(id), Some(account), Some(op_type)),
                None => (None, None, None, None),
            };

            Ok(PendingMailOpsSummary {
                pending_count,
                in_progress_count,
                failed_count,
                total_active_count: pending_count + in_progress_count + failed_count,
                last_error,
                updated_at,
                last_error_operation_id,
                last_error_account_id,
                last_error_op_type,
            })
        })
    }

    pub fn mark_pending_mail_op_in_progress(&self, id: &str) -> Result<()> {
        self.with_write(|conn| {
            conn.execute(
                "UPDATE pending_mail_ops
                 SET status = ?1,
                     updated_at = ?2
                 WHERE id = ?3",
                params![
                    PendingMailOpStatus::InProgress.as_str(),
                    pebble_core::now_timestamp(),
                    id,
                ],
            )?;
            Ok(())
        })
    }

    /// A failed SMTP submission may already have been accepted remotely.
    /// Never automatically resubmit it; retain the message for explicit review.
    pub fn hold_failed_send(&self, id: &str, error: &str) -> Result<()> {
        self.with_write(|conn| {
            let accepted: bool = conn.query_row("SELECT coalesce(json_extract(payload_json,'$.provider_accepted'),0)=1
                FROM pending_mail_ops WHERE id=?1",[id],|r|r.get(0)).optional()?.unwrap_or(false);
            if accepted {
                // Retry only local completion; replay guards against another SMTP submission.
                let attempts: i64 = conn.query_row("SELECT attempts FROM pending_mail_ops WHERE id=?1",[id],|r|r.get(0))?;
                conn.execute("UPDATE pending_mail_ops SET status='failed',attempts=?1,last_error=?2,next_retry_at=?3,updated_at=?4 WHERE id=?5 AND status!='done'",
                    params![attempts+1,error,if attempts+1<MAX_PENDING_MAIL_OP_ATTEMPTS {Some(pebble_core::now_timestamp()+60)} else {None},pebble_core::now_timestamp(),id])?;
                return Ok(());
            }
            conn.execute("UPDATE pending_mail_ops SET status='failed', attempts=max(attempts,?1), last_error=?2, next_retry_at=NULL, updated_at=?3 WHERE id=?4 AND op_type='send' AND status!='done'",
                params![MAX_PENDING_MAIL_OP_ATTEMPTS, error, pebble_core::now_timestamp(), id])?;
            Ok(())
        })
    }

    pub fn insert_held_send(&self, account_id: &str, message_id: &str, payload: &str, error: &str) -> Result<String> {
        self.with_write(|conn| {
            let id = pebble_core::new_id();
            let now = pebble_core::now_timestamp();
            conn.execute("INSERT INTO pending_mail_ops (id,account_id,message_id,op_type,payload_json,status,attempts,last_error,created_at,updated_at,next_retry_at) VALUES (?1,?2,?3,'send',?4,'failed',?5,?6,?7,?7,NULL)",
                params![id,account_id,message_id,payload,MAX_PENDING_MAIL_OP_ATTEMPTS,error,now])?;
            Ok(id)
        })
    }

    pub fn retry_failed_send_once(&self, id: &str) -> Result<()> {
        self.with_write(|conn| {
            let count = conn.execute("UPDATE pending_mail_ops SET status='pending',attempts=0,last_error=NULL,payload_json=json_remove(payload_json,'$.dismissed_at'),next_retry_at=?1,updated_at=?1 WHERE id=?2 AND op_type='send' AND status='failed' AND coalesce(json_extract(payload_json,'$.provider_accepted'),0)=0
                AND coalesce(json_extract(payload_json,'$.duplicate_submission'),0)=0
                AND EXISTS(SELECT 1 FROM messages m WHERE m.id=pending_mail_ops.message_id AND m.is_deleted=0
                  AND NOT EXISTS(SELECT 1 FROM message_folders mf JOIN folders f ON f.id=mf.folder_id WHERE mf.message_id=m.id AND f.role='sent'))",
                params![pebble_core::now_timestamp(), id])?;
            if count != 1 { return Err(PebbleError::Validation("此邮件已发送、已被服务器接受、正在发送或已移除，不能重复提交；请刷新队列并核对已发送".into())); }
            Ok(())
        })
    }

    /// Safe repair for legacy terminal states; no claim or transport is run.
    pub fn repair_legacy_outbox_states(&self) -> Result<()> {
        self.with_write(|conn| {
            // Older dismissal/permanent-error paths used done without a Sent
            // commit. Surface those stranded copies for review, never send them.
            conn.execute("UPDATE pending_mail_ops SET status='failed',attempts=?1,next_retry_at=NULL,
                last_error=CASE WHEN coalesce(json_extract(payload_json,'$.provider_accepted'),0)=1
                    THEN '服务商已接受邮件，本地归档未完成；只能补归档，不要重新发送。'
                    ELSE '历史待发记录被标为完成，但没有已发送归档；发送结果需核对，未自动重发。' END,
                updated_at=?2 WHERE op_type='send' AND status='done'
                AND EXISTS(SELECT 1 FROM messages m JOIN message_folders mf ON mf.message_id=m.id
                    JOIN folders f ON f.id=mf.folder_id WHERE m.id=pending_mail_ops.message_id
                    AND m.is_deleted=0 AND f.remote_id='__local_outbox__')",
                params![MAX_PENDING_MAIL_OP_ATTEMPTS,pebble_core::now_timestamp()])?;
            Ok(())
        })
    }

    pub fn reset_in_progress_pending_mail_ops(&self) -> Result<()> {
        self.repair_legacy_outbox_states()?;
        self.with_write(|conn| {
            // Older versions retried failed sends silently. On upgrade, retain
            // those messages but require review before any further submission.
            conn.execute("UPDATE pending_mail_ops SET attempts=?1,next_retry_at=NULL WHERE op_type='send' AND status='failed' AND attempts<?1 AND coalesce(json_extract(payload_json,'$.provider_accepted'),0)!=1",
                params![MAX_PENDING_MAIL_OP_ATTEMPTS])?;
            // An acceptance receipt makes restart recovery postprocessing-only.
            // Preserve its retry budget; never turn it back into a transport send.
            conn.execute("UPDATE pending_mail_ops SET status='pending',next_retry_at=?1,updated_at=?1 WHERE status='in_progress' AND op_type='send' AND attempts<?2 AND coalesce(json_extract(payload_json,'$.provider_accepted'),0)=1",
                params![pebble_core::now_timestamp(),MAX_PENDING_MAIL_OP_ATTEMPTS])?;
            conn.execute("UPDATE pending_mail_ops SET status='failed',attempts=max(attempts,?1),next_retry_at=NULL,last_error='上次发送中断，结果未确认，自动重试已暂停；请核对已发送及收件方。',updated_at=?2 WHERE status='in_progress' AND op_type='send'",
                params![MAX_PENDING_MAIL_OP_ATTEMPTS,pebble_core::now_timestamp()])?;
            conn.execute(
                "UPDATE pending_mail_ops
                 SET status = ?1,
                     updated_at = ?2,
                     next_retry_at = NULL
                 WHERE status = ?3",
                params![
                    PendingMailOpStatus::Pending.as_str(),
                    pebble_core::now_timestamp(),
                    PendingMailOpStatus::InProgress.as_str(),
                ],
            )?;
            Ok(())
        })
    }

    /// Retire flag retries created for messages that had no server target.
    /// Do not replay their old values over newer local user changes.
    pub fn retire_local_flag_retries(&self) -> Result<()> {
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            let now = pebble_core::now_timestamp();
            {
                let mut stmt = tx.prepare(
                    "SELECT p.id, m.remote_id, p.payload_json
                     FROM pending_mail_ops p JOIN messages m
                       ON m.id=p.message_id AND m.account_id=p.account_id
                     WHERE p.op_type='update_flags' AND p.status IN ('pending','failed')",
                )?;
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
                })?;
                let rows = rows.collect::<rusqlite::Result<Vec<_>>>()?;
                for (id, current_remote_id, payload) in rows {
                    let saved_remote_id = serde_json::from_str::<serde_json::Value>(&payload)
                        .ok()
                        .and_then(|value| value.get("remote_id")?.as_str().map(str::to_owned));
                    if is_local_message_id(&current_remote_id)
                        || saved_remote_id.as_deref().is_some_and(is_local_message_id)
                    {
                        tx.execute(
                            "UPDATE pending_mail_ops SET status='done',last_error=NULL,
                                 next_retry_at=NULL,updated_at=?2 WHERE id=?1",
                            params![id, now],
                        )?;
                    }
                }
            }
            tx.commit()?;
            Ok(())
        })
    }

    pub fn try_claim_pending_mail_op(&self, id: &str) -> Result<bool> {
        self.with_write(|conn| {
            Ok(conn.execute("UPDATE pending_mail_ops SET status='in_progress',updated_at=?1 WHERE id=?2 AND (status='pending' OR (status='failed' AND attempts<?3)) AND (next_retry_at IS NULL OR next_retry_at<=?1)",
                params![pebble_core::now_timestamp(),id,MAX_PENDING_MAIL_OP_ATTEMPTS])? == 1)
        })
    }

    pub fn record_send_acceptance(&self, operation_id: &str, header: &str) -> Result<()> {
        self.with_write(|conn| {
            let changed = conn.execute("UPDATE pending_mail_ops SET payload_json=json_set(payload_json,'$.provider_accepted',1,'$.submitted_message_id',?1),attempts=0,updated_at=?2 WHERE id=?3 AND op_type='send' AND status='in_progress'",
                params![header,pebble_core::now_timestamp(),operation_id])?;
            if changed != 1 { return Err(PebbleError::Validation("发送回执未能保存到对应任务，禁止重新发送".into())); }
            Ok(())
        })
    }

    pub fn mark_pending_mail_op_failed(&self, id: &str, error: &str) -> Result<()> {
        self.with_write(|conn| {
            let current_attempts = conn
                .query_row(
                    "SELECT attempts FROM pending_mail_ops WHERE id = ?1",
                    params![id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .unwrap_or(0);
            let attempts = current_attempts + 1;
            let now = pebble_core::now_timestamp();
            let next_retry_at = if attempts < MAX_PENDING_MAIL_OP_ATTEMPTS {
                Some(now + pending_mail_retry_delay_secs(attempts))
            } else {
                None
            };
            conn.execute(
                "UPDATE pending_mail_ops
                 SET status = ?1,
                     attempts = attempts + 1,
                     last_error = ?2,
                     updated_at = ?3,
                     next_retry_at = ?4
                 WHERE id = ?5",
                params![
                    PendingMailOpStatus::Failed.as_str(),
                    error,
                    now,
                    next_retry_at,
                    id,
                ],
            )?;
            Ok(())
        })
    }

    /// Acknowledging a failure is not delivery and must retain its audit trail.
    pub fn dismiss_failed_pending_mail_ops(&self, account_id: Option<&str>) -> Result<u64> {
        self.with_write(|conn| {
            Ok(conn.execute("UPDATE pending_mail_ops SET payload_json=json_set(payload_json,'$.dismissed_at',?1),
                attempts=max(attempts,?3),next_retry_at=NULL,updated_at=?1
                WHERE status='failed' AND (?2 IS NULL OR account_id=?2)
                AND json_extract(payload_json,'$.dismissed_at') IS NULL",
                params![pebble_core::now_timestamp(),account_id,MAX_PENDING_MAIL_OP_ATTEMPTS])? as u64)
        })
    }

    pub fn mark_pending_mail_op_done(&self, id: &str) -> Result<()> {
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            let incomplete: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pending_mail_ops p JOIN messages m ON m.id=p.message_id WHERE p.id=?1 AND p.op_type='send' AND m.is_deleted=0 AND m.is_draft=0
                AND coalesce(json_extract(p.payload_json,'$.user_confirmed_sent'),0)!=1
                AND (coalesce(json_extract(p.payload_json,'$.provider_accepted'),0)!=1
                    OR coalesce(json_extract(p.payload_json,'$.local_sent_committed'),0)!=1
                    OR coalesce(json_extract(p.payload_json,'$.send_rules_applied'),0)!=1
                    OR coalesce(json_extract(p.payload_json,'$.send_index_updated'),0)!=1
                    OR coalesce(json_extract(p.payload_json,'$.source_draft_cleaned'),0)!=1
                    OR EXISTS(SELECT 1 FROM message_folders mf JOIN folders f ON f.id=mf.folder_id WHERE mf.message_id=m.id AND f.remote_id='__local_outbox__')))",[id],|r|r.get(0))?;
            if incomplete { return Err(PebbleError::Validation("发送凭据或本地归档尚未完成，不能将任务标为完成".into())); }
            tx.execute(
                "UPDATE pending_mail_ops
                 SET status = ?1,
                     last_error = NULL,
                     updated_at = ?2,
                     next_retry_at = NULL
                 WHERE id = ?3",
                params![
                    PendingMailOpStatus::Done.as_str(),
                    pebble_core::now_timestamp(),
                    id,
                ],
            )?;
            tx.commit()?;
            Ok(())
        })
    }

    #[cfg(test)]
    pub fn force_pending_mail_op_retry_now_for_test(&self, id: &str) -> Result<()> {
        self.with_write(|conn| {
            conn.execute(
                "UPDATE pending_mail_ops SET next_retry_at = ?1 WHERE id = ?2",
                params![pebble_core::now_timestamp() - 1, id],
            )?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pebble_core::*;
    #[test]
    fn a_confirmed_duplicate_cannot_be_resubmitted_from_the_old_queue() {
        let s=Store::open_in_memory().unwrap();let a=test_account();s.insert_account(&a).unwrap();
        let f=test_folder(&a.id);s.insert_folder(&f).unwrap();let m=test_message(&a.id);s.insert_message(&m,&[f.id]).unwrap();
        let id=s.insert_held_send(&a.id,&m.id,r#"{"duplicate_submission":1}"#,"Confirmed duplicate").unwrap();
        assert!(s.retry_failed_send_once(&id).is_err());assert!(s.list_retryable_pending_mail_ops(10).unwrap().is_empty());
    }
    #[test]
    fn accepted_send_records_completion_stages_and_only_postprocessing_is_retryable() {
        let s=Store::open_in_memory().unwrap();let a=test_account();s.insert_account(&a).unwrap();
        let f=test_folder(&a.id);s.insert_folder(&f).unwrap();let m=test_message(&a.id);s.insert_message(&m,&[f.id]).unwrap();
        let id=s.insert_pending_mail_op(&a.id,&m.id,"send","{}").unwrap();assert!(s.try_claim_pending_mail_op(&id).unwrap());
        s.record_send_acceptance(&id,"<accepted@example.test>").unwrap();
        s.record_send_completion_stage(&id,"local_sent_committed").unwrap();
        assert!(s.record_send_completion_stage(&id,"not-a-stage").is_err());
        s.hold_failed_send(&id,"Local index unavailable").unwrap();
        assert!(s.send_was_accepted(&id).unwrap());assert!(s.retry_failed_send_once(&id).is_err());
        s.force_pending_mail_op_retry_now_for_test(&id).unwrap();
        let ops=s.list_retryable_pending_mail_ops(10).unwrap();assert_eq!(ops.len(),1);
        let payload:serde_json::Value=serde_json::from_str(&ops[0].payload_json).unwrap();assert_eq!(payload["local_sent_committed"],1);
        assert_eq!(ops[0].attempts,1);
        s.dismiss_failed_pending_mail_ops(Some(&a.id)).unwrap();assert!(s.list_retryable_pending_mail_ops(10).unwrap().is_empty());
    }
    #[test]
    fn dismissing_a_send_retains_failure_and_never_becomes_delivery() {
        let s=Store::open_in_memory().unwrap();let a=test_account();s.insert_account(&a).unwrap();
        let f=test_folder(&a.id);s.insert_folder(&f).unwrap();let m=test_message(&a.id);s.insert_message(&m,&[f.id]).unwrap();
        let id=s.insert_pending_mail_op(&a.id,&m.id,"send","{}").unwrap();s.hold_failed_send(&id,"Original SMTP error").unwrap();
        assert_eq!(s.dismiss_failed_pending_mail_ops(Some(&a.id)).unwrap(),1);
        let ops=s.list_active_pending_mail_ops(Some(&a.id),10).unwrap();assert_eq!(ops[0].status,PendingMailOpStatus::Failed);
        assert_eq!(ops[0].last_error.as_deref(),Some("Original SMTP error"));assert!(ops[0].payload_json.contains("dismissed_at"));
        assert_eq!(s.pending_mail_ops_summary(Some(&a.id)).unwrap().failed_count,0);
        assert!(s.list_retryable_pending_mail_ops(10).unwrap().is_empty());assert!(!s.send_was_accepted(&id).unwrap());
    }
    #[test]
    fn historical_done_outbox_is_held_for_review_without_resubmission() {
        let s=Store::open_in_memory().unwrap();let a=test_account();s.insert_account(&a).unwrap();
        let mut f=test_folder(&a.id);f.remote_id="__local_outbox__".into();f.role=None;s.insert_folder(&f).unwrap();
        let mut m=test_message(&a.id);m.remote_id="local-outbox-fixture".into();s.insert_message(&m,&[f.id]).unwrap();
        let id=s.insert_pending_mail_op(&a.id,&m.id,"send","{}").unwrap();
        // Recreate the OLD on-disk bug; the current completion API rejects it.
        s.with_write(|c|{c.execute("UPDATE pending_mail_ops SET status='done' WHERE id=?1",[&id])?;Ok(())}).unwrap();
        s.reset_in_progress_pending_mail_ops().unwrap();
        let ops=s.list_active_pending_mail_ops(Some(&a.id),10).unwrap();assert_eq!(ops[0].status,PendingMailOpStatus::Failed);
        assert!(ops[0].last_error.as_deref().unwrap().contains("历史待发"));assert!(s.list_retryable_pending_mail_ops(10).unwrap().is_empty());
        assert_eq!(s.get_message(&m.id).unwrap().unwrap().remote_id,"local-outbox-fixture");
    }

    fn test_account() -> Account {
        let now = now_timestamp();
        Account {
            id: new_id(),
            email: "test@example.com".to_string(),
            display_name: "Test".to_string(),
            color: None,
            provider: ProviderType::Gmail,
            created_at: now,
            updated_at: now,
        }
    }

    fn test_message(account_id: &str) -> Message {
        let now = now_timestamp();
        Message {
            id: new_id(),
            account_id: account_id.to_string(),
            remote_id: "remote-123".to_string(),
            message_id_header: None,
            in_reply_to: None,
            references_header: None,
            thread_id: None,
            subject: "Test".to_string(),
            snippet: "test".to_string(),
            from_address: "from@example.com".to_string(),
            from_name: "From".to_string(),
            to_list: vec![],
            cc_list: vec![],
            bcc_list: vec![],
            body_text: "body".to_string(),
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

    fn test_folder(account_id: &str) -> Folder {
        Folder {
            id: new_id(),
            account_id: account_id.to_string(),
            remote_id: "INBOX".to_string(),
            name: "Inbox".to_string(),
            folder_type: FolderType::Folder,
            role: Some(FolderRole::Inbox),
            parent_id: None,
            color: None,
            is_system: true,
            sort_order: 0,
        }
    }

    #[test]
    fn local_flag_retries_retire_without_replaying_stale_values_or_touching_other_ops() {
        let store = Store::open_in_memory().unwrap();
        let mut account = test_account();
        account.provider = ProviderType::Imap;
        store.insert_account(&account).unwrap();
        let folder = test_folder(&account.id);
        store.insert_folder(&folder).unwrap();
        let mut cached = test_message(&account.id);
        cached.remote_id = "__local_imap_cache__:fixture".into();
        cached.is_read = true;
        store.insert_message(&cached, &[folder.id.clone()]).unwrap();
        let mut rebound = test_message(&account.id);
        rebound.remote_id = "42".into();
        store.insert_message(&rebound, &[folder.id]).unwrap();

        let queue = |message: &Message, op, payload| {
            store.insert_pending_mail_op(&account.id, &message.id, op, payload).unwrap()
        };
        let old_cached = queue(&cached, "update_flags", r#"{"is_read":false}"#);
        let old_rebound = queue(&rebound, "update_flags",
            r#"{"remote_id":"__local_history__:fixture","payload":{"is_read":true}}"#);
        store.mark_pending_mail_op_failed(&old_rebound, "Invalid IMAP UID").unwrap();
        let valid = queue(&rebound, "update_flags", r#"{"remote_id":"42","is_read":true}"#);
        let unrelated = queue(&cached, "move_to_folder", "{}");

        store.retire_local_flag_retries().unwrap();

        let active = store.list_active_pending_mail_ops(Some(&account.id), 10).unwrap();
        let active_ids: Vec<_> = active.iter().map(|op| op.id.as_str()).collect();
        assert!(!active_ids.contains(&old_cached.as_str()));
        assert!(!active_ids.contains(&old_rebound.as_str()));
        assert!(active_ids.contains(&valid.as_str()));
        assert!(active_ids.contains(&unrelated.as_str()));
        assert!(store.get_message(&cached.id).unwrap().unwrap().is_read);
        assert!(!store.get_message(&rebound.id).unwrap().unwrap().is_read);
    }

    #[test]
    fn pending_mail_ops_insert_list_mark_failed_and_done() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let folder = test_folder(&account.id);
        store.insert_folder(&folder).unwrap();
        let message = test_message(&account.id);
        store.insert_message(&message, &[folder.id]).unwrap();

        let op_id = store
            .insert_pending_mail_op(&account.id, &message.id, "flag", r#"{"is_read":true}"#)
            .unwrap();

        let ops = store.list_pending_mail_ops(&account.id).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].id, op_id);
        assert_eq!(ops[0].status, PendingMailOpStatus::Pending);
        assert_eq!(ops[0].attempts, 0);

        store
            .mark_pending_mail_op_failed(&op_id, "remote unavailable")
            .unwrap();
        let failed = store.list_pending_mail_ops(&account.id).unwrap();
        assert_eq!(failed[0].status, PendingMailOpStatus::Failed);
        assert_eq!(failed[0].attempts, 1);
        assert_eq!(failed[0].last_error.as_deref(), Some("remote unavailable"));

        store.mark_pending_mail_op_done(&op_id).unwrap();
        let done = store.list_pending_mail_ops(&account.id).unwrap();
        assert_eq!(done[0].status, PendingMailOpStatus::Done);
    }

    #[test]
    fn held_sends_require_explicit_retry_and_never_restart_automatically() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account(); store.insert_account(&account).unwrap();
        let folder = test_folder(&account.id); store.insert_folder(&folder).unwrap();
        let message = test_message(&account.id); store.insert_message(&message, &[folder.id]).unwrap();
        let id = store.insert_held_send(&account.id, &message.id, "{}", "result unknown").unwrap();
        assert!(store.list_retryable_pending_mail_ops(100).unwrap().is_empty());
        store.reset_in_progress_pending_mail_ops().unwrap();
        assert!(store.list_retryable_pending_mail_ops(100).unwrap().is_empty());
        store.retry_failed_send_once(&id).unwrap();
        assert_eq!(store.list_retryable_pending_mail_ops(100).unwrap().len(), 1);
        assert!(store.retry_failed_send_once(&id).is_err());
        store.mark_pending_mail_op_in_progress(&id).unwrap();
        store.hold_failed_send(&id, "failed again").unwrap();
        assert!(store.list_retryable_pending_mail_ops(100).unwrap().is_empty());
        assert!(store.get_message(&message.id).unwrap().is_some());
        store.retry_failed_send_once(&id).unwrap();
        assert!(store.mark_pending_mail_op_done(&id).is_err());
        store.hold_failed_send(&id,"Confirmed by fixture user").unwrap();
        store.confirm_pending_send_delivered(&id,None).unwrap();
        assert!(store.retry_failed_send_once(&id).is_err());
        let other = store.insert_pending_mail_op(&account.id, &message.id, "move_to_folder", "{}").unwrap();
        assert!(store.retry_failed_send_once(&other).is_err());
    }

    #[test]
    fn interrupted_or_smtp_accepted_sends_are_not_automatically_submitted_again() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account(); store.insert_account(&account).unwrap();
        let folder = test_folder(&account.id); store.insert_folder(&folder).unwrap();
        let message = test_message(&account.id); store.insert_message(&message, &[folder.id]).unwrap();
        let id = store.insert_pending_mail_op(&account.id, &message.id, "send", "{}").unwrap();
        assert!(store.try_claim_pending_mail_op(&id).unwrap());
        assert!(!store.try_claim_pending_mail_op(&id).unwrap());
        store.record_send_acceptance(&id, "<accepted@example.test>").unwrap();
        store.reset_in_progress_pending_mail_ops().unwrap();
        let retryable = store.list_retryable_pending_mail_ops(100).unwrap();
        assert_eq!(retryable.len(),1);
        assert!(store.send_was_accepted(&retryable[0].id).unwrap());
        assert!(store.retry_failed_send_once(&id).is_err());
        assert!(store.try_claim_pending_mail_op(&id).unwrap());
        assert!(!store.try_claim_pending_mail_op(&id).unwrap());
    }

    #[test]
    fn legacy_failed_sends_are_held_when_worker_starts() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account(); store.insert_account(&account).unwrap();
        let folder = test_folder(&account.id); store.insert_folder(&folder).unwrap();
        let message = test_message(&account.id); store.insert_message(&message, &[folder.id]).unwrap();
        let id = store.insert_pending_mail_op(&account.id, &message.id, "send", "{}").unwrap();
        store.mark_pending_mail_op_failed(&id, "legacy network error").unwrap();
        store.reset_in_progress_pending_mail_ops().unwrap();
        let ops = store.list_active_pending_mail_ops(Some(&account.id), 10).unwrap();
        assert_eq!(ops[0].attempts, MAX_PENDING_MAIL_OP_ATTEMPTS);
        assert!(ops[0].next_retry_at.is_none());
        assert_eq!(ops[0].last_error.as_deref(), Some("legacy network error"));
        assert!(store.list_retryable_pending_mail_ops(100).unwrap().is_empty());
    }

    #[test]
    fn rule_move_commits_local_folder_and_remote_outbox_atomically() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let source = test_folder(&account.id);
        let mut target = test_folder(&account.id);
        target.id = new_id();
        target.remote_id = "Customers/Rain".to_string();
        target.name = "Rain".to_string();
        target.role = None;
        store.insert_folder(&source).unwrap();
        store.insert_folder(&target).unwrap();
        let message = test_message(&account.id);
        store
            .insert_message(&message, std::slice::from_ref(&source.id))
            .unwrap();

        let moved = store
            .move_rule_messages_to_folder_with_outbox(
                std::slice::from_ref(&message),
                &source,
                &target,
            )
            .unwrap();

        assert_eq!(moved, 1);
        assert_eq!(
            store.get_message_folder_ids(&message.id).unwrap(),
            vec![target.id.clone()]
        );
        let ops = store.list_pending_mail_ops(&account.id).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].op_type, "move_to_folder");
        assert!(ops[0].payload_json.contains(&source.remote_id));
        assert!(ops[0].payload_json.contains(&target.remote_id));

        // A server reconciliation may still see the old source UID while the
        // move is pending. It must not hide the locally moved message.
        store
            .bulk_soft_delete(std::slice::from_ref(&message.id))
            .unwrap();
        assert!(!store.get_message(&message.id).unwrap().unwrap().is_deleted);

        store.mark_pending_mail_op_done(&ops[0].id).unwrap();
        store
            .bulk_soft_delete(std::slice::from_ref(&message.id))
            .unwrap();
        assert!(store.get_message(&message.id).unwrap().unwrap().is_deleted);
    }

    #[test]
    fn rule_move_rolls_back_local_changes_when_outbox_batch_is_invalid() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let source = test_folder(&account.id);
        let mut target = test_folder(&account.id);
        target.id = new_id();
        target.remote_id = "Customers".to_string();
        target.role = None;
        store.insert_folder(&source).unwrap();
        store.insert_folder(&target).unwrap();
        let valid = test_message(&account.id);
        store
            .insert_message(&valid, std::slice::from_ref(&source.id))
            .unwrap();
        let mut invalid = test_message(&account.id);
        invalid.account_id = "different-account".to_string();

        assert!(store
            .move_rule_messages_to_folder_with_outbox(&[valid.clone(), invalid], &source, &target)
            .is_err());
        assert_eq!(
            store.get_message_folder_ids(&valid.id).unwrap(),
            vec![source.id]
        );
        assert!(store.list_pending_mail_ops(&account.id).unwrap().is_empty());
    }

    #[test]
    fn pending_mail_ops_retryable_list_and_summary_ignore_done_ops() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let folder = test_folder(&account.id);
        store.insert_folder(&folder).unwrap();
        let message = test_message(&account.id);
        store.insert_message(&message, &[folder.id]).unwrap();

        let pending_id = store
            .insert_pending_mail_op(&account.id, &message.id, "archive", "{}")
            .unwrap();
        let failed_id = store
            .insert_pending_mail_op(&account.id, &message.id, "update_flags", "{}")
            .unwrap();
        let done_id = store
            .insert_pending_mail_op(&account.id, &message.id, "delete", "{}")
            .unwrap();

        store
            .mark_pending_mail_op_failed(&failed_id, "network unavailable")
            .unwrap();
        store.mark_pending_mail_op_done(&done_id).unwrap();

        let retryable = store.list_retryable_pending_mail_ops(10).unwrap();
        let retryable_ids: Vec<_> = retryable.iter().map(|op| op.id.as_str()).collect();
        assert_eq!(retryable_ids, vec![pending_id.as_str()]);

        store.mark_pending_mail_op_in_progress(&pending_id).unwrap();
        let summary = store.pending_mail_ops_summary(Some(&account.id)).unwrap();
        assert_eq!(summary.pending_count, 0);
        assert_eq!(summary.in_progress_count, 1);
        assert_eq!(summary.failed_count, 1);
        assert_eq!(summary.total_active_count, 2);
        assert_eq!(summary.last_error.as_deref(), Some("network unavailable"));
        assert_eq!(summary.last_error_operation_id.as_deref(), Some(failed_id.as_str()));
        assert_eq!(summary.last_error_account_id.as_deref(), Some(account.id.as_str()));
        assert_eq!(summary.last_error_op_type.as_deref(), Some("update_flags"));

        let retryable_after_claim = store.list_retryable_pending_mail_ops(10).unwrap();
        assert!(retryable_after_claim.is_empty());
        let failed = store.list_pending_mail_ops(&account.id).unwrap();
        let failed = failed.iter().find(|op| op.id == failed_id).unwrap();
        assert!(failed.next_retry_at.unwrap() > now_timestamp());
    }

    #[test]
    fn pending_error_identity_follows_its_own_account_and_survives_identical_messages() {
        let store = Store::open_in_memory().unwrap();
        let first = test_account();
        let mut second = test_account(); second.email = "second@example.test".into();
        let mut ids = Vec::new();
        for account in [&first, &second] {
            store.insert_account(account).unwrap();
            let folder = test_folder(&account.id); store.insert_folder(&folder).unwrap();
            let message = test_message(&account.id); store.insert_message(&message, &[folder.id]).unwrap();
            let id = store.insert_pending_mail_op(&account.id, &message.id, "send", "{}").unwrap();
            store.mark_pending_mail_op_failed(&id, "Same connection failure").unwrap(); ids.push(id);
        }
        for (account, id) in [(&first, &ids[0]), (&second, &ids[1])] {
            let summary = store.pending_mail_ops_summary(Some(&account.id)).unwrap();
            assert_eq!(summary.last_error_account_id.as_deref(), Some(account.id.as_str()));
            assert_eq!(summary.last_error_operation_id.as_deref(), Some(id.as_str()));
        }
        store.dismiss_failed_pending_mail_ops(Some(&second.id)).unwrap();
        let all = store.pending_mail_ops_summary(None).unwrap();
        assert_eq!(all.last_error_account_id.as_deref(), Some(first.id.as_str()));
        assert_eq!(all.last_error_operation_id.as_deref(), Some(ids[0].as_str()));
        store.dismiss_failed_pending_mail_ops(Some(&first.id)).unwrap();
        let empty = store.pending_mail_ops_summary(None).unwrap();
        assert!(empty.last_error.is_none() && empty.last_error_account_id.is_none() && empty.last_error_operation_id.is_none());
    }

    #[test]
    fn failed_pending_mail_ops_stop_retrying_after_max_attempts() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let folder = test_folder(&account.id);
        store.insert_folder(&folder).unwrap();
        let message = test_message(&account.id);
        store.insert_message(&message, &[folder.id]).unwrap();

        let op_id = store
            .insert_pending_mail_op(&account.id, &message.id, "archive", "{}")
            .unwrap();
        for attempt in 0..MAX_PENDING_MAIL_OP_ATTEMPTS {
            store
                .mark_pending_mail_op_failed(&op_id, &format!("failure {attempt}"))
                .unwrap();
            store
                .force_pending_mail_op_retry_now_for_test(&op_id)
                .unwrap();
        }

        assert!(store
            .list_retryable_pending_mail_ops(10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn active_pending_mail_ops_list_filters_done_ops_accounts_and_limit() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let folder = test_folder(&account.id);
        store.insert_folder(&folder).unwrap();
        let message = test_message(&account.id);
        store.insert_message(&message, &[folder.id]).unwrap();

        let other_account = test_account();
        store.insert_account(&other_account).unwrap();
        let other_folder = test_folder(&other_account.id);
        store.insert_folder(&other_folder).unwrap();
        let other_message = test_message(&other_account.id);
        store
            .insert_message(&other_message, &[other_folder.id])
            .unwrap();

        let pending_id = store
            .insert_pending_mail_op(&account.id, &message.id, "archive", "{}")
            .unwrap();
        let failed_id = store
            .insert_pending_mail_op(&account.id, &message.id, "update_flags", "{}")
            .unwrap();
        let done_id = store
            .insert_pending_mail_op(&account.id, &message.id, "delete", "{}")
            .unwrap();
        let other_id = store
            .insert_pending_mail_op(&other_account.id, &other_message.id, "archive", "{}")
            .unwrap();

        store
            .mark_pending_mail_op_failed(&failed_id, "network unavailable")
            .unwrap();
        store.mark_pending_mail_op_done(&done_id).unwrap();

        let account_ops = store
            .list_active_pending_mail_ops(Some(&account.id), 50)
            .unwrap();
        let account_op_ids: Vec<_> = account_ops.iter().map(|op| op.id.as_str()).collect();
        assert_eq!(account_ops.len(), 2);
        assert!(account_op_ids.contains(&pending_id.as_str()));
        assert!(account_op_ids.contains(&failed_id.as_str()));
        assert!(!account_op_ids.contains(&done_id.as_str()));
        assert!(!account_op_ids.contains(&other_id.as_str()));
        assert!(account_ops
            .iter()
            .all(|op| op.status != PendingMailOpStatus::Done));

        let limited_ops = store.list_active_pending_mail_ops(None, 1).unwrap();
        assert_eq!(limited_ops.len(), 1);
        assert_ne!(limited_ops[0].status, PendingMailOpStatus::Done);
    }

    #[test]
    fn pending_mail_ops_can_reset_stuck_in_progress_ops() {
        let store = Store::open_in_memory().unwrap();
        let account = test_account();
        store.insert_account(&account).unwrap();
        let folder = test_folder(&account.id);
        store.insert_folder(&folder).unwrap();
        let message = test_message(&account.id);
        store.insert_message(&message, &[folder.id]).unwrap();

        let op_id = store
            .insert_pending_mail_op(&account.id, &message.id, "archive", "{}")
            .unwrap();
        store.mark_pending_mail_op_in_progress(&op_id).unwrap();

        store.reset_in_progress_pending_mail_ops().unwrap();

        let retryable = store.list_retryable_pending_mail_ops(10).unwrap();
        assert_eq!(retryable.len(), 1);
        assert_eq!(retryable[0].id, op_id);
        assert_eq!(retryable[0].status, PendingMailOpStatus::Pending);
    }
}
