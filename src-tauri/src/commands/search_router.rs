//! All AI web-search entry points share policy, cache, fallback and task budgets.
use super::{external_services::get_external_service_api_keys, web_research};
use crate::state::AppState;
use pebble_core::{PebbleError, Result};
use pebble_websearch::{Attempt, Budget, Hit, Keys, SearchConfig, SearchResult};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, future::Future, hash::{Hash, Hasher}, sync::{Arc, OnceLock}, time::{Duration, Instant}};
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::State;

const CONFIG_KEY: &str = "ai_search_settings_v1";
const QUOTA_KEY: &str = "ai_search_local_usage_v1";
static SETTINGS_LOCK: OnceLock<std::sync::Mutex<()>>=OnceLock::new();
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Stored { config: SearchConfig, tinyfish_key: String }

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Settings { pub config: SearchConfig, pub tinyfish_configured: bool }

fn load(state: &AppState) -> Result<Stored> {
    match state.store.get_secure_user_data(CONFIG_KEY)? {
        None => Ok(Stored::default()),
        Some(bytes) => serde_json::from_slice(&state.crypto.decrypt(&bytes)?)
            .map_err(|_|PebbleError::Internal("搜索配置无法读取".into())),
    }
}
fn save<T: Serialize>(state: &AppState, key: &str, value: &T) -> Result<()> {
    let bytes=serde_json::to_vec(value).map_err(|_|PebbleError::Internal("搜索配置无法序列化".into()))?;
    state.store.set_secure_user_data(key,&state.crypto.encrypt(&bytes)?)
}
#[tauri::command]
pub async fn get_ai_search_settings(state: State<'_,AppState>) -> Result<Settings> {
    let stored=load(&state)?;
    Ok(Settings{config:stored.config,tinyfish_configured:!stored.tinyfish_key.is_empty()})
}
#[tauri::command]
pub async fn save_ai_search_settings(state: State<'_,AppState>, config: SearchConfig, api_key: Option<String>, delete_key: bool) -> Result<Settings> {
    let _guard=SETTINGS_LOCK.get_or_init(Default::default).lock().map_err(|_|PebbleError::Internal("搜索设置锁不可用".into()))?;
    config.validate().map_err(PebbleError::Validation)?;
    let mut stored=load(&state)?;
    if delete_key { stored.tinyfish_key.clear(); }
    else if let Some(key)=api_key.filter(|k| !k.trim().is_empty()) { stored.tinyfish_key=key.trim().into(); }
    if (config.tinyfish_search_enabled || config.tinyfish_fetch_enabled) && stored.tinyfish_key.is_empty() {
        return Err(PebbleError::Validation("启用 TinyFish 前请填写 API Key".into()));
    }
    stored.config=config;
    save(&state,CONFIG_KEY,&stored)?;
    Ok(Settings{config:stored.config,tinyfish_configured:!stored.tinyfish_key.is_empty()})
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Usage { day:i64, search:u32, fetch:u32, minute:i64, minute_search:u32, minute_fetch:u32, hour:i64, hour_search:u32 }
static USAGE_LOCK: OnceLock<std::sync::Mutex<()>>=OnceLock::new();
/// Reserve BEFORE dispatch (including failed requests). Encrypted, survives restarts.
/// Local counts cannot see usage by other apps/accounts; UI must not promise free billing.
fn reserve_tinyfish(state:&AppState, config:&SearchConfig, fetch:bool) -> Result<()> {
    let _lock=USAGE_LOCK.get_or_init(Default::default).lock().map_err(|_|PebbleError::Internal("搜索额度锁不可用".into()))?;
    let mut usage:Usage=match state.store.get_secure_user_data(QUOTA_KEY)? {
        Some(bytes)=>serde_json::from_slice(&state.crypto.decrypt(&bytes)?).map_err(|_|PebbleError::Internal("搜索用量记录损坏，已停止云请求".into()))?,
        None=>Usage::default(),
    };
    let now=chrono::Utc::now().timestamp();
    if usage.day!=now/86400 {usage.day=now/86400;usage.search=0;usage.fetch=0;}
    if usage.minute!=now/60 {usage.minute=now/60;usage.minute_search=0;usage.minute_fetch=0;}
    if usage.hour!=now/3600 {usage.hour=now/3600;usage.hour_search=0;}
    if fetch {
        if usage.fetch>=config.tinyfish_fetch_daily_limit || usage.minute_fetch>=100 {return Err(PebbleError::Validation("TinyFish 本地读取上限已到".into()));}
        usage.fetch+=1;usage.minute_fetch+=1;
    } else {
        if usage.search>=config.tinyfish_search_daily_limit || usage.minute_search>=24 || usage.hour_search>=400 {return Err(PebbleError::Validation("TinyFish 本地搜索上限已到".into()));}
        usage.search+=1;usage.minute_search+=1;usage.hour_search+=1;
    }
    save(state,QUOTA_KEY,&usage)
}

#[derive(Clone)]
struct CacheEntry { at:Instant, result:SearchResult, ttl:Duration }
static CACHE:OnceLock<tokio::sync::Mutex<HashMap<(u64,String),CacheEntry>>>=OnceLock::new();
static FLIGHTS:OnceLock<tokio::sync::Mutex<HashMap<(u64,String),Arc<tokio::sync::Mutex<()>>>>>=OnceLock::new();
static CIRCUITS:OnceLock<std::sync::Mutex<HashMap<(u64,String),Instant>>>=OnceLock::new();
static FETCH_CACHE:OnceLock<tokio::sync::Mutex<HashMap<(u64,String),(Instant,String,String)>>>=OnceLock::new();
tokio::task_local! { static SESSION: Arc<SearchSession>; }

pub struct SearchSession { config:SearchConfig, keys:Keys, budget:Budget, namespace:u64, api:reqwest::Client, local:reqwest::Client, configured_api:bool, deepseek:Option<DeepSeekBudget> }

// Reserve separate space for Search and Fetch so a wave of queries cannot
// consume the entire DeepSeek allowance before the evidence-reading phase.
struct DeepSeekBudget { key:String, search:AtomicUsize, fetch:AtomicUsize, store:Arc<pebble_store::Store>, crypto:Arc<pebble_crypto::CryptoService> }
impl DeepSeekBudget {
    fn enabled(&self)->bool {super::external_services::deepseek_key_is_enabled(&self.store,&self.crypto,&self.key)}
    fn reserve(&self, fetch:bool, limit:usize)->bool {
        let fetch_limit=limit/3;
        let (count,cap)=if fetch {(&self.fetch,fetch_limit)} else {(&self.search,limit-fetch_limit)};
        count.fetch_update(Ordering::Relaxed,Ordering::Relaxed,|n|(n<cap).then_some(n+1)).is_ok()
    }
}
fn configured_api_allowed(config:&SearchConfig, saved_policy:bool)->bool {
    config.configured_api_enabled.unwrap_or(config.paid_search_enabled || !saved_policy)
}
impl SearchSession {
    pub(super) fn deepseek_enabled(&self)->bool {self.deepseek.as_ref().is_some_and(DeepSeekBudget::enabled) && self.config.max_paid_requests>=3}
    fn new(state:&AppState)->Result<Arc<Self>> {
        Self::with_scope(state,false)
    }
    fn with_scope(state:&AppState, research:bool)->Result<Arc<Self>> {
        let stored=load(state)?;
        let configured_api=configured_api_allowed(&stored.config,state.store.get_secure_user_data(CONFIG_KEY)?.is_some());
        stored.config.validate().map_err(PebbleError::Validation)?;
        let keys=Keys{
            brave:get_external_service_api_keys(state,"brave")?,
            tavily:get_external_service_api_keys(state,"tavily")?,
            firecrawl:get_external_service_api_keys(state,"firecrawl")?, tinyfish:stored.tinyfish_key,
        };
        let deepseek_key=if research {super::external_services::get_external_service_api_key(state,"deepseek")?.filter(|key|!key.trim().is_empty() && super::external_services::deepseek_key_is_enabled(&state.store,&state.crypto,key))} else {None};
        let mut hasher=std::collections::hash_map::DefaultHasher::new();
        state.attachments_dir.hash(&mut hasher); stored.config.hash(&mut hasher);
        configured_api.hash(&mut hasher);
        deepseek_key.hash(&mut hasher);
        keys.brave.hash(&mut hasher);keys.tavily.hash(&mut hasher);keys.firecrawl.hash(&mut hasher);keys.tinyfish.hash(&mut hasher);
        let mut builder=reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(16));
        if let Some(proxy)=super::network::get_global_proxy_raw(&state.crypto,&state.store)? {
            builder=builder.proxy(reqwest::Proxy::all(proxy.socks5h_uri().map_err(PebbleError::Network)?).map_err(|_|PebbleError::Network("搜索代理配置无效".into()))?);
        }
        let api=builder.build().map_err(|_|PebbleError::Network("搜索客户端初始化失败".into()))?;
        let local=reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(16)).build().map_err(|_|PebbleError::Network("本地搜索客户端初始化失败".into()))?;
        let deepseek=deepseek_key.map(|key|DeepSeekBudget{key,search:AtomicUsize::new(0),fetch:AtomicUsize::new(0),store:state.store.clone(),crypto:state.crypto.clone()});
        Ok(Arc::new(Self{budget:Budget::new(stored.config.clone()),config:stored.config,keys,namespace:hasher.finish(),api,local,configured_api,deepseek}))
    }
}
pub async fn scoped<T,F:Future<Output=Result<T>>>(state:&AppState, future:F)->Result<T> {
    if SESSION.try_with(|_|()).is_ok() {return future.await;}
    SESSION.scope(SearchSession::new(state)?,future).await
}
/// A twenty-company delivery needs more keyless discovery than a short query.
/// Keep explicit user policy and the configured/paid API cap unchanged.
pub async fn scoped_leads<T,F:Future<Output=Result<T>>>(state:&AppState,page_size:usize,future:F)->Result<T>{
    if SESSION.try_with(|_|()).is_ok(){return future.await;}
    let mut runtime=SearchSession::with_scope(state,true)?;
    if state.store.get_secure_user_data(CONFIG_KEY)?.is_none(){
        if let Some(session)=Arc::get_mut(&mut runtime){
            session.config.max_queries=page_size.saturating_mul(2).clamp(18,40);
            session.config.max_requests=page_size.saturating_mul(8).clamp(60,160);
            session.budget=Budget::new(session.config.clone());
        }
    }
    SESSION.scope(runtime,future).await
}
/// Company research needs independent-source coverage, not a larger paid cap.
/// Respect a saved explicit policy; expand only the default keyless work limit.
pub async fn scoped_company<T,F:Future<Output=Result<T>>>(state:&AppState,future:F)->Result<T>{
    if SESSION.try_with(|_|()).is_ok(){return future.await;}
    let mut runtime=SearchSession::with_scope(state,true)?;
    if state.store.get_secure_user_data(CONFIG_KEY)?.is_none(){if let Some(s)=Arc::get_mut(&mut runtime){
        s.config.max_queries=32;s.config.max_requests=160;s.budget=Budget::new(s.config.clone());
    }}
    SESSION.scope(runtime,future).await
}
pub async fn scoped_session<T,F:Future<Output=T>>(session:Arc<SearchSession>,future:F)->T {SESSION.scope(session,future).await}
pub fn session(state:&AppState)->Result<Arc<SearchSession>> {SESSION.try_with(Arc::clone).map(Ok).unwrap_or_else(|_|SearchSession::new(state))}

fn circuit_open(namespace:u64,provider:&str)->bool {
    CIRCUITS.get_or_init(Default::default).lock().map(|mut circuits| {
        circuits.retain(|_,until|*until>Instant::now());
        circuits.contains_key(&(namespace,provider.into()))
    }).unwrap_or(true)
}
fn cool_down(namespace:u64,provider:&str,error:&pebble_websearch::Failure) {
    if let Ok(mut circuits)=CIRCUITS.get_or_init(Default::default).lock() {
        if circuits.len()>=256 {circuits.clear();}
        circuits.insert((namespace,provider.into()),Instant::now()+Duration::from_secs(if matches!(error,pebble_websearch::Failure::Auth|pebble_websearch::Failure::Quota){3600}else{60}));
    }
}

pub async fn search(state:&AppState,client:&reqwest::Client,query:&str)->SearchResult {
    match session(state) {
        Ok(session)=>search_with_rephrase(state,client,&session,query).await,
        Err(_)=>SearchResult{warning:"搜索配置读取失败，未调用外部服务".into(),..Default::default()},
    }
}
async fn search_with_rephrase(state:&AppState,client:&reqwest::Client,session:&SearchSession,query:&str)->SearchResult {
    let mut result=search_in(state,client,session,query).await;
    if result.items.is_empty() && !result.warning.contains("预算") {
        if let Some(variant)=pebble_websearch::query_variant(query) {
            let next=search_in(state,client,session,&variant).await;
            result.cache_hit=result.cache_hit && next.cache_hit;
            result.attempts.extend(next.attempts.into_iter().map(|mut a|{a.status=format!("调整关键词：{}",a.status);a}));
            result.items=next.items;result.warning=next.warning;
        }
    }
    result
}

/// Automatic send-guard enrichment was historically keyless. Never make that
/// path billable merely because the user enabled paid research elsewhere.
pub async fn search_free(state:&AppState,client:&reqwest::Client,query:&str)->SearchResult {
    let Ok(mut runtime)=SearchSession::new(state) else {return SearchResult{warning:"搜索配置不可用".into(),..Default::default()};};
    let Some(runtime_mut)=Arc::get_mut(&mut runtime) else {return SearchResult::default();};
    runtime_mut.config.paid_search_enabled=false;
    runtime_mut.configured_api=false;
    runtime_mut.config.tinyfish_search_enabled=false;
    runtime_mut.config.tinyfish_fetch_enabled=false;
    runtime_mut.namespace^=0xa16e_a5e0_f0ee_0001;
    search_with_rephrase(state,client,&runtime,query).await
}
async fn search_in(state:&AppState,client:&reqwest::Client,session:&SearchSession,query:&str)->SearchResult {
    search_mode(state,client,session,query,false).await
}
/// Also consult the public index ensemble after one configured API succeeds.
/// A separate cache key prevents a narrow quick-search hit masquerading as a
/// completed diversity search. Other search consumers keep their old behavior.
pub async fn search_company(state:&AppState,client:&reqwest::Client,query:&str)->SearchResult{
    match session(state){Ok(runtime)=>search_mode(state,client,&runtime,query,true).await,
        Err(_)=>SearchResult{warning:"调查搜索配置不可用".into(),..Default::default()}}
}
async fn search_mode(state:&AppState,client:&reqwest::Client,session:&SearchSession,query:&str,diverse:bool)->SearchResult {
    let query=pebble_websearch::normalize_query(query);
    if query.is_empty(){return SearchResult{warning:"缺少搜索关键词".into(),..Default::default()};}
    let cache_key=(session.namespace,if diverse{format!("company-diverse:{query}")}else{query.clone()});
    let flight={let mut flights=FLIGHTS.get_or_init(Default::default).lock().await;
        flights.retain(|_,value|Arc::strong_count(value)>1);
        flights.entry(cache_key.clone()).or_default().clone()};
    let _flight=flight.lock().await;
    {let mut cache=CACHE.get_or_init(Default::default).lock().await;
        cache.retain(|_,entry|entry.at.elapsed()<entry.ttl);
        if let Some(entry)=cache.get(&cache_key){let mut result=entry.result.clone();result.cache_hit=true;return result;}
    }
    if !session.budget.query(){return SearchResult{warning:"本次任务搜索次数已达上限，请缩小范围或开始新任务".into(),..Default::default()};}
    let mut result=SearchResult::default();
    let mut providers=Vec::new();
    if session.deepseek.as_ref().is_some_and(DeepSeekBudget::enabled) && query.chars().count()<=128 {providers.push("deepseek");}
    if session.config.openserp_enabled {providers.push("openserp");}
    if session.config.tinyfish_search_enabled {providers.push("tinyfish");}
    // Saved keys are deliberate user configuration, not permission to enable
    // a hosted provider, add a subscription, or embed an operator's key.
    if session.configured_api {providers.extend(["tavily","brave","firecrawl"]);}
    providers.push("public");
    for provider in providers {
        // One successful configured search per query, plus independent public
        // indexes; do not multiply billable calls by the number of API keys.
        if diverse && !result.items.is_empty() && matches!(provider,"tavily"|"brave"|"firecrawl"|"tinyfish"|"openserp"){continue;}
        if circuit_open(session.namespace,provider){result.attempts.push(Attempt{provider:provider.into(),status:"冷却中，已跳过".into(),elapsed_ms:0,results:0});continue;}
        let keys=match provider {"brave"=>session.keys.brave.clone(),"tavily"=>session.keys.tavily.clone(),"firecrawl"=>session.keys.firecrawl.clone(),"tinyfish"=>vec![session.keys.tinyfish.clone()],"deepseek"=>session.deepseek.as_ref().map(|runtime|vec![runtime.key.clone()]).unwrap_or_default(),_=>vec![String::new()]};
        if keys.is_empty() || (provider=="tinyfish" && keys[0].is_empty()){continue;}
        let started=Instant::now();
        if provider=="public" {
            // Conservatively reserve the bounded public-provider fanout.
            if !(0..web_research::PUBLIC_SEARCH_PROVIDERS).all(|_|session.budget.request(false)){result.warning="本次任务请求预算已到，已停止搜索".into();break;}
            let items=web_research::multi_source_search(client,&query,20).await.into_iter().map(|item|Hit{provider:item.provider,title:item.title,url:item.url,description:item.snippet}).collect();
            let items=pebble_websearch::relevant_hits(&query,pebble_websearch::dedupe(items,|url|web_research::validate_public_url_syntax(url).is_ok()));
            result.attempts.push(Attempt{provider:provider.into(),status:if items.is_empty(){"无可用结果（可能无命中或公开索引不可用）"}else{"成功"}.into(),elapsed_ms:started.elapsed().as_millis() as u64,results:items.len()});
            if !items.is_empty(){result.items.extend(items);if !diverse{break;}}
            continue;
        }
        let paid=matches!(provider,"brave"|"tavily"|"firecrawl");
        let output=pebble_websearch::with_keys(&keys,|key| {
            let query=&query;
            async move {
                if provider=="deepseek" && !session.deepseek.as_ref().is_some_and(|runtime|runtime.enabled() && runtime.reserve(false,session.config.max_paid_requests)) {return Err(pebble_websearch::Failure::Budget);}
                if !session.budget.request(paid){return Err(pebble_websearch::Failure::Budget);}
                if provider=="tinyfish" && reserve_tinyfish(state,&session.config,false).is_err(){return Err(pebble_websearch::Failure::Quota);}
                let api=if provider=="openserp" && reqwest::Url::parse(&session.config.openserp_url).ok().and_then(|u|u.host_str().map(pebble_translate::endpoint::is_local_host)).unwrap_or(false){&session.local}else{&session.api};
                pebble_websearch::request(api,provider,&session.config.openserp_url,&key,query).await
            }
        }).await;
        match output {
            Ok(items)=>{
                let raw_count=items.len();
                let items=pebble_websearch::relevant_hits(&query,pebble_websearch::dedupe(items,|url|web_research::validate_public_url_syntax(url).is_ok()));
                result.attempts.push(Attempt{provider:provider.into(),status:if items.is_empty() && raw_count>0 {"结果相关性不足／链接不安全"}else if items.is_empty(){"无命中"}else{"成功"}.into(),elapsed_ms:started.elapsed().as_millis() as u64,results:items.len()});
                if !items.is_empty(){result.items.extend(items);if !diverse{break;}}
            },
            Err(error)=>{
                result.attempts.push(Attempt{provider:provider.into(),status:error.label().into(),elapsed_ms:started.elapsed().as_millis() as u64,results:0});
                if error==pebble_websearch::Failure::Budget {if provider!="deepseek" {result.warning="本轮 API 请求上限已到，尝试公开搜索".into();}continue;}
                if provider!="deepseek" || error!=pebble_websearch::Failure::Invalid {cool_down(session.namespace,provider,&error);}
            }
        }
    }
    result.items=pebble_websearch::dedupe_limit(result.items,|url|web_research::validate_public_url_syntax(url).is_ok(),if diverse{60}else{20});
    if result.items.is_empty() && result.warning.is_empty(){result.warning="未取得可核验结果。请调整产品、国家或公司名；失败不等于不存在目标公司。".into();}
    // Short negative cache prevents a retry storm, preserving explicit failures.
    {
        let mut cache=CACHE.get_or_init(Default::default).lock().await;
        if cache.len()>=256 {if let Some(key)=cache.iter().min_by_key(|(_,e)|e.at).map(|(k,_)|k.clone()){cache.remove(&key);}}
        let ttl=if result.items.is_empty(){15}else{session.config.cache_minutes*60};
        // Task-budget failures must not suppress a subsequent new task.
        if !result.warning.contains("预算") && !result.attempts.iter().any(|a|a.provider=="deepseek" && a.status==pebble_websearch::Failure::Budget.label()) {
            cache.insert(cache_key,CacheEntry{at:Instant::now(),result:result.clone(),ttl:Duration::from_secs(ttl)});
        }
    }
    result
}

/// Optional Markdown supplement after the caller has checked the site's robots
/// policy. Retains the locally checked URL, since Fetch returns no final URL.
pub(super) async fn supplement_with_deepseek(session:&SearchSession, client:&reqwest::Client, original:&str, page:&mut web_research::PageDocument, timeout:Duration) -> Option<String> {
    use web_research::EvidenceStatus;
    let runtime=session.deepseek.as_ref()?;
    if !runtime.enabled() {return None;}
    let eligible=match page.evidence.status {
        EvidenceStatus::Ok if !page.evidence.content_type.contains("pdf") => {
            let base=web_research::validate_public_url_syntax(&page.final_url).ok()?;
            let (_,text,_)=web_research::html_page_content(&page.text,&base,&base);
            text.chars().count()<160
        }
        EvidenceStatus::Empty|EvidenceStatus::Timeout|EvidenceStatus::NetworkError=>true,
        // Do not try to bypass a denial, rate limit or access restriction.
        EvidenceStatus::HttpError=>page.evidence.http_status.is_some_and(|status|status>=500),
        _=>false,
    };
    if !eligible {return None;}
    let started=Instant::now();
    let read=async {
        let mut url=web_research::validate_public_url_syntax(&page.final_url).ok()?;
        if !web_research::same_site(&web_research::validate_public_url_syntax(original).ok()?,&url) || url.query().is_some(){return None;}
        url.set_fragment(None);
        if url.as_str()!=original {web_research::research_robots_allowed(client,url.as_str()).await.ok()?;}
        web_research::validate_public_dns(&url).await.ok()?;
        let key=(session.namespace,format!("deepseek-fetch:{url}"));
        let flight={let mut flights=FLIGHTS.get_or_init(Default::default).lock().await;
            flights.retain(|_,value|Arc::strong_count(value)>1);
            flights.entry(key.clone()).or_default().clone()};
        let _flight=flight.lock().await;
        if let Some((at,title,text))=FETCH_CACHE.get_or_init(Default::default).lock().await.get(&key){
            if at.elapsed()<Duration::from_secs(session.config.cache_minutes*60){return Some((url,title.clone(),text.clone()));}
        }
        if circuit_open(session.namespace,"deepseek_fetch") || circuit_open(session.namespace,"deepseek")
            || !runtime.enabled() || !runtime.reserve(true,session.config.max_paid_requests) || !session.budget.request(false) {return None;}
        match pebble_websearch::deepseek::fetch(&session.api,&runtime.key,&url).await {
            Ok(Some((title,text))) if text.trim().chars().count()>=160=>{
                let mut cache=FETCH_CACHE.get_or_init(Default::default).lock().await;
                if cache.len()>=64 {if let Some(old)=cache.iter().min_by_key(|(_,v)|v.0).map(|(key,_)|key.clone()){cache.remove(&old);}}
                cache.insert(key,(Instant::now(),title.clone(),text.clone()));
                Some((url,title,text))
            }
            Err(error)=>{
                let circuit=match error {
                    pebble_websearch::Failure::Auth|pebble_websearch::Failure::Quota=>"deepseek",
                    _=>"deepseek_fetch",
                };
                if error!=pebble_websearch::Failure::Invalid {cool_down(session.namespace,circuit,&error);}
                None
            }
            _=>None,
        }
    };
    if let Ok(Some((url,title,text)))=tokio::time::timeout(timeout.min(Duration::from_secs(5)),read).await {
        page.final_url=url.to_string();let local_html=std::mem::replace(&mut page.text,text);page.bytes.clear();
        page.evidence.url=page.final_url.clone();page.evidence.title=title;page.evidence.provider="deepseek_fetch".into();page.evidence.providers=vec!["deepseek_fetch".into()];
        page.evidence.status=EvidenceStatus::Ok;page.evidence.http_status=None;page.evidence.error.clear();page.evidence.content_type="text/markdown".into();
        page.evidence.fetched_at=chrono::Utc::now().timestamp();page.evidence.latency_ms+=started.elapsed().as_millis() as u64;
        return Some(local_html);
    }
    None
}

/// Render only a public research page using an ALREADY configured provider.
/// No bundled operator key, no new subscription, same shared paid-request cap.
pub async fn firecrawl_fetch(state:&AppState,url:&str)->Result<Option<(String,String)>>{
    let runtime=session(state)?;
    if !runtime.configured_api || runtime.keys.firecrawl.is_empty() || circuit_open(runtime.namespace,"firecrawl_fetch"){return Ok(None);}
    let checked=web_research::validate_public_url_syntax(url).map_err(PebbleError::Validation)?;
    web_research::validate_public_dns(&checked).await.map_err(PebbleError::Validation)?;
    let key=(runtime.namespace,format!("firecrawl-fetch:{checked}"));
    if let Some((at,final_url,html))=FETCH_CACHE.get_or_init(Default::default).lock().await.get(&key){
        if at.elapsed()<Duration::from_secs(600){return Ok(Some((final_url.clone(),html.clone())));}
    }
    let result=pebble_websearch::with_service_keys(&runtime.keys.firecrawl,|api_key|{
        let api=&runtime.api;let budget=&runtime.budget;
        async move{
            if !budget.request(true){return Err(pebble_websearch::Failure::Budget);}
            let response=api.post("https://api.firecrawl.dev/v2/scrape").bearer_auth(api_key)
                .timeout(Duration::from_secs(18)).json(&serde_json::json!({"url":url,"formats":["html"],"onlyMainContent":false,"timeout":12000})).send().await
                .map_err(|_|pebble_websearch::Failure::Network)?;
            pebble_websearch::bounded_json(response).await
        }
    }).await;
    let value=match result{Ok(v)=>v,Err(error)=>{cool_down(runtime.namespace,"firecrawl_fetch",&error);return Ok(None);}};
    if value.get("success").and_then(|v|v.as_bool())!=Some(true){return Ok(None);}
    let data=&value["data"];let final_url=data["metadata"]["sourceURL"].as_str().unwrap_or(url);
    web_research::validate_public_url_syntax(final_url).map_err(PebbleError::Validation)?;
    if pebble_websearch::leads::host(final_url)!=pebble_websearch::leads::host(url){return Ok(None);}
    let html=data["html"].as_str().unwrap_or("");if html.trim().is_empty()||html.len()>2*1024*1024{return Ok(None);}
    let mut cache=FETCH_CACHE.get_or_init(Default::default).lock().await;
    if cache.len()>=64{if let Some(old)=cache.iter().min_by_key(|(_,v)|v.0).map(|(k,_)|k.clone()){cache.remove(&old);}}
    cache.insert(key,(Instant::now(),final_url.into(),html.into()));Ok(Some((final_url.into(),html.into())))
}

/// Optional cloud extraction, only for public targets explicitly requested by a
/// research task. Never sends mail, cookies, local files or login credentials.
pub async fn tinyfish_fetch(state:&AppState,url:&str)->Result<Option<(String,String)>> {
    let session=session(state)?;
    if !session.config.tinyfish_fetch_enabled || session.keys.tinyfish.is_empty(){return Ok(None);}
    let target=web_research::validate_public_url_syntax(url).map_err(PebbleError::Validation)?;
    let cache_key=(session.namespace,format!("fetch:{target}"));
    let flight={let mut flights=FLIGHTS.get_or_init(Default::default).lock().await;
        flights.retain(|_,value|Arc::strong_count(value)>1);
        flights.entry(cache_key.clone()).or_default().clone()};
    let _flight=flight.lock().await;
    {
        let mut cache=FETCH_CACHE.get_or_init(Default::default).lock().await;
        cache.retain(|_,(at,_,_)|at.elapsed()<Duration::from_secs(session.config.cache_minutes*60));
        if let Some((_,url,text))=cache.get(&cache_key) {return Ok(Some((url.clone(),text.clone())));}
    }
    web_research::validate_public_dns(&target).await.map_err(PebbleError::Validation)?;
    if circuit_open(session.namespace,"tinyfish_fetch") || !session.budget.request(false){return Ok(None);}
    reserve_tinyfish(state,&session.config,true)?;
    let request=session.api.post("https://api.fetch.tinyfish.ai").header("X-API-Key",&session.keys.tinyfish)
        .timeout(Duration::from_secs(20)).json(&serde_json::json!({"urls":[url],"format":"markdown"})).send().await;
    let value=match request {
        Ok(response)=>pebble_websearch::bounded_json(response).await,
        Err(_)=>Err(pebble_websearch::Failure::Network),
    };
    let value=match value {Ok(value)=>value,Err(error)=>{cool_down(session.namespace,"tinyfish_fetch",&error);return Err(PebbleError::Network(format!("TinyFish {}",error.label())));}};
    let Some(page)=value.get("results").and_then(|v|v.as_array()).and_then(|v|v.first()) else {return Ok(None);};
    let final_url=page.get("final_url").and_then(|v|v.as_str()).unwrap_or(url);
    web_research::validate_public_url_syntax(final_url).map_err(PebbleError::Validation)?;
    let text=page.get("text").and_then(|v|v.as_str()).unwrap_or_default().chars().take(60_000).collect::<String>();
    if text.trim().is_empty(){return Ok(None);}
    let mut cache=FETCH_CACHE.get_or_init(Default::default).lock().await;
    if cache.len()>=64 {if let Some(key)=cache.iter().min_by_key(|(_,v)|v.0).map(|(key,_)|key.clone()){cache.remove(&key);}}
    cache.insert(cache_key,(Instant::now(),final_url.into(),text.clone()));
    Ok(Some((final_url.into(),text)))
}

pub async fn fetch_with_optional_cloud(state:&AppState,client:&reqwest::Client,url:&str,provider:&str,policy:web_research::FetchPolicy)->web_research::PageDocument {
    let started=Instant::now();
    let mut page=web_research::safe_fetch(client,url,provider,policy).await;
    if provider=="company_research" {
        if let Ok(session)=session(state) {
            let _=supplement_with_deepseek(&session,client,url,&mut page,Duration::from_secs(5)).await;
            if page.evidence.provider=="deepseek_fetch" {return page;}
        }
    }
    use web_research::EvidenceStatus;
    // Never route SSRF blocks, unsafe redirects, oversized or unsupported data
    // to another transport. For a public thin/failed page, optional extraction
    // receives only the original public URL, no mail/session credentials.
    let thin=page.evidence.status==EvidenceStatus::Ok && !page.evidence.content_type.contains("pdf") && page.text.chars().count()<300;
    if thin || matches!(page.evidence.status,EvidenceStatus::Empty|EvidenceStatus::HttpError|EvidenceStatus::Timeout|EvidenceStatus::NetworkError) {
        if let Ok(Some((final_url,text)))=tinyfish_fetch(state,url).await {
            page.final_url=final_url.clone();page.text=text;page.bytes.clear();
            page.evidence.url=final_url;page.evidence.provider="tinyfish_fetch".into();page.evidence.providers=vec!["tinyfish_fetch".into()];
            page.evidence.status=EvidenceStatus::Ok;page.evidence.http_status=None;page.evidence.error.clear();page.evidence.content_type="text/markdown".into();
            page.evidence.fetched_at=chrono::Utc::now().timestamp();page.evidence.latency_ms=started.elapsed().as_millis() as u64;
        }
    }
    page
}

#[tauri::command]
pub async fn test_ai_search(state:State<'_,AppState>,query:String)->Result<SearchResult> {
    if query.trim().is_empty() || query.chars().count()>500 {return Err(PebbleError::Validation("请输入 1–500 字的公开搜索关键词".into()));}
    let proxy=super::network::get_global_proxy_raw(&state.crypto,&state.store)?;
    let client=web_research::build_research_client(proxy.as_ref())?;
    scoped(&state,async {Ok(search(&state,&client,&query).await)}).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{Read,Write},net::TcpListener,sync::atomic::{AtomicUsize,Ordering}};
    static ID:AtomicUsize=AtomicUsize::new(0);
    struct Fixture {state:AppState,path:std::path::PathBuf}
    impl Fixture {
        fn new()->Self {
            let path=std::env::temp_dir().join(format!("mail-search-test-{}-{}",std::process::id(),ID.fetch_add(1,Ordering::SeqCst)));
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(path.join("portable-key"),format!("PEBBLE-PORTABLE-KEY-V1\n{}\n","01".repeat(32))).unwrap();
            let crypto=pebble_crypto::CryptoService::init_for_profile(&path).unwrap();
            let (tx,_)=std::sync::mpsc::channel();
            let state=AppState::new(pebble_store::Store::open_in_memory().unwrap(),pebble_search::TantivySearch::open_in_memory().unwrap(),crypto,tx,path.join("attachments"));
            Self{state,path}
        }
    }
    impl Drop for Fixture {fn drop(&mut self){let _=std::fs::remove_file(self.path.join("portable-key"));let _=std::fs::remove_dir(&self.path);}}
    fn server(body:&str,status:u16)->(String,std::thread::JoinHandle<String>) {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();let address=listener.local_addr().unwrap();let body=body.to_string();
        let thread=std::thread::spawn(move||{let (mut socket,_)=listener.accept().unwrap();socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();let mut bytes=[0;8192];let n=socket.read(&mut bytes).unwrap();let request=String::from_utf8_lossy(&bytes[..n]).into_owned();write!(socket,"HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();request});
        (format!("http://{address}"),thread)
    }
    #[tokio::test] async fn lead_delivery_scales_only_default_public_limits_not_paid_calls_or_explicit_policy(){
        let f=Fixture::new();
        scoped_leads(&f.state,20,async{let s=session(&f.state)?;assert_eq!(s.config.max_queries,40);assert_eq!(s.config.max_requests,160);assert_eq!(s.config.max_paid_requests,6);Ok(())}).await.unwrap();
        let mut stored=Stored::default();stored.config.max_queries=2;stored.config.max_requests=4;save(&f.state,CONFIG_KEY,&stored).unwrap();
        scoped_leads(&f.state,20,async{let s=session(&f.state)?;assert_eq!(s.config.max_queries,2);assert_eq!(s.config.max_requests,4);assert_eq!(s.config.max_paid_requests,6);Ok(())}).await.unwrap();
    }
    #[tokio::test] async fn company_expands_only_default_public_work_not_paid_or_explicit_caps(){
        let f=Fixture::new();
        scoped_company(&f.state,async{let s=session(&f.state)?;assert_eq!(s.config.max_queries,32);assert_eq!(s.config.max_requests,160);assert_eq!(s.config.max_paid_requests,6);Ok(())}).await.unwrap();
        let mut saved=Stored::default();saved.config.max_queries=3;saved.config.max_requests=9;saved.config.max_paid_requests=1;save(&f.state,CONFIG_KEY,&saved).unwrap();
        scoped_company(&f.state,async{let s=session(&f.state)?;assert_eq!(s.config.max_queries,3);assert_eq!(s.config.max_requests,9);assert_eq!(s.config.max_paid_requests,1);Ok(())}).await.unwrap();
    }
    #[tokio::test] async fn narrow_cache_cannot_masquerade_as_company_diversity(){
        let f=Fixture::new();let runtime=SearchSession::new(&f.state).unwrap();let query="isolated sample company";
        CACHE.get_or_init(Default::default).lock().await.insert((runtime.namespace,query.into()),CacheEntry{at:Instant::now(),result:SearchResult{warning:"narrow-cache".into(),..Default::default()},ttl:Duration::from_secs(60)});
        CACHE.get_or_init(Default::default).lock().await.insert((runtime.namespace,format!("company-diverse:{query}")),CacheEntry{at:Instant::now(),result:SearchResult{warning:"diverse-cache".into(),..Default::default()},ttl:Duration::from_secs(60)});
        let client=reqwest::Client::new();
        assert_eq!(search_mode(&f.state,&client,&runtime,query,false).await.warning,"narrow-cache");
        assert_eq!(search_mode(&f.state,&client,&runtime,query,true).await.warning,"diverse-cache");
    }
    #[tokio::test] async fn rendering_is_not_enabled_without_a_configured_key(){
        let f=Fixture::new();assert!(firecrawl_fetch(&f.state,"https://example.com/").await.unwrap().is_none());
        assert!(f.state.store.get_secure_user_data(QUOTA_KEY).unwrap().is_none());
    }
    #[test] fn encrypted_settings_keep_secrets_and_survive_reload() {
        let f=Fixture::new();let stored=Stored{config:SearchConfig::default(),tinyfish_key:"dummy-fixture-secret".into()};
        save(&f.state,CONFIG_KEY,&stored).unwrap();
        let raw=f.state.store.get_secure_user_data(CONFIG_KEY).unwrap().unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("dummy-fixture-secret"));
        assert_eq!(load(&f.state).unwrap().tinyfish_key,"dummy-fixture-secret");
    }
    #[test] fn saved_search_keys_are_not_blocked_by_an_absent_hidden_policy() {
        let mut c=SearchConfig::default();
        assert!(configured_api_allowed(&c,false));
        assert!(!configured_api_allowed(&c,true)); // Preserve an explicit old opt-out.
        c.configured_api_enabled=Some(false); assert!(!configured_api_allowed(&c,false));
        c.configured_api_enabled=Some(true); assert!(configured_api_allowed(&c,true));
    }
    #[test] fn persisted_local_quota_cannot_be_reset_by_new_session_or_key() {
        let f=Fixture::new();let config=SearchConfig{tinyfish_fetch_daily_limit:1,..Default::default()};
        reserve_tinyfish(&f.state,&config,true).unwrap();
        let _new_session=SearchSession::new(&f.state).unwrap();
        assert!(reserve_tinyfish(&f.state,&config,true).is_err());
        assert!(reserve_tinyfish(&f.state,&config,false).is_ok());
    }
    #[tokio::test] async fn real_http_search_coalesces_caches_and_keeps_source() {
        let f=Fixture::new();let (url,server)=server(r#"{"results":[{"title":"Public company","url":"https://example.com/?utm_source=test","snippet":"Public fixture"}]}"#,200);
        save(&f.state,CONFIG_KEY,&Stored{config:SearchConfig{openserp_enabled:true,openserp_url:url,..Default::default()},tinyfish_key:String::new()}).unwrap();
        let runtime=SearchSession::new(&f.state).unwrap();let client=reqwest::Client::new();
        let (a,b)=tokio::join!(search_in(&f.state,&client,&runtime,"fixture company"),search_in(&f.state,&client,&runtime,"fixture company"));
        assert_eq!(a.items.len(),1);assert_eq!(a.items[0].provider,"openserp");assert_eq!(a.items[0].url,"https://example.com/");assert!(!a.cache_hit);assert!(b.cache_hit);
        let request=server.join().unwrap();assert!(request.starts_with("GET /mega/search?"));assert!(!request.contains("API-Key"));
    }
    #[tokio::test] async fn scope_reuses_budget_and_join_tasks_share_it() {
        let f=Fixture::new();let runtime=SearchSession::new(&f.state).unwrap();
        scoped_session(runtime.clone(),async {
            assert!(Arc::ptr_eq(&session(&f.state).unwrap(),&runtime));
            scoped(&f.state,async {assert!(Arc::ptr_eq(&session(&f.state).unwrap(),&runtime));Ok(())}).await.unwrap();
        }).await;
        assert!(!Arc::ptr_eq(&session(&f.state).unwrap(),&runtime));
    }
    #[tokio::test] async fn exhausted_task_does_not_poison_later_task_or_trigger_public_network() {
        let f=Fixture::new();let (url,server)=server(r#"{"results":[]}"#,200);
        save(&f.state,CONFIG_KEY,&Stored{config:SearchConfig{openserp_enabled:true,openserp_url:url,max_requests:1,..Default::default()},tinyfish_key:String::new()}).unwrap();
        let runtime=SearchSession::new(&f.state).unwrap();let result=search_in(&f.state,&reqwest::Client::new(),&runtime,"empty fixture").await;
        assert!(result.warning.contains("预算"));assert_eq!(result.attempts[0].status,"无命中");assert!(!circuit_open(runtime.namespace,"openserp"));server.join().unwrap();
    }
    #[tokio::test] async fn deepseek_quota_reserves_fetch_and_original_search_remains_available(){
        let f=Fixture::new();
        let (url,server)=server(r#"{"results":[{"title":"Fixture company","url":"https://example.com/","snippet":"Public fixture"}]}"#,200);
        save(&f.state,CONFIG_KEY,&Stored{config:SearchConfig{openserp_enabled:true,openserp_url:url,..Default::default()},..Default::default()}).unwrap();
        let mut runtime=SearchSession::with_scope(&f.state,true).unwrap();
        assert!(runtime.deepseek.is_none());
        let runtime=Arc::get_mut(&mut runtime).unwrap();
        let secret=serde_json::json!({"deepseek_keys":["fixture-never-sent"],"deepseek_search_enabled":true});
        f.state.store.set_secure_user_data("external_service_api_keys", &f.state.crypto.encrypt(&serde_json::to_vec(&secret).unwrap()).unwrap()).unwrap();
        runtime.deepseek=Some(DeepSeekBudget{key:"fixture-never-sent".into(),search:0.into(),fetch:0.into(),store:f.state.store.clone(),crypto:f.state.crypto.clone()});
        let budget=runtime.deepseek.as_ref().unwrap();
        for _ in 0..4 {assert!(budget.reserve(false,6));}
        assert!(!budget.reserve(false,6));
        assert!(budget.reserve(true,6));
        let result=search_in(&f.state,&reqwest::Client::new(),runtime,"fixture company").await;
        assert_eq!(result.attempts[0].provider,"deepseek");
        assert_eq!(result.items[0].provider,"openserp");
        assert!(!circuit_open(runtime.namespace,"deepseek"));
        server.join().unwrap();
    }
    #[test] fn saved_deepseek_key_without_billing_consent_never_creates_a_paid_session(){
        let f=Fixture::new();
        let write=|value:serde_json::Value|f.state.store.set_secure_user_data("external_service_api_keys",&f.state.crypto.encrypt(&serde_json::to_vec(&value).unwrap()).unwrap()).unwrap();
        // Legacy profiles contain a key but no explicit consent field.
        write(serde_json::json!({"deepseek_keys":["fixture-key"]}));
        assert!(SearchSession::with_scope(&f.state,true).unwrap().deepseek.is_none());
        write(serde_json::json!({"deepseek_keys":["fixture-key"],"deepseek_search_enabled":true}));
        let runtime=SearchSession::with_scope(&f.state,true).unwrap();
        assert!(runtime.deepseek_enabled());
        assert!(SearchSession::new(&f.state).unwrap().deepseek.is_none());
        // Disabling while a task is running blocks its next API request.
        write(serde_json::json!({"deepseek_keys":["fixture-key"],"deepseek_search_enabled":false}));
        assert!(!runtime.deepseek_enabled());
        write(serde_json::json!({"deepseek_keys":["replacement-key"],"deepseek_search_enabled":true}));
        assert!(!runtime.deepseek_enabled());
        f.state.store.set_secure_user_data("external_service_api_keys",b"invalid-encrypted-fixture").unwrap();
        assert!(!runtime.deepseek_enabled());
    }
    #[tokio::test] async fn cloud_never_bypasses_private_url_rejection() {
        let f=Fixture::new();
        save(&f.state,CONFIG_KEY,&Stored{config:SearchConfig{tinyfish_fetch_enabled:true,..Default::default()},tinyfish_key:"dummy-never-sent".into()}).unwrap();
        for url in ["http://127.0.0.1/private","http://[::1]/private","http://169.254.169.254/latest/meta-data"] {
            let page=fetch_with_optional_cloud(&f.state,&reqwest::Client::new(),url,"fixture",web_research::FetchPolicy::default()).await;
            assert_eq!(page.evidence.status,web_research::EvidenceStatus::Invalid);
        }
        assert!(f.state.store.get_secure_user_data(QUOTA_KEY).unwrap().is_none());
    }
    #[test] fn corrupt_usage_fails_closed_and_old_day_resets() {
        let f=Fixture::new();let config=SearchConfig{tinyfish_fetch_daily_limit:1,..Default::default()};
        save(&f.state,QUOTA_KEY,&Usage{day:chrono::Utc::now().timestamp()/86400-1,fetch:999,..Default::default()}).unwrap();
        assert!(reserve_tinyfish(&f.state,&config,true).is_ok());
        f.state.store.set_secure_user_data(QUOTA_KEY,b"not encrypted data").unwrap();
        assert!(reserve_tinyfish(&f.state,&config,true).is_err());
    }
}
