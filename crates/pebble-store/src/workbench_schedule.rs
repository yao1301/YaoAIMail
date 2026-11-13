//! Move a local draft into the existing pending-mail-op sender, atomically.
//! No transport or background sender belongs here.
use crate::Store;
use pebble_core::{new_id, now_timestamp, EmailAddress, PebbleError, Result};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};

fn invalid(message: &str) -> PebbleError {
    PebbleError::Validation(message.to_string())
}

fn folder(tx: &Transaction<'_>, account_id: &str, drafts: bool) -> Result<String> {
    let (remote_id, name, role, order) = if drafts {
        ("__local_workbench_drafts__", "Drafts", Some("drafts"), 1)
    } else {
        ("__local_outbox__", "Outbox", None, 3)
    };
    if drafts {
        if let Some(id) = tx.query_row(
            "SELECT id FROM folders WHERE account_id=?1 AND role='drafts' ORDER BY id LIMIT 1",
            [account_id], |row| row.get(0),
        ).optional()? {
            return Ok(id);
        }
    }
    if let Some((id, stored_role)) = tx.query_row(
        "SELECT id, role FROM folders WHERE account_id=?1 AND remote_id=?2",
        params![account_id, remote_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
    ).optional()? {
        if stored_role.as_deref() != role {
            return Err(invalid("本地邮件文件夹角色冲突，请刷新账号后重试"));
        }
        return Ok(id);
    }
    let id = new_id();
    tx.execute(
        "INSERT INTO folders(id,account_id,remote_id,name,folder_type,role,is_system,sort_order)
         VALUES(?1,?2,?3,?4,'folder',?5,1,?6)",
        params![id, account_id, remote_id, name, role, order],
    )?;
    Ok(id)
}

fn set_folder(tx: &Transaction<'_>, message_id: &str, folder_id: &str, now: i64) -> Result<()> {
    tx.execute("DELETE FROM message_folders WHERE message_id=?1", [message_id])?;
    tx.execute("INSERT INTO message_folders(message_id,folder_id) VALUES(?1,?2)", params![message_id, folder_id])?;
    tx.execute(
        "INSERT OR REPLACE INTO search_pending(message_id,operation,created_at) VALUES(?1,'index',?2)",
        params![message_id, now],
    )?;
    Ok(())
}

impl Store {
    /// Schedule exactly this persisted revision; repeated/concurrent scheduling
    /// is rejected after the first transaction consumes the draft. HTML and
    /// attachment rows (including content_id/is_inline) are never rewritten.
    pub fn schedule_workbench_draft(
        &self,
        account_id: &str,
        draft_id: &str,
        expected_updated_at: i64,
        send_at: i64,
    ) -> Result<String> {
        self.enqueue_persisted_draft(account_id,draft_id,expected_updated_at,Some(send_at))
    }

    pub fn send_saved_draft(&self, account_id:&str, draft_id:&str, expected_updated_at:i64)->Result<String> {
        self.enqueue_persisted_draft(account_id,draft_id,expected_updated_at,None)
    }

    fn enqueue_persisted_draft(&self, account_id:&str, draft_id:&str, expected_updated_at:i64, schedule:Option<i64>)->Result<String> {
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            let now = now_timestamp();
            let send_at=schedule.unwrap_or(now);
            if schedule.is_some() && send_at <= now.saturating_add(5) {
                return Err(invalid("定时发送时间必须至少晚于当前 5 秒，请重新确认"));
            }
            let row = tx.query_row(
                "SELECT account_id,remote_id,is_draft,is_deleted,updated_at,message_id_header,to_list
                 FROM messages WHERE id=?1",
                [draft_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?,
                    r.get::<_, bool>(2)?, r.get::<_, bool>(3)?, r.get::<_, i64>(4)?,
                    r.get::<_, Option<String>>(5)?, r.get::<_, String>(6)?)),
            ).optional()?.ok_or_else(|| invalid("草稿不存在，请刷新后重试"))?;
            let (owner, remote_id, is_draft, deleted, updated_at, old_header, to_json) = row;
            // Empty is the precise marker used by drafts::save_draft_locally.
            // A broad is_local_message_id check would also admit Sent/Outbox.
            let local_draft=remote_id.is_empty() || remote_id.starts_with("__local_draft__:");
            if owner != account_id || !is_draft || deleted || (schedule.is_some() && !local_draft) {
                return Err(invalid("草稿已变化、已入队或不属于当前账户；定时功能仅接受本地草稿"));
            }
            let remote_source=if !local_draft {
                if crate::local_messages::is_local_message_id(&remote_id) {return Err(invalid("该消息不是可发送的草稿"));}
                let source:Option<String>=tx.query_row("SELECT f.remote_id FROM message_folders mf JOIN folders f ON mf.folder_id=f.id WHERE mf.message_id=?1 AND f.account_id=?2 AND f.role='drafts' LIMIT 1",params![draft_id,account_id],|r|r.get(0)).optional()?;
                let source=source.filter(|s|!s.is_empty()&&!s.starts_with("__local"))
                    .ok_or_else(||invalid("无法确认远端草稿所属文件夹，请先刷新草稿箱"))?;
                Some(json!({"remote_id":remote_id,"folder_remote_id":source,"message_id_header":old_header}))
            }else{None};
            if updated_at != expected_updated_at {
                return Err(invalid("草稿已修改，请刷新预览并重新确认定时发送"));
            }
            let next_version = updated_at.checked_add(1)
                .ok_or_else(|| invalid("草稿版本无效"))?.max(now);
            let to: Vec<EmailAddress> = serde_json::from_str(&to_json)
                .map_err(|_| invalid("草稿收件人数据无效"))?;
            if !to.iter().any(|recipient| !recipient.address.trim().is_empty()) {
                return Err(invalid("至少需要一位收件人"));
            }
            let (email, display_name): (String, String) = tx.query_row(
                "SELECT email,coalesce(json_extract(nullif(sync_state,''),'$.sender_name'),display_name) FROM accounts WHERE id=?1", [account_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ).optional()?.ok_or_else(|| invalid("发送账号不存在"))?;
            let unsafe_history: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM pending_mail_ops WHERE message_id=?1 AND
                    (status!='done' OR (op_type='send' AND NOT (
                        json_extract(payload_json,'$.workbench_schedule')=1 AND
                        json_extract(payload_json,'$.cancelled_before_submission')=1))))",
                [draft_id], |r| r.get(0),
            )?;
            // Treat missing/null JSON markers as unsafe too (SQL NULL must not
            // accidentally exempt legacy send history).
            let prior_send: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM pending_mail_ops WHERE message_id=?1 AND op_type='send'
                 AND NOT (status='done' AND coalesce(json_extract(payload_json,'$.workbench_schedule'),0)=1
                 AND coalesce(json_extract(payload_json,'$.cancelled_before_submission'),0)=1))",
                [draft_id], |r| r.get(0),
            )?;
            let wrong_folder: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM message_folders mf JOIN folders f ON f.id=mf.folder_id
                 WHERE mf.message_id=?1 AND (f.account_id!=?2 OR f.role IN ('sent','trash')))",
                params![draft_id, account_id], |r| r.get(0),
            )?;
            if unsafe_history || prior_send || wrong_folder {
                return Err(invalid("草稿已有操作或发送记录，不能重复入队，请刷新队列"));
            }
            let header = old_header.filter(|h| !h.trim().is_empty()).unwrap_or_else(|| {
                let domain = email.rsplit_once('@').map(|(_, domain)| domain).unwrap_or("pebble.local");
                format!("<{}-{}@{}>", now, new_id(), domain)
            });
            let queued_remote = format!("local-outbox-{draft_id}");
            let outbox = folder(&tx, account_id, false)?;
            let count = tx.execute(
                "UPDATE messages SET is_draft=0,remote_id=?1,message_id_header=?2,
                    from_address=?3,from_name=?4,updated_at=?5
                 WHERE id=?6 AND account_id=?7 AND is_draft=1 AND is_deleted=0
                   AND remote_id=?9 AND updated_at=?8",
                params![queued_remote, header, email, display_name, next_version,
                    draft_id, account_id, expected_updated_at, remote_id],
            )?;
            if count != 1 { return Err(invalid("草稿状态已变化，请重新确认")); }
            set_folder(&tx, draft_id, &outbox, now)?;
            let op_id = new_id();
            let payload = json!({
                "provider_account_id": account_id, "remote_id": queued_remote, "op": "send",
                "payload": { "scheduled_at": send_at },
                "workbench_schedule": schedule.is_some(), "send_saved_draft": schedule.is_none(), "expected_updated_at": expected_updated_at,
                "queued_updated_at": next_version,
                "source_draft": remote_source,
            });
            tx.execute(
                "INSERT INTO pending_mail_ops(id,account_id,message_id,op_type,payload_json,status,
                    attempts,last_error,created_at,updated_at,next_retry_at)
                 VALUES(?1,?2,?3,'send',?4,'pending',0,NULL,?5,?5,?6)",
                params![op_id, account_id, draft_id, payload.to_string(), now, send_at],
            )?;
            tx.commit()?;
            Ok(op_id)
        })
    }

    /// Cancel only an untouched future schedule. The done operation is kept as
    /// a tombstone so a worker holding a previously listed op cannot claim it.
    pub fn cancel_workbench_schedule(&self, account_id: &str, operation_id: &str) -> Result<String> {
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            let now = now_timestamp();
            let row = tx.query_row(
                "SELECT message_id,payload_json FROM pending_mail_ops
                 WHERE id=?1 AND account_id=?2 AND op_type='send' AND status='pending'
                   AND attempts=0 AND next_retry_at>?3",
                params![operation_id, account_id, now],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            ).optional()?.ok_or_else(|| invalid("任务已到期、已开始或不属于此账号，不能取消"))?;
            let (draft_id, payload_json) = row;
            let mut payload: Value = serde_json::from_str(&payload_json)
                .map_err(|_| invalid("定时任务数据无效"))?;
            if payload.get("workbench_schedule").and_then(Value::as_bool) != Some(true)
                || payload.get("provider_accepted").is_some_and(|v| !v.is_null() && v != &json!(false) && v != &json!(0))
                || payload.get("submitted_message_id").is_some()
                || payload.get("cancelled_before_submission").is_some()
            {
                return Err(invalid("任务不是可取消的本地草稿定时任务，或已经提交"));
            }
            let send_at = payload.pointer("/payload/scheduled_at").and_then(Value::as_i64)
                .ok_or_else(|| invalid("定时任务时间无效"))?;
            let unchanged: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM messages m JOIN pending_mail_ops p ON p.message_id=m.id
                 WHERE p.id=?1 AND m.id=?2 AND m.account_id=?3 AND m.is_draft=0 AND m.is_deleted=0
                   AND m.remote_id=?4 AND p.next_retry_at=?5
                   AND NOT EXISTS(SELECT 1 FROM message_folders mf JOIN folders f ON f.id=mf.folder_id
                       WHERE mf.message_id=m.id AND (f.account_id!=?3 OR f.role='sent'))
                   AND NOT EXISTS(SELECT 1 FROM pending_mail_ops other WHERE other.message_id=m.id
                       AND other.id!=p.id AND other.status!='done'))",
                params![operation_id, draft_id, account_id, format!("local-outbox-{draft_id}"), send_at],
                |r| r.get(0),
            )?;
            if !unchanged { return Err(invalid("邮件或任务已变化，不能取消为草稿")); }
            let drafts = folder(&tx, account_id, true)?;
            payload["cancelled_before_submission"] = json!(true);
            payload["cancelled_at"] = json!(now);
            let count = tx.execute(
                "UPDATE pending_mail_ops SET status='done',next_retry_at=NULL,last_error=NULL,
                    payload_json=?1,updated_at=?2 WHERE id=?3 AND account_id=?4 AND status='pending'
                    AND attempts=0 AND next_retry_at>?2",
                params![payload.to_string(), now, operation_id, account_id],
            )?;
            if count != 1 { return Err(invalid("任务已经开始，无法取消")); }
            tx.execute(
                "UPDATE messages SET is_draft=1,remote_id='',updated_at=max(updated_at+1,?1)
                 WHERE id=?2 AND account_id=?3", params![now, draft_id, account_id],
            )?;
            set_folder(&tx, &draft_id, &drafts, now)?;
            tx.commit()?;
            Ok(draft_id)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    fn fixture() -> (Store, String, String, i64) {
        let store = Store::open_in_memory().unwrap();
        let now = now_timestamp();
        let account = new_id();
        let draft = new_id();
        store.with_write(|conn| {
            conn.execute("INSERT INTO accounts(id,email,display_name,provider,created_at,updated_at)
                VALUES(?1,'sender@example.test','Fixture','imap',?2,?2)", params![account, now])?;
            conn.execute("INSERT INTO messages(id,account_id,remote_id,to_list,body_text,body_html_raw,
                is_draft,has_attachments,date,created_at,updated_at)
                VALUES(?1,?2,'',?3,'Body','<p>Body<img src=\"cid:fixture\"></p>',1,1,?4,?4,?4)",
                params![draft, account, json!([{"address":"to@example.test","name":null}]).to_string(), now])?;
            for (suffix, inline, cid) in [("regular", false, None), ("inline", true, Some("fixture"))] {
                conn.execute("INSERT INTO attachments(id,message_id,filename,mime_type,size,local_path,content_id,is_inline)
                    VALUES(?1,?2,?3,'image/png',17,?4,?5,?6)",
                    params![format!("{draft}-{suffix}"), draft, format!("{suffix}.png"),
                        format!("fixture-only/{suffix}.png"), cid, inline])?;
            }
            Ok(())
        }).unwrap();
        (store, account, draft, now)
    }

    fn schedule(store: &Store, account: &str, draft: &str, version: i64) -> String {
        store.schedule_workbench_draft(account, draft, version, now_timestamp()+3600).unwrap()
    }

    #[test]
    fn scheduling_is_in_place_atomic_and_preserves_html_attachments_and_cids() {
        let (store, account, draft, version) = fixture();
        let before = store.get_message(&draft).unwrap().unwrap();
        let attachments = store.list_attachments_by_message(&draft).unwrap();
        let op = schedule(&store, &account, &draft, version);
        let queued = store.get_message(&draft).unwrap().unwrap();
        assert_eq!(queued.id, draft);
        assert_eq!(queued.remote_id, format!("local-outbox-{draft}"));
        assert!(!queued.is_draft);
        assert!(queued.message_id_header.as_deref().unwrap().starts_with('<'));
        assert_eq!(queued.body_html_raw, before.body_html_raw);
        assert_eq!(serde_json::to_value(store.list_attachments_by_message(&draft).unwrap()).unwrap(), serde_json::to_value(attachments).unwrap());
        let ops = store.list_pending_mail_ops(&account).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].id, op);
        assert_eq!(ops[0].message_id, draft);
        assert_eq!(ops[0].op_type, "send");
        assert_eq!(serde_json::from_str::<Value>(&ops[0].payload_json).unwrap().pointer("/payload/scheduled_at").and_then(Value::as_i64), ops[0].next_retry_at);
        assert!(!store.try_claim_pending_mail_op(&op).unwrap());
        assert!(store.schedule_workbench_draft(&account, &draft, version, now_timestamp()+3600).is_err());
    }

    #[test]
    fn concurrent_schedulers_create_only_one_send() {
        let (store, account, draft, version) = fixture();
        let store = Arc::new(store);
        let gate = Arc::new(Barrier::new(3));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let (store, gate, account, draft) = (store.clone(), gate.clone(), account.clone(), draft.clone());
            handles.push(std::thread::spawn(move || {
                gate.wait();
                store.schedule_workbench_draft(&account, &draft, version, now_timestamp()+3600)
            }));
        }
        gate.wait();
        let successes = handles.into_iter().filter(|h| h.thread().id() != std::thread::current().id())
            .map(|h| h.join().unwrap().is_ok()).filter(|ok| *ok).count();
        assert_eq!(successes, 1);
        assert_eq!(store.list_pending_mail_ops(&account).unwrap().len(), 1);
    }

    #[test] fn sender_identity_saved_draft_and_schedule_freeze_public_name(){
        for scheduled in [false,true] {
            let (store,account,draft,version)=fixture();
            let email=store.get_account(&account).unwrap().unwrap().email;
            store.update_account_with_sender(&account,&email,"Local Label",None,Some("Public Team")).unwrap();
            if scheduled { store.schedule_workbench_draft(&account,&draft,version,now_timestamp()+3600).unwrap(); }
            else { store.send_saved_draft(&account,&draft,version).unwrap(); }
            store.update_account_with_sender(&account,&email,"Changed Label",None,Some("New Public Team")).unwrap();
            let queued=store.get_message(&draft).unwrap().unwrap();
            assert_eq!(queued.from_name,"Public Team");assert_eq!(queued.from_address,email);
        }
    }

    #[test] fn sending_saved_draft_is_due_now_in_place_and_cannot_be_submitted_twice(){
        let (store,account,draft,version)=fixture();
        let before=store.get_message(&draft).unwrap().unwrap();
        let files=serde_json::to_value(store.list_attachments_by_message(&draft).unwrap()).unwrap();
        let op=store.send_saved_draft(&account,&draft,version).unwrap();
        let after=store.get_message(&draft).unwrap().unwrap();
        assert!(!after.is_draft);assert_eq!(after.id,draft);assert_eq!(after.body_html_raw,before.body_html_raw);
        assert_eq!(serde_json::to_value(store.list_attachments_by_message(&draft).unwrap()).unwrap(),files);
        assert!(store.try_claim_pending_mail_op(&op).unwrap());
        assert!(store.send_saved_draft(&account,&draft,version).is_err());
        assert!(store.replace_message_with_attachments(&before,&[],&[]).is_err());
        let ops=store.list_pending_mail_ops(&account).unwrap();assert_eq!(ops.len(),1);
        let payload:Value=serde_json::from_str(&ops[0].payload_json).unwrap();
        assert_eq!(payload["send_saved_draft"],true);assert_eq!(payload["workbench_schedule"],false);
        assert!(store.cancel_workbench_schedule(&account,&op).is_err());
    }

    #[test] fn saved_draft_send_rejects_wrong_owner_stale_version_and_foreign_state_without_queue(){
        let (store,account,draft,version)=fixture();
        assert!(store.send_saved_draft("other",&draft,version).is_err());
        assert!(store.send_saved_draft(&account,&draft,version-1).is_err());
        store.with_write(|c|{c.execute("UPDATE messages SET remote_id='local-sent-fixture' WHERE id=?1",[&draft])?;Ok(())}).unwrap();
        assert!(store.send_saved_draft(&account,&draft,version).is_err());
        assert!(store.list_pending_mail_ops(&account).unwrap().is_empty());
    }

    #[test] fn remote_draft_send_retains_exact_cleanup_source_but_remote_schedule_still_rejected(){
        let (store,account,draft,version)=fixture();
        store.with_write(|c|{
            c.execute("INSERT INTO folders(id,account_id,remote_id,name,folder_type,role,is_system,sort_order) VALUES('remote-drafts',?1,'Drafts','Drafts','folder','drafts',1,1)",[&account])?;
            c.execute("INSERT INTO message_folders(message_id,folder_id) VALUES(?1,'remote-drafts')",[&draft])?;
            c.execute("UPDATE messages SET remote_id='425',message_id_header='<old-draft@example.test>' WHERE id=?1",[&draft])?;Ok(())
        }).unwrap();
        assert!(store.schedule_workbench_draft(&account,&draft,version,now_timestamp()+3600).is_err());
        store.send_saved_draft(&account,&draft,version).unwrap();
        let ops=store.list_pending_mail_ops(&account).unwrap();
        let payload:Value=serde_json::from_str(&ops[0].payload_json).unwrap();
        assert_eq!(payload["source_draft"]["remote_id"],"425");assert_eq!(payload["source_draft"]["folder_remote_id"],"Drafts");
        assert_eq!(payload["source_draft"]["message_id_header"],"<old-draft@example.test>");
    }
    #[test]
    fn workbench_imported_local_draft_can_schedule_and_stale_editor_cannot_overwrite_it(){
        let (store,account,draft,version)=fixture();
        store.with_write(|c|{c.execute("UPDATE messages SET remote_id=?1 WHERE id=?2",params![format!("__local_draft__:{draft}"),draft])?;Ok(())}).unwrap();
        let mut old=store.get_message(&draft).unwrap().unwrap();
        let files=store.list_attachments_by_message(&draft).unwrap();
        store.replace_message_with_attachments(&old,&[],&files).unwrap();
        let current=store.get_message(&draft).unwrap().unwrap();assert!(current.updated_at>version);
        assert!(store.schedule_workbench_draft(&account,&draft,version,now_timestamp()+3600).is_err());
        schedule(&store,&account,&draft,current.updated_at);
        old.body_text="stale editor text".into();assert!(store.replace_message_with_attachments(&old,&[],&files).is_err());
        assert!(!store.get_message(&draft).unwrap().unwrap().is_draft);
        assert_eq!(store.list_pending_mail_ops(&account).unwrap().len(),1);
    }

    #[test]
    fn wrong_account_stale_version_remote_draft_and_past_time_are_rejected() {
        let (store, account, draft, version) = fixture();
        for (owner, revision, at) in [("other", version, now_timestamp()+3600),
            (account.as_str(), version-1, now_timestamp()+3600), (account.as_str(), version, now_timestamp())] {
            assert!(store.schedule_workbench_draft(owner, &draft, revision, at).is_err());
        }
        store.with_write(|c| { c.execute("UPDATE messages SET remote_id='provider-draft-id' WHERE id=?1", [&draft])?; Ok(()) }).unwrap();
        assert!(store.schedule_workbench_draft(&account, &draft, version, now_timestamp()+3600).is_err());
        assert!(store.list_pending_mail_ops(&account).unwrap().is_empty());
    }

    #[test]
    fn queue_insert_failure_rolls_back_message_folder_and_header() {
        let (store, account, draft, version) = fixture();
        store.with_write(|c| { c.execute_batch("CREATE TRIGGER reject_schedule BEFORE INSERT ON pending_mail_ops BEGIN SELECT RAISE(ABORT,'fixture failure'); END;")?; Ok(()) }).unwrap();
        assert!(store.schedule_workbench_draft(&account, &draft, version, now_timestamp()+3600).is_err());
        let message = store.get_message(&draft).unwrap().unwrap();
        assert!(message.is_draft && message.remote_id.is_empty() && message.message_id_header.is_none());
        assert!(store.get_message_folder_ids(&draft).unwrap().is_empty());
        assert!(store.list_folders(&account).unwrap().is_empty());
    }

    #[test]
    fn cancellation_restores_same_draft_and_restart_or_old_snapshot_cannot_send_it() {
        let (store, account, draft, version) = fixture();
        let op = schedule(&store, &account, &draft, version);
        let queued = store.get_message(&draft).unwrap().unwrap();
        let attachments = serde_json::to_value(store.list_attachments_by_message(&draft).unwrap()).unwrap();
        assert!(store.cancel_workbench_schedule("other", &op).is_err());
        assert_eq!(store.cancel_workbench_schedule(&account, &op).unwrap(), draft);
        let restored = store.get_message(&draft).unwrap().unwrap();
        assert!(restored.is_draft && restored.remote_id.is_empty());
        assert_eq!(restored.message_id_header, queued.message_id_header);
        assert_eq!(restored.body_html_raw, queued.body_html_raw);
        assert_eq!(serde_json::to_value(store.list_attachments_by_message(&draft).unwrap()).unwrap(), attachments);
        store.reset_in_progress_pending_mail_ops().unwrap();
        assert!(!store.try_claim_pending_mail_op(&op).unwrap());
        assert!(store.list_retryable_pending_mail_ops(100).unwrap().is_empty());
        assert!(store.cancel_workbench_schedule(&account, &op).is_err());
        // Explicitly scheduling the new draft revision creates a new operation;
        // the old cancelled operation remains permanently unclaimable.
        let next = schedule(&store, &account, &draft, restored.updated_at);
        assert_ne!(next, op);
        assert!(!store.try_claim_pending_mail_op(&op).unwrap());
    }

    #[test]
    fn due_claimed_accepted_and_submitted_schedules_cannot_be_cancelled() {
        for state in ["due", "in_progress", "accepted", "submitted"] {
            let (store, account, draft, version) = fixture();
            let op = schedule(&store, &account, &draft, version);
            store.with_write(|c| {
                match state {
                    "due" => { c.execute("UPDATE pending_mail_ops SET next_retry_at=?1 WHERE id=?2", params![now_timestamp(), op])?; }
                    "in_progress" => { c.execute("UPDATE pending_mail_ops SET status='in_progress' WHERE id=?1", [&op])?; }
                    "accepted" => { c.execute("UPDATE pending_mail_ops SET payload_json=json_set(payload_json,'$.provider_accepted',1) WHERE id=?1", [&op])?; }
                    _ => { c.execute("UPDATE pending_mail_ops SET payload_json=json_set(payload_json,'$.submitted_message_id','<accepted@example.test>') WHERE id=?1", [&op])?; }
                }
                Ok(())
            }).unwrap();
            assert!(store.cancel_workbench_schedule(&account, &op).is_err(), "{state}");
            assert!(!store.get_message(&draft).unwrap().unwrap().is_draft);
        }
    }

    #[test]
    fn interrupted_send_stays_held_and_cannot_be_cancelled_or_auto_replayed() {
        let (store, account, draft, version) = fixture();
        let op = schedule(&store, &account, &draft, version);
        store.force_pending_mail_op_retry_now_for_test(&op).unwrap();
        assert!(store.try_claim_pending_mail_op(&op).unwrap());
        store.reset_in_progress_pending_mail_ops().unwrap();
        assert!(store.list_retryable_pending_mail_ops(100).unwrap().is_empty());
        assert!(store.cancel_workbench_schedule(&account, &op).is_err());
        assert!(!store.try_claim_pending_mail_op(&op).unwrap());
    }
}
