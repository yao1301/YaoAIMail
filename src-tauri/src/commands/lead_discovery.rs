//! Multi-route company discovery: proposals are seeds, only cited business evidence becomes a lead.
use super::{company_intel::{PublicCompanyMatch,lead_research_completion},network::get_global_proxy_raw,search_router,web_research};
use crate::state::AppState;
use pebble_core::PebbleError;
use pebble_websearch::{Hit,lead_research::{self,Review,TaskConstraint},leads::{self,Assessment,LeadRequest,Page,SourceKind}};
use serde::{Deserialize,Serialize};
use std::{collections::{HashMap,HashSet},sync::{Mutex,OnceLock},time::Duration};
use tokio::time::{Instant,timeout_at};
use tauri::State;

#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct LeadResult {pub company:PublicCompanyMatch,pub quality:Assessment}
#[derive(Clone,Default,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct DiscoveryReport {
    #[serde(default)]pub source_elapsed_ms:u64,#[serde(default)]pub read_elapsed_ms:u64,#[serde(default)]pub review_elapsed_ms:u64,
    #[serde(default)]pub cached_site_reads:usize,#[serde(default)]pub review_requests:usize,#[serde(default)]pub review_timeouts:usize,
    pub queries:usize,pub search_hits:usize,pub directories_read:usize,pub sites_read:usize,pub pages_read:usize,pub unread_sites:usize,
    pub warnings:Vec<String>,pub query_details:Vec<QueryDiagnostic>,pub outcome:String,
    pub reviewed_companies:usize,pub rejected_companies:usize,pub pending_companies:usize,pub model_seeds:usize,
    pub matched_companies:usize,pub constraint_pending_companies:usize,
    pub task_plan:Option<lead_research::TaskPlan>,
    pub review_issues:std::collections::BTreeMap<String,usize>,
    #[serde(default)] pub page_size:usize,
    #[serde(default)] pub plan_reused:bool,
    #[serde(default)] pub stop_reason:String,
    #[serde(default)] pub target_reached:bool,
}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct QueryDiagnostic {pub channel:String,pub query:String,pub hits:usize,pub attempts:Vec<pebble_websearch::Attempt>,pub warning:String}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct DiscoveryResponse {pub items:Vec<LeadResult>,pub report:DiscoveryReport}

const MEMO_KEY:&str="lead_research_tasks_v2";
static MEMO_LOCK:Mutex<()>=Mutex::new(());
static TASK_FLIGHTS:OnceLock<Mutex<HashSet<(usize,String,String)>>>=OnceLock::new();
static DELETED_TASKS:OnceLock<Mutex<HashSet<(usize,String,String)>>>=OnceLock::new();
fn task_key(state:&AppState,id:&str,scope:&str)->(usize,String,String){(std::sync::Arc::as_ptr(&state.store) as usize,id.into(),scope.into())}
fn task_was_deleted(state:&AppState,id:&str,scope:&str)->bool{
    DELETED_TASKS.get_or_init(Default::default).lock().map(|set|set.contains(&task_key(state,id,scope))).unwrap_or(true)
}
#[derive(Clone,Serialize,Deserialize)]
struct TaskMemo {
    id:String,scope:String,intent:serde_json::Value,plan:lead_research::TaskPlan,plan_incomplete:bool,
    pending:Vec<(Hit,Vec<String>)>,examined:Vec<String>,attempts:HashMap<String,u8>,
    buffered:Vec<LeadResult>,used_queries:Vec<String>,round:usize,last:Option<DiscoveryResponse>,
}
fn intent(request:&LeadRequest)->serde_json::Value {
    let mut value=serde_json::to_value(request).expect("serializable lead request");
    for key in ["sessionId","scopeId","pageSize","page","excludeWebsites","batchMode"]{value.as_object_mut().unwrap().remove(key);}
    // Bumped to 4: review now fails closed on missing targetRelation/affinity and
    // runs a condition supplement pass. A cached task from version 3 holds
    // results judged by the old rules, so it must not be continued as if the
    // standard were unchanged; the task restarts under the current rules.
    value["reviewPolicyVersion"]=serde_json::json!(4);
    value
}
fn read_memos(state:&AppState)->Result<Vec<TaskMemo>,PebbleError>{
    match state.store.get_secure_user_data(MEMO_KEY)? {
        None=>Ok(vec![]),Some(bytes)=>serde_json::from_slice(&state.crypto.decrypt(&bytes)?)
            .map_err(|_|PebbleError::Validation("搜客任务缓存读取失败，原记录未清除".into()))
    }
}
pub(super) fn recover_deliveries(state:&AppState,data:&mut serde_json::Value)->Result<(),PebbleError>{
    let memos=serde_json::to_value(read_memos(state)?).map_err(|_|PebbleError::Internal("搜客结果恢复失败".into()))?;
    super::lead_result_recovery::reconcile(data,&memos);
    if let Some(bytes)=state.store.get_secure_user_data("research_engine_jobs_v1")? {
        let jobs=state.crypto.decrypt(&bytes)?;
        let jobs:serde_json::Value=serde_json::from_slice(&jobs).map_err(|_|PebbleError::Validation("研究记录读取失败，原数据未覆盖".into()))?;
        super::lead_result_recovery::restore_contacts(data,&jobs);
    }
    Ok(())
}
fn load_memo(state:&AppState,request:&LeadRequest)->Result<Option<TaskMemo>,PebbleError>{
    if request.session_id.is_empty(){return Ok(None);}
    let _lock=MEMO_LOCK.lock().map_err(|_|PebbleError::Internal("搜客任务缓存锁不可用".into()))?;
    let expected=intent(request);
    Ok(read_memos(state)?.into_iter().find(|m|m.id==request.session_id && m.scope==request.scope_id && m.intent==expected)
        .map(|mut m|{m.plan.incomplete=m.plan_incomplete;if let Some(p)=m.last.as_mut().and_then(|r|r.report.task_plan.as_mut()){p.incomplete=m.plan_incomplete;}m}))
}
fn save_memo(state:&AppState,memo:&TaskMemo)->Result<(),PebbleError>{
    if memo.id.is_empty(){return Ok(());}
    let _lock=MEMO_LOCK.lock().map_err(|_|PebbleError::Internal("搜客任务缓存锁不可用".into()))?;
    if task_was_deleted(state,&memo.id,&memo.scope){return Ok(());}
    let mut all=read_memos(state)?;all.retain(|m|!(m.id==memo.id && m.scope==memo.scope));all.push(memo.clone());
    if all.len()>30{all.drain(..all.len()-30);}
    let bytes=serde_json::to_vec(&all).map_err(|_|PebbleError::Internal("搜客任务缓存保存失败".into()))?;
    state.store.set_secure_user_data(MEMO_KEY,&state.crypto.encrypt(&bytes)?)
}
struct TaskFlight(Option<(usize,String,String)>);
impl TaskFlight {
    fn acquire(state:&AppState,request:&LeadRequest)->Result<Self,PebbleError>{
        if request.session_id.is_empty(){return Ok(Self(None));}
        if task_was_deleted(state,&request.session_id,&request.scope_id){return Err(PebbleError::Validation("该搜客任务已删除".into()));}
        let key=task_key(state,&request.session_id,&request.scope_id);
        let mut flights=TASK_FLIGHTS.get_or_init(Default::default).lock().map_err(|_|PebbleError::Internal("搜客任务锁不可用".into()))?;
        if !flights.insert(key.clone()){return Err(PebbleError::Validation("此搜客任务仍在执行，请等待结果".into()));}
        Ok(Self(Some(key)))
    }
}
impl Drop for TaskFlight {fn drop(&mut self){if let Some(key)=&self.0{
    if let Ok(mut f)=TASK_FLIGHTS.get_or_init(Default::default).lock(){f.remove(key);}
}}}

#[tauri::command]
pub async fn forget_lead_task(state:State<'_,AppState>,session_id:String,scope_id:String)->Result<(),PebbleError>{
    forget_task(&state,&session_id,&scope_id)
}
fn forget_task(state:&AppState,session_id:&str,scope_id:&str)->Result<(),PebbleError>{
    let key=task_key(state,session_id,scope_id);
    let _lock=MEMO_LOCK.lock().map_err(|_|PebbleError::Internal("搜客任务缓存锁不可用".into()))?;
    let mut all=read_memos(state)?;all.retain(|m|m.id!=session_id||m.scope!=scope_id);
    let bytes=serde_json::to_vec(&all).map_err(|_|PebbleError::Internal("搜客任务缓存保存失败".into()))?;
    state.store.set_secure_user_data(MEMO_KEY,&state.crypto.encrypt(&bytes)?)?;
    // Removing a history item must also forget its private native cache; a
    // late-running task may not recreate the removed instruction snapshot.
    // Record cancellation even before native work starts: frontend product
    // interpretation or a queued IPC may still complete after deletion.
    let mut deleted=DELETED_TASKS.get_or_init(Default::default).lock().map_err(|_|PebbleError::Internal("搜客任务锁不可用".into()))?;
    if deleted.len()>=256{
        let flights=TASK_FLIGHTS.get_or_init(Default::default).lock().map_err(|_|PebbleError::Internal("搜客任务锁不可用".into()))?;
        deleted.retain(|id|flights.contains(id));
    }
    deleted.insert(key);
    Ok(())
}

/// Product planning must use the same bounded structured transport as company
/// research, not the ordinary writing endpoint's reasoning/output defaults.
#[tauri::command]
pub async fn lead_research_prompt(state:State<'_,AppState>,system:String,user:String)->Result<String,PebbleError>{
    if system.chars().count()>8000 || user.chars().count()>20000 {
        return Err(PebbleError::Validation("搜客规划输入过长，请精简任务或所选资料".into()));
    }
    match tokio::time::timeout(Duration::from_secs(60),lead_research_completion(&state,&system,&user)).await {
        Ok(Ok(raw))=>Ok(raw),Ok(Err(error))=>Err(PebbleError::Translate(error)),
        Err(_)=>Err(PebbleError::Translate("搜客规划请求超时，未当作没有客户".into()))
    }
}

/// Bound expensive network/model work, never already-generated cached pages.
static DISCOVERY_SLOTS: OnceLock<tokio::sync::Semaphore> = OnceLock::new();

fn discovery_slot() -> &'static tokio::sync::Semaphore {
    DISCOVERY_SLOTS.get_or_init(|| tokio::sync::Semaphore::new(1))
}
async fn acquire_discovery_slot()->Result<tokio::sync::SemaphorePermit<'static>,PebbleError>{
    match tokio::time::timeout(Duration::from_secs(20),discovery_slot().acquire()).await {
        Ok(Ok(permit))=>Ok(permit),
        Ok(Err(_))=>Err(PebbleError::Internal("搜客任务调度不可用".into())),
        Err(_)=>Err(PebbleError::Validation("另一个搜客任务正在运行，请稍后重试；已生成的历史结果仍可查看".into())),
    }
}

#[tauri::command]
pub async fn discover_leads(state:State<'_,AppState>,request:LeadRequest,on_progress:tauri::ipc::Channel<DiscoveryResponse>)->Result<DiscoveryResponse,PebbleError>{
    super::research_service::leads(&state,request,on_progress).await
}

pub(crate) async fn discover_leads_core(state:&AppState,request:LeadRequest,progress:Option<&(dyn Fn(DiscoveryResponse)+Send+Sync)>)->Result<DiscoveryResponse,PebbleError>{
    if request.requirements.chars().count()>6000{return Err(PebbleError::Validation("用户指令过长，请精简后重试；未截断条件执行筛选".into()));}
    if request.session_id.len()>100 || !request.session_id.chars().all(|c|c.is_ascii_alphanumeric()||matches!(c,'-'|'_')) || request.scope_id.len()>128 {
        return Err(PebbleError::Validation("搜客任务标识无效".into()));
    }
    let _flight=TaskFlight::acquire(&state,&request)?;
    let request=request.bounded();
    search_router::scoped_leads(&state,request.page_size,discover(&state,request,progress)).await
}
fn admissible(hit:&Hit)->bool {
    web_research::validate_public_url_syntax(&hit.url).is_ok()
}

pub(crate) async fn plan_lead_requirements(state:&AppState,request:&LeadRequest)->Result<lead_research::TaskPlan,String>{
    if request.requirements.trim().is_empty(){return Ok(Default::default());}
    let input=serde_json::json!({"originalInstruction":request.requirements,"instructionPassages":lead_research::instruction_blocks(&request.requirements),"product":request.product,"market":request.market,"buyerRole":request.buyer_type,"channels":request.channels});
    let deadline=Instant::now()+Duration::from_secs(35);
    let mut input=input;
    for attempt in 0..2 {
        let system=format!("{}\n每条条件/说明优先输出sourceRef，选择instructionPassages中支持该解释的段落id；由程序取回用户原话，省略sourceQuote。不得猜编号；语义必须仍与原始指令一致。\n输出前逐条复核executionNotes：如果一条要求会改变哪些公司或网站可以出现在最终交付中，它就是客户筛选条件，应移回constraints（取消限制则归nonRestrictiveNotes）。例如排除某类公司、目录网站或平台是交付对象限制，必须进入constraints，不能以‘这是搜索方法/结果要求’为理由移进executionNotes。只有不改变交付对象的执行/报告行为才放executionNotes。",lead_research::TASK_PLAN_SYSTEM);
        let raw=timeout_at(deadline,lead_research_completion(state,&system,&input.to_string())).await
            .map_err(|_|"用户指令理解超时，未执行假定条件筛选".to_string())??;
        match lead_research::parse_task_plan(&raw,&request.requirements) {
            Ok(plan)=>return Ok(plan),
            Err(error) if attempt==0=>{
                // Repair representation once, not business requirements. Never
                // accept a paraphrase as a user's instruction or invent filters.
                input["formatCorrection"]=serde_json::json!({"error":error,"instruction":"只修正JSON结构，优先使用instructionPassages的sourceRef编号取代抄写原话。不要增加、取消或猜测任何用户条件。"});
            }
            Err(error)=>return Err(error.into()),
        }
    }
    unreachable!()
}
fn company_from(hit:&Hit,quality:&Assessment)->PublicCompanyMatch {
    let mut root=reqwest::Url::parse(&hit.url).expect("validated URL");root.set_path("/");root.set_query(None);root.set_fragment(None);
    PublicCompanyMatch {legal_name:hit.title.clone(),country:String::new(),city:String::new(),address:String::new(),
        registration_status:"未核验注册身份".into(),lei:String::new(),source_url:hit.url.clone(),website:root.to_string(),
        description:hit.description.clone(),source_name:format!("公开网页研究 · {}",hit.provider),public_emails:vec![],
        recommendation_reason:"已读官网支持其经营业务与采购渠道的关联，实际采购需求仍待确认".into(),
        discovery_basis:quality.evidence.iter().map(|p|p.quote.clone()).take(4).collect(),company_introduction:String::new(),
        email_evidence:vec![],contact_status:"待补全".into(),website_status:"已核验".into(),
        website_status_reason:"已读同站页面并核对经营主体；不代表注册、国别或采购意向已核验".into(),contacts:vec![],buying_signals:vec![]}
}
fn page_brand(html:&str)->Option<String>{
    let doc=scraper::Html::parse_document(html);let selector=scraper::Selector::parse("meta[property='og:site_name']").ok()?;
    let name=doc.select(&selector).next()?.value().attr("content")?.trim();
    (!name.is_empty() && !name.contains('<')).then(||name.chars().take(150).collect())
}
fn publish(progress:Option<&(dyn Fn(DiscoveryResponse)+Send+Sync)>,items:&[LeadResult],report:&DiscoveryReport){
    if let Some(c)=progress{let mut report=report.clone();report.matched_companies=items.iter().filter(|i|i.quality.level!="needs_review").count();report.constraint_pending_companies=items.iter().filter(|i|i.quality.level=="needs_review").count();c(DiscoveryResponse{items:items.to_vec(),report});}
}
#[derive(Default,Deserialize)]
#[serde(default)]
struct Seed {name:String,website:String,channel:String}
fn fatal_model_error(error:&str)->bool { ["认证","权限","配置不可用","接口不存在"].iter().any(|s|error.contains(s)) }
async fn propose(state:&AppState,request:&LeadRequest,exclude:&[String],focus:&str,deadline:Instant)->Result<Vec<Hit>,String>{
    let task=serde_json::json!({"product":request.product,"aliases":request.aliases,"buyerChannels":request.channels,"market":request.market,
        "productPositioning":request.product_positioning,"productUseCases":request.use_cases,
        "buyerRole":request.buyer_type,"requirements":request.requirements,"taskPlan":request.task_plan,"qualifiers":request.qualifiers,
        "excludeWebsites":exclude,"focus":focus});
    let raw=match timeout_at(deadline.min(Instant::now()+Duration::from_secs(35)),lead_research_completion(state,lead_research::SEED_SYSTEM,&task.to_string())).await{
        Ok(Ok(raw))=>raw,Ok(Err(error))=>return Err(error),Err(_)=>return Err("公司提名超时，未把模型记忆当作已核验客户".into())
    };
    let parsed=lead_research::parse_checked_array::<Seed>(&raw).map_err(str::to_string)?;
    if parsed.items.is_empty() && parsed.invalid_items>0{return Err("公司提名格式不完整，未当作没有公司".into());}
    Ok(parsed.items.into_iter().filter_map(|s|{
        if s.name.trim().len()<2 || s.website.trim().is_empty(){return None;}
        let url=if s.website.starts_with("https://")||s.website.starts_with("http://"){s.website}else{format!("https://{}",s.website)};
        let hit=Hit{title:s.name.chars().take(150).collect(),url,description:s.channel.chars().take(200).collect(),provider:"AI 公司提名（须官网核验）".into()};
        admissible(&hit).then_some(hit)
    }).take(20).collect())
}
async fn search_hits(state:&AppState,client:&reqwest::Client,request:&LeadRequest,used:&[String],deadline:Instant)->(Vec<Hit>,Vec<QueryDiagnostic>){
    let session=match search_router::session(state){Ok(s)=>s,Err(_)=>return(vec![],vec![])};
    let used:HashSet<_>=used.iter().map(|q|leads::query_fingerprint(q)).collect();
    let plans:Vec<_>=request.queries().into_iter().filter(|p|!used.contains(&leads::query_fingerprint(&p.query))).collect();let mut hits=vec![];let mut diagnostics=vec![];
    for wave in plans.chunks(3){
        if Instant::now()>=deadline{break;}
        let mut tasks=tokio::task::JoinSet::new();
        for plan in wave{
            let state=state.clone();let client=client.clone();let session=session.clone();let plan=plan.clone();
            tasks.spawn(async move{search_router::scoped_session(session,async{
                let mut r=timeout_at(deadline,search_router::search(&state,&client,&plan.query)).await.unwrap_or_else(|_|pebble_websearch::SearchResult{warning:"本轮部分搜索未完成".into(),..Default::default()});
                for h in &mut r.items{h.provider=format!("{} / {}",h.provider,plan.channel);}
                let d=QueryDiagnostic{channel:plan.channel,query:plan.query,hits:r.items.len(),attempts:r.attempts,warning:r.warning};
                (r.items,d)
            }).await});
        }
        while let Some(result)=tasks.join_next().await{if let Ok((items,d))=result{hits.extend(items.into_iter().filter(admissible));diagnostics.push(d);}}
    }
    (hits,diagnostics)
}
fn sort_candidates(hits:Vec<Hit>,request:&LeadRequest,excluded:&HashSet<String>)->Vec<(Hit,Vec<String>)>{
    let mut map:HashMap<String,(Hit,Vec<String>,usize)>=HashMap::new();
    for h in hits{
        // Source routes are not company identities. An explicit model-proposed
        // operator still gets semantic research, regardless of its sector.
        let source_kind=leads::source_kind(&h.url,&h.title);
        // A page that lists dealers/members can belong to a distributor,
        // association or venue the user wants. Routing labels never blacklist
        // its operator. Identity/official-site/target checks below must still
        // establish who owns the site; a profile cannot certify its subject as
        // the owner of the directory/platform root.
        let Some(host)=leads::host(&h.url)else{continue};
        if excluded.contains(&host){continue;}
        let text=format!("{} {}",h.title,h.description);
        // Model memory is an exploration route, not stronger evidence than a
        // live search hit. The old unconditional +4 for AI nominations put a
        // whole remembered list ahead of better task-specific web candidates.
        // Rank only hints here; full semantic/citation checks still decide fit.
        let score=usize::from(!h.provider.contains("AI 公司提名"))*2+usize::from(source_kind==SourceKind::Company)
            +request.aliases.iter().chain(std::iter::once(&request.product)).filter(|t|!t.trim().is_empty()&&leads::contains_term(&text,t)).count()*2
            +usize::from(!request.buyer_type.trim().is_empty()&&leads::contains_term(&text,&request.buyer_type))*3
            +request.channels.iter().filter(|t|!t.trim().is_empty()&&leads::contains_term(&text,t)).count();
        let e=map.entry(host).or_insert_with(||(h.clone(),vec![],score));
        if !e.1.contains(&h.url){e.1.push(h.url);}e.2=e.2.max(score);
    }
    let mut values:Vec<_>=map.into_values().collect();
    values.sort_by(|a,b|b.2.cmp(&a.2).then_with(||a.0.url.cmp(&b.0.url)));
    values.truncate(80);
    values.into_iter().map(|(h,u,_)|(h,u)).collect()
}
async fn read_candidate(client:reqwest::Client,hit:Hit,urls:Vec<String>,deadline:Instant,session:Option<std::sync::Arc<search_router::SearchSession>>)->(Hit,Vec<Page>,Vec<String>){
    // Read the homepage first, then prefer official company/contact pages over
    // product/search landing pages so basic identity and location facts are available.
    let mut root=reqwest::Url::parse(&hit.url).expect("validated URL");root.set_path("/");root.set_query(None);root.set_fragment(None);
    let home=root.to_string();let mut queue=vec![home.clone()];
    // A failed homepage must not discard a reachable search landing/contact
    // page. Keep the original source as a real same-site fallback.
    if hit.url!=home && leads::host(&hit.url)==leads::host(&home){queue.push(hit.url.clone());}
    for url in &urls{if queue.len()>=3{break}if leads::host(url)==leads::host(&home)&&!queue.contains(url){queue.push(url.clone());}}
    let deadline=deadline.min(Instant::now()+Duration::from_secs(32));
    let page_timeout=Duration::from_secs(if session.as_deref().is_some_and(search_router::SearchSession::deepseek_enabled){20}else{16});
    let mut pages=vec![];let mut index=0;let mut spare:Vec<String>=vec![];let mut attempted=HashSet::new();
    while index<queue.len() && index<4 && Instant::now()<deadline{
        let url=queue[index].clone();
        attempted.insert(url.clone());
        // The reader spends up to six seconds on robots and ten on content.
        // An outer ten-second timeout previously cut legitimate page reads short.
        if let Ok(Some((p,links)))=timeout_at(deadline.min(Instant::now()+page_timeout),web_research::read_discovery_page(&client,&url,session.as_deref())).await{
            if leads::host(&p.url)!=leads::host(&home){index+=1;continue;}
            let brand=page_brand(&p.raw_text);
            pages.push(Page{url:p.url,title:format!("{} {}",p.title,brand.unwrap_or_default()),text:p.text});
            let mut extra:Vec<String>=links.iter().filter(|(u,_)|leads::host(u)==leads::host(&home) && !queue.contains(u)
                && company_info_page_priority(u)<4).map(|(u,_)|u.clone()).collect();
            extra.extend(urls.iter().filter(|u|leads::host(u)==leads::host(&home) && !queue.contains(u)).cloned());
            extra.sort_by_key(|u|(company_info_page_priority(u),u.clone()));extra.dedup();
            // One contact/legal and one company/about page before additional
            // contact aliases. Otherwise /contact and /contact-us consumed the
            // whole budget while company identity/size evidence was never read.
            let mut diverse=vec![];
            for priority in [0,2,1]{if let Some(url)=extra.iter().find(|u|company_info_page_priority(u)==priority && !queue.contains(u)){diverse.push(url.clone());}}
            diverse.extend(extra.iter().cloned());
            for u in &diverse{if queue.len()>=4{break;}if !queue.contains(u){queue.push(u.clone());}}
            // Same-site pages that did not make the first-pass budget stay
            // available: a condition supplement may still need them.
            spare.extend(links.into_iter().map(|(u,_)|u).filter(|u|leads::host(u)==leads::host(&home)));
        }
        index+=1;
    }
    spare.extend(queue.into_iter().filter(|u|!attempted.contains(u)));
    spare.sort();spare.dedup();spare.retain(|u|!attempted.contains(u)&&!pages.iter().any(|p|&p.url==u));
    (hit,pages,spare)
}
fn company_info_page_priority(url:&str)->u8{
    let Ok(parsed)=reqwest::Url::parse(url) else{return 4;};
    let path=parsed.path().to_lowercase();
    if ["contact","kontakt","contacto","contato","contactez"].iter().any(|term|path.contains(term)){0}
    else if ["address","location","office","headquarters","impressum","imprint","legal"].iter().any(|term|path.contains(term)){1}
    else if ["about","company","our-story","who-we-are"].iter().any(|term|path.contains(term)){2}
    else {4}
}
pub(crate) async fn review_wave(state:&AppState,request:&LeadRequest,wave:&[(Hit,Vec<Page>,Vec<String>)],deadline:Instant)->Result<lead_research::ParsedArray<Review>,String>{
    let passages=wave.iter().enumerate().map(|(index,(_,pages,_))|lead_research::review_blocks(pages,index,request)).collect::<Vec<_>>();
    let candidates:Vec<_>=wave.iter().enumerate().map(|(index,(hit,_,_))|serde_json::json!({"index":index,"seedName":hit.title,"website":hit.url,
        "passages":passages[index]})).collect();
    let task=serde_json::json!({"product":request.product,"aliases":request.aliases,"channels":request.channels,"market":request.market,
        "productPositioning":request.product_positioning,"productUseCases":request.use_cases,
        "buyerRole":request.buyer_type,"requirements":request.requirements,"taskPlan":request.task_plan,"qualifiers":request.qualifiers,"candidates":candidates});
    let system=format!("{}\n补充字段：introduction用1至3句简短中文说明已读业务（不超过180字），reason仅解释匹配与缺口（不超过150字），每个criteria.reason不超过80字。\ntargetRelation=target/source/unknown：必须区分自身可能采购、销售或使用产品的经营者，与仅汇聚/服务其他买家的目录、媒体或平台。后者自身没有采购连接时为source；用户明确要开发该类经营者时按其自身用途判断，不按行业名称屏蔽。affinity=specific/plausible/broad/unknown：specific需同类产品或明确用途证据；plausible需具体品类、客户群或用途连接；仅泛行业相似为broad，资料不足为unknown，不能凑数。\ncountry/city/address和对应countryRef/cityRef/addressRef必须从本候选段落逐字取值，国家为必查项。没有原文就留空，不从域名、语言、服务器或目标市场猜测。地址按实际邮寄/办公/仓库表述，不擅自称总部。\n有购物车/网上销售不自动等于为第三方撮合的电商平台，除非用户明确排除所有线上销售；分类条件可由清楚的正面经营描述支持，但不能据未提及就认定不属于大企业、某国家或其他限制。保留用户全部条件与否定、例外，不自定规模阈值。当前只提供有限原文摘录，未见某事实不等于事实不存在；资料不足用unknown。",lead_research::REFERENCED_REVIEW_SYSTEM);
    let system=format!("{system}\n逐项区分本企业自身、客户、供应商、代理品牌及合作方的身份；对方角色不能归到本企业。‘提供定制、集成、代理或解决方案’本身既不能证明自有制造，也不能证明没有制造。硬条件必须有直接主体证据；措辞有多种合理解释时保留unknown，不因中英文表达差异强行判met或violated。");
    let system=format!("{system}\ntaskPlan.executionNotes是对研究员的执行与报告要求，不是公司属性，不输出对应criteria、不要求企业官网证明研究员的行为。仅taskPlan.constraints参与公司筛选。direct只表示已读原文明确经营用户所售的同类产品或服务；业务自身有合理终端使用场景但未证实经营该产品/服务时用channel，不因用途明确就提升为direct，不把终端用户误写为供应商或已证实正在采购。");
    let system=format!("{system}\n地点须有本企业地址、办公室、登记地等明确主体关系。导航菜单、产品/案例名称中的国家、服务市场、配送地、语言/币种选择器及合作方所在地，即使逐字包含国家也不能证明本企业所在地，必须留空。某办公室所在地不擅自等同总部、注册地或整个集团唯一所在地。每个地点值须完整出现在对应引用中，不借用未展示的相邻段落补齐地址。");
    match timeout_at(deadline.min(Instant::now()+Duration::from_secs(45)),lead_research_completion(state,&system,&task.to_string())).await{
        Ok(Ok(raw))=>lead_research::parse_referenced_reviews_with_blocks(&raw,&wave.iter().map(|(_,pages,_)|pages.clone()).collect::<Vec<_>>(),&passages).map_err(str::to_string),Ok(Err(error))=>Err(error),Err(_)=>Err("公司业务核验超时".into())
    }
}
async fn research_wave(state:&AppState,request:&LeadRequest,read:&[(Hit,Vec<Page>,Vec<String>)],deadline:Instant,report:&mut DiscoveryReport)->(Vec<Review>,bool){
    let started=Instant::now();report.review_requests+=read.chunks(2).len();
    let mut jobs=tokio::task::JoinSet::new();
    // Three small bounded calls in parallel, not three serial 35-second gates.
    for (batch_index,batch) in read.chunks(2).enumerate(){
        let state=state.clone();let request=request.clone();let batch=batch.to_vec();
        jobs.spawn(async move{(batch_index,review_wave(&state,&request,&batch,deadline).await)});
    }
    let mut reviews=vec![];let mut fatal=false;
    while let Some(joined)=jobs.join_next().await {
        let Ok((batch_index,result))=joined else {continue;};
        match result {
            Ok(parsed)=>{
                if parsed.invalid_items>0{report.warnings.push("部分公司判断不完整，保留其他有效结果".into());}
                if parsed.items.is_empty(){report.warnings.push("部分公司判断未完成".into());}
                for mut review in parsed.items {
                    let batch_len=(read.len().saturating_sub(batch_index*2)).min(2);
                    if review.index>=batch_len{continue;}
                    review.index+=batch_index*2;reviews.push(review);
                }
            }
            Err(error)=>{
                if error.contains("超时"){report.review_timeouts+=1;}
                report.warnings.push(format!("公司业务核验未完成：{error}"));
                if fatal_model_error(&error){fatal=true;}
            }
        }
    }
    report.review_elapsed_ms+=started.elapsed().as_millis() as u64;(reviews,fatal)
}
/// A user condition is written in the user's words while site paths are written
/// in the site's words, so both sides are matched. This only decides *where to
/// look*; whether a condition is met is still decided by cited page text.
fn condition_page_terms(instruction:&str)->Vec<&'static str>{
    let text=instruction.to_lowercase();
    let mut terms:Vec<&'static str>=vec![];
    for (triggers,paths) in [
        (&["规模","人数","员工","产能","工厂","设备","成立","年限","经营时间","营业额","employees","turnover","revenue","founded","capacity","factory","facility"][..],
         &["about","company","our-story","who-we-are","history","factory","facility","production","team","imprint","impressum"][..]),
        (&["地址","国家","地区","城市","所在地","位于","country","address","location","located"][..],
         &["contact","kontakt","contacto","contato","address","location","office","imprint","impressum","legal"][..]),
        (&["认证","资质","证书","标准","检测","certif","iso","audit"][..],
         &["certification","certificate","quality","standard","compliance","audit","about"][..]),
        (&["渠道","经销","代理","批发","零售","分销","wholesale","distributor","dealer","retail"][..],
         &["wholesale","dealer","distributor","partner","stockist","trade","b2b","retail"][..]),
        (&["客户","合作","案例","项目","customer","client","reference","project"][..],
         &["customer","client","reference","case","portfolio","project","partner"][..]),
    ]{
        if triggers.iter().any(|trigger|text.contains(trigger)){terms.extend_from_slice(paths);}
    }
    terms
}

/// Rank unread same-site pages for a supplement read. Pages matching the
/// condition wording come first; the company-info priority is only a fallback so
/// an unusual wording still reads the imprint/contact page rather than nothing.
fn supplement_targets(spare:&[String],instructions:&[String],limit:usize)->Vec<String>{
    let mut terms:Vec<&str>=vec![];
    for instruction in instructions{terms.extend(condition_page_terms(instruction));}
    let mut scored:Vec<(i32,String)>=spare.iter().map(|url|{
        let path=reqwest::Url::parse(url).map(|parsed|parsed.path().to_lowercase()).unwrap_or_default();
        let hits=terms.iter().filter(|term|path.contains(**term)).count() as i32;
        (hits*10+(10-i32::from(company_info_page_priority(url))),url.clone())
    }).collect();
    scored.sort_by(|a,b|b.0.cmp(&a.0).then_with(||a.1.cmp(&b.1)));
    scored.into_iter().map(|(_,url)|url).take(limit).collect()
}

/// Directed evidence supplement. Companies that already passed identity and
/// business-fit checks are re-read on one or two more pages when a hard user
/// condition is still unresolved, and only those conditions are asked again.
/// Without this step a company that did publish the fact (usually in the imprint
/// or about page) stays "待确认" forever, which is why fully confirmed matches
/// stayed at zero even though the sources were reachable.
async fn supplement_conditions(state:&AppState,client:&reqwest::Client,request:&LeadRequest,read:&mut [(Hit,Vec<Page>,Vec<String>)],reviews:&mut [Review],report:&mut DiscoveryReport,deadline:Instant){
    struct Ask{index:usize,base_pages:usize,constraints:Vec<TaskConstraint>}
    let mut asks:Vec<Ask>=vec![];
    for review in reviews.iter(){
        let Some((_,pages,_))=read.get(review.index) else{continue;};
        // Identity/business rejections are final; only near-misses are worth
        // another page. `prefer` conditions never block, so they are excluded.
        if lead_research::review_issue(request,pages,review).is_some(){continue;}
        let missing=lead_research::unresolved_hard_conditions(request,pages,review);
        if missing.is_empty(){continue;}
        asks.push(Ask{index:review.index,base_pages:pages.len(),constraints:missing.into_iter().cloned().collect()});
        if asks.len()>=3{break;}
    }
    if asks.is_empty(){return;}
    let instructions:Vec<Vec<String>>=asks.iter().map(|ask|ask.constraints.iter().map(|c|c.instruction.clone()).collect()).collect();
    let mut reads=tokio::task::JoinSet::new();
    let search_session=search_router::session(state).ok();
    for (slot,ask) in asks.iter().enumerate(){
        let Some((hit,_,spare))=read.get(ask.index) else{continue;};
        let targets=supplement_targets(spare,&instructions[slot],2);
        if targets.is_empty(){continue;}
        let client=client.clone();let home=hit.url.clone();let search_session=search_session.clone();
        reads.spawn(async move{
            let mut fresh=vec![];
            let page_timeout=Duration::from_secs(if search_session.as_deref().is_some_and(search_router::SearchSession::deepseek_enabled){18}else{14});
            for url in targets{
                if Instant::now()>=deadline{break;}
                if let Ok(Some((p,_)))=timeout_at(deadline.min(Instant::now()+page_timeout),web_research::read_discovery_page(&client,&url,search_session.as_deref())).await{
                    // Cross-host redirects are not evidence for this company.
                    if leads::host(&p.url)==leads::host(&home){fresh.push(Page{url:p.url,title:p.title,text:p.text});}
                }
            }
            (slot,fresh)
        });
    }
    let mut fresh_by_slot:HashMap<usize,Vec<Page>>=HashMap::new();
    while let Some(joined)=reads.join_next().await{
        if let Ok((slot,pages))=joined{if !pages.is_empty(){fresh_by_slot.insert(slot,pages);}}
    }
    let mut added=false;
    for slot in 0..asks.len(){
        let Some(fresh)=fresh_by_slot.remove(&slot) else{continue;};
        let index=asks[slot].index;
        let Some((_,pages,_))=read.get_mut(index) else{continue;};
        report.pages_read+=fresh.len();
        asks[slot].base_pages=pages.len();
        pages.extend(fresh);
        added=true;
    }
    if !added{return;}
    // A separate small call per company: re-asking the full review prompt would
    // pay for re-judging identity and business fit that are already settled.
    let mut calls=tokio::task::JoinSet::new();
    for ask in &asks{
        let Some((_,pages,_))=read.get(ask.index) else{continue;};
        if pages.len()<=ask.base_pages{continue;}
        let blocks=lead_research::evidence_blocks_from(pages,ask.index,ask.base_pages);
        if blocks.is_empty(){continue;}
        let payload=serde_json::json!({
            "company":pages.first().map(|page|page.title.clone()).unwrap_or_default(),
            "unresolvedConditions":ask.constraints.iter().map(|c|serde_json::json!({"id":c.id,"mode":c.mode,"instruction":c.instruction})).collect::<Vec<_>>(),
            "passages":blocks,
        });
        let state=state.clone();let system=lead_research::CONDITION_SYSTEM.to_string();let index=ask.index;
        calls.spawn(async move{
            match timeout_at(deadline.min(Instant::now()+Duration::from_secs(25)),lead_research_completion(&state,&system,&payload.to_string())).await{
                Ok(Ok(raw))=>Some((index,raw)),_=>None
            }
        });
    }
    while let Some(joined)=calls.join_next().await{
        let Ok(Some((index,raw)))=joined else{continue;};
        let Some((_,pages,_))=read.get(index) else{continue;};
        let Ok(findings)=lead_research::parse_condition_findings(&raw,pages,index) else{report.warnings.push("条件补证结果格式不完整，保留原判断".into());continue;};
        let Some(review)=reviews.iter_mut().find(|r|r.index==index) else{continue;};
        lead_research::merge_condition_findings(review,findings,pages);
    }
}

async fn discover_more(state:&AppState,client:&reqwest::Client,request:&LeadRequest,used:&[String],excluded:&HashSet<String>,deadline:Instant,report:&mut DiscoveryReport)->(Vec<(Hit,Vec<String>)>,Vec<String>){
    let mut request=request.clone();request.exclude_websites=excluded.iter().map(|h|format!("https://{h}/")).collect();
    let ((mut hits,diagnostics),seeds)=tokio::join!(
        search_hits(state,client,&request,used,(Instant::now()+Duration::from_secs(45)).min(deadline)),
        propose(state,&request,&request.exclude_websites,"按本次任务补充尚未覆盖的真实经营主体和合理采购渠道；不凑数量，不预设企业规模，避开已有域名",deadline)
    );
    let mut used_now=vec![];
    report.queries+=diagnostics.len();report.search_hits+=hits.len();
    for diagnostic in diagnostics {
        // 记账规则：只要这次查询真的执行完，就写进 used_queries，包括 0 结果的。
        // 原来只记 hits>0，0 命中会在下一轮被原样重跑，用户的搜索额度白烧一遍，
        // 而且第二轮拿回的还是同样的 0 条。真正该重试的是"供应商层面没成功"
        // warning 在正常零命中时也非空，必须读取真实渠道完成状态而不是 warning。
        if query_completed(&diagnostic){used_now.push(diagnostic.query.clone());}
        if !diagnostic.warning.is_empty(){report.warnings.push(diagnostic.warning.clone());}
        report.query_details.push(diagnostic);
    }
    match seeds {Ok(seeds)=>{report.model_seeds+=seeds.len();hits.extend(seeds);},Err(error)=>report.warnings.push(error)}
    let directories:Vec<_>=hits.iter().filter(|h|leads::source_kind(&h.url,&h.title)==SourceKind::Directory).take(3).cloned().collect();
    let directory_deadline=(Instant::now()+Duration::from_secs(18)).min(deadline);
    for directory in directories {
        if let Ok(Some((_,links)))=timeout_at(directory_deadline,web_research::read_discovery_page(client,&directory.url,None)).await {
            report.directories_read+=1;
            for (url,title) in links.into_iter().filter(|(u,t)|leads::host(u)!=leads::host(&directory.url)&&t.chars().count()>3).take(12){
                let hit=Hit{url,title,description:String::new(),provider:format!("名录发现：{}",directory.url)};
                if admissible(&hit){hits.push(hit);}
            }
        }
    }
    (sort_candidates(hits,&request,excluded),used_now)
}
fn defer_candidate(memo:&mut TaskMemo,hit:&Hit,urls:&[String],retry:&mut Vec<(Hit,Vec<String>)>){
    let Some(host)=leads::host(&hit.url)else{return;};
    let attempt=memo.attempts.entry(host.clone()).or_default();*attempt=attempt.saturating_add(1);
    if *attempt<2 {retry.push((hit.clone(),urls.to_vec()));}
    else if !memo.examined.contains(&host){memo.examined.push(host);}
}
fn query_completed(diagnostic:&QueryDiagnostic)->bool{
    diagnostic.hits>0 || diagnostic.attempts.iter().any(|attempt|matches!(
        attempt.status.strip_prefix("调整关键词：").unwrap_or(&attempt.status),
        "成功"|"无命中"|"结果相关性不足／链接不安全"
    ))
}
async fn discover(state:&AppState,mut request:LeadRequest,progress:Option<&(dyn Fn(DiscoveryResponse)+Send+Sync)>)->Result<DiscoveryResponse,PebbleError>{
    if !lead_research::english_term(&request.product){return Err(PebbleError::Validation("海外检索尚未取得有效英文产品词，请重试产品理解；不会直接使用中文任务搜索".into()));}
    let mut report=DiscoveryReport{page_size:request.page_size,..Default::default()};
    let cached=load_memo(state,&request)?;
    report.plan_reused=cached.is_some();
    if let Some(memo)=&cached{
        if memo.round==request.page {if let Some(mut response)=memo.last.clone(){response.report.plan_reused=true;return Ok(response);}}
        if memo.round>request.page{return Err(PebbleError::Validation("该批客户已保存，请在搜索会话中查看".into()));}
    }
    let incoming_seen:HashSet<_>=request.exclude_websites.iter().filter_map(|u|leads::host(u)).collect();
    let fully_buffered=cached.as_ref().is_some_and(|memo|memo.buffered.iter().filter(|i|!leads::host(&i.company.website).is_some_and(|h|incoming_seen.contains(&h))).count()>=request.page_size);
    // Cached delivery skips the global network slot. Planning a NEW task still
    // acquires it, so moving this guard does not create unbounded model calls.
    let _slot=if fully_buffered{None}else{Some(acquire_discovery_slot().await?)};
    let mut memo=if let Some(memo)=cached {
        memo
    }else{
        let plan=match plan_lead_requirements(state,&request).await {
            Ok(plan)=>plan,Err(error) if fatal_model_error(&error)=>return Err(PebbleError::Validation(error)),
            Err(_)=>lead_research::TaskPlan{incomplete:true,..Default::default()}
        };
        let memo=TaskMemo{id:request.session_id.clone(),scope:request.scope_id.clone(),intent:intent(&request),plan_incomplete:plan.incomplete,plan,
            pending:vec![],examined:vec![],attempts:HashMap::new(),buffered:vec![],used_queries:vec![],round:0,last:None};
        // Persist the task interpretation BEFORE web work. Continuations and
        // process restarts reuse it, including a clearly incomplete plan.
        save_memo(state,&memo)?;memo
    };
    request.task_plan=memo.plan.clone();
    if request.task_plan.incomplete{report.warnings.push("本次筛选条件尚未全部确认，相关结果保留为待确认".into());}
    report.task_plan=Some(request.task_plan.clone());
    let target=request.page_size;
    let mut accepted:Vec<_>=memo.buffered.drain(..).filter(|i|!leads::host(&i.company.website).is_some_and(|h|incoming_seen.contains(&h))).collect();
    publish(progress,&accepted[..accepted.len().min(target)],&report);
    let proxy=get_global_proxy_raw(&state.crypto,&state.store)?;let client=web_research::build_research_client(proxy.as_ref())?;
    let deadline=Instant::now()+Duration::from_secs(720);
    let mut excluded:HashSet<_>=memo.examined.iter().cloned().chain(incoming_seen).collect();
    let mut candidates=std::mem::take(&mut memo.pending);
    candidates.retain(|(h,_)|!leads::host(&h.url).is_some_and(|host|excluded.contains(&host)));
    let mut cursor=0;let mut source_round=0;let mut since_source=0;let mut retry=vec![];let mut fatal=false;
    let mut fill=pebble_websearch::lead_fill::FillTracker::default();
    let mut read_cache:HashMap<String,(Vec<Page>,Vec<String>)>=HashMap::new();
    let mut stop=pebble_websearch::lead_fill::FillStop::TimeLimit;
    let search_session=search_router::session(state).ok();
    while accepted.len()<target && Instant::now()<deadline && !task_was_deleted(state,&request.session_id,&request.scope_id) {
        if cursor>=candidates.len() && !retry.is_empty(){candidates.extend(std::mem::take(&mut retry));}
        if cursor>=candidates.len() || (since_source>=18 && fill.stop(accepted.len(),target,false,fatal).is_none()){
            if let Some(reason)=fill.stop(accepted.len(),target,Instant::now()+Duration::from_secs(15)>=deadline,fatal){stop=reason;break;}
            fill.new_round(accepted.len());
            if let Some(reason @ pebble_websearch::lead_fill::FillStop::NoProgress)=fill.stop(accepted.len(),target,false,fatal){stop=reason;break;}
            let mut next=request.clone();next.page=(request.page-1)*8+source_round+1;source_round+=1;
            let mut known=excluded.clone();known.extend(candidates.iter().filter_map(|(h,_)|leads::host(&h.url)));
            let source_started=Instant::now();
            let (more,used)=discover_more(state,&client,&next,&memo.used_queries,&known,deadline,&mut report).await;
            report.source_elapsed_ms+=source_started.elapsed().as_millis() as u64;
            memo.used_queries.extend(used);memo.used_queries.sort();memo.used_queries.dedup();
            // Interleave fresh routes ahead of the unread tail instead of
            // spending the whole deadline on one weak initial route.
            candidates.splice(cursor..cursor,more);since_source=0;
            if cursor>=candidates.len(){continue;}
        }
        let read_started=Instant::now();
        let end=(cursor+6).min(candidates.len());let mut jobs=tokio::task::JoinSet::new();
        let mut read=vec![];
        for (hit,urls) in &candidates[cursor..end]{
            if let Some((pages,spare))=leads::host(&hit.url).and_then(|h|read_cache.get(&h)) {read.push((hit.clone(),pages.clone(),spare.clone()));report.cached_site_reads+=1;}
            else{jobs.spawn(read_candidate(client.clone(),hit.clone(),urls.clone(),deadline,search_session.clone()));}
        }
        while let Some(result)=jobs.join_next().await {
            let Ok((hit,pages,spare))=result else{report.pending_companies+=1;continue;};
            if pages.is_empty(){
                report.unread_sites+=1;report.pending_companies+=1;
                let urls=candidates[cursor..end].iter().find(|(h,_)|h.url==hit.url).map(|(_,u)|u.as_slice()).unwrap_or(&[]);
                defer_candidate(&mut memo,&hit,urls,&mut retry);continue;
            }
            report.sites_read+=1;report.pages_read+=pages.len();
            if let Some(host)=leads::host(&hit.url){read_cache.insert(host,(pages.clone(),spare.clone()));}
            read.push((hit,pages,spare));
        }
        report.read_elapsed_ms+=read_started.elapsed().as_millis() as u64;
        let (mut reviews,model_fatal)=research_wave(state,&request,&read,deadline,&mut report).await;fatal|=model_fatal;
        // One directed re-read for near-miss companies before the final
        // decision, so "condition unknown" is not the end of the line.
        supplement_conditions(state,&client,&request,&mut read,&mut reviews,&mut report,deadline).await;
        let mut reviewed=HashSet::new();
        for review in reviews {
            if !reviewed.insert(review.index){continue;}
            let Some((hit,pages,_))=read.get(review.index)else{continue;};report.reviewed_companies+=1;
            if let Some(issue)=lead_research::review_issue(&request,pages,&review){
                *report.review_issues.entry(issue.into()).or_default()+=1;
                if issue=="review_incomplete"{
                    report.pending_companies+=1;
                    let urls=candidates[cursor..end].iter().find(|(h,_)|h.url==hit.url).map(|(_,u)|u.as_slice()).unwrap_or(&[]);
                    defer_candidate(&mut memo,hit,urls,&mut retry);continue;
                }
            }
            if let Some(quality)=lead_research::validate_review(&request,pages,&review){
                let mut company=company_from(hit,&quality);company.legal_name=review.name;
                if lead_research::cited_company_location(pages,&review.country_url,&review.country_quote,&review.country,100){company.country=review.country.clone();}
                if lead_research::cited_company_location(pages,&review.city_url,&review.city_quote,&review.city,120){company.city=review.city.clone();}
                if lead_research::cited_company_location(pages,&review.address_url,&review.address_quote,&review.address,350){company.address=review.address.clone();}
                company.company_introduction=if review.introduction.trim().is_empty(){quality.evidence.iter().find(|p|p.kind=="company_identity").map(|p|p.quote.clone()).unwrap_or_default()}else{review.introduction.chars().take(900).collect()};
                company.description=company.company_introduction.clone();
                company.recommendation_reason=if review.reason.trim().is_empty(){"与本次产品或采购渠道存在关联，具体采购需求仍需确认。".into()}else{review.reason.chars().take(900).collect()};
                company.source_url=review.identity_url;
                super::research_evidence::remember_pages(state,&company.legal_name,&company.website,pages);
                if !leads::host(&company.website).is_some_and(|host|accepted.iter().any(|item|leads::host(&item.company.website)==Some(host.clone()))){accepted.push(LeadResult{company,quality});}
            }else if lead_research::violates_task_constraint(&request,pages,&review) || (!review.plan_incomplete && review.fit=="none"){
                report.rejected_companies+=1;
            }else{report.pending_companies+=1;}
            if let Some(host)=leads::host(&hit.url){excluded.insert(host.clone());if !memo.examined.contains(&host){memo.examined.push(host);}}
        }
        for (index,(hit,_,_)) in read.iter().enumerate().filter(|(i,_)|!reviewed.contains(i)){
            let _=index;report.pending_companies+=1;
            let urls=candidates[cursor..end].iter().find(|(h,_)|h.url==hit.url).map(|(_,u)|u.as_slice()).unwrap_or(&[]);
            defer_candidate(&mut memo,hit,urls,&mut retry);
        }
        since_source+=end-cursor;cursor=end;
        publish(progress,&accepted[..accepted.len().min(target)],&report);
        if fatal{stop=pebble_websearch::lead_fill::FillStop::ServiceError;break;}
    }
    if accepted.len()>=target{stop=pebble_websearch::lead_fill::FillStop::TargetReached;}
    report.target_reached=accepted.len()>=target;
    report.stop_reason=stop.code().into();
    memo.buffered=if accepted.len()>target{accepted.split_off(target)}else{vec![]};
    memo.pending=candidates.into_iter().skip(cursor).chain(retry).filter(|(h,_)|!leads::host(&h.url).is_some_and(|host|memo.examined.contains(&host))).take(160).collect();
    report.pending_companies+=memo.pending.len();
    report.matched_companies=accepted.iter().filter(|i|i.quality.level!="needs_review").count();
    report.constraint_pending_companies=accepted.iter().filter(|i|i.quality.level=="needs_review").count();
    report.outcome=if report.matched_companies>0{"candidates"}else if report.pending_companies>0 || !accepted.is_empty() || fatal{"research_incomplete"}else if report.search_hits==0 && report.model_seeds==0{"no_usable_sources"}else{"no_company_candidates"}.into();
    report.warnings.sort();report.warnings.dedup();report.warnings.truncate(6);
    let response=DiscoveryResponse{items:accepted,report};
    if task_was_deleted(state,&request.session_id,&request.scope_id){return Err(PebbleError::Validation("该搜客任务已删除".into()));}
    if fatal && response.items.is_empty(){save_memo(state,&memo)?;return Err(PebbleError::Validation("当前模型认证或权限不可用，请检查模型连接；已有搜客任务已保留".into()));}
    memo.round=request.page;memo.last=Some(response.clone());save_memo(state,&memo)?;
    Ok(response)
}

#[cfg(test)] mod tests{
    use super::*;
    static FIXTURE_ID:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);
    struct Fixture{state:AppState,path:std::path::PathBuf}
    impl Fixture{fn new()->Self{
        let path=std::env::temp_dir().join(format!("mail-lead-memo-test-{}-{}",std::process::id(),FIXTURE_ID.fetch_add(1,std::sync::atomic::Ordering::SeqCst)));
        std::fs::create_dir_all(&path).unwrap();std::fs::write(path.join("portable-key"),format!("PEBBLE-PORTABLE-KEY-V1\n{}\n","02".repeat(32))).unwrap();
        let crypto=pebble_crypto::CryptoService::init_for_profile(&path).unwrap();let(tx,_)=std::sync::mpsc::channel();
        let state=AppState::new(pebble_store::Store::open_in_memory().unwrap(),pebble_search::TantivySearch::open_in_memory().unwrap(),crypto,tx,path.join("attachments"));Self{state,path}
    }}
    impl Drop for Fixture{fn drop(&mut self){let _=std::fs::remove_file(self.path.join("portable-key"));let _=std::fs::remove_dir(&self.path);}}
    fn request()->LeadRequest{LeadRequest{session_id:"isolated-task".into(),scope_id:"account-a".into(),product:"industrial pump".into(),requirements:"Only verified distributors".into(),page:1,..Default::default()}.bounded()}
    fn memo(r:&LeadRequest)->TaskMemo{TaskMemo{id:r.session_id.clone(),scope:r.scope_id.clone(),intent:intent(r),plan:Default::default(),plan_incomplete:false,pending:vec![],examined:vec![],attempts:HashMap::new(),buffered:vec![],used_queries:vec![],round:0,last:None}}
    fn result(index:usize)->LeadResult{
        let hit=Hit{title:format!("Fixture Company {index}"),url:format!("https://buyer{index}.example.invalid/"),description:String::new(),provider:"fixture".into()};
        let quality=Assessment{level:"needs_review".into(),..Default::default()};LeadResult{company:company_from(&hit,&quality),quality}
    }
    #[test] fn encrypted_task_plan_survives_page_changes_but_not_intent_account_or_profile_changes(){
        let f=Fixture::new();let r=request();let mut m=memo(&r);m.plan_incomplete=true;m.plan.incomplete=true;
        m.pending.push((Hit{title:"Pending".into(),url:"https://pending.example.invalid/".into(),description:String::new(),provider:"fixture".into()},vec![]));
        save_memo(&f.state,&m).unwrap();let raw=f.state.store.get_secure_user_data(MEMO_KEY).unwrap().unwrap();assert!(!String::from_utf8_lossy(&raw).contains(&r.requirements));
        let mut next=r.clone();next.page=3;next.page_size=10;next.exclude_websites=vec!["https://seen.example.invalid/".into()];
        let loaded=load_memo(&f.state,&next).unwrap().unwrap();assert!(loaded.plan.incomplete);assert_eq!(loaded.pending.len(),1);
        next.product="different product".into();assert!(load_memo(&f.state,&next).unwrap().is_none());
        next=r.clone();next.scope_id="account-b".into();assert!(load_memo(&f.state,&next).unwrap().is_none());
        let other=Fixture::new();assert!(load_memo(&other.state,&r).unwrap().is_none());
    }
    #[tokio::test] async fn cached_page_and_next_full_buffer_require_no_model_config_or_network_calls(){
        let f=Fixture::new();let mut r=request();let mut m=memo(&r);
        m.round=1;m.last=Some(DiscoveryResponse{items:(0..20).map(result).collect(),report:DiscoveryReport{page_size:20,..Default::default()}});
        m.buffered=(20..40).map(result).collect();save_memo(&f.state,&m).unwrap();
        // This state has no model or search keys. Any planning or HTTP access
        // would fail; both deliveries must be served solely from encrypted memo.
        // Another task owns the network slot: cached results must still be instant.
        let slot=discovery_slot().acquire().await.unwrap();
        let first=tokio::time::timeout(Duration::from_secs(1),discover(&f.state,r.clone(),None)).await.unwrap().unwrap();assert_eq!(first.items.len(),20);assert!(first.report.plan_reused);
        r.page=2;r.exclude_websites=first.items.iter().map(|i|i.company.website.clone()).collect();
        let second=tokio::time::timeout(Duration::from_secs(1),discover(&f.state,r.clone(),None)).await.unwrap().unwrap();assert_eq!(second.items.len(),20);assert!(second.report.plan_reused);
        assert!(second.items.iter().all(|i|!r.exclude_websites.contains(&i.company.website)));
        let repeated=discover(&f.state,r,None).await.unwrap();assert_eq!(repeated.items.len(),20);
        assert_eq!(repeated.items[0].company.website,second.items[0].company.website);
        drop(slot);
    }
    #[test] fn completed_zero_queries_are_remembered_but_transport_failures_are_retryable(){
        let diagnostic=|status:&str|QueryDiagnostic{channel:"test".into(),query:"English product distributors".into(),hits:0,warning:"未取得可核验结果".into(),attempts:vec![pebble_websearch::Attempt{provider:"test".into(),status:status.into(),elapsed_ms:1,results:0}]};
        for status in ["无命中","调整关键词：无命中","结果相关性不足／链接不安全"]{assert!(query_completed(&diagnostic(status)));}
        for status in ["超时","限流","认证失败","无可用结果（可能无命中或公开索引不可用）"]{assert!(!query_completed(&diagnostic(status)));}
    }
    #[test] fn task_flight_blocks_duplicate_work_but_not_other_accounts(){
        let f=Fixture::new();let r=request();let guard=TaskFlight::acquire(&f.state,&r).unwrap();assert!(TaskFlight::acquire(&f.state,&r).is_err());
        let mut other=r.clone();other.scope_id="other".into();assert!(TaskFlight::acquire(&f.state,&other).is_ok());drop(guard);assert!(TaskFlight::acquire(&f.state,&r).is_ok());
    }
    #[test] fn encrypted_task_catalog_is_bounded(){
        let f=Fixture::new();for i in 0..35{let mut r=request();r.session_id=format!("task-{i}");save_memo(&f.state,&memo(&r)).unwrap();}
        let all=read_memos(&f.state).unwrap();assert_eq!(all.len(),30);assert_eq!(all[0].id,"task-5");
    }
    #[test] fn deleting_history_forgets_the_private_cache_and_a_late_task_cannot_restore_it(){
        let f=Fixture::new();let r=request();let m=memo(&r);let flight=TaskFlight::acquire(&f.state,&r).unwrap();save_memo(&f.state,&m).unwrap();
        forget_task(&f.state,&r.session_id,&r.scope_id).unwrap();assert!(load_memo(&f.state,&r).unwrap().is_none());
        save_memo(&f.state,&m).unwrap();assert!(load_memo(&f.state,&r).unwrap().is_none());drop(flight);
        save_memo(&f.state,&m).unwrap();assert!(load_memo(&f.state,&r).unwrap().is_none());assert!(TaskFlight::acquire(&f.state,&r).is_err());
    }
    #[test] fn deletion_before_native_start_prevents_a_queued_task_from_recreating_private_input(){
        let f=Fixture::new();let r=request();forget_task(&f.state,&r.session_id,&r.scope_id).unwrap();
        assert!(TaskFlight::acquire(&f.state,&r).is_err());save_memo(&f.state,&memo(&r)).unwrap();assert!(load_memo(&f.state,&r).unwrap().is_none());
    }
    #[test] fn snippet_email_and_query_market_never_become_facts(){
        let h=Hit{title:"Acme".into(),url:"https://example.org/products".into(),description:"German sales@example.org".into(),provider:"fixture".into()};
        let q=leads::assess(&LeadRequest::default(),&[]);let c=company_from(&h,&q);
        assert!(c.country.is_empty());assert!(c.public_emails.is_empty());assert_eq!(c.website,"https://example.org/");
    }
    #[test] fn discovery_rejects_private_targets_without_blacklisting_public_business_sectors(){
        for u in ["http://127.0.0.1/","http://[::ffff:192.168.1.1]/"]{
            assert!(!admissible(&Hit{title:"x".into(),url:u.into(),description:String::new(),provider:String::new()}));
        }
        assert!(admissible(&Hit{title:"Public operator".into(),url:"https://facebook.com/".into(),description:String::new(),provider:"AI 公司提名".into()}));
    }
    #[test] fn product_page_titles_do_not_replace_available_store_names(){
        assert_eq!(page_brand("<meta property='og:site_name' content='Acme'>"),Some("Acme".into()));
        assert!(page_brand("<title>Products</title>").is_none());
    }
    #[test] fn duplicate_domains_and_excluded_sites_never_fill_multiple_company_slots(){
        let req=LeadRequest{product:"industrial pump".into(),..Default::default()};
        let hits:Vec<_>=["https://acme.example/","https://acme.example/products","https://skip.example/"].iter().map(|u|Hit{title:"Acme".into(),url:(*u).into(),description:"Industrial pump distributor".into(),provider:"fixture".into()}).collect();
        let candidates=sort_candidates(hits,&req,&HashSet::from(["skip.example".into()]));
        assert_eq!(candidates.len(),1);assert_eq!(candidates[0].1.len(),2);
    }
    #[test] fn live_task_specific_candidates_are_not_preempted_by_model_memory(){
        let req=LeadRequest{product:"industrial pump".into(),buyer_type:"distributor".into(),..Default::default()};
        let hits=vec![
            Hit{title:"Remembered operator".into(),url:"https://memory.example/".into(),description:"industrial pump".into(),provider:"AI 公司提名（须官网核验）".into()},
            Hit{title:"Industrial pump distributor".into(),url:"https://web.example/".into(),description:String::new(),provider:"search / 本次指令检索".into()},
        ];
        let rows=sort_candidates(hits,&req,&HashSet::new());
        assert_eq!(rows[0].0.url,"https://web.example/");assert_eq!(rows.len(),2);
        // No candidate is declared a buyer, or discarded for its sector, here.
    }
    #[test] fn directory_shaped_business_pages_are_not_industry_exclusions(){
        let r=LeadRequest{product:"event audiovisual services".into(),buyer_type:"exhibition organizer".into(),..Default::default()};
        let hits=vec![Hit{title:"Example Events exhibitor list".into(),url:"https://events.example/exhibitors".into(),description:"Exhibition organizer and venue operator".into(),provider:"web".into()},
            Hit{title:"Example Components".into(),url:"https://parts.example/distributors".into(),description:"Industrial components distributor".into(),provider:"web".into()},
            Hit{title:"Example Marketplace".into(),url:"https://market.example/".into(),description:"B2B marketplace operator".into(),provider:"web".into()}];
        assert_eq!(sort_candidates(hits,&r,&HashSet::new()).len(),3);
        // Routing grants no facts: same-company quotes/target role are still
        // mandatory in lead_research::validate_review before any result exists.
    }
}
