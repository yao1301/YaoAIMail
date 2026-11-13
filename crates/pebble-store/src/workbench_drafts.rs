//! Local draft execution is transactional and idempotent, not an LLM side effect.
use crate::Store;
use pebble_core::{EmailAddress, PebbleError, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkbenchDraftItem {
    pub key: String,
    pub to: Vec<String>,
    #[serde(default)] pub cc: Vec<String>,
    #[serde(default)] pub bcc: Vec<String>,
    pub subject: String,
    pub body_text: String,
    #[serde(default)] pub body_html: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchDraftReceipt { pub key: String, pub draft_id: String, pub created: bool, pub exists: bool }

impl Store {
    pub fn commit_workbench_drafts(&self, account: &str, source: Option<(&str,i64,&str)>, request: &str, items: &[WorkbenchDraftItem]) -> Result<Vec<WorkbenchDraftReceipt>> {
        self.commit_workbench_drafts_inner(account,source,None,request,items)
    }

    pub fn commit_workbench_reply_draft(&self, account:&str, reply_id:&str, version:i64, request:&str, items:&[WorkbenchDraftItem])->Result<Vec<WorkbenchDraftReceipt>> {
        if items.len()!=1 {return Err(PebbleError::Validation("回复草稿必须逐封核对保存".into()));}
        self.commit_workbench_drafts_inner(account,None,Some((reply_id,version)),request,items)
    }

    fn commit_workbench_drafts_inner(&self, account:&str, source:Option<(&str,i64,&str)>, reply:Option<(&str,i64)>, request:&str, items:&[WorkbenchDraftItem])->Result<Vec<WorkbenchDraftReceipt>> {
        if items.is_empty() || items.len()>200 || request.is_empty() || request.len()>160 {
            return Err(PebbleError::Validation("请选择1–200份草稿，并保留原任务编号".into()));
        }
        if items.iter().map(|item|item.body_text.len()+item.body_html.as_ref().map_or(0,String::len)).sum::<usize>()>2_000_000 {
            return Err(PebbleError::Validation("本批正文过大，请减少选择后分批保存".into()));
        }
        let mut keys=HashSet::new();
        for item in items {
            if item.key.is_empty() || item.key.len()>160 || !keys.insert(&item.key) || item.to.is_empty()
                || item.body_text.len()>300_000 || item.body_html.as_ref().is_some_and(|s|s.len()>600_000) {
                return Err(PebbleError::Validation("草稿编号、收件人或正文大小无效".into()));
            }
        }
        self.with_write(|conn| {
            let tx=conn.unchecked_transaction()?;
            let (email,name):(String,String)=tx.query_row("SELECT email,display_name FROM accounts WHERE id=?1",[account],|r|Ok((r.get(0)?,r.get(1)?)))?;
            if let Some((source_id,version,html))=source {
                let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM messages WHERE id=?1 AND account_id=?2 AND updated_at=?3 AND body_html_raw=?4 AND is_deleted=0)",params![source_id,account,version,html],|r|r.get(0))?;
                if !valid { return Err(PebbleError::Validation("来源邮件已变化或不属于当前账户，请重新预览".into())); }
            }
            // Thread metadata comes from the real, same-account source, never model JSON.
            let (parent,references,thread):(Option<String>,Option<String>,Option<String>)=if let Some((id,version))=reply {
                let row:Option<(Option<String>,Option<String>,Option<String>)>=tx.query_row("SELECT message_id_header,references_header,thread_id FROM messages WHERE id=?1 AND account_id=?2 AND updated_at=?3 AND is_deleted=0 AND is_draft=0 AND COALESCE(remote_version,'')!='headers-only'",params![id,account,version],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
                let (parent,old,thread)=row.ok_or_else(||PebbleError::Validation("回复原信已变化、不属于当前账户或正文尚未下载，请重新读取".into()))?;
                if parent.as_ref().is_some_and(|s|s.contains(['\r','\n','\0'])) || old.as_ref().is_some_and(|s|s.contains(['\r','\n','\0'])) {return Err(PebbleError::Validation("原信线程头无效，不能自动建立回复".into()));}
                let references=parent.as_ref().map(|p|format!("{} {}",old.as_deref().unwrap_or(""),p).trim().to_string());
                (parent,references,thread)
            }else{(None,None,None)};
            tx.execute_batch("CREATE TABLE IF NOT EXISTS workbench_draft_receipts(account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,request_key TEXT NOT NULL,item_key TEXT NOT NULL,payload_json TEXT NOT NULL,draft_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(account_id,request_key,item_key));")?;
            let now=pebble_core::now_timestamp();
            let mut folder:Option<String>=tx.query_row("SELECT id FROM folders WHERE account_id=?1 AND role='drafts' LIMIT 1",[account],|r|r.get(0)).optional()?;
            let scope=source.map(|(id,_,_)|format!("mailto:{id}")).unwrap_or_else(||reply.map(|(id,_)|format!("reply:{id}:{request}")).unwrap_or_else(||format!("generated:{request}")));
            let mut receipts=Vec::new();
            for item in items {
                let payload=serde_json::to_string(item).map_err(|e|PebbleError::Storage(e.to_string()))?;
                let old:Option<(String,String)>=tx.query_row("SELECT payload_json,draft_id FROM workbench_draft_receipts WHERE account_id=?1 AND request_key=?2 AND item_key=?3",params![account,scope,item.key],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
                if let Some((previous,id))=old {
                    if previous!=payload { return Err(PebbleError::Validation("这份草稿已保存过，内容与原任务不同；请打开原草稿编辑，勿重复创建".into())); }
                    let exists=tx.query_row("SELECT EXISTS(SELECT 1 FROM messages WHERE id=?1 AND account_id=?2 AND is_draft=1 AND is_deleted=0)",params![id,account],|r|r.get(0))?;
                    receipts.push(WorkbenchDraftReceipt{key:item.key.clone(),draft_id:id,created:false,exists});
                    continue;
                }
                let folder_id=if let Some(id)=folder.as_ref(){id.clone()} else {
                    let id=pebble_core::new_id();
                    tx.execute("INSERT INTO folders(id,account_id,remote_id,name,folder_type,role,is_system,sort_order) VALUES(?1,?2,'__local_workbench_drafts__','Drafts','folder','drafts',1,4)",params![id,account])?;
                    folder=Some(id.clone());id
                };
                let addresses=|xs:&[String]|serde_json::to_string(&xs.iter().map(|s|EmailAddress{name:None,address:s.clone()}).collect::<Vec<_>>()).map_err(|e|PebbleError::Storage(e.to_string()));
                let id=pebble_core::new_id();
                tx.execute("INSERT INTO messages(id,account_id,remote_id,subject,snippet,from_address,from_name,to_list,cc_list,bcc_list,body_text,body_html_raw,is_read,is_draft,date,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,1,1,?13,?13,?13)",params![id,account,format!("__local_draft__:{id}"),item.subject,item.body_text.chars().take(200).collect::<String>(),email,name,addresses(&item.to)?,addresses(&item.cc)?,addresses(&item.bcc)?,item.body_text,item.body_html.as_deref().unwrap_or(""),now])?;
                if reply.is_some() {tx.execute("UPDATE messages SET in_reply_to=?2,references_header=?3,thread_id=?4 WHERE id=?1",params![id,parent,references,thread])?;}
                tx.execute("INSERT INTO message_folders(message_id,folder_id) VALUES(?1,?2)",params![id,folder_id])?;
                tx.execute("INSERT OR REPLACE INTO search_pending(message_id,operation,created_at) VALUES(?1,'index',?2)",params![id,now])?;
                tx.execute("INSERT INTO workbench_draft_receipts(account_id,request_key,item_key,payload_json,draft_id,created_at) VALUES(?1,?2,?3,?4,?5,?6)",params![account,scope,item.key,payload,id,now])?;
                receipts.push(WorkbenchDraftReceipt{key:item.key.clone(),draft_id:id,created:true,exists:true});
            }
            tx.commit()?;Ok(receipts)
        })
    }
}

#[cfg(test)] mod tests {
    use super::*;
    fn fixture()->Store{
        let store=Store::open_in_memory().unwrap();
        for id in ["one","two"] {store.insert_account(&pebble_core::Account{id:id.into(),email:format!("{id}@example.test"),display_name:id.into(),color:None,provider:pebble_core::ProviderType::Imap,created_at:1,updated_at:1}).unwrap();}
        store
    }
    fn item(key:&str)->WorkbenchDraftItem {WorkbenchDraftItem{key:key.into(),to:vec!["buyer@example.test".into()],cc:vec!["copy@example.test".into()],bcc:vec![],subject:"Fixture".into(),body_text:"Original\ncontent".into(),body_html:Some("<p>Original<br>content</p>".into())}}
    #[test] fn repeated_batch_is_atomic_local_only_and_does_not_duplicate(){
        let s=fixture();let rows=vec![item("first"),item("second")];
        let a=s.commit_workbench_drafts("one",None,"request",&rows).unwrap();
        let b=s.commit_workbench_drafts("one",None,"request",&rows).unwrap();
        assert!(a.iter().all(|x|x.created));assert!(b.iter().all(|x|!x.created&&x.exists));
        assert_eq!(a[0].draft_id,b[0].draft_id);
        assert_eq!(s.list_message_ids_by_account("one").unwrap().len(),2);
        let m=s.get_message(&a[0].draft_id).unwrap().unwrap();assert!(m.is_draft);assert_eq!(m.cc_list[0].address,"copy@example.test");assert_eq!(m.body_html_raw,rows[0].body_html.clone().unwrap());
        assert!(s.list_retryable_pending_mail_ops(10).unwrap().is_empty());
    }
    #[test] fn conflicting_repeat_rolls_back_other_new_items(){
        let s=fixture();s.commit_workbench_drafts("one",None,"request",&[item("existing")]).unwrap();
        let mut conflict=item("existing");conflict.subject="Changed".into();
        assert!(s.commit_workbench_drafts("one",None,"request",&[item("new"),conflict]).is_err());
        assert_eq!(s.list_message_ids_by_account("one").unwrap().len(),1);
    }
    #[test] fn missing_source_or_cross_account_cannot_create_drafts(){
        let s=fixture();assert!(s.commit_workbench_drafts("one",Some(("missing",1,"")),"request",&[item("x")]).is_err());
        assert!(s.list_message_ids_by_account("one").unwrap().is_empty());
    }
    #[test] fn deleting_a_saved_draft_does_not_make_replay_create_it_again(){
        let s=fixture();let rows=[item("x")];let a=s.commit_workbench_drafts("one",None,"request",&rows).unwrap();
        s.hard_delete_messages(&[a[0].draft_id.clone()]).unwrap();
        let b=s.commit_workbench_drafts("one",None,"request",&rows).unwrap();assert!(!b[0].exists&&!b[0].created);
    }
    #[test] fn concurrent_batch_creators_make_only_one_copy(){
        let s=std::sync::Arc::new(fixture());let gate=std::sync::Arc::new(std::sync::Barrier::new(3));let mut jobs=vec![];
        for _ in 0..2 {let s=s.clone();let gate=gate.clone();jobs.push(std::thread::spawn(move||{gate.wait();s.commit_workbench_drafts("one",None,"request",&[item("x")]).unwrap()}));}
        gate.wait();let created:usize=jobs.into_iter().map(|job|job.join().unwrap().into_iter().filter(|r|r.created).count()).sum();
        assert_eq!(created,1);assert_eq!(s.list_message_ids_by_account("one").unwrap().len(),1);
    }
    #[test] fn account_deletion_cleans_private_execution_receipts(){
        let s=fixture();s.commit_workbench_drafts("one",None,"request",&[item("x")]).unwrap();
        s.with_write(|c|{c.execute("DELETE FROM accounts WHERE id='one'",[])?;let n:i64=c.query_row("SELECT count(*) FROM workbench_draft_receipts WHERE account_id='one'",[],|r|r.get(0))?;assert_eq!(n,0);Ok(())}).unwrap();
    }
    fn original(s:&Store)->String {
        let id=s.commit_workbench_drafts("one",None,"source",&[item("source")]).unwrap()[0].draft_id.clone();
        s.with_write(|c|{c.execute("UPDATE messages SET is_draft=0,message_id_header='<parent@example.test>',references_header='<root@example.test>',thread_id='fixture-thread',updated_at=12 WHERE id=?1",[&id])?;Ok(())}).unwrap();id
    }
    #[test] fn reply_draft_uses_real_thread_metadata_and_stable_receipts_without_send(){
        let s=fixture();let parent=original(&s);let rows=[item("reply")];
        let saved=s.commit_workbench_reply_draft("one",&parent,12,"request",&rows).unwrap();
        let draft=s.get_message(&saved[0].draft_id).unwrap().unwrap();
        assert_eq!(draft.in_reply_to.as_deref(),Some("<parent@example.test>"));
        assert_eq!(draft.references_header.as_deref(),Some("<root@example.test> <parent@example.test>"));assert_eq!(draft.thread_id.as_deref(),Some("fixture-thread"));
        assert!(draft.is_draft);assert!(!s.get_message(&parent).unwrap().unwrap().is_draft);
        assert!(!s.commit_workbench_reply_draft("one",&parent,12,"request",&rows).unwrap()[0].created);
        assert!(s.list_retryable_pending_mail_ops(10).unwrap().is_empty());
    }
    #[test] fn reply_draft_rejects_changed_missing_cross_account_and_header_only_sources(){
        let s=fixture();let parent=original(&s);let rows=[item("reply")];
        for (account,id,version) in [("one","missing",12),("two",parent.as_str(),12),("one",parent.as_str(),11)] {assert!(s.commit_workbench_reply_draft(account,id,version,"request",&rows).is_err());}
        s.with_write(|c|{c.execute("UPDATE messages SET remote_version='headers-only' WHERE id=?1",[&parent])?;Ok(())}).unwrap();
        assert!(s.commit_workbench_reply_draft("one",&parent,12,"request",&rows).is_err());
        assert_eq!(s.list_message_ids_by_account("one").unwrap().len(),1);
    }
    #[test] fn reply_draft_rejects_malicious_thread_header_and_deleted_source(){
        let s=fixture();let parent=original(&s);
        s.with_write(|c|{c.execute("UPDATE messages SET message_id_header=?2 WHERE id=?1",params![parent,"<id>\r\nBcc: hidden@example.test"])?;Ok(())}).unwrap();
        assert!(s.commit_workbench_reply_draft("one",&parent,12,"request",&[item("reply")]).is_err());
        s.with_write(|c|{c.execute("UPDATE messages SET message_id_header='<parent@example.test>',is_deleted=1 WHERE id=?1",[&parent])?;Ok(())}).unwrap();
        assert!(s.commit_workbench_reply_draft("one",&parent,12,"request",&[item("reply")]).is_err());
    }
}
