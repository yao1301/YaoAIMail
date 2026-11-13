//! Separate cached mail from an IMAP identifier that can no longer be trusted.
use crate::Store;
use pebble_core::{now_timestamp, Result};
use rusqlite::{params, OptionalExtension};
use std::collections::BTreeSet;

pub(crate) fn initialize(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS preserved_remote_history (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        source_folder_id TEXT NOT NULL,
        remote_id TEXT NOT NULL,
        uidvalidity INTEGER NOT NULL,
        preserved_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_preserved_remote_origin
       ON preserved_remote_history(account_id,source_folder_id,uidvalidity,remote_id);")?;
    retire_legacy_history_folders(conn)?;
    Ok(())
}

/// Put legacy copies back where the user expects them. If their source folder
/// was removed, use the account's normal Archive. Keep local IDs until a new
/// server response establishes the link again.
fn retire_legacy_history_folders(conn: &rusqlite::Connection) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    let legacy = {
        let mut stmt = tx.prepare("SELECT id,account_id FROM folders WHERE remote_id='__local_history__'")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (folder, account) in legacy {
        let cross_account: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM message_folders mf JOIN messages m ON m.id=mf.message_id
             WHERE mf.folder_id=?1 AND m.account_id<>?2)", params![folder, account], |r| r.get(0),
        )?;
        if cross_account {
            return Err(pebble_core::PebbleError::Storage("Cannot migrate a legacy IMAP folder with inconsistent ownership".into()));
        }
        let archive: Option<String> = tx.query_row(
            "SELECT id FROM folders WHERE account_id=?1 AND role='archive' AND id<>?2 ORDER BY sort_order,id LIMIT 1",
            params![account, folder], |r| r.get(0),
        ).optional()?;
        // Only use a fallback when an actual row has lost its source folder.
        let needs_archive: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM message_folders mf JOIN messages m ON m.id=mf.message_id
                WHERE mf.folder_id=?1 AND m.account_id=?2 AND NOT EXISTS(
                    SELECT 1 FROM preserved_remote_history h JOIN folders f ON f.id=h.source_folder_id
                    WHERE h.message_id=m.id AND h.account_id=?2 AND f.account_id=?2
                      AND f.remote_id<>'__local_history__'))",
            params![folder, account], |r| r.get(0),
        )?;
        let keep_as_archive = needs_archive && archive.is_none();
        let fallback = archive.as_deref().unwrap_or(&folder);
        tx.execute(
            "INSERT OR IGNORE INTO message_folders(message_id,folder_id)
             SELECT m.id,coalesce(source.id,?3)
             FROM message_folders mf JOIN messages m ON m.id=mf.message_id
             LEFT JOIN preserved_remote_history h ON h.message_id=m.id AND h.account_id=?2
             LEFT JOIN folders source ON source.id=h.source_folder_id AND source.account_id=?2
                  AND source.remote_id<>'__local_history__'
             WHERE mf.folder_id=?1 AND m.account_id=?2",
            params![folder, account, fallback],
        )?;
        if keep_as_archive {
            tx.execute("DELETE FROM message_folders WHERE folder_id=?1 AND message_id IN (
                SELECT h.message_id FROM preserved_remote_history h JOIN folders f ON f.id=h.source_folder_id
                WHERE h.account_id=?2 AND f.account_id=?2 AND f.remote_id<>'__local_history__')", params![folder, account])?;
            tx.execute("UPDATE folders SET remote_id='__local_archive__', name='Archive', role='archive',
                is_system=1, sort_order=3, parent_id=NULL WHERE id=?1", [&folder])?;
        } else {
            tx.execute("UPDATE folders SET parent_id=NULL WHERE parent_id=?1", [&folder])?;
            tx.execute("DELETE FROM folders WHERE id=?1", [&folder])?;
        }
        tx.execute("INSERT OR REPLACE INTO search_pending(message_id,operation,created_at)
            SELECT m.id, 'index', ?2 FROM messages m WHERE m.account_id=?1 AND m.is_deleted=0
              AND substr(m.remote_id,1,18)='__local_history__:'", params![account, now_timestamp()])?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pebble_core::*;
    fn fixture() -> (Store, String, String, String) {
        let s=Store::open_in_memory().unwrap();let now=now_timestamp();
        let a=Account{id:new_id(),email:"sender@example.test".into(),display_name:"Test".into(),color:None,provider:ProviderType::Imap,created_at:now,updated_at:now};s.insert_account(&a).unwrap();
        let f=Folder{id:new_id(),account_id:a.id.clone(),remote_id:"INBOX".into(),name:"Inbox".into(),folder_type:FolderType::Folder,role:Some(FolderRole::Inbox),parent_id:None,color:None,is_system:true,sort_order:0};s.insert_folder(&f).unwrap();
        let m:Message=serde_json::from_value(serde_json::json!({"id":new_id(),"account_id":a.id,"remote_id":"101","message_id_header":"<fixture@example.test>","in_reply_to":null,"references_header":null,"thread_id":null,"subject":"Fixture","snippet":"Body","from_address":a.email,"from_name":"Sender","to_list":[],"cc_list":[],"bcc_list":[],"body_text":"Retain my body","body_html_raw":"<p>Retain my body</p>","has_attachments":false,"is_read":true,"is_starred":false,"is_draft":false,"date":now,"remote_version":null,"is_deleted":false,"deleted_at":null,"created_at":now,"updated_at":now})).unwrap();s.insert_message(&m,&[f.id.clone()]).unwrap();
        (s,a.id,f.id,m.id)
    }
    #[test] fn restricted_view_retains_body_and_returns_same_row_when_visible_again() {
        let(s,a,f,id)=fixture();
        assert_eq!(s.detach_missing_imap_uids(&a,&f,17,&[(id.clone(),"101".into())]).unwrap(),1);
        let saved=s.get_message(&id).unwrap().unwrap();assert!(!saved.is_deleted);assert_eq!(saved.body_text,"Retain my body");assert!(crate::local_messages::is_local_message_id(&saved.remote_id));
        assert_eq!(s.get_message_folder_ids(&id).unwrap(),vec![f.clone()]);
        assert_eq!(s.list_folders(&a).unwrap().len(),1);
        assert_eq!(s.get_max_remote_id(&a,&f).unwrap(),None);
        assert_eq!(s.purge_old_tombstones(0).unwrap(),0);
        assert_eq!(s.restore_visible_history(&a,&f,17,&["101".into()]).unwrap(),1);
        assert_eq!(s.get_message(&id).unwrap().unwrap().remote_id,"101");assert_eq!(s.get_message_folder_ids(&id).unwrap(),vec![f]);
    }
    #[test] fn uid_reuse_in_another_epoch_does_not_restore_the_wrong_body() {
        let(s,a,f,id)=fixture();s.detach_missing_imap_uids(&a,&f,17,&[(id.clone(),"101".into())]).unwrap();
        assert_eq!(s.restore_visible_history(&a,&f,18,&["101".into()]).unwrap(),0);
        assert!(s.get_message(&id).unwrap().unwrap().remote_id.starts_with("__local_imap_cache__:"));
    }
    #[test] fn manual_deletion_is_not_undone_by_visibility_changes() {
        let(s,a,f,id)=fixture();s.detach_missing_imap_uids(&a,&f,17,&[(id.clone(),"101".into())]).unwrap();
        s.soft_delete_message(&id).unwrap();assert_eq!(s.restore_visible_history(&a,&f,17,&["101".into()]).unwrap(),0);
        assert!(s.get_message(&id).unwrap().unwrap().is_deleted);
    }
    #[test] fn cross_account_stale_snapshots_and_pending_user_moves_do_not_detach() {
        let(s,a,f,id)=fixture();let rows=[(id.clone(),"101".into())];
        assert_eq!(s.detach_missing_imap_uids("other",&f,17,&rows).unwrap(),0);
        assert_eq!(s.detach_missing_imap_uids(&a,&f,17,&[(id.clone(),"102".into())]).unwrap(),0);
        s.insert_pending_mail_op(&a,&id,"move_to_folder","{}").unwrap();
        assert_eq!(s.detach_missing_imap_uids(&a,&f,17,&rows).unwrap(),0);
        assert_eq!(s.get_message(&id).unwrap().unwrap().remote_id,"101");
    }

    #[test]
    fn legacy_folder_migration_preserves_membership_attachments_and_deleted_state() {
        let (s,a,f,id)=fixture();
        let legacy=new_id();
        s.with_write(|conn| {
            conn.execute("INSERT INTO folders(id,account_id,remote_id,name,folder_type,is_system) VALUES(?1,?2,'__local_history__','Legacy','folder',1)",params![legacy,a])?;
            detach_imap_uid(conn,&a,&f,17,&id,"101",now_timestamp(),false)?;
            conn.execute("UPDATE message_folders SET folder_id=?1 WHERE message_id=?2",params![legacy,id])?;
            conn.execute("UPDATE messages SET remote_id=?1 WHERE id=?2",params![format!("__local_history__:{id}"),id])?;
            conn.execute("INSERT INTO attachments(id,message_id,filename,mime_type,size,is_inline) VALUES('fixture-part',?1,'file.txt','text/plain',20,0)",[&id])?;
            initialize(conn)
        }).unwrap();
        assert!(s.get_folder(&legacy).unwrap().is_none());
        assert_eq!(s.get_message_folder_ids(&id).unwrap(),vec![f.clone()]);
        assert_eq!(s.list_attachments_by_message(&id).unwrap().len(),1);
        assert_eq!(s.restore_visible_history(&a,&f,17,&["101".into()]).unwrap(),1);
        assert_eq!(s.get_message(&id).unwrap().unwrap().body_text,"Retain my body");
        s.with_write(initialize).unwrap();
        assert_eq!(s.list_folders(&a).unwrap().len(),1);
    }

    #[test]
    fn missing_source_falls_back_to_archive_without_resurrecting_deleted_mail() {
        let (s,a,f,id)=fixture();
        let legacy=new_id();
        s.with_write(|conn| {
            conn.execute("INSERT INTO folders(id,account_id,remote_id,name,folder_type,is_system) VALUES(?1,?2,'__local_history__','Legacy','folder',1)",params![legacy,a])?;
            detach_imap_uid(conn,&a,&f,17,&id,"101",now_timestamp(),false)?;
            conn.execute("UPDATE message_folders SET folder_id=?1 WHERE message_id=?2",params![legacy,id])?;
            conn.execute("UPDATE messages SET is_deleted=1 WHERE id=?1",[&id])?;
            conn.execute("DELETE FROM folders WHERE id=?1",[&f])?;
            initialize(conn)
        }).unwrap();
        let folders=s.list_folders(&a).unwrap();
        assert_eq!(folders.len(),1);
        assert_eq!(folders[0].role,Some(FolderRole::Archive));
        assert_eq!(folders[0].remote_id,"__local_archive__");
        assert_eq!(s.get_message_folder_ids(&id).unwrap(),vec![folders[0].id.clone()]);
        assert!(s.get_message(&id).unwrap().unwrap().is_deleted);
    }

    #[test]
    fn epoch_reset_commits_before_reusing_uids_and_keeps_original_mail() {
        let (s,a,f,id)=fixture();
        s.set_folder_sync_state(&a,&f,r#"{"uidvalidity":17,"last_uid":101}"#).unwrap();
        s.upsert_sync_failure(&a,&f,"101","imap","old epoch").unwrap();
        let queued=s.insert_pending_mail_op(&a,&id,"move_to_folder","{}").unwrap();
        let new_cursor=r#"{"uidvalidity":18}"#;
        s.replace_imap_uid_epoch(&a,&f,17,new_cursor,true).unwrap();
        assert_eq!(s.get_folder_sync_state(&a,&f).unwrap().as_deref(),Some(new_cursor));
        assert!(!s.has_sync_failures_for_folder(&a,&f).unwrap());
        assert!(!s.try_claim_pending_mail_op(&queued).unwrap());
        assert_eq!(s.get_message_folder_ids(&id).unwrap(),vec![f.clone()]);
        assert_eq!(s.restore_visible_history(&a,&f,18,&["101".into()]).unwrap(),0);
        let mut new_mail=s.get_message(&id).unwrap().unwrap();
        new_mail.id=new_id(); new_mail.remote_id="101".into(); new_mail.body_text="Different message".into();
        assert_eq!(s.insert_imap_messages_batch(&[(new_mail.clone(),vec![f.clone()])]).unwrap().0,vec![new_mail.id]);
        assert_eq!(s.list_messages_by_folder(&f,10,0).unwrap().len(),2);
        assert_eq!(s.list_folders(&a).unwrap().len(),1);
    }

    #[test]
    fn in_flight_operation_rolls_back_entire_epoch_change() {
        let (s,a,f,id)=fixture();
        let old_cursor=r#"{"uidvalidity":17,"last_uid":101}"#;
        s.set_folder_sync_state(&a,&f,old_cursor).unwrap();
        let queued=s.insert_pending_mail_op(&a,&id,"move_to_folder","{}").unwrap();
        assert!(s.try_claim_pending_mail_op(&queued).unwrap());
        assert!(s.replace_imap_uid_epoch(&a,&f,17,r#"{"uidvalidity":18}"#,true).is_err());
        assert_eq!(s.get_folder_sync_state(&a,&f).unwrap().as_deref(),Some(old_cursor));
        assert_eq!(s.get_message(&id).unwrap().unwrap().remote_id,"101");
    }
    #[test] fn accepted_send_can_bind_its_server_uid_while_finishing_local_stages() {
        let(s,a,f,id)=fixture();s.update_remote_id(&id,"local-sent-fixture").unwrap();
        let op=s.insert_pending_mail_op(&a,&id,"send","{}").unwrap();assert!(s.try_claim_pending_mail_op(&op).unwrap());
        assert!(!s.adopt_local_sent_copy(&a,&f,"<fixture@example.test>","202").unwrap());
        s.record_send_acceptance(&op,"<fixture@example.test>").unwrap();
        assert!(s.adopt_local_sent_copy(&a,&f,"<fixture@example.test>","202").unwrap());
    }
    #[test] fn sent_dedup_never_replaces_a_valid_folder_uid_or_another_folder_copy() {
        let(s,a,f,id)=fixture();assert!(!s.adopt_local_sent_copy(&a,&f,"<fixture@example.test>","202").unwrap());
        assert_eq!(s.get_message(&id).unwrap().unwrap().remote_id,"101");
        s.update_remote_id(&id,"local-sent-fixture").unwrap();
        assert!(!s.adopt_local_sent_copy(&a,"other-folder","<fixture@example.test>","202").unwrap());
        assert!(s.adopt_local_sent_copy(&a,&f,"<fixture@example.test>","202").unwrap());
        assert_eq!(s.get_message(&id).unwrap().unwrap().remote_id,"202");
    }
    #[test] fn imap_batch_rechecks_a_placeholder_created_after_the_header_snapshot() {
        let(s,a,f,id)=fixture();
        let mut incoming=s.get_message(&id).unwrap().unwrap(); incoming.id=new_id(); incoming.remote_id="202".into(); incoming.remote_version=Some("headers-only".into()); incoming.body_text.clear();
        s.update_remote_id(&id,"local-sent-fixture").unwrap();
        let (inserted,deferred)=s.insert_imap_messages_batch(&[(incoming.clone(),vec![f.clone()])]).unwrap();
        assert!(inserted.is_empty() && deferred.is_empty());
        assert!(s.get_message(&incoming.id).unwrap().is_none());
        let kept=s.get_message(&id).unwrap().unwrap(); assert_eq!(kept.remote_id,"202"); assert_eq!(kept.body_text,"Retain my body");
        // A genuinely different server UID is a separate remote copy.
        incoming.id=new_id(); incoming.remote_id="203".into();
        assert_eq!(s.insert_imap_messages_batch(&[(incoming.clone(),vec![f])]).unwrap().0,vec![incoming.id]);
        assert_eq!(s.get_message(&id).unwrap().unwrap().account_id,a);
    }
    #[test] fn accepted_outbox_is_deferred_until_filing_and_not_resubmitted() {
        let(s,a,f,id)=fixture();
        s.with_write(|c| {c.execute("UPDATE folders SET role='sent' WHERE id=?1",[&f])?; Ok(())}).unwrap();
        s.update_remote_id(&id,"local-outbox-fixture").unwrap();
        let op=s.insert_pending_mail_op(&a,&id,"send","{}").unwrap(); assert!(s.try_claim_pending_mail_op(&op).unwrap());
        let mut incoming=s.get_message(&id).unwrap().unwrap(); incoming.id=new_id(); incoming.remote_id="202".into();
        let batch=vec![(incoming.clone(),vec![f.clone()])];
        // The server may expose Sent before SMTP's response reaches us.
        assert_eq!(s.insert_imap_messages_batch(&batch).unwrap(),(vec![],vec!["202".into()]));
        assert!(!s.send_was_accepted(&op).unwrap());
        s.record_send_acceptance(&op,"<fixture@example.test>").unwrap();
        assert_eq!(s.insert_imap_messages_batch(&batch).unwrap(),(vec![],vec!["202".into()]));
        assert_eq!(s.get_message(&id).unwrap().unwrap().remote_id,"local-outbox-fixture");
        s.update_remote_id(&id,"local-sent-fixture").unwrap();
        assert_eq!(s.insert_imap_messages_batch(&batch).unwrap(),(vec![],vec![]));
        assert_eq!(s.get_message(&id).unwrap().unwrap().remote_id,"202");
        assert!(s.get_message(&incoming.id).unwrap().is_none());
    }

    #[test] fn sync_waits_for_rule_move_and_preserves_other_mail_in_a_mixed_folder() {
        let (s, account, sent, id) = fixture();
        s.with_write(|c| { c.execute("UPDATE folders SET role='sent' WHERE id=?1",[&sent])?; Ok(()) }).unwrap();
        let target = new_id();
        s.insert_folder(&Folder { id: target.clone(), account_id: account.clone(), remote_id: "Projects".into(), name: "Projects".into(),
            folder_type: FolderType::Folder, role: None, parent_id: None, color: None, is_system: false, sort_order: 0 }).unwrap();
        let inbox = new_id();
        s.insert_folder(&Folder { id: inbox.clone(), account_id: account.clone(), remote_id: "Receive".into(), name: "Receive".into(),
            folder_type: FolderType::Folder, role: Some(FolderRole::Inbox), parent_id: None, color: None, is_system: true, sort_order: 0 }).unwrap();
        s.update_remote_id(&id, "local-sent-fixture").unwrap();
        let original = s.get_message(&id).unwrap().unwrap();
        let source_folder = s.get_folder(&sent).unwrap().unwrap();
        let target_folder = s.get_folder(&target).unwrap().unwrap();
        assert_eq!(s.move_rule_messages_to_folder_with_outbox(&[original], &source_folder, &target_folder).unwrap(), 1);
        let op = s.list_pending_mail_ops(&account).unwrap().remove(0).id;
        let mut copy = s.get_message(&id).unwrap().unwrap();
        copy.id = new_id(); copy.remote_id = "702".into(); copy.is_read = false;
        assert!(s.has_outgoing_copy(&copy).unwrap());
        assert_eq!(s.insert_imap_messages_batch(&[(copy.clone(),vec![target.clone()])]).unwrap(), (vec![],vec!["702".into()]));
        let mut sent_echo = copy.clone();
        sent_echo.id = new_id();
        sent_echo.remote_id = "101".into();
        assert_eq!(s.insert_imap_messages_batch(&[(sent_echo,vec![sent.clone()])]).unwrap(), (vec![],vec!["101".into()]));
        s.update_remote_id(&id, "101").unwrap();
        assert_eq!(s.insert_imap_messages_batch(&[(copy.clone(),vec![target.clone()])]).unwrap(), (vec![],vec!["702".into()]));
        assert!(s.try_claim_pending_mail_op(&op).unwrap());
        assert_eq!(s.insert_imap_messages_batch(&[(copy.clone(),vec![target.clone()])]).unwrap(), (vec![],vec!["702".into()]));
        assert!(s.get_message(&copy.id).unwrap().is_none());

        let mut inbound = copy.clone();
        inbound.id = new_id(); inbound.remote_id = "703".into(); inbound.message_id_header = Some("<different@example.test>".into());
        assert!(!s.has_outgoing_copy(&inbound).unwrap());
        assert_eq!(s.insert_imap_messages_batch(&[(inbound.clone(),vec![target.clone()])]).unwrap().0, vec![inbound.id.clone()]);
        assert!(!s.get_message(&inbound.id).unwrap().unwrap().is_read);

        let mut self_delivery = copy.clone();
        self_delivery.id = new_id(); self_delivery.remote_id = "101".into(); // Same UID value in a different folder.
        assert_eq!(s.insert_imap_messages_batch(&[(self_delivery.clone(),vec![inbox.clone()])]).unwrap().0, vec![self_delivery.id.clone()]);

        assert_eq!(s.reconcile_moved_message_by_header(&account,&target,"<fixture@example.test>","702",Some(&id)).unwrap(), Some(id.clone()));
        s.mark_pending_mail_op_done(&op).unwrap();
        assert!(s.has_outgoing_copy(&copy).unwrap()); // No longer in Sent, but its source is recorded.
        assert_eq!(s.insert_imap_messages_batch(&[(copy,vec![target.clone()])]).unwrap(), (vec![],vec![]));
        assert_eq!(s.list_messages_by_folder(&target,50,0).unwrap().len(), 2);
        let received = s.get_message(&self_delivery.id).unwrap().unwrap();
        assert!(!received.is_deleted && !received.is_read);
        assert_eq!(s.get_message_folder_ids(&received.id).unwrap(), vec![inbox]);
    }

    #[test]
    fn startup_rebinds_completed_sent_rule_pair_without_discarding_mime_or_merging_uncertain_copies() {
        let (store, account, sent, id) = fixture();
        store.with_write(|conn| {
            conn.execute("UPDATE folders SET role='sent' WHERE id=?1", [&sent])?;
            Ok(())
        }).unwrap();
        let source = store.get_folder(&sent).unwrap().unwrap();
        let target = Folder {
            id: new_id(), account_id: account.clone(), remote_id: "Project".into(), name: "Project".into(),
            folder_type: FolderType::Folder, role: None, parent_id: None, color: None, is_system: false, sort_order: 1,
        };
        store.insert_folder(&target).unwrap();
        store.update_remote_id(&id, "local-sent-fixture").unwrap();
        let local = store.get_message(&id).unwrap().unwrap();
        store.move_rule_messages_to_folder_with_outbox(&[local.clone()], &source, &target).unwrap();
        let op = store.list_pending_mail_ops(&account).unwrap().remove(0);
        store.mark_pending_mail_op_done(&op.id).unwrap();

        let mut remote = local.clone();
        remote.id = new_id();
        remote.remote_id = "711".into();
        remote.body_text = "Unrelated contents".into();
        remote.body_html_raw = "<p>Server copy of the same message</p>".into();
        store.insert_message(&remote, std::slice::from_ref(&target.id)).unwrap();
        assert!(store.reconcile_completed_sent_rule_copies().unwrap().is_empty());

        store.update_message_content(&remote.id, "Retain\nmy body", &remote.body_html_raw, "", false, None).unwrap();
        store.with_write(|conn| {
            conn.execute("INSERT INTO attachments (id,message_id,filename,mime_type,size,content_id,is_inline)
                         VALUES ('remote-part',?1,'mail.png','image/png',32,'inline',1)", [&remote.id])?;
            Ok(())
        }).unwrap();
        assert!(store.reconcile_completed_sent_rule_copies().unwrap().is_empty());
        store.with_write(|conn| {
            conn.execute("INSERT INTO attachments (id,message_id,filename,mime_type,size,content_id,is_inline)
                         VALUES ('local-part',?1,'local.png','image/png',32,'inline',1)", [&id])?;
            Ok(())
        }).unwrap();

        assert_eq!(store.reconcile_completed_sent_rule_copies().unwrap(), vec![account]);
        assert_eq!(store.get_message(&id).unwrap().unwrap().remote_id, "711");
        assert_eq!(store.list_messages_by_folder(&target.id, 50, 0).unwrap().len(), 1);
        let backup = store.get_message(&remote.id).unwrap().unwrap();
        assert!(backup.is_deleted && backup.deleted_at.is_none());
        assert_eq!(backup.body_html_raw, remote.body_html_raw);
        assert_eq!(store.list_attachments_by_message(&remote.id).unwrap().len(), 1);
        assert!(store.reconcile_completed_sent_rule_copies().unwrap().is_empty());
    }
}

impl Store {
    /// Older builds could complete a local Sent rule move before seeing the
    /// server copy. Repair only proven local/remote pairs in that destination.
    /// Keep the original message, its attachments and its stable references.
    pub fn reconcile_completed_sent_rule_copies(&self) -> Result<Vec<String>> {
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            let candidates = {
                let mut stmt = tx.prepare(
                    "SELECT DISTINCT l.id, r.id, l.account_id, r.remote_id
                     FROM pending_mail_ops p JOIN messages l ON l.id=p.message_id AND l.account_id=p.account_id
                     JOIN accounts a ON a.id=l.account_id
                     JOIN folders source ON source.id=COALESCE(json_extract(p.payload_json,'$.payload.source_folder_id'),
                                                               json_extract(p.payload_json,'$.source_folder_id'))
                     JOIN folders target ON target.id=COALESCE(json_extract(p.payload_json,'$.payload.target_folder_id'),
                                                               json_extract(p.payload_json,'$.target_folder_id'))
                     JOIN message_folders lf ON lf.folder_id=target.id AND lf.message_id=l.id
                     JOIN messages r ON r.account_id=l.account_id AND r.message_id_header=l.message_id_header
                     JOIN message_folders rf ON rf.folder_id=target.id AND rf.message_id=r.id
                     WHERE a.provider='imap' AND p.op_type='move_to_folder' AND p.status='done'
                       AND source.account_id=l.account_id AND source.role='sent'
                       AND target.account_id=l.account_id AND target.role IS NULL AND substr(target.remote_id,1,8)<>'__local_'
                       AND l.remote_id LIKE 'local-sent-%' AND r.remote_id<>'' AND r.remote_id NOT GLOB '*[^0-9]*'
                       AND l.is_deleted=0 AND r.is_deleted=0 AND l.is_draft=0 AND r.is_draft=0
                       AND l.message_id_header<>''
                       AND l.from_address=r.from_address COLLATE NOCASE AND l.subject=r.subject
                       AND l.to_list=r.to_list AND l.cc_list=r.cc_list AND abs(l.date-r.date)<=300
                       AND NOT EXISTS (SELECT 1 FROM pending_mail_ops active
                           WHERE active.message_id IN (l.id,r.id) AND active.status<>'done')
                       AND NOT EXISTS (SELECT 1 FROM message_folders other
                           WHERE other.message_id IN (l.id,r.id) AND other.folder_id<>target.id)
                       AND NOT EXISTS (SELECT 1 FROM message_folders mf JOIN messages other ON other.id=mf.message_id
                           WHERE mf.folder_id=target.id AND other.account_id=l.account_id AND other.is_deleted=0
                             AND other.id NOT IN (l.id,r.id) AND (other.remote_id=r.remote_id
                                OR (other.message_id_header=l.message_id_header AND other.from_address=l.from_address COLLATE NOCASE)))
                     LIMIT 200"
                )?;
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?, row.get::<_,String>(3)?))
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            let mut changed_accounts = BTreeSet::new();
            let now = now_timestamp();
            for (local, remote, account, uid) in candidates {
                if uid.parse::<u32>().ok().filter(|&uid| uid != 0).is_none() { continue; }
                let normalized_body = |id: &str| -> rusqlite::Result<String> {
                    let body: String = tx.query_row("SELECT body_text FROM messages WHERE id=?1", [id], |row| row.get(0))?;
                    Ok(body.split_whitespace().collect::<Vec<_>>().join(" "))
                };
                let local_body = normalized_body(&local)?;
                if local_body.is_empty() || local_body != normalized_body(&remote)?
                    || sent_rule_attachment_parts(&tx, &local)? != sent_rule_attachment_parts(&tx, &remote)? {
                    continue;
                }
                tx.execute(
                    "UPDATE messages SET remote_id=?1, updated_at=?2,
                         is_starred=max(is_starred,(SELECT is_starred FROM messages WHERE id=?4))
                     WHERE id=?3",
                    params![uid, now, local, remote],
                )?;
                // An inactive copy with no tombstone expiry keeps both original
                // MIME representations available for local recovery.
                tx.execute("UPDATE messages SET is_deleted=1, deleted_at=NULL, updated_at=?1 WHERE id=?2", params![now, remote])?;
                tx.execute("UPDATE body_download_jobs SET status='done',updated_at=?1 WHERE message_id=?2", params![now, remote])?;
                tx.execute("INSERT OR REPLACE INTO search_pending VALUES(?1,'remove',?2)", params![remote, now])?;
                tx.execute("INSERT OR REPLACE INTO search_pending VALUES(?1,'index',?2)", params![local, now])?;
                changed_accounts.insert(account);
            }
            tx.commit()?;
            Ok(changed_accounts.into_iter().collect())
        })
    }

    /// Adopt only a local Sent placeholder; never replace a valid remote UID.
    pub fn adopt_local_sent_copy(&self, account: &str, folder: &str, header: &str, uid: &str) -> Result<bool> {
        self.with_write(|conn| adopt_local_sent_copy_in(conn, account, folder, header, uid))
    }
}

type AttachmentPart = (bool, String, String, i64, String, bool);

fn sent_rule_attachment_parts(conn: &rusqlite::Connection, id: &str) -> rusqlite::Result<Vec<AttachmentPart>> {
    let mut stmt = conn.prepare(
        "SELECT is_inline, coalesce(content_id,''), mime_type, size, filename,
                coalesce(local_path,'')<>''
         FROM attachments WHERE message_id=?1"
    )?;
    let rows = stmt.query_map([id], |row| {
        let inline: bool = row.get(0)?;
        let content_id: String = row.get(1)?;
        // Servers can rename an inline image without changing its MIME part.
        let filename = if inline && !content_id.is_empty() { String::new() } else { row.get(4)? };
        Ok((inline, content_id, row.get(2)?, row.get(3)?, filename, row.get(5)?))
    })?;
    let mut parts = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    parts.sort();
    Ok(parts)
}

pub(crate) fn adopt_local_sent_copy_in(conn: &rusqlite::Connection, account: &str, folder: &str, header: &str, uid: &str) -> Result<bool> {
            let changed = conn.execute("UPDATE messages SET remote_id=?1,updated_at=?2 WHERE id=(
                SELECT m.id FROM messages m JOIN message_folders mf ON mf.message_id=m.id
                WHERE m.account_id=?3 AND mf.folder_id=?4 AND m.message_id_header=?5 AND m.is_deleted=0
                  AND substr(m.remote_id,1,11)='local-sent-'
                  AND NOT EXISTS(SELECT 1 FROM pending_mail_ops p WHERE p.message_id=m.id AND p.status IN ('pending','in_progress')
                    AND (p.op_type!='send' OR coalesce(json_extract(p.payload_json,'$.provider_accepted'),0)!=1))
                ORDER BY m.created_at LIMIT 1)",params![uid,now_timestamp(),account,folder,header])?;
            Ok(changed > 0)
}

impl Store {
    /// Keep the cached message in its folder. Park only the old UID so a
    /// server write cannot target an identifier that is no longer visible.
    pub fn detach_missing_imap_uids(&self, account: &str, folder: &str, epoch: u64, messages: &[(String, String)]) -> Result<usize> {
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            let now = now_timestamp();
            let mut changed = 0;
            for (id, uid) in messages {
                changed += detach_imap_uid(&tx, account, folder, epoch, id, uid, now, false)?;
            }
            tx.commit()?;
            Ok(changed)
        })
    }

    /// Change the UID epoch atomically with invalidation of the old numeric
    /// IDs (including tombstones). Fetches can then safely reuse UID numbers.
    pub fn replace_imap_uid_epoch(&self, account: &str, folder: &str, old_epoch: u64, new_state: &str, retain: bool) -> Result<()> {
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            let rows = {
                let mut stmt = tx.prepare("SELECT m.id,m.remote_id FROM messages m JOIN message_folders mf ON mf.message_id=m.id
                    WHERE m.account_id=?1 AND mf.folder_id=?2 AND m.remote_id<>'' AND m.remote_id NOT GLOB '*[^0-9]*'")?;
                let rows = stmt.query_map(params![account, folder], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            let now = now_timestamp();
            for (id, uid) in rows {
                // Never replay an action recorded under the previous epoch
                // against a reused UID. Let an already running operation
                // finish before changing the binding.
                tx.execute("UPDATE pending_mail_ops SET status='failed',attempts=?2,next_retry_at=NULL,
                    last_error='服务器已更换此文件夹的邮件编号，旧操作已停止，请核对邮件后重试。',updated_at=?3
                    WHERE message_id=?1 AND status IN ('pending','failed') AND op_type<>'send'",
                    params![id, crate::pending_ops::MAX_PENDING_MAIL_OP_ATTEMPTS, now])?;
                if detach_imap_uid(&tx, account, folder, old_epoch, &id, &uid, now, true)? != 1 {
                    return Err(pebble_core::PebbleError::Sync("IMAP UID epoch changed while mail operations are pending; folder sync paused".into()));
                }
                if !retain {
                    tx.execute("UPDATE messages SET is_deleted=1,deleted_at=coalesce(deleted_at,?2) WHERE id=?1", params![id, now])?;
                    tx.execute("INSERT OR REPLACE INTO search_pending VALUES(?1,'remove',?2)", params![id, now])?;
                }
            }
            tx.execute("DELETE FROM sync_failures WHERE account_id=?1 AND folder_id=?2", params![account, folder])?;
            tx.execute("INSERT INTO folder_sync_state(account_id,folder_id,state,updated_at) VALUES(?1,?2,?3,?4)
                ON CONFLICT(account_id,folder_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at",
                params![account, folder, new_state, now])?;
            tx.commit()?;
            Ok(())
        })
    }

    pub fn has_detached_imap_uids(&self, account: &str, folder: &str, epoch: u64) -> Result<bool> {
        self.with_read(|conn| Ok(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM preserved_remote_history
              WHERE account_id=?1 AND source_folder_id=?2 AND uidvalidity=?3)",
            params![account, folder, epoch as i64], |row| row.get(0),
        )?))
    }

    pub fn has_detached_imap_uid_match(&self, account: &str, folder: &str, epoch: u64, uids: &[String]) -> Result<bool> {
        let uids = serde_json::to_string(uids).map_err(|e| pebble_core::PebbleError::Storage(e.to_string()))?;
        self.with_read(|conn| Ok(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM preserved_remote_history
              WHERE account_id=?1 AND source_folder_id=?2 AND uidvalidity=?3
                AND remote_id IN (SELECT value FROM json_each(?4)))",
            params![account, folder, epoch as i64, uids], |row| row.get(0),
        )?))
    }

    /// Reattach only a verified UID from the same account, folder and epoch.
    /// An explicit local move or deletion is never undone.
    pub fn restore_visible_history(&self, account: &str, folder: &str, epoch: u64, uids: &[String]) -> Result<usize> {
        if epoch == 0 || uids.is_empty() { return Ok(0); }
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            let now = now_timestamp();
            let uids = serde_json::to_string(uids).map_err(|e| pebble_core::PebbleError::Storage(e.to_string()))?;
            let rows = {
                let mut stmt = tx.prepare("SELECT m.id,h.remote_id FROM preserved_remote_history h JOIN messages m ON m.id=h.message_id
                    JOIN message_folders mf ON mf.message_id=m.id AND mf.folder_id=h.source_folder_id
                    WHERE h.account_id=?1 AND m.account_id=?1 AND h.source_folder_id=?2 AND h.uidvalidity=?3
                    AND h.remote_id IN (SELECT value FROM json_each(?4)) AND m.is_deleted=0
                    AND (substr(m.remote_id,1,18)='__local_history__:' OR substr(m.remote_id,1,21)='__local_imap_cache__:')
                    AND NOT EXISTS(SELECT 1 FROM pending_mail_ops p WHERE p.message_id=m.id AND p.status<>'done')
                    AND NOT EXISTS(SELECT 1 FROM messages existing JOIN message_folders ef ON ef.message_id=existing.id
                        WHERE existing.account_id=?1 AND ef.folder_id=?2 AND existing.remote_id=h.remote_id)
                    ORDER BY h.preserved_at DESC, m.id")?;
                let rows = stmt.query_map(params![account, folder, epoch as i64, uids],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            let mut claimed = BTreeSet::new();
            for (id, uid) in rows {
                if !claimed.insert(uid.clone()) { continue; }
                tx.execute("UPDATE messages SET remote_id=?1,updated_at=?2 WHERE id=?3", params![uid, now, id])?;
                tx.execute("UPDATE body_download_jobs SET status='pending',attempts=0,next_attempt_at=0,last_error=NULL
                    WHERE message_id=?1 AND EXISTS(SELECT 1 FROM messages WHERE id=?1 AND remote_version='headers-only')", [&id])?;
                tx.execute("DELETE FROM preserved_remote_history WHERE message_id=?1", [&id])?;
                tx.execute("INSERT OR REPLACE INTO search_pending VALUES(?1,'index',?2)", params![id, now])?;
            }
            tx.commit()?;
            Ok(claimed.len())
        })
    }
}

fn detach_imap_uid(conn: &rusqlite::Connection, account: &str, folder: &str, epoch: u64, id: &str, uid: &str, now: i64, epoch_changed: bool) -> Result<usize> {
    if uid.parse::<u32>().is_err() { return Ok(0); }
    let changed = conn.execute("UPDATE messages SET remote_id=?1,updated_at=?2
        WHERE id=?3 AND account_id=?4 AND remote_id=?5 AND (is_deleted=0 OR ?7)
          AND EXISTS(SELECT 1 FROM message_folders mf JOIN folders f ON f.id=mf.folder_id
                     WHERE mf.message_id=?3 AND f.id=?6 AND f.account_id=?4 AND substr(f.remote_id,1,8)<>'__local_')
          AND NOT EXISTS(SELECT 1 FROM pending_mail_ops WHERE message_id=?3 AND status<>'done'
              AND (NOT ?7 OR status='in_progress' OR op_type='send'))",
        params![format!("__local_imap_cache__:{id}"), now, id, account, uid, folder, epoch_changed])?;
    if changed != 0 {
        conn.execute("INSERT OR REPLACE INTO preserved_remote_history VALUES(?1,?2,?3,?4,?5,?6)",
            params![id, account, folder, uid, epoch as i64, now])?;
        conn.execute("UPDATE body_download_jobs SET status='unavailable',next_attempt_at=0,updated_at=?2 WHERE message_id=?1", params![id, now])?;
    }
    Ok(changed)
}
