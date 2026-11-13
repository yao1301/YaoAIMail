//! Desktop IPC and HTTP use this same backend, never separate search workflows.
use crate::state::AppState;
use pebble_research::{BoxFuture,Engine,Job,JobRepository,Observer,Progress,ResearchBackend,ResearchKind,TaskRequest};
use pebble_core::PebbleError;
use serde::{Deserialize,Serialize};
use serde_json::Value;
use std::{collections::HashMap,sync::{Arc,Mutex,OnceLock}};
use super::{company_intel::{PublicCompanyMatch,CompanyResearchReport},lead_discovery::DiscoveryResponse};
use pebble_websearch::leads::LeadRequest;

const JOBS_KEY:&str="research_engine_jobs_v1";
static ENGINES:OnceLock<Mutex<HashMap<usize,Arc<Engine>>>>=OnceLock::new();
struct EncryptedRepository(AppState);
impl EncryptedRepository {
    fn archive_key(id:&str)->Result<String,String>{
        if id.len()!=36||!id.chars().all(|c|c.is_ascii_hexdigit()||c=='-'){return Err("研究归档标识无效".into());}
        Ok(format!("research_job_archive_v1:{id}"))
    }
    fn read_archived(&self,id:&str)->Result<Option<Job>,String>{
        let Ok(key)=Self::archive_key(id)else{return Ok(None)};
        let Some(blob)=self.0.store.get_secure_user_data(&key).map_err(|_|"研究归档读取失败")?else{return Ok(None)};
        let plain=self.0.crypto.decrypt(&blob).map_err(|_|"研究归档解密失败")?;
        let job:Job=serde_json::from_slice(&plain).map_err(|_|"研究归档损坏，原记录保留")?;
        if job.id!=id{return Err("研究归档标识不一致".into());}Ok(Some(job))
    }
    fn archive_index(&self)->Result<Vec<(String,String)>,String>{
        let Some(blob)=self.0.store.get_secure_user_data("research_job_archive_index_v1").map_err(|_|"研究归档索引读取失败")?else{return Ok(vec![])};
        let plain=self.0.crypto.decrypt(&blob).map_err(|_|"研究归档索引解密失败")?;
        serde_json::from_slice(&plain).map_err(|_|"研究归档索引损坏，未覆盖原件".into())
    }
}
impl JobRepository for EncryptedRepository {
    fn load(&self)->Result<Vec<Job>,String>{
        let Some(bytes)=self.0.store.get_secure_user_data(JOBS_KEY).map_err(|_|"研究任务读取失败")?else{return Ok(vec![])};
        if bytes.len()>128*900*1024{return Err("研究任务记录过大，原记录保留".into());}
        let plain=self.0.crypto.decrypt(&bytes).map_err(|_|"研究任务解密失败，原记录未改动")?;
        serde_json::from_slice(&plain).map_err(|_|"研究任务记录损坏，原记录未覆盖".into())
    }
    fn save(&self,jobs:&[Job])->Result<(),String>{
        let plain=serde_json::to_vec(jobs).map_err(|_|"研究任务序列化失败")?;
        let bytes=self.0.crypto.encrypt(&plain).map_err(|_|"研究任务加密失败")?;
        self.0.store.set_secure_user_data(JOBS_KEY,&bytes).map_err(|_|"研究任务保存失败".into())
    }
    fn archive(&self,jobs:&[Job])->Result<(),String>{
        let mut index=self.archive_index()?;
        for job in jobs {
            if !matches!(job.status,pebble_research::JobStatus::Succeeded|pebble_research::JobStatus::Failed|pebble_research::JobStatus::Cancelled){return Err("只能归档已终结的研究任务".into());}
            let key=Self::archive_key(&job.id)?;
            let plain=serde_json::to_vec(job).map_err(|_|"研究归档编码失败")?;
            let blob=self.0.crypto.encrypt(&plain).map_err(|_|"研究归档加密失败")?;
            self.0.store.set_secure_user_data(&key,&blob).map_err(|_|"研究归档保存失败")?;
            if let Some(token)=&job.request.idempotency_key{
                index.retain(|(k,_)|k!=token);index.push((token.clone(),job.id.clone()));
            }
        }
        let plain=serde_json::to_vec(&index).map_err(|_|"研究归档索引编码失败")?;
        let blob=self.0.crypto.encrypt(&plain).map_err(|_|"研究归档索引加密失败")?;
        self.0.store.set_secure_user_data("research_job_archive_index_v1",&blob).map_err(|_|"研究归档索引保存失败".into())
    }
    fn get_archived(&self,id:&str)->Result<Option<Job>,String>{self.read_archived(id)}
    fn find_archived_idempotency(&self,key:&str)->Result<Option<Job>,String>{
        match self.archive_index()?.iter().find(|(k,_)|k==key){Some((_,id))=>{
            let job=self.read_archived(id)?.ok_or("研究归档索引指向缺失记录，未重复执行")?;
            if job.request.idempotency_key.as_deref()!=Some(key){return Err("研究归档幂等标识不一致，未重复执行".into());}
            Ok(Some(job))
        },None=>Ok(None)}
    }
}
#[derive(Clone,Serialize,Deserialize)]
#[serde(default,rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct CompanyInput {pub company_name:String,pub website:String,pub country:String,pub vat:String}
impl Default for CompanyInput {fn default()->Self{Self{company_name:String::new(),website:String::new(),country:String::new(),vat:String::new()}}}
struct NativeBackend(AppState);
fn decode<T:serde::de::DeserializeOwned>(v:&Value)->Result<T,String>{serde_json::from_value(v.clone()).map_err(|_|"研究请求字段格式无效".into())}
fn encode<T:Serialize>(v:T)->Result<Value,String>{serde_json::to_value(v).map_err(|_|"研究结果序列化失败".into())}
fn public_url(value:&str)->Result<(),String>{
    if value.is_empty(){return Ok(());}
    let value=normalized_url(value);
    super::web_research::validate_public_url_syntax(&value).map(|_|()).map_err(|_|"研究网址必须是公开HTTP/HTTPS地址".into())
}
fn normalized_url(value:&str)->String{
    let value=value.trim();
    if value.is_empty()||value.contains("://"){value.into()}else{format!("https://{value}")}
}
impl ResearchBackend for NativeBackend {
    fn validate(&self,task:&TaskRequest)->Result<(),String>{
        if serde_json::to_vec(&task.input).map_err(|_|"研究请求无效")?.len()>60*1024{return Err("研究请求过大".into());}
        match task.kind {
            ResearchKind::Leads=>{
                let r:LeadRequest=decode(&task.input)?;
                let instruction=super::lead_preparation::instruction(&task.input)?;
                if (r.product.trim().is_empty()&&instruction.is_empty())||r.product.chars().count()>180||r.requirements.chars().count()+instruction.chars().count()>6000||r.scope_id.len()>128||r.session_id.len()>100{return Err("搜客需要产品或有效长度的任务指令".into());}
                if !r.session_id.chars().all(|c|c.is_ascii_alphanumeric()||matches!(c,'-'|'_')){return Err("搜客任务标识无效".into());}
            },
            ResearchKind::Company=>{
                let r:CompanyInput=decode(&task.input)?;
                if r.company_name.trim().is_empty()&&r.website.trim().is_empty(){return Err("请填写公司名称或官网".into());}
                if r.company_name.len()>500||r.website.len()>2000||r.country.len()>100||r.vat.len()>100{return Err("公司调查字段过长".into());}public_url(&r.website)?;
            },
            ResearchKind::Contacts=>{
                let r:PublicCompanyMatch=decode(&task.input)?;
                if r.legal_name.trim().is_empty()||r.legal_name.len()>500||r.website.trim().is_empty(){return Err("联系人研究需要公司名称和官网".into());}public_url(&r.website)?;
            }
        }Ok(())
    }
    fn run(&self,task:TaskRequest,progress:Progress)->BoxFuture<'_,Result<Value,String>>{
        Box::pin(async move{match task.kind{
            ResearchKind::Leads=>{
                let mut r:LeadRequest=decode(&task.input)?;
                let instruction=super::lead_preparation::instruction(&task.input)?;
                if !instruction.is_empty(){r.requirements=if r.requirements.is_empty(){instruction.clone()}else{format!("{}\n{}",instruction,r.requirements)};}
                if r.session_id.is_empty(){
                    // A resumed API request must reuse its task understanding.
                    // Desktop supplies its own random session ID; headless
                    // clients should supply one too for independent searches.
                    use std::hash::{Hash,Hasher};let mut h=std::collections::hash_map::DefaultHasher::new();
                    task.input.to_string().hash(&mut h);task.idempotency_key.hash(&mut h);
                    r.session_id=format!("api-{:016x}",h.finish());
                }
                if r.scope_id.is_empty(){r.scope_id="research-api".into();}
                progress.stage("正在理解搜客任务");
                r=super::lead_preparation::prepare(&self.0,r,&instruction).await?;
                progress.stage("正在研究目标客户");
                let update=|response:DiscoveryResponse|{if let Ok(value)=serde_json::to_value(response){progress.snapshot(value);}};
                let result=super::lead_discovery::discover_leads_core(&self.0,r,Some(&update)).await.map_err(safe_error)?;
                encode(result)
            },
            ResearchKind::Company=>{
                let mut r:CompanyInput=decode(&task.input)?;r.website=normalized_url(&r.website);progress.stage("正在调查公司");
                let update=|stage:String|{progress.stage(&stage);};
                let result=super::search_router::scoped_company(&self.0,super::company_intel::research_company_inner(&self.0,r.company_name,r.website,r.country,r.vat,Some(&update))).await.map_err(safe_error)?;
                encode(result)
            },
            ResearchKind::Contacts=>{
                let mut r:PublicCompanyMatch=decode(&task.input)?;r.website=normalized_url(&r.website);progress.stage("正在核对公开联系人与邮箱");
                encode(super::company_intel::enrich_lead_candidate_core(&self.0,r).await.map_err(safe_error)?)
            }
        }})
    }
}
fn safe_error(error:PebbleError)->String{
    // Provider errors can contain authenticated URLs, keys or response bodies.
    match error {PebbleError::Validation(_)=>"研究请求未通过校验，请核对输入或任务状态".into(),
        PebbleError::Translate(_)=>"模型请求未完成，请检查模型配置、权限与网络".into(),
        _=>"研究暂未完成，已有任务记录保留，请稍后重试".into()}
}
pub(crate) fn engine(state:&AppState)->Result<Arc<Engine>,PebbleError>{
    let key=Arc::as_ptr(&state.store) as usize;
    let mut engines=ENGINES.get_or_init(Default::default).lock().map_err(|_|PebbleError::Internal("研究引擎锁不可用".into()))?;
    if let Some(engine)=engines.get(&key){return Ok(engine.clone());}
    // Preserve the existing desktop contact queue's three-way concurrency.
    let engine=Engine::new_with_limits(Arc::new(NativeBackend(state.clone())),Arc::new(EncryptedRepository(state.clone())),2,3)
        .map_err(|_|PebbleError::Internal("研究任务恢复失败，原记录保留".into()))?;
    engines.insert(key,engine.clone());Ok(engine)
}
async fn execute<T:serde::de::DeserializeOwned>(state:&AppState,kind:ResearchKind,input:Value,observer:Option<Observer>)->Result<T,PebbleError>{
    let value=engine(state)?.execute(TaskRequest{kind,input,idempotency_key:None},observer).await.map_err(|error|PebbleError::Validation(
        if error.contains("cancelled"){"研究任务已取消"}else if error.contains("interrupted"){"研究任务已中断，已有记录保留，可显式恢复"}
        else if error.contains("repository"){"研究记录读写失败，原记录保留"}else if error.contains("invalid"){"研究请求无效，请核对公司、网址与任务条件"}
        else{"研究未完成，请检查模型配置、网络与数据源后重试；已有记录保留"}.into()))?;
    serde_json::from_value(value).map_err(|_|PebbleError::Internal("研究结果格式无效".into()))
}
pub(crate) async fn leads(state:&AppState,request:LeadRequest,channel:tauri::ipc::Channel<DiscoveryResponse>)->Result<DiscoveryResponse,PebbleError>{
    let observer:Observer=Arc::new(move|v|{if let Ok(r)=serde_json::from_value::<DiscoveryResponse>(v){let _=channel.send(r);}});
    execute(state,ResearchKind::Leads,serde_json::to_value(request).map_err(|_|PebbleError::Validation("搜客请求无效".into()))?,Some(observer)).await
}
pub(crate) async fn company(state:&AppState,company_name:String,website:String,country:String,vat:String,channel:Option<tauri::ipc::Channel<String>>)->Result<CompanyResearchReport,PebbleError>{
    let observer=channel.map(|channel|Arc::new(move|v:Value|{if let Some(stage)=v.as_str(){let _=channel.send(stage.to_owned());}})as Observer);
    execute(state,ResearchKind::Company,serde_json::to_value(CompanyInput{company_name,website,country,vat}).unwrap_or(Value::Null),observer).await
}
pub(crate) async fn contacts(state:&AppState,candidate:PublicCompanyMatch)->Result<PublicCompanyMatch,PebbleError>{
    // Preserve the old no-website behavior without publishing unverified emails.
    if candidate.website.trim().is_empty(){return super::company_intel::enrich_lead_candidate_core(state,candidate).await;}
    execute(state,ResearchKind::Contacts,serde_json::to_value(candidate).map_err(|_|PebbleError::Validation("联系人请求无效".into()))?,None).await
}
pub(crate) fn start_optional_api(state:&AppState){
    let Ok(addr)=std::env::var("PEBBLE_RESEARCH_API_ADDR")else{return;};
    let Ok(token)=std::env::var("PEBBLE_RESEARCH_API_TOKEN")else{tracing::warn!("Research API disabled: authentication token is required");return;};
    let Ok(addr)=addr.parse::<std::net::SocketAddr>()else{tracing::warn!("Research API disabled: invalid listen address");return;};
    let engine=match engine(state){Ok(e)=>e,Err(_)=>{tracing::warn!("Research API disabled: task recovery failed");return;}};
    tauri::async_runtime::spawn(async move{if pebble_research::api::serve(engine,addr,token).await.is_err(){tracing::warn!("Research API stopped or could not start; no credentials logged");}});
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn public_research_never_accepts_local_files_or_private_services(){
        for url in ["file:///C:/private.txt","http://127.0.0.1:8080/","http://192.168.1.2/","http://[::1]/"]{assert!(public_url(url).is_err());}
        assert!(public_url("https://company.invalid/about").is_ok());
        assert!(public_url("company.invalid").is_ok());assert!(public_url("localhost:8080").is_err());
    }
    #[test]fn minimal_contact_api_input_and_legacy_records_remain_readable(){
        let item:PublicCompanyMatch=decode(&serde_json::json!({"companyName":"Sample Components","website":"https://sample.invalid/"})).unwrap();
        assert_eq!(item.legal_name,"Sample Components");assert!(item.contacts.is_empty());assert!(item.email_evidence.is_empty());
        let old:super::super::company_intel::EmailEvidence=serde_json::from_value(serde_json::json!({"email":"sales@sample.invalid","source":"Hunter","sourceUrl":"https://sample.invalid/","confidence":null,"verification":"Hunter 可投递/全收域","emailType":"通用邮箱","person":"","suitability":"待核实"})).unwrap();
        assert_eq!(old.research.delivery_status,pebble_websearch::contact_research::DeliveryStatus::NotChecked);
        let json=serde_json::to_value(old).unwrap();assert_eq!(json["deliveryStatus"],"not_checked");assert_eq!(json["evidenceKind"],"unknown");
    }
    #[test]fn company_api_rejects_unknown_fields_instead_of_honoring_hidden_actions(){
        assert!(decode::<CompanyInput>(&serde_json::json!({"companyName":"Sample","sendEmail":true})).is_err());
    }
    #[tokio::test]async fn desktop_and_api_use_the_same_native_backend_and_encrypted_job_store(){
        let profile=std::env::temp_dir().join(format!("research-adapter-test-{}",pebble_core::new_id()));
        std::fs::create_dir(&profile).unwrap();
        let key_path=profile.join("portable-key");
        std::fs::write(&key_path,format!("PEBBLE-PORTABLE-KEY-V1\n{}\n","2a".repeat(32))).unwrap();
        let crypto=pebble_crypto::CryptoService::init_for_profile(&profile).unwrap();
        let store=pebble_store::Store::open_in_memory().unwrap();
        // A malformed *test-only* proxy fails before any public network call.
        let proxy=crypto.encrypt(br#"{"host":"","port":0}"#).unwrap();
        store.set_secure_user_data("global_network_proxy",&proxy).unwrap();
        let (tx,_rx)=std::sync::mpsc::channel();
        let state=AppState::new(store,pebble_search::TantivySearch::open_in_memory().unwrap(),crypto,tx,profile.join("attachments"));
        assert!(company(&state,"Sample Components".into(),String::new(),String::new(),String::new(),None).await.is_err());
        let shared=engine(&state).unwrap();
        let task=TaskRequest{kind:ResearchKind::Company,input:serde_json::json!({"companyName":"Second Components"}),idempotency_key:Some("native-adapter-example".into())};
        assert!(shared.execute(task,None).await.is_err());
        let jobs=EncryptedRepository(state.clone()).load().unwrap();assert_eq!(jobs.len(),2);
        assert!(jobs.iter().all(|j|j.status==pebble_research::JobStatus::Failed));
        let blob=state.store.get_secure_user_data(JOBS_KEY).unwrap().unwrap();
        assert!(!String::from_utf8_lossy(&blob).contains("Sample Components"));
        let status=engine(&state).unwrap();assert!(Arc::ptr_eq(&shared,&status));
        let index=state.crypto.encrypt(&serde_json::to_vec(&vec![("missing-record",pebble_core::new_id())]).unwrap()).unwrap();
        state.store.set_secure_user_data("research_job_archive_index_v1",&index).unwrap();
        assert!(EncryptedRepository(state.clone()).find_archived_idempotency("missing-record").is_err());
        shared.shutdown().unwrap();
        std::fs::remove_file(key_path).unwrap();std::fs::remove_dir(profile).unwrap();
    }
}
