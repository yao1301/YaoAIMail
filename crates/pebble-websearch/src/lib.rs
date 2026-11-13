//! Search transport and deterministic policy. No mail access, model calls or paid agent API.
pub mod leads;
pub mod lead_research;
pub mod content;
pub mod company_profile;
pub mod company_report;
pub mod investigation;
pub mod contact_research;
pub mod email_checks;
pub mod outreach_feedback;
pub mod lead_fill;
pub mod deepseek;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::atomic::{AtomicUsize, Ordering}, time::Duration};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(default, rename_all = "camelCase")]
pub struct SearchConfig {
    pub openserp_enabled: bool,
    pub openserp_url: String,
    pub tinyfish_search_enabled: bool,
    pub tinyfish_fetch_enabled: bool,
    pub paid_search_enabled: bool,
    /// None preserves legacy intent: existing saved policy wins; otherwise
    /// user-supplied search keys are usable without a second hidden switch.
    pub configured_api_enabled: Option<bool>,
    pub max_queries: usize,
    pub max_requests: usize,
    pub max_paid_requests: usize,
    pub cache_minutes: u64,
    pub tinyfish_search_daily_limit: u32,
    pub tinyfish_fetch_daily_limit: u32,
}
impl Default for SearchConfig {
    fn default() -> Self { Self {
        openserp_enabled: false, openserp_url: "http://127.0.0.1:7000".into(),
        tinyfish_search_enabled: false, tinyfish_fetch_enabled: false,
        paid_search_enabled: false, configured_api_enabled: None, max_queries: 18, max_requests: 60,
        max_paid_requests: 6, cache_minutes: 10,
        tinyfish_search_daily_limit: 200, tinyfish_fetch_daily_limit: 200,
    } }
}
impl SearchConfig {
    pub fn validate(&self) -> Result<(), String> {
        pebble_translate::endpoint::validate_service_endpoint(&self.openserp_url)?;
        let url = reqwest::Url::parse(&self.openserp_url).map_err(|_| "OpenSERP 地址无效")?;
        if !matches!(url.path(), "" | "/") || url.query().is_some() {
            return Err("OpenSERP 请填写服务根地址，不带 /mega/search 或查询参数".into());
        }
        if !(1..=40).contains(&self.max_queries) || !(1..=160).contains(&self.max_requests)
            || self.max_paid_requests > 20 || !(1..=1440).contains(&self.cache_minutes)
            || self.tinyfish_search_daily_limit > 400 || self.tinyfish_fetch_daily_limit > 900 {
            return Err("搜索预算超出允许范围".into());
        }
        Ok(())
    }
}

#[derive(Clone, Default)]
pub struct Keys { pub brave: Vec<String>, pub tavily: Vec<String>, pub firecrawl: Vec<String>, pub tinyfish: String }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hit { pub title: String, pub url: String, pub description: String, pub provider: String }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt { pub provider: String, pub status: String, pub elapsed_ms: u64, pub results: usize }

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult { pub items: Vec<Hit>, pub attempts: Vec<Attempt>, pub cache_hit: bool, pub warning: String }

pub struct Budget { queries: AtomicUsize, requests: AtomicUsize, paid: AtomicUsize, pub config: SearchConfig }
fn take(counter: &AtomicUsize, cap: usize) -> bool {
    counter.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < cap).then_some(n + 1)).is_ok()
}
impl Budget {
    pub fn new(config: SearchConfig) -> Self { Self { queries: AtomicUsize::new(0), requests: AtomicUsize::new(0), paid: AtomicUsize::new(0), config } }
    pub fn query(&self) -> bool { take(&self.queries, self.config.max_queries) }
    pub fn request(&self, paid: bool) -> bool {
        if paid && !take(&self.paid, self.config.max_paid_requests) { return false; }
        take(&self.requests, self.config.max_requests)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Failure { Auth, Quota, RateLimit, Network, Server, Invalid, Schema, TooLarge, Budget }
impl Failure {
    pub fn label(&self) -> &'static str { match self {
        Self::Auth => "认证失败", Self::Quota => "额度耗尽", Self::RateLimit => "服务限流",
        Self::Network => "网络失败", Self::Server => "服务失败", Self::Invalid => "请求被拒绝",
        Self::Schema => "响应格式无效", Self::TooLarge => "响应超限",
        Self::Budget => "本次任务请求预算已到",
    } }
    pub fn rotate_key(&self) -> bool { matches!(self, Self::Auth | Self::Quota) }
}

pub fn normalize_query(query: &str) -> String { query.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(500).collect() }
/// Conservative relevance floor: reject a multi-keyword SERP that only
/// matches one generic word (e.g. "industrial" dictionary definitions).
/// This is not company verification; downstream identity checks still apply.
pub fn relevant_hits(query: &str, items: Vec<Hit>) -> Vec<Hit> {
    let terms:HashSet<String>=query.split_whitespace().filter_map(|word|{
        if word.contains(':') || word.starts_with('-') {return None;}
        let term=word.trim_matches(|c:char|!c.is_alphanumeric()).to_lowercase();
        if term.chars().count()<2 || matches!(term.as_str(),"and"|"the"|"for"|"with"|"from"|"com"|"www"|"not"|"or") {return None;}
        Some(term)
    }).collect();
    if terms.len()<3 {return items;}
    let buyer_terms = ["distributor", "distribution", "importer", "wholesale", "wholesaler", "supplier", "manufacturer", "retail", "retailer", "shop", "store", "florist", "dealer", "stockist", "boutique", "经销商", "进口商", "批发商", "门店", "礼品店", "花店", "großhandel", "händler", "importeur", "grossiste", "distributeur", "importateur", "mayorista", "distribuidor", "importador", "grossista", "distributore", "卸売", "販売代理店"];
    let buyer_query = terms.iter().any(|term| buyer_terms.iter().any(|buyer| leads::contains_term(term, buyer)));
    let mut items:Vec<_>=items.into_iter().filter_map(|item|{
        let text=format!("{} {} {}",item.title,item.url,item.description).to_lowercase();
        let score=terms.iter().filter(|term|leads::contains_term(&text, term)).count();
        let native_product=terms.iter().any(|term| !term.is_ascii() && term.chars().count()>=4 && leads::contains_term(&text,term));
        let business_match = !buyer_query || buyer_terms.iter().any(|buyer| leads::contains_term(&text,buyer));
        // Do not demand an English buyer word on a German/Chinese company page.
        // Strict product/channel grading happens on the fetched source, not SERP.
        ((score>=2 && business_match) || native_product).then_some((score,item))
    }).collect();
    items.sort_by_key(|(score,_)|std::cmp::Reverse(*score));items.into_iter().map(|(_,item)|item).collect()
}
/// One bounded alternate query. Preserve every original token, country,
/// operator and exclusion; never broaden a site-restricted request.
pub fn query_variant(query:&str)->Option<String> {
    if query.contains(['"',':','(',')']) {return None;}
    let words:Vec<_>=query.split_whitespace().collect();
    if words.len()<4 || words[0].starts_with('-') || words[1].starts_with('-') {return None;}
    Some(format!("\"{} {}\" {}",words[0],words[1],words[2..].join(" ")))
}
pub fn dedupe(items: Vec<Hit>, valid: impl Fn(&str) -> bool) -> Vec<Hit> {
    dedupe_limit(items, valid, 20)
}
pub fn dedupe_limit(items: Vec<Hit>, valid: impl Fn(&str) -> bool, limit: usize) -> Vec<Hit> {
    let mut seen = HashSet::new();
    items.into_iter().filter_map(|mut hit| {
        if !valid(&hit.url) { return None; }
        let mut url = reqwest::Url::parse(&hit.url).ok()?;
        url.set_fragment(None);
        let pairs: Vec<_> = url.query_pairs().filter(|(key, _)| !key.starts_with("utm_") && !matches!(key.as_ref(), "gclid" | "fbclid")).map(|(k,v)| (k.into_owned(),v.into_owned())).collect();
        url.set_query(None);
        if !pairs.is_empty() { url.query_pairs_mut().extend_pairs(pairs); }
        hit.url = url.to_string();
        hit.title = hit.title.chars().take(300).collect();
        hit.description = hit.description.chars().take(4000).collect();
        seen.insert(hit.url.clone()).then_some(hit)
    }).take(limit.min(200)).collect()
}

/// Missing result arrays are not successful zero-hit searches.
pub fn parse_results(provider: &str, value: &Value) -> Result<Vec<Hit>, Failure> {
    let rows = match provider { "brave" => value.pointer("/web/results"), "firecrawl" => value.pointer("/data/web").or_else(|| value.get("data")), _ => value.get("results") }
        .and_then(Value::as_array).ok_or(Failure::Schema)?;
    Ok(rows.iter().take(20).filter_map(|row| Some(Hit {
        title: row.get("title").and_then(Value::as_str).unwrap_or_default().into(),
        url: row.get("url").and_then(Value::as_str)?.into(),
        description: (if provider == "deepseek" { &["summary", "snippet"][..] } else { &["snippet", "description", "content", "markdown"][..] })
            .iter().find_map(|k| row.get(*k).and_then(Value::as_str).filter(|s| !s.trim().is_empty())).unwrap_or_default().into(),
        provider: provider.into(),
    })).collect())
}

pub async fn bounded_json(response: reqwest::Response) -> Result<Value, Failure> {
    let code = response.status().as_u16();
    if !(200..300).contains(&code) { return Err(match code { 401|403 => Failure::Auth, 402|432 => Failure::Quota, 429 => Failure::RateLimit, 500..=599 => Failure::Server, _ => Failure::Invalid }); }
    if response.content_length().is_some_and(|n| n > 2_000_000) { return Err(Failure::TooLarge); }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Network)? {
        if bytes.len() + chunk.len() > 2_000_000 { return Err(Failure::TooLarge); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Failure::Schema)
}

/// API URLs are fixed except for the explicitly configured OpenSERP service.
/// Clients MUST disable redirects so a service cannot forward API keys elsewhere.
pub fn search_request(client: &reqwest::Client, provider: &str, base: &str, key: &str, query: &str) -> Result<reqwest::RequestBuilder, Failure> {
    let request = match provider {
        "openserp" => client.get(format!("{}/mega/search", base.trim_end_matches('/')))
            .query(&[("text",query),("engines","bing,duckduckgo,google"),("mode","any"),("limit","12")]),
        "tinyfish" => client.get("https://api.search.tinyfish.ai").header("X-API-Key", key).query(&[("query",query)]),
        "brave" => client.get("https://api.search.brave.com/res/v1/web/search").header("X-Subscription-Token",key).query(&[("q",query),("count","10")]),
        "tavily" => client.post("https://api.tavily.com/search").bearer_auth(key).json(&json!({"query":query,"max_results":10,"include_answer":false})),
        "firecrawl" => client.post("https://api.firecrawl.dev/v2/search").bearer_auth(key).json(&json!({"query":query,"limit":8})),
        "deepseek" => return deepseek::search_request(client, key, query),
        _ => return Err(Failure::Invalid),
    };
    Ok(request.timeout(Duration::from_secs(15)))
}
pub async fn request(client: &reqwest::Client, provider: &str, base: &str, key: &str, query: &str) -> Result<Vec<Hit>, Failure> {
    let response = search_request(client,provider,base,key,query)?.send().await.map_err(|_| Failure::Network)?;
    parse_results(provider, &bounded_json(response).await?)
}

/// Retries only authentication/quota failures. Empty results and rate limits
/// never rotate accounts, avoiding accidental cost and rate-limit evasion.
pub async fn with_keys<F, Fut>(keys: &[String], mut call: F) -> Result<Vec<Hit>, Failure>
where F: FnMut(String) -> Fut, Fut: std::future::Future<Output=Result<Vec<Hit>, Failure>> {
    with_service_keys(keys,move|key|call(key)).await
}
pub async fn with_service_keys<T,F,Fut>(keys:&[String],mut call:F)->Result<T,Failure>
where F:FnMut(String)->Fut,Fut:std::future::Future<Output=Result<T,Failure>>{
    let mut last = Failure::Auth;
    for key in keys.iter().take(2) {
        match call(key.clone()).await { Ok(items) => return Ok(items), Err(error) if error.rotate_key() => last=error, Err(error) => return Err(error) }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn config_defaults_have_no_cloud_or_paid_calls() {
        let c=SearchConfig::default(); assert!(!c.tinyfish_search_enabled && !c.tinyfish_fetch_enabled && !c.paid_search_enabled); assert!(c.validate().is_ok());
        let mut c=c; c.openserp_url="http://example.com".into(); assert!(c.validate().is_err());
    }
    #[test] fn tinyfish_transport_uses_documented_search_only_without_leaking_key_to_url() {
        let request=search_request(&reqwest::Client::new(),"tinyfish","","dummy-fixture-key","lighting UK").unwrap().build().unwrap();
        assert_eq!(request.url().host_str(),Some("api.search.tinyfish.ai"));
        assert_eq!(request.url().query_pairs().find(|(k,_)|k=="query").unwrap().1,"lighting UK");
        assert_eq!(request.headers()["X-API-Key"],"dummy-fixture-key");
        assert!(!request.url().as_str().contains("dummy-fixture-key"));
        assert_eq!(request.method(),reqwest::Method::GET);
    }
    #[test] fn parses_real_provider_envelopes_and_empty_is_success() {
        for provider in ["openserp","tinyfish","tavily"] { assert_eq!(parse_results(provider,&json!({"results":[]})),Ok(vec![])); }
        assert_eq!(parse_results("tinyfish",&json!({"error":"bad"})),Err(Failure::Schema));
        assert_eq!(parse_results("brave",&json!({"web":{"results":[{"title":"A","url":"https://example.com","description":"B"}]}})).unwrap()[0].description,"B");
        assert_eq!(parse_results("firecrawl",&json!({"data":{"web":[]}})),Ok(vec![]));
    }
    #[test] fn normalizes_and_dedupes_tracking_urls() {
        let row=|url:&str| Hit{title:"A".into(),url:url.into(),description:"B".into(),provider:"test".into()};
        let rows=dedupe(vec![row("https://example.com/?utm_source=a#x"),row("https://example.com/"),row("file:///x")],|u|u.starts_with("https://"));
        assert_eq!(rows.len(),1); assert_eq!(normalize_query(" a\n b  "),"a b");
    }
    #[test] fn dictionary_noise_does_not_stop_fallback_for_buyer_queries() {
        let hit=|title:&str|Hit{title:title.into(),url:"https://example.com".into(),description:String::new(),provider:"test".into()};
        let rows=relevant_hits("industrial lighting distributors UK",vec![hit("Industrial dictionary definition"),hit("UK industrial lighting distributor")]);
        assert_eq!(rows.len(),1);assert!(rows[0].title.contains("distributor"));
        assert_eq!(relevant_hits("Example",vec![hit("Example company")]).len(),1);
        assert!(relevant_hits("LED lighting importers Australia",vec![hit("LED lighting definition encyclopedia")]).is_empty());
        assert_eq!(query_variant("garden lighting wholesalers Germany").unwrap(),"\"garden lighting\" wholesalers Germany");
        assert!(query_variant("site:example.com lighting importers UK").is_none());
    }
    #[tokio::test] async fn zero_hits_and_rate_limit_never_try_next_key() {
        for output in [Ok(vec![]),Err(Failure::RateLimit),Err(Failure::Network)] {
            let calls=AtomicUsize::new(0); let keys=vec!["dummy-a".into(),"dummy-b".into()];
            let _=with_keys(&keys, |_| { calls.fetch_add(1,Ordering::SeqCst); std::future::ready(output.clone()) }).await;
            assert_eq!(calls.load(Ordering::SeqCst),1);
        }
    }
    #[tokio::test] async fn auth_can_try_one_other_key() {
        let calls=AtomicUsize::new(0);
        let _=with_keys(&vec!["a".into(),"b".into(),"c".into()], |_| { calls.fetch_add(1,Ordering::SeqCst); std::future::ready(Err(Failure::Auth)) }).await;
        assert_eq!(calls.load(Ordering::SeqCst),2);
    }
    #[test] fn parallel_task_budget_cannot_overspend() {
        let budget=std::sync::Arc::new(Budget::new(SearchConfig{max_requests:3,max_paid_requests:2,..Default::default()}));
        let threads:Vec<_>=(0..20).map(|_|{let budget=budget.clone();std::thread::spawn(move||budget.request(true))}).collect();
        assert_eq!(threads.into_iter().map(|t|t.join().unwrap()).filter(|ok|*ok).count(),2);
        let budget=Budget::new(SearchConfig{max_requests:1,..Default::default()}); assert!(budget.request(false)); assert!(!budget.request(false));
    }
}
