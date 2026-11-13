//! Send completion is not equivalent to dismissing an error.
use crate::{pending_ops::{PendingMailOp, PendingMailOpStatus}, Store};
use pebble_core::{new_id, now_timestamp, PebbleError, Result};
use rusqlite::{params, OptionalExtension};

impl Store {
    /// Continue cleanup of an accepted send, retaining the transport receipt.
    pub fn retry_send_postprocessing(&self, operation: &str) -> Result<()> {
        self.with_write(|conn| {
            let changed=conn.execute("UPDATE pending_mail_ops SET status='pending',attempts=0,next_retry_at=?1,updated_at=?1,payload_json=json_remove(payload_json,'$.dismissed_at') WHERE id=?2 AND op_type='send' AND status='failed' AND coalesce(json_extract(payload_json,'$.provider_accepted'),0)=1",params![now_timestamp(),operation])?;
            if changed!=1 { return Err(PebbleError::Validation("没有可继续归档的已接受发送任务，未提交发送".into())); } Ok(())
        })
    }
    pub fn commit_accepted_send_archive(&self, operation: &str, sent: &str) -> Result<()> {
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            let row = tx.query_row("SELECT p.message_id,p.account_id FROM pending_mail_ops p JOIN messages m ON m.id=p.message_id AND m.account_id=p.account_id AND m.is_deleted=0 JOIN folders f ON f.id=?2 AND f.account_id=p.account_id AND f.role='sent' WHERE p.id=?1 AND p.op_type='send' AND p.status='in_progress' AND coalesce(json_extract(p.payload_json,'$.provider_accepted'),0)=1",params![operation,sent],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
            let Some((message,account)) = row else { return Err(PebbleError::Validation("未记录发送接受回执，不能提交已发送归档".into())); };
            let now = now_timestamp();
            tx.execute("UPDATE messages SET remote_id=CASE WHEN remote_id LIKE 'local-outbox-%' THEN ?1 ELSE remote_id END,is_draft=0,updated_at=?2 WHERE id=?3 AND account_id=?4",params![format!("local-sent-{message}"),now,message,account])?;
            tx.execute("DELETE FROM message_folders WHERE message_id=?1",[&message])?;
            tx.execute("INSERT INTO message_folders(message_id,folder_id) VALUES(?1,?2)",params![message,sent])?;
            tx.execute("UPDATE pending_mail_ops SET payload_json=json_set(payload_json,'$.local_sent_committed',1),updated_at=?1 WHERE id=?2",params![now,operation])?;
            tx.execute("INSERT OR REPLACE INTO search_pending(message_id,operation,created_at) VALUES(?1,'index',?2)",params![message,now])?;
            tx.commit()?; Ok(())
        })
    }
    /// Persist ownership BEFORE touching SMTP/API. Background workers cannot
    /// claim an immediate submission that is already in progress.
    pub fn begin_immediate_send(&self, account: &str, message: &str, payload: &str) -> Result<PendingMailOp> {
        let value: serde_json::Value = serde_json::from_str(payload).map_err(|e| PebbleError::Validation(e.to_string()))?;
        if !value.is_object() { return Err(PebbleError::Validation("发送记录格式无效".into())); }
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            let valid: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM messages WHERE id=?1 AND account_id=?2 AND is_deleted=0 AND remote_id LIKE 'local-outbox-%')",params![message,account],|r|r.get(0))?;
            let busy: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pending_mail_ops WHERE message_id=?1 AND op_type='send' AND status!='done')",[message],|r|r.get(0))?;
            if !valid || busy { return Err(PebbleError::Validation("发送副本已变化或已有发送任务，未重复提交".into())); }
            let id = new_id(); let now = now_timestamp();
            tx.execute("INSERT INTO pending_mail_ops(id,account_id,message_id,op_type,payload_json,status,attempts,created_at,updated_at) VALUES(?1,?2,?3,'send',?4,'in_progress',0,?5,?5)",params![id,account,message,payload,now])?;
            tx.commit()?;
            Ok(PendingMailOp { id,account_id:account.into(),message_id:message.into(),op_type:"send".into(),payload_json:payload.into(),status:PendingMailOpStatus::InProgress,attempts:0,last_error:None,created_at:now,updated_at:now,next_retry_at:None })
        })
    }

    /// Explicit human confirmation. This is NOT a fabricated provider receipt.
    /// Keeps already-filed mail in its folder; removes only a verified local
    /// duplicate when an existing sent copy was explicitly designated.
    pub fn confirm_pending_send_delivered(&self, operation: &str, duplicate_of: Option<&str>) -> Result<()> {
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            let row = tx.query_row("SELECT p.message_id,p.account_id,p.status,m.remote_id,m.is_deleted FROM pending_mail_ops p JOIN messages m ON m.id=p.message_id AND m.account_id=p.account_id WHERE p.id=?1 AND p.op_type='send'",[operation],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,bool>(4)?))).optional()?;
            let Some((message,account,status,remote,deleted)) = row else { return Err(PebbleError::Validation("未找到对应发送任务".into())); };
            if status == "done" {
                let confirmed: bool = tx.query_row("SELECT coalesce(json_extract(payload_json,'$.user_confirmed_sent'),0)=1 FROM pending_mail_ops WHERE id=?1",[operation],|r|r.get(0))?;
                if confirmed { return Ok(()); }
            }
            if status != "failed" || deleted { return Err(PebbleError::Validation("发送任务正在执行或副本已变化，未修改".into())); }
            let now = now_timestamp();
            if let Some(other) = duplicate_of {
                let identical: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM messages a JOIN messages b ON a.account_id=b.account_id WHERE a.id=?1 AND b.id=?2 AND a.id!=b.id AND b.is_deleted=0 AND b.is_draft=0 AND a.to_list=b.to_list AND a.cc_list=b.cc_list AND a.bcc_list=b.bcc_list AND a.subject=b.subject AND a.body_text=b.body_text AND a.body_html_raw=b.body_html_raw AND a.in_reply_to IS b.in_reply_to
                    AND NOT EXISTS(SELECT 1 FROM attachments WHERE message_id IN (?1,?2))
                    AND EXISTS(SELECT 1 FROM message_folders mf JOIN folders f ON f.id=mf.folder_id WHERE mf.message_id=b.id AND f.role='sent')
                    AND NOT EXISTS(SELECT 1 FROM pending_mail_ops WHERE message_id=b.id AND op_type='send' AND status!='done'))",params![message,other],|r|r.get(0))?;
                if !identical || !remote.starts_with("local-outbox-") { return Err(PebbleError::Validation("不能确认是同账号已发送的本地重复副本，未删除".into())); }
                tx.execute("UPDATE messages SET is_deleted=1,deleted_at=?1,updated_at=?1 WHERE id=?2",params![now,message])?;
            } else {
                let in_outbox: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM message_folders mf JOIN folders f ON f.id=mf.folder_id WHERE mf.message_id=?1 AND f.remote_id='__local_outbox__')",[&message],|r|r.get(0))?;
                if in_outbox {
                    let sent: String = tx.query_row("SELECT id FROM folders WHERE account_id=?1 AND role='sent' ORDER BY sort_order,id LIMIT 1",[&account],|r|r.get(0))?;
                    tx.execute("DELETE FROM message_folders WHERE message_id=?1",[&message])?;
                    tx.execute("INSERT INTO message_folders(message_id,folder_id) VALUES(?1,?2)",params![message,sent])?;
                }
                if remote.starts_with("local-outbox-") { tx.execute("UPDATE messages SET remote_id=?1,updated_at=?2 WHERE id=?3",params![format!("local-sent-{message}"),now,message])?; }
            }
            tx.execute("UPDATE pending_mail_ops SET status='done',last_error=NULL,next_retry_at=NULL,updated_at=?1,payload_json=json_set(payload_json,'$.user_confirmed_sent',1,'$.user_confirmed_at',?1,'$.resolution','user_confirmed_sent','$.confirmed_duplicate_of',?2) WHERE id=?3",params![now,duplicate_of,operation])?;
            tx.execute("INSERT OR REPLACE INTO search_pending(message_id,operation,created_at) VALUES(?1,?2,?3)",params![message,if duplicate_of.is_some(){"remove"}else{"index"},now])?;
            tx.commit()?; Ok(())
        })
    }
}

#[cfg(test)] mod tests {
    use super::*;
    use pebble_core::*;
    fn fixture() -> (Store, String, String, String) {
        let store=Store::open_in_memory().unwrap(); let now=now_timestamp(); let account=new_id();
        store.insert_account(&Account{id:account.clone(),email:"sender@example.test".into(),display_name:"Fixture".into(),color:None,provider:ProviderType::Imap,created_at:now,updated_at:now}).unwrap();
        let outbox=new_id(); let sent=new_id();
        for (id,remote,role) in [(&outbox,"__local_outbox__",None),(&sent,"Sent",Some(FolderRole::Sent))] {
            store.insert_folder(&Folder{id:id.clone(),account_id:account.clone(),remote_id:remote.into(),name:remote.into(),role,folder_type:FolderType::Folder,parent_id:None,color:None,is_system:true,sort_order:0}).unwrap();
        }
        let message=new_id(); let m:Message=serde_json::from_value(serde_json::json!({"id":message,"account_id":account,"remote_id":format!("local-outbox-{message}"),"message_id_header":"<fixture@example.test>","in_reply_to":null,"references_header":null,"thread_id":null,"subject":"Fixture","snippet":"Fixture","from_address":"sender@example.test","from_name":"Fixture","to_list":[],"cc_list":[],"bcc_list":[],"body_text":"Body","body_html_raw":"<p>Body</p>","has_attachments":false,"has_replies":false,"is_read":true,"is_starred":false,"is_draft":false,"is_deleted":false,"deleted_at":null,"date":now,"created_at":now,"updated_at":now,"remote_version":null})).unwrap();
        store.insert_message(&m,&[outbox]).unwrap(); (store,account,message,sent)
    }
    #[test] fn ownership_is_durable_before_send_and_cannot_be_claimed_twice() {
        let(s,a,m,_)=fixture(); let op=s.begin_immediate_send(&a,&m,"{}").unwrap();
        assert_eq!(op.status,PendingMailOpStatus::InProgress);
        assert!(s.list_retryable_pending_mail_ops(20).unwrap().is_empty());
        assert!(s.begin_immediate_send(&a,&m,"{}").is_err());
        assert!(s.record_send_acceptance("missing","<fixture@example.test>").is_err());
        s.reset_in_progress_pending_mail_ops().unwrap();
        assert!(s.list_retryable_pending_mail_ops(20).unwrap().is_empty());
        assert!(!s.send_was_accepted(&op.id).unwrap());
    }
    #[test] fn receipt_archive_and_all_post_stages_are_required_before_done() {
        let(s,a,m,sent)=fixture(); let op=s.begin_immediate_send(&a,&m,"{}").unwrap();
        assert!(s.mark_pending_mail_op_done(&op.id).is_err());
        assert!(s.commit_accepted_send_archive(&op.id,&sent).is_err());
        s.record_send_acceptance(&op.id,"<fixture@example.test>").unwrap();
        assert!(s.mark_pending_mail_op_done(&op.id).is_err());
        s.commit_accepted_send_archive(&op.id,&sent).unwrap();
        assert!(s.get_message(&m).unwrap().unwrap().remote_id.starts_with("local-sent-"));
        assert!(s.mark_pending_mail_op_done(&op.id).is_err());
        for stage in ["send_rules_applied","send_index_updated","source_draft_cleaned"] { s.record_send_completion_stage(&op.id,stage).unwrap(); }
        s.mark_pending_mail_op_done(&op.id).unwrap();
        s.reset_in_progress_pending_mail_ops().unwrap();
        assert_eq!(s.pending_mail_ops_summary(Some(&a)).unwrap().total_active_count,0);
    }
    #[test] fn confirmation_is_atomic_and_is_not_a_fabricated_transport_receipt() {
        let(s,a,m,sent)=fixture(); let op=s.insert_held_send(&a,&m,"{}","Unknown").unwrap();
        s.confirm_pending_send_delivered(&op,None).unwrap();
        s.confirm_pending_send_delivered(&op,None).unwrap();
        assert!(!s.send_was_accepted(&op).unwrap());
        assert_eq!(s.get_message_folder_ids(&m).unwrap(),vec![sent]);
        s.reset_in_progress_pending_mail_ops().unwrap();
        assert!(s.list_retryable_pending_mail_ops(20).unwrap().is_empty());
        assert!(s.retry_failed_send_once(&op).is_err());
    }
    #[test] fn invalid_duplicate_target_rolls_back_and_valid_sent_copy_is_preserved() {
        let(s,a,m,sent)=fixture(); let op=s.insert_held_send(&a,&m,"{}","Unknown").unwrap();
        assert!(s.confirm_pending_send_delivered(&op,Some("missing")).is_err());
        assert!(!s.get_message(&m).unwrap().unwrap().is_deleted);
        let mut other=s.get_message(&m).unwrap().unwrap();other.id=new_id();other.remote_id="local-sent-fixture".into();
        s.insert_message(&other,&[sent]).unwrap();
        s.confirm_pending_send_delivered(&op,Some(&other.id)).unwrap();
        assert!(s.get_message(&m).unwrap().unwrap().is_deleted);
        assert!(!s.get_message(&other.id).unwrap().unwrap().is_deleted);
        assert!(s.list_retryable_pending_mail_ops(20).unwrap().is_empty());
    }
    #[test] fn postprocessing_retry_requires_a_receipt_and_retains_it() {
        let(s,a,m,_)=fixture(); let op=s.begin_immediate_send(&a,&m,"{}").unwrap();
        s.hold_failed_send(&op.id,"Unknown").unwrap();assert!(s.retry_send_postprocessing(&op.id).is_err());
        s.retry_failed_send_once(&op.id).unwrap();assert!(s.try_claim_pending_mail_op(&op.id).unwrap());s.record_send_acceptance(&op.id,"<fixture@example.test>").unwrap();
        s.hold_failed_send(&op.id,"Local storage failure").unwrap();s.retry_send_postprocessing(&op.id).unwrap();
        assert!(s.send_was_accepted(&op.id).unwrap());assert!(s.retry_failed_send_once(&op.id).is_err());
    }
    #[test] fn already_filed_confirmed_mail_keeps_its_current_business_folder() {
        let(s,a,m,sent)=fixture(); let mut folder=s.list_folders(&a).unwrap().into_iter().find(|f|f.id==sent).unwrap();
        folder.id=new_id();folder.remote_id="Customers".into();folder.name="Customers".into();folder.role=None;s.insert_folder(&folder).unwrap();
        s.move_message_to_folder(&m,&folder.id).unwrap();
        let op=s.insert_held_send(&a,&m,"{}","Unknown").unwrap();s.confirm_pending_send_delivered(&op,None).unwrap();
        assert_eq!(s.get_message_folder_ids(&m).unwrap(),vec![folder.id]);
    }
}
