//! Profile-local encrypted screening and explicit, single-key paid verification.
use crate::state::AppState;
use pebble_core::{now_timestamp,PebbleError};
use pebble_websearch::email_checks::{self,EmailVerification,ScreenStatus};
use serde::{Deserialize,Serialize};
use std::collections::BTreeMap;
use tauri::State;

static WRITE_LOCK:std::sync::Mutex<()>=std::sync::Mutex::new(());
static VERIFY_LOCK:tokio::sync::Mutex<()>=tokio::sync::Mutex::const_new(());
pub use super::email_check_store::{EmailCheck,EmailFeedback};

fn read(state:&AppState)->Result<BTreeMap<String,EmailCheck>,PebbleError> {
    super::email_check_store::read(&state.store,&state.crypto)
}
fn update(state:&AppState,rows:Vec<(String,EmailCheck)>)->Result<(),PebbleError> {
    super::email_check_store::update(&state.store,&state.crypto,rows)
}
fn inputs(emails:Vec<String>)->Result<Vec<String>,PebbleError> {
    if emails.len()>200 || emails.iter().any(|e|e.len()>512){return Err(PebbleError::Validation("单次最多检查200个邮箱".into()));}
    Ok(emails.into_iter().map(|e|e.trim().to_ascii_lowercase()).filter(|e|!e.is_empty()).collect::<std::collections::BTreeSet<_>>().into_iter().collect())
}
#[tauri::command]
pub async fn load_research_email_checks(state:State<'_,AppState>,emails:Vec<String>)->Result<BTreeMap<String,EmailCheck>,PebbleError> {
    let wanted=inputs(emails)?;let mut all=read(&state)?;
    all.retain(|key,_|wanted.contains(key));Ok(all)
}
#[tauri::command]
pub async fn prescreen_research_emails(state:State<'_,AppState>,emails:Vec<String>)->Result<BTreeMap<String,EmailCheck>,PebbleError> {
    let emails=inputs(emails)?;let all=read(&state)?;let now=now_timestamp();
    let missing=emails.iter().filter(|email|!all.get(*email).and_then(|r|r.screen.as_ref()).is_some_and(|s|{
        let ttl=match s.status{ScreenStatus::Passed=>3600,ScreenStatus::Invalid=>900,ScreenStatus::Unknown=>300};
        s.checked_at<=now && now-s.checked_at<ttl
    })).cloned().collect::<Vec<_>>();
    if !missing.is_empty(){
        let proxy=super::network::get_global_proxy_raw(&state.crypto,&state.store)?;
        let client=super::web_research::build_research_client(proxy.as_ref())?;
        let screens=email_checks::prescreen(&client,&missing,now).await;
        update(&state,screens.into_iter().map(|s|(s.email.clone(),EmailCheck{screen:Some(s),..Default::default()})).collect())?;
    }
    let mut result=read(&state)?;result.retain(|key,_|emails.contains(key));Ok(result)
}
#[tauri::command]
pub async fn verify_research_email(state:State<'_,AppState>,email:String,refresh:bool)->Result<EmailVerification,PebbleError> {
    let email=inputs(vec![email])?.pop().ok_or_else(||PebbleError::Validation("请选择邮箱".into()))?;
    email_checks::address_domain(&email).map_err(|_|PebbleError::Validation("邮箱格式不支持，未调用Hunter".into()))?;
    // No hidden key rotation, model call, SMTP probe, or automatic retry.
    let _guard=VERIFY_LOCK.lock().await;
    let now=now_timestamp();let all=read(&state)?;
    if all.get(&email).and_then(|r|r.feedback.as_ref()).is_some_and(|f|f.kind=="unsubscribe"){return Err(PebbleError::Validation("该邮箱已记录退订，不再发送给验证服务".into()));}
    if let Some(old)=all.get(&email).and_then(|r|r.verification.as_ref()) {
        if old.reason_code=="claimed_email"{return Err(PebbleError::Validation(old.reason.clone()));}
        if !refresh && old.checked_at<=now && now-old.checked_at<86400{return Ok(old.clone());}
    }
    let keys=super::external_services::get_external_service_api_keys(&state,"hunter")?;
    let key=keys.first().ok_or_else(||PebbleError::Validation("请先在设置→联网搜索与数据服务配置Hunter API Key".into()))?;
    let proxy=super::network::get_global_proxy_raw(&state.crypto,&state.store)?;
    let client=super::web_research::build_research_client(proxy.as_ref())?;
    let result=email_checks::verify_hunter(&client,key,&email,now).await.map_err(|e|PebbleError::Network(e.into()))?;
    update(&state,vec![(email,EmailCheck{verification:Some(result.clone()),..Default::default()})])?;
    Ok(result)
}

#[tauri::command]
pub async fn record_research_email_feedback(state:State<'_,AppState>,email:String,kind:String)->Result<EmailFeedback,PebbleError>{
    if !["replied","hard_bounce","soft_bounce","unsubscribe","cleared"].contains(&kind.as_str()){return Err(PebbleError::Validation("联系结果类型无效".into()));}
    let email=inputs(vec![email])?.pop().ok_or_else(||PebbleError::Validation("邮箱为空".into()))?;
    let feedback=EmailFeedback{kind,recorded_at:now_timestamp(),..Default::default()};
    update(&state,vec![(email,EmailCheck{feedback:Some(feedback.clone()),..Default::default()})])?;Ok(feedback)
}
pub fn contact_block(row:&EmailCheck,now:i64)->Option<&'static str>{
    email_checks::contact_block(row.screen.as_ref(),row.verification.as_ref(),row.feedback.as_ref().map(|f|f.kind.as_str()),now)
}
#[tauri::command]
pub async fn check_research_contact_allowed(state:State<'_,AppState>,email:String)->Result<(),PebbleError>{
    if let Some(row)=read(&state)?.get(&email.trim().to_ascii_lowercase()){
        if let Some(reason)=contact_block(row,now_timestamp()){return Err(PebbleError::Validation(reason.into()));}
    }
    Ok(())
}

const PROFILES_KEY:&str="research_icp_profiles_v1";
pub(crate) async fn run_feedback_worker(app:tauri::AppHandle){
    use tauri::{Emitter,Manager};
    loop {
        let state=app.state::<AppState>().inner().clone();
        let outcome=tauri::async_runtime::spawn_blocking(move||super::research_feedback::scan_once(&state)).await;
        let delay=match outcome{Ok(Ok((changed,more)))=>{if changed>0{let _=app.emit("research:email-feedback",());}if more{1}else{30}},_=>{tracing::warn!("Local research feedback scan deferred; records preserved");60}};
        tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
    }
}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ResearchProfile {pub id:String,pub scope_id:String,pub name:String,pub product:String,pub market:String,pub buyer_type:String,pub requirements:String}
fn profiles(state:&AppState)->Result<Vec<ResearchProfile>,PebbleError>{
    let Some(blob)=state.store.get_secure_user_data(PROFILES_KEY)?else{return Ok(vec![])};
    serde_json::from_slice(&state.crypto.decrypt(&blob)?).map_err(|_|PebbleError::Validation("客户画像读取失败，原记录未覆盖".into()))
}
#[tauri::command]
pub async fn list_research_profiles(state:State<'_,AppState>,scope_id:String)->Result<Vec<ResearchProfile>,PebbleError>{Ok(profiles(&state)?.into_iter().filter(|p|p.scope_id==scope_id).collect())}
#[tauri::command]
pub async fn save_research_profile(state:State<'_,AppState>,profile:ResearchProfile)->Result<(),PebbleError>{
    if profile.id.is_empty()||profile.id.len()>100||profile.scope_id.len()>100||profile.name.trim().is_empty()||profile.name.len()>200||profile.product.len()>1000||profile.market.len()>200||profile.buyer_type.len()>200||profile.requirements.len()>12000{return Err(PebbleError::Validation("客户画像内容过长或名称为空".into()));}
    let _guard=WRITE_LOCK.lock().map_err(|_|PebbleError::Internal("画像记录忙".into()))?;
    let mut all=profiles(&state)?;all.retain(|p|p.id!=profile.id||p.scope_id!=profile.scope_id);
    if all.len()>=100{return Err(PebbleError::Validation("最多保存100份客户画像，请先删除不再使用的画像".into()));}
    all.push(profile);let plain=serde_json::to_vec(&all).map_err(|_|PebbleError::Internal("画像序列化失败".into()))?;
    state.store.set_secure_user_data(PROFILES_KEY,&state.crypto.encrypt(&plain)?)
}
#[tauri::command]
pub async fn delete_research_profile(state:State<'_,AppState>,id:String,scope_id:String)->Result<(),PebbleError>{
    let _guard=WRITE_LOCK.lock().map_err(|_|PebbleError::Internal("画像记录忙".into()))?;
    let mut all=profiles(&state)?;all.retain(|p|p.id!=id||p.scope_id!=scope_id);
    let plain=serde_json::to_vec(&all).map_err(|_|PebbleError::Internal("画像序列化失败".into()))?;
    state.store.set_secure_user_data(PROFILES_KEY,&state.crypto.encrypt(&plain)?)
}
