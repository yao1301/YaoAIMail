//! App-created copies have no provider-side UID. Never send these IDs to IMAP.
use crate::Store;
use pebble_core::{PebbleError, Result};
use rusqlite::{params, OptionalExtension};

pub fn is_local_message_id(id: &str) -> bool {
    id.is_empty() || id.starts_with("__local_") || id.starts_with("local-sent-") || id.starts_with("local-outbox-")
}

impl Store {
    /// Handle a user-requested local deletion atomically, without server calls.
    /// False means the message now has a real server identifier: caller reloads.
    pub fn delete_local_message(&self, id: &str, trash: Option<&str>, permanent: bool) -> Result<bool> {
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            let row = tx.query_row("SELECT remote_id,account_id FROM messages WHERE id=?1", [id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
            let Some((remote, account)) = row else { return Err(PebbleError::Validation("邮件已不存在，请刷新列表".into())); };
            if !is_local_message_id(&remote) { return Ok(false); }
            let busy:bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pending_mail_ops WHERE message_id=?1 AND status='in_progress')",[id],|r|r.get(0))?;
            if busy { return Err(PebbleError::Validation("此邮件有正在执行的操作，请稍后再删除".into())); }
            if let Some(trash) = trash {
                let valid:bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM folders WHERE id=?1 AND account_id=?2 AND role='trash')",params![trash,account],|r|r.get(0))?;
                if !valid { return Err(PebbleError::Validation("废纸篓不属于此邮件账号".into())); }
            }
            let now = pebble_core::now_timestamp();
            // Deleting a queued message must also cancel its send, never leave
            // an invisible scheduled/retry operation capable of transmitting it.
            tx.execute("UPDATE pending_mail_ops SET status='done',next_retry_at=NULL,last_error=NULL,updated_at=?1 WHERE message_id=?2 AND status!='done'",params![now,id])?;
            if permanent {
                tx.execute("DELETE FROM message_folders WHERE message_id=?1",[id])?;
                tx.execute("DELETE FROM messages WHERE id=?1",[id])?;
            } else if let Some(trash) = trash {
                tx.execute("DELETE FROM message_folders WHERE message_id=?1",[id])?;
                tx.execute("INSERT INTO message_folders(message_id,folder_id) VALUES(?1,?2)",params![id,trash])?;
                tx.execute("UPDATE messages SET is_deleted=0,deleted_at=NULL,updated_at=?1 WHERE id=?2",params![now,id])?;
            } else {
                tx.execute("UPDATE messages SET is_deleted=1,deleted_at=?1,updated_at=?1 WHERE id=?2",params![now,id])?;
            }
            tx.commit()?; Ok(true)
        })
    }

    pub fn restore_local_message(&self, id: &str, inbox: &str) -> Result<bool> {
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            let row = tx.query_row("SELECT remote_id,account_id FROM messages WHERE id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
            let Some((remote,account)) = row else { return Err(PebbleError::Validation("邮件已不存在".into())); };
            if !is_local_message_id(&remote) { return Ok(false); }
            let valid:bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM folders WHERE id=?1 AND account_id=?2 AND role='inbox')",params![inbox,account],|r|r.get(0))?;
            if !valid { return Err(PebbleError::Validation("收件箱不属于此邮件账号".into())); }
            tx.execute("DELETE FROM message_folders WHERE message_id=?1",[id])?;
            tx.execute("INSERT INTO message_folders(message_id,folder_id) VALUES(?1,?2)",params![id,inbox])?;
            tx.execute("UPDATE messages SET is_deleted=0,deleted_at=NULL,updated_at=?1 WHERE id=?2",params![pebble_core::now_timestamp(),id])?;
            tx.commit()?; Ok(true)
        })
    }
}

#[cfg(test)] mod tests {
    use super::*;
    use pebble_core::*;
    fn fixture(remote:&str)->(Store,String,String,String,String) {
        let s=Store::open_in_memory().unwrap(); let now=now_timestamp();
        let a=Account{id:new_id(),email:"sender@example.test".into(),display_name:"Fixture".into(),color:None,provider:ProviderType::Imap,created_at:now,updated_at:now};s.insert_account(&a).unwrap();
        let mut ids=Vec::new();
        for (role,name) in [(FolderRole::Sent,"Sent"),(FolderRole::Trash,"Trash"),(FolderRole::Inbox,"Inbox")] {
            let f=Folder{id:new_id(),account_id:a.id.clone(),remote_id:format!("INBOX.{name}"),name:name.into(),folder_type:FolderType::Folder,role:Some(role),parent_id:None,color:None,is_system:true,sort_order:0};s.insert_folder(&f).unwrap();ids.push(f.id);
        }
        let id=new_id(); let m:Message=serde_json::from_value(serde_json::json!({"id":id,"account_id":a.id,"remote_id":remote,"message_id_header":"<fixture@example.test>","in_reply_to":null,"references_header":null,"thread_id":null,"subject":"Fixture","snippet":"Fixture","from_address":a.email,"from_name":"Fixture","to_list":[],"cc_list":[],"bcc_list":[],"body_text":"Fixture","body_html_raw":"","has_attachments":false,"is_read":true,"is_starred":false,"is_draft":false,"date":now,"remote_version":null,"is_deleted":false,"deleted_at":null,"created_at":now,"updated_at":now})).unwrap();s.insert_message(&m,&[ids[0].clone()]).unwrap();
        (s,a.id,id,ids[1].clone(),ids[2].clone())
    }
    #[test] fn only_explicit_local_ids_bypass_server_operations() {
        for id in ["","__local_draft__","local-sent-fixture","local-outbox-fixture"] {assert!(is_local_message_id(id));}
        for id in ["142","server-id","abc-invalid-uid","local-sent","AAMkGraphRemoteId"] {assert!(!is_local_message_id(id));}
    }
    #[test] fn local_copy_can_be_trashed_restored_then_permanently_deleted_offline() {
        let(s,_,id,trash,inbox)=fixture("local-sent-fixture");
        assert!(s.delete_local_message(&id,Some(&trash),false).unwrap());
        assert_eq!(s.get_message_folder_ids(&id).unwrap(),vec![trash.clone()]);
        assert!(s.get_message(&id).unwrap().is_some());
        assert!(s.restore_local_message(&id,&inbox).unwrap());
        assert_eq!(s.get_message_folder_ids(&id).unwrap(),vec![inbox]);
        assert!(s.delete_local_message(&id,Some(&trash),false).unwrap());
        assert!(s.delete_local_message(&id,Some(&trash),true).unwrap());
        assert!(s.get_message(&id).unwrap().is_none());
    }
    #[test] fn deleting_a_queued_copy_cancels_its_send_and_restore_does_not_reactivate_it() {
        let(s,account,id,trash,inbox)=fixture("local-outbox-fixture");
        let op=s.insert_pending_mail_op(&account,&id,"send","{}").unwrap();
        assert!(s.delete_local_message(&id,Some(&trash),false).unwrap());
        assert!(s.list_retryable_pending_mail_ops(20).unwrap().is_empty());
        assert!(s.restore_local_message(&id,&inbox).unwrap());
        assert!(!s.try_claim_pending_mail_op(&op).unwrap());
    }
    #[test] fn real_server_message_and_inflight_send_are_not_silently_deleted() {
        let(s,_,id,trash,_)=fixture("12345");
        assert!(!s.delete_local_message(&id,Some(&trash),false).unwrap());
        assert!(s.get_message(&id).unwrap().is_some());
        let(s,account,id,trash,_)=fixture("local-outbox-fixture");
        let op=s.insert_pending_mail_op(&account,&id,"send","{}").unwrap();s.try_claim_pending_mail_op(&op).unwrap();
        assert!(s.delete_local_message(&id,Some(&trash),false).is_err());
        assert!(s.get_message(&id).unwrap().is_some());
    }
}
