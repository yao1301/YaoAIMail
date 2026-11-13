//! Local-only incremental reply/opt-out/DSN feedback for known research emails.
//! No LLM, web request, SMTP probe, read flag mutation or automatic sending.
use crate::state::AppState;
use pebble_core::{Message,PebbleError,now_timestamp};
use pebble_websearch::outreach_feedback::{self,SentEvidence};
use super::email_check_store::{self,EmailCheck,EmailFeedback};
use serde::{Serialize,Deserialize};
use std::{hash::{Hash,Hasher},collections::BTreeMap};
const KEY:&str="research_feedback_cursor_v1";
#[derive(Default,Serialize,Deserialize)]struct Cursor {updated:i64,id:String,known:u64}
fn report_text(state:&AppState,message:&Message)->String{
    let mut text=message.body_text.chars().take(32000).collect::<String>();
    let root=state.attachments_dir.canonicalize().ok();
    if let (Some(root),Ok(attachments))=(root,state.store.list_attachments_by_message(&message.id)) {
        for a in attachments.into_iter().filter(|a|matches!(a.mime_type.as_str(),"message/delivery-status"|"message/rfc822") && a.size<=65536).take(4){
            let path=a.local_path.and_then(|p|std::path::PathBuf::from(p).canonicalize().ok());
            if let Some(path)=path.filter(|p|p.starts_with(&root)) {if let Ok(bytes)=std::fs::read(path){if bytes.len()<=65536{text.push_str("\n\n");text.push_str(&String::from_utf8_lossy(&bytes));}}}
        }
    }text
}
pub(crate) fn observe(state:&AppState,message:&Message,known:&BTreeMap<String,EmailCheck>)->Result<usize,PebbleError>{
    let sender=message.from_address.trim().to_ascii_lowercase();
    let is_report=["mailer-daemon","postmaster"].contains(&sender.split('@').next().unwrap_or(""));
    if !is_report && !known.contains_key(&sender){return Ok(0)}
    let Some(account)=state.store.get_account(&message.account_id)?else{return Ok(0)};
    if message.is_deleted||message.is_draft||message.from_address.eq_ignore_ascii_case(&account.email)||message.date<now_timestamp()-90*86400{return Ok(0)}
    let folders=state.store.list_folders(&account.id)?;let ids=state.store.get_message_folder_ids(&message.id)?;
    if folders.iter().any(|f|ids.contains(&f.id)&&matches!(f.role,Some(pebble_core::FolderRole::Spam|pebble_core::FolderRole::Trash|pebble_core::FolderRole::Drafts|pebble_core::FolderRole::Sent))){return Ok(0)}
    let references=format!("{} {}",message.in_reply_to.as_deref().unwrap_or(""),message.references_header.as_deref().unwrap_or(""));
    let mut report=String::new();let local=message.from_address.split('@').next().unwrap_or("").to_ascii_lowercase();
    let mut refs=outreach_feedback::message_ids(&references);
    if ["mailer-daemon","postmaster"].contains(&local.as_str()){
        let full=state.store.get_message(&message.id)?.unwrap_or_else(||message.clone());
        report=report_text(state,&full);
        for line in report.lines(){if let Some((name,value))=line.split_once(':'){if name.eq_ignore_ascii_case("Original-Message-ID")||name.eq_ignore_ascii_case("Message-ID"){refs.extend(outreach_feedback::message_ids(value));}}}
    }
    refs.sort();refs.dedup();if refs.is_empty(){return Ok(0)}
    let sent=state.store.sent_messages_for_feedback(&account.id,&refs)?.into_iter().filter(|m|m.from_address.eq_ignore_ascii_case(&account.email)&&m.date<=message.date+120).collect::<Vec<_>>();
    let evidence=sent.iter().filter_map(|m|Some(SentEvidence{header:m.message_id_header.clone()?,recipients:m.to_list.iter().chain(&m.cc_list).chain(&m.bcc_list).map(|a|a.address.to_ascii_lowercase()).filter(|e|known.contains_key(e)).collect()})).collect::<Vec<_>>();
    if evidence.iter().all(|s|s.recipients.is_empty()){return Ok(0)}
    let full=state.store.get_message(&message.id)?.unwrap_or_else(||message.clone());
    if full.is_deleted || full.is_draft || full.account_id!=account.id{return Ok(0)}
    let subject=full.subject.to_lowercase();
    let body=if ["automatic reply","auto-reply","out of office","自动回复"].iter().any(|s|subject.contains(s)){format!("Automatic reply\n{}",full.body_text)}else{full.body_text};
    let signals=outreach_feedback::infer(&message.from_address,&references,&body,&report,&evidence);
    let mut updates=vec![];
    for signal in signals {
        let Some(current)=known.get(&signal.email)else{continue};
        if current.auto_events.iter().any(|e|e.source_message_id.as_deref()==Some(&message.id)&&e.account_id.as_deref()==Some(&account.id)&&e.kind==signal.kind){continue}
        let source=sent.iter().find(|m|m.message_id_header.as_ref()==Some(&signal.sent_header));
        let event=EmailFeedback{kind:signal.kind,recorded_at:message.date.min(now_timestamp()),source:Some("automatic".into()),source_message_id:Some(message.id.clone()),account_id:Some(account.id.clone()),sent_message_id:source.map(|m|m.id.clone()),reason:Some(signal.reason)};
        updates.push((signal.email,EmailCheck{auto_events:vec![event],..Default::default()}));
    }
    let count=updates.len();if count>0{email_check_store::update(&state.store,&state.crypto,updates)?;}Ok(count)
}
pub(crate) fn scan_once(state:&AppState)->Result<(usize,bool),PebbleError>{
    let known=email_check_store::read(&state.store,&state.crypto)?;if known.is_empty(){return Ok((0,false))}
    let mut hasher=std::collections::hash_map::DefaultHasher::new();for key in known.keys(){key.hash(&mut hasher)}let signature=hasher.finish();
    let mut cursor=match state.store.get_secure_user_data(KEY)?{None=>Cursor{updated:now_timestamp()-90*86400,..Default::default()},Some(blob)=>serde_json::from_slice::<Cursor>(&state.crypto.decrypt(&blob)?).map_err(|_|PebbleError::Internal("反馈游标读取失败，原记录保留".into()))?};
    if cursor.known!=0&&cursor.known!=signature{cursor.updated=cursor.updated.min(now_timestamp()-7*86400);cursor.id.clear();}cursor.known=signature;
    let messages=state.store.list_research_feedback_messages(cursor.updated,&cursor.id,100)?;let more=messages.len()==100;let mut changed=0;
    for message in messages {changed+=observe(state,&message,&known)?;cursor.updated=message.updated_at;cursor.id=message.id;}
    if !more {cursor.updated=now_timestamp()-2;cursor.id.clear();}
    let blob=serde_json::to_vec(&cursor).map_err(|_|PebbleError::Internal("反馈游标保存失败".into()))?;state.store.set_secure_user_data(KEY,&state.crypto.encrypt(&blob)?)?;
    Ok((changed,more))
}
#[cfg(test)]mod tests{
 use super::*;use serde_json::json;
 fn state()->AppState{
  let root=std::env::temp_dir().join(format!("feedback-test-{}",pebble_core::new_id()));std::fs::create_dir(&root).unwrap();
  let key=root.join("portable-key");std::fs::write(&key,format!("PEBBLE-PORTABLE-KEY-V1\n{}\n","2a".repeat(32))).unwrap();
  let crypto=pebble_crypto::CryptoService::init_for_profile(&root).unwrap();std::fs::remove_file(key).unwrap();std::fs::remove_dir(&root).unwrap();
  let store=pebble_store::Store::open_in_memory().unwrap();let now=now_timestamp();
  for id in ["a","b"]{let a:pebble_core::Account=serde_json::from_value(json!({"id":id,"email":format!("{id}@sender.invalid"),"display_name":id,"color":null,"provider":"imap","created_at":now,"updated_at":now})).unwrap();store.insert_account(&a).unwrap();
   for role in ["inbox","sent","spam"]{let f:pebble_core::Folder=serde_json::from_value(json!({"id":format!("{id}-{role}"),"account_id":id,"remote_id":role,"name":role,"folder_type":"folder","role":role,"parent_id":null,"color":null,"is_system":true,"sort_order":0})).unwrap();store.insert_folder(&f).unwrap();}}
  let(tx,_)=std::sync::mpsc::channel();let s=AppState::new(store,pebble_search::TantivySearch::open_in_memory().unwrap(),crypto,tx,root);
  email_check_store::update(&s.store,&s.crypto,vec![("buyer@example.invalid".into(),EmailCheck::default())]).unwrap();s
 }
 fn mail(id:&str,account:&str,from:&str,body:&str,reply:Option<&str>)->Message{
  let now=now_timestamp();serde_json::from_value(json!({"id":id,"account_id":account,"remote_id":id,"message_id_header":format!("<{id}@sender.invalid>"),"in_reply_to":reply,"references_header":null,"thread_id":null,"subject":"Business reply","snippet":"","from_address":from,"from_name":"","to_list":[{"address":"buyer@example.invalid","name":null}],"cc_list":[],"bcc_list":[],"body_text":body,"body_html_raw":"","has_attachments":false,"is_read":false,"is_starred":false,"is_draft":false,"date":now-10,"remote_version":null,"is_deleted":false,"deleted_at":null,"created_at":now-10,"updated_at":now})).unwrap()
 }
 fn sent(s:&AppState){let mut m=mail("out","a","a@sender.invalid","A genuine sent request",None);m.date-=20;s.store.insert_message(&m,&["a-sent".into()]).unwrap();}
 #[test]fn real_local_scan_correlates_persists_and_is_idempotent_without_marking_read(){
  let s=state();sent(&s);let m=mail("reply","a","buyer@example.invalid","Please remove me from your list.",Some("out@sender.invalid"));s.store.insert_message(&m,&["a-inbox".into()]).unwrap();
  assert_eq!(scan_once(&s).unwrap().0,1);assert_eq!(scan_once(&s).unwrap().0,0);
  let records=email_check_store::read(&s.store,&s.crypto).unwrap();let row=&records["buyer@example.invalid"];assert_eq!(row.feedback.as_ref().unwrap().kind,"unsubscribe");assert_eq!(row.auto_events.len(),1);assert_eq!(row.feedback.as_ref().unwrap().source_message_id.as_deref(),Some("reply"));
  assert!(!s.store.get_message("reply").unwrap().unwrap().is_read);
 }
 #[test]fn foreign_account_spam_and_quoted_optout_do_not_create_false_restrictions(){
  let s=state();sent(&s);
  for (id,account,body,folders) in [("foreign","b","Unsubscribe",vec!["b-inbox".into()]),("junk","a","Unsubscribe",vec!["a-inbox".into(),"a-spam".into()]),("quoted","a","Thanks for your quote\n> Unsubscribe",vec!["a-inbox".into()])]{let m=mail(id,account,"buyer@example.invalid",body,Some("out@sender.invalid"));s.store.insert_message(&m,&folders).unwrap();}
  scan_once(&s).unwrap();let r=email_check_store::read(&s.store,&s.crypto).unwrap();assert_eq!(r["buyer@example.invalid"].feedback.as_ref().unwrap().kind,"replied");assert_eq!(r["buyer@example.invalid"].auto_events.len(),1);
 }
 #[test]fn dsn_requires_a_real_sent_message_and_manual_correction_wins_over_old_events(){
  let s=state();sent(&s);let report="Original-Message-ID: <out@sender.invalid>\n\nFinal-Recipient: rfc822; buyer@example.invalid\nAction: failed\nStatus: 5.1.1";
  let m=mail("dsn","a","mailer-daemon@example.invalid",report,None);s.store.insert_message(&m,&["a-inbox".into()]).unwrap();
  email_check_store::update(&s.store,&s.crypto,vec![("buyer@example.invalid".into(),EmailCheck{feedback:Some(EmailFeedback{kind:"cleared".into(),recorded_at:now_timestamp(),..Default::default()}),..Default::default()})]).unwrap();
  scan_once(&s).unwrap();let r=email_check_store::read(&s.store,&s.crypto).unwrap();assert_eq!(r["buyer@example.invalid"].feedback.as_ref().unwrap().kind,"cleared");assert_eq!(r["buyer@example.invalid"].auto_events[0].kind,"hard_bounce");
 }
}
