//! Desktop-free repository, shared by IPC and isolated persistence tests.
use pebble_core::PebbleError;
use pebble_crypto::CryptoService;
use pebble_store::Store;
use pebble_websearch::email_checks::{EmailScreen,EmailVerification};
use serde::{Serialize,Deserialize};
use std::collections::BTreeMap;
const KEY:&str="research_email_checks_v1";
static LOCK:std::sync::Mutex<()>=std::sync::Mutex::new(());
#[derive(Clone,Default,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct EmailCheck {pub screen:Option<EmailScreen>,pub verification:Option<EmailVerification>,#[serde(default)]pub feedback:Option<EmailFeedback>,#[serde(default)]pub auto_events:Vec<EmailFeedback>}
#[derive(Clone,Default,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct EmailFeedback {pub kind:String,pub recorded_at:i64,#[serde(default)]pub source:Option<String>,#[serde(default)]pub source_message_id:Option<String>,#[serde(default)]pub account_id:Option<String>,#[serde(default)]pub sent_message_id:Option<String>,#[serde(default)]pub reason:Option<String>}
pub fn read(store:&Store,crypto:&CryptoService)->Result<BTreeMap<String,EmailCheck>,PebbleError>{
    let Some(blob)=store.get_secure_user_data(KEY)?else{return Ok(BTreeMap::new())};
    serde_json::from_slice(&crypto.decrypt(&blob)?).map_err(|_|PebbleError::Internal("邮箱检查记录读取失败，原记录未覆盖".into()))
}
pub fn update(store:&Store,crypto:&CryptoService,rows:Vec<(String,EmailCheck)>)->Result<(),PebbleError>{
    let _guard=LOCK.lock().map_err(|_|PebbleError::Internal("邮箱检查记录忙，请重试".into()))?;
    let mut all=read(store,crypto)?;
    for(email,row)in rows{
        let current=all.entry(email).or_default();
        if row.screen.as_ref().is_some_and(|s|s.checked_at>=current.screen.as_ref().map(|s|s.checked_at).unwrap_or(0)){current.screen=row.screen;}
        if row.verification.as_ref().is_some_and(|s|s.checked_at>=current.verification.as_ref().map(|s|s.checked_at).unwrap_or(0)){current.verification=row.verification;}
        if row.feedback.as_ref().is_some_and(|s|s.recorded_at>=current.feedback.as_ref().map(|s|s.recorded_at).unwrap_or(0)){current.feedback=row.feedback;}
        for event in row.auto_events {
            if current.auto_events.iter().any(|old|old.source_message_id==event.source_message_id&&old.account_id==event.account_id&&old.kind==event.kind){continue}
            // Replies never revoke opt-outs/hard-bounces. Only an explicit
            // human correction can clear such restrictions.
            let sticky=current.feedback.as_ref().is_some_and(|f|matches!(f.kind.as_str(),"unsubscribe"|"hard_bounce"));
            let newer=current.feedback.as_ref().is_none_or(|f|event.recorded_at>f.recorded_at);
            if newer && (!sticky || event.kind=="unsubscribe") {current.feedback=Some(event.clone());}
            current.auto_events.push(event);
        }
        current.auto_events.sort_by_key(|e|e.recorded_at);
        if current.auto_events.len()>20{current.auto_events.drain(..current.auto_events.len()-20);}
    }
    while all.len()>10_000{
        let oldest=all.iter().filter(|(_,v)|pebble_websearch::email_checks::contact_block(v.screen.as_ref(),v.verification.as_ref(),v.feedback.as_ref().map(|f|f.kind.as_str()),pebble_core::now_timestamp()).is_none())
            .min_by_key(|(_,v)|v.verification.as_ref().map(|v|v.checked_at).unwrap_or(0).max(v.screen.as_ref().map(|s|s.checked_at).unwrap_or(0))).map(|(k,_)|k.clone());
        if let Some(key)=oldest{all.remove(&key);}else{break;}
    }
    let bytes=serde_json::to_vec(&all).map_err(|_|PebbleError::Internal("邮箱检查记录保存失败".into()))?;
    store.set_secure_user_data(KEY,&crypto.encrypt(&bytes)?)
}
#[cfg(test)]mod tests{
    use super::*;
    fn fixture()->(Store,CryptoService){
        let folder=std::env::temp_dir().join(format!("email-check-store-test-{}",pebble_core::new_id()));std::fs::create_dir(&folder).unwrap();
        let key=folder.join("portable-key");std::fs::write(&key,format!("PEBBLE-PORTABLE-KEY-V1\n{}\n","2a".repeat(32))).unwrap();
        let crypto=CryptoService::init_for_profile(&folder).unwrap();std::fs::remove_file(key).unwrap();std::fs::remove_dir(folder).unwrap();
        (Store::open_in_memory().unwrap(),crypto)
    }
    #[test]fn encrypted_roundtrip_keeps_feedback_separate_from_dns(){
        let(store,crypto)=fixture();let email="a@example.org";
        update(&store,&crypto,vec![(email.into(),EmailCheck{feedback:Some(EmailFeedback{kind:"unsubscribe".into(),recorded_at:123,..Default::default()}),..Default::default()})]).unwrap();
        update(&store,&crypto,vec![(email.into(),EmailCheck{screen:Some(EmailScreen{email:email.into(),status:pebble_websearch::email_checks::ScreenStatus::Passed,reason:"MX".into(),checked_at:124}),..Default::default()})]).unwrap();
        let rows=read(&store,&crypto).unwrap();assert_eq!(rows[email].feedback.as_ref().unwrap().kind,"unsubscribe");
        let blob=store.get_secure_user_data(KEY).unwrap().unwrap();assert!(!String::from_utf8_lossy(&blob).contains(email));
    }
    #[test]fn late_old_response_cannot_replace_newer_feedback(){let(store,crypto)=fixture();for(time,kind)in[(200,"unsubscribe"),(100,"replied")]{update(&store,&crypto,vec![("a@example.org".into(),EmailCheck{feedback:Some(EmailFeedback{kind:kind.into(),recorded_at:time,..Default::default()}),..Default::default()})]).unwrap();}assert_eq!(read(&store,&crypto).unwrap()["a@example.org"].feedback.as_ref().unwrap().kind,"unsubscribe");}
    #[test]fn automatic_events_are_idempotent_and_replies_cannot_revoke_an_optout(){
        let(store,crypto)=fixture();let event=|kind:&str,time:i64,id:&str|EmailFeedback{kind:kind.into(),recorded_at:time,source:Some("automatic".into()),source_message_id:Some(id.into()),..Default::default()};
        for e in [event("unsubscribe",100,"m1"),event("replied",200,"m2"),event("unsubscribe",100,"m1")]{update(&store,&crypto,vec![("a@example.org".into(),EmailCheck{auto_events:vec![e],..Default::default()})]).unwrap();}
        let r=read(&store,&crypto).unwrap();assert_eq!(r["a@example.org"].feedback.as_ref().unwrap().kind,"unsubscribe");assert_eq!(r["a@example.org"].auto_events.len(),2);
        update(&store,&crypto,vec![("a@example.org".into(),EmailCheck{feedback:Some(EmailFeedback{kind:"cleared".into(),recorded_at:300,..Default::default()}),..Default::default()})]).unwrap();
        update(&store,&crypto,vec![("a@example.org".into(),EmailCheck{auto_events:vec![event("hard_bounce",250,"m3")],..Default::default()})]).unwrap();
        assert_eq!(read(&store,&crypto).unwrap()["a@example.org"].feedback.as_ref().unwrap().kind,"cleared");
    }
    #[test]fn corrupt_cache_is_preserved(){let(store,crypto)=fixture();let bad=vec![1u8,2,3];store.set_secure_user_data(KEY,&bad).unwrap();assert!(update(&store,&crypto,vec![]).is_err());assert_eq!(store.get_secure_user_data(KEY).unwrap().unwrap(),bad);}
    #[test]fn pruning_never_discards_an_optout(){let(store,crypto)=fixture();let mut rows=(0..10_001).map(|i|(format!("a{i}@example.org"),EmailCheck::default())).collect::<Vec<_>>();rows.push(("optout@example.org".into(),EmailCheck{feedback:Some(EmailFeedback{kind:"unsubscribe".into(),recorded_at:1,..Default::default()}),..Default::default()}));update(&store,&crypto,rows).unwrap();let records=read(&store,&crypto).unwrap();assert_eq!(records.len(),10_000);assert!(records.contains_key("optout@example.org"));}
}
