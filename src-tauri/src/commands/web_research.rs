//! Safe, evidence-first web retrieval primitives used by lead research.
//!
//! The model may choose URLs, so this module treats every target as untrusted.
//! Redirects are followed manually and every hop is validated again.

use pebble_core::{now_timestamp, HttpProxyConfig, PebbleError};
use quick_xml::events::Event;
use quick_xml::Reader;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub const DEFAULT_HTML_LIMIT: usize = 2 * 1024 * 1024;
pub const DEFAULT_PDF_LIMIT: usize = 12 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const MAX_URL_LENGTH: usize = 8192;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceStatus {
    Ok,
    Empty,
    Blocked,
    Invalid,
    TooLarge,
    Unsupported,
    Timeout,
    NetworkError,
    HttpError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceEvidence {
    pub provider: String,
    pub query: String,
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub fetched_at: i64,
    pub status: EvidenceStatus,
    pub latency_ms: u64,
    pub http_status: Option<u16>,
    pub content_type: String,
    pub consensus: u32,
    pub providers: Vec<String>,
    pub error: String,
}

impl SourceEvidence {
    fn pending(provider: &str, url: &str) -> Self {
        Self {
            provider: provider.to_string(),
            query: String::new(),
            title: String::new(),
            url: url.to_string(),
            snippet: String::new(),
            fetched_at: now_timestamp(),
            status: EvidenceStatus::NetworkError,
            latency_ms: 0,
            http_status: None,
            content_type: String::new(),
            consensus: 1,
            providers: vec![provider.to_string()],
            error: String::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PageDocument {
    pub evidence: SourceEvidence,
    pub bytes: Vec<u8>,
    pub text: String,
    pub final_url: String,
}

#[derive(Debug, Clone, Copy)]
pub struct FetchPolicy {
    pub max_bytes: usize,
    pub timeout: Duration,
    pub allow_pdf: bool,
}

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub provider: String,
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub rank: usize,
}

pub type SearchFuture<'a> = Pin<Box<dyn Future<Output = Result<Vec<SearchHit>, String>> + Send + 'a>>;

/// Common provider contract. Providers return evidence candidates only; they
/// never create companies or infer facts.
pub trait SearchProvider: Send + Sync {
    fn name(&self) -> &'static str;
    fn index_family(&self) -> &'static str;
    fn search<'a>(&'a self, client: &'a reqwest::Client, query: &'a str) -> SearchFuture<'a>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProviderHealth {
    pub provider: String,
    pub index_family: String,
    pub state: String,
    pub consecutive_failures: u32,
    pub successes: u64,
    pub failures: u64,
    pub cache_hits: u64,
    pub last_latency_ms: u64,
    pub last_error: String,
    pub cooldown_until: i64,
}

#[derive(Debug, Clone)]
struct CircuitState {
    consecutive_failures: u32,
    successes: u64,
    failures: u64,
    cache_hits: u64,
    last_latency_ms: u64,
    last_error: String,
    cooldown_until: i64,
}

impl Default for CircuitState {
    fn default() -> Self {
        Self {
            consecutive_failures: 0,
            successes: 0,
            failures: 0,
            cache_hits: 0,
            last_latency_ms: 0,
            last_error: String::new(),
            cooldown_until: 0,
        }
    }
}

#[derive(Debug, Clone)]
struct SearchCacheEntry {
    created_at: i64,
    items: Vec<SourceEvidence>,
}

static SEARCH_CACHE: OnceLock<tokio::sync::Mutex<HashMap<String, SearchCacheEntry>>> = OnceLock::new();
static SEARCH_CIRCUITS: OnceLock<tokio::sync::Mutex<HashMap<String, CircuitState>>> = OnceLock::new();
static BING_SEARCH_LIMITER: OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = OnceLock::new();
static DDG_SEARCH_LIMITER: OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = OnceLock::new();
static MOJEEK_SEARCH_LIMITER: OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = OnceLock::new();
const SEARCH_CACHE_TTL_SECS: i64 = 10 * 60;
const SEARCH_CACHE_MAX_ENTRIES: usize = 256;
const CIRCUIT_FAILURE_THRESHOLD: u32 = 3;
const CIRCUIT_COOLDOWN_SECS: i64 = 60;

fn search_cache() -> &'static tokio::sync::Mutex<HashMap<String, SearchCacheEntry>> {
    SEARCH_CACHE.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

fn search_circuits() -> &'static tokio::sync::Mutex<HashMap<String, CircuitState>> {
    SEARCH_CIRCUITS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

fn provider_limiter(name: &str) -> std::sync::Arc<tokio::sync::Semaphore> {
    let slot = match name {
        "bing_rss" => &BING_SEARCH_LIMITER,
        "duckduckgo_html" => &DDG_SEARCH_LIMITER,
        "brave_web" => &BRAVE_WEB_LIMITER,
        "yahoo_web" => &YAHOO_WEB_LIMITER,
        _ => &MOJEEK_SEARCH_LIMITER,
    };
    // Email completion can launch several companies at once. Bound each
    // public provider independently so one batch cannot trigger rate limits
    // and open every circuit at the same time.
    slot.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(2))).clone()
}

struct BingRssProvider;
struct DuckDuckGoProvider;
struct MojeekProvider;
struct BraveWebProvider;
struct YahooWebProvider;
static BRAVE_WEB_LIMITER: OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = OnceLock::new();
static YAHOO_WEB_LIMITER: OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = OnceLock::new();
pub const PUBLIC_SEARCH_PROVIDERS: usize = 5;

fn search_policy() -> FetchPolicy {
    FetchPolicy {
        max_bytes: 1024 * 1024,
        timeout: Duration::from_secs(12),
        allow_pdf: false,
    }
}

fn search_url(base: &str, query: &str, extra: &[(&str, &str)]) -> Result<String, String> {
    let mut url = reqwest::Url::parse(base).map_err(|error| error.to_string())?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("q", query);
        for (key, value) in extra {
            pairs.append_pair(key, value);
        }
    }
    Ok(url.to_string())
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

fn compact_text(value: &str, max_chars: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(max_chars).collect()
}

fn parse_bing_rss(xml: &str) -> Vec<SearchHit> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut inside_item = false;
    let mut field = String::new();
    let mut title = String::new();
    let mut link = String::new();
    let mut description = String::new();
    let mut hits = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                let name = String::from_utf8_lossy(event.name().as_ref()).to_ascii_lowercase();
                if name == "item" {
                    inside_item = true;
                    title.clear();
                    link.clear();
                    description.clear();
                }
                field = name;
            }
            Ok(Event::Text(event)) if inside_item => {
                let value = decode_entities(&String::from_utf8_lossy(event.as_ref()));
                match field.as_str() {
                    "title" => title.push_str(&value),
                    "link" => link.push_str(&value),
                    "description" => description.push_str(&value),
                    _ => {}
                }
            }
            Ok(Event::CData(event)) if inside_item => {
                if field == "description" {
                    description.push_str(&String::from_utf8_lossy(event.as_ref()));
                }
            }
            Ok(Event::End(event)) => {
                let name = String::from_utf8_lossy(event.name().as_ref()).to_ascii_lowercase();
                if name == "item" {
                    inside_item = false;
                    if validate_public_url_syntax(&link).is_ok() {
                        hits.push(SearchHit {
                            provider: "bing_rss".to_string(),
                            title: compact_text(&title, 240),
                            url: link.trim().to_string(),
                            snippet: compact_text(&description, 600),
                            rank: hits.len() + 1,
                        });
                    }
                }
                field.clear();
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    hits
}

fn first_text(element: scraper::ElementRef<'_>, selectors: &[&str]) -> String {
    for selector in selectors {
        if let Ok(selector) = Selector::parse(selector) {
            if let Some(found) = element.select(&selector).next() {
                let text = found.text().collect::<Vec<_>>().join(" ");
                if !text.trim().is_empty() {
                    return compact_text(&text, 600);
                }
            }
        }
    }
    String::new()
}

fn first_link(element: scraper::ElementRef<'_>, selectors: &[&str]) -> Option<(String, String)> {
    for selector in selectors {
        let Ok(selector) = Selector::parse(selector) else { continue };
        if let Some(found) = element.select(&selector).next() {
            let href = found.value().attr("href")?.trim().to_string();
            let title = compact_text(&found.text().collect::<Vec<_>>().join(" "), 240);
            return Some((href, title));
        }
    }
    None
}

fn unwrap_ddg_url(raw: &str) -> String {
    let Ok(url) = reqwest::Url::parse(raw) else { return raw.to_string() };
    if url.host_str().is_some_and(|host| host.ends_with("duckduckgo.com")) {
        if let Some((_, value)) = url.query_pairs().find(|(key, _)| key == "uddg") {
            return value.into_owned();
        }
    }
    raw.to_string()
}

fn unwrap_yahoo_url(raw: &str) -> String {
    let Ok(url) = reqwest::Url::parse(raw) else { return raw.to_string() };
    if url.host_str() != Some("r.search.yahoo.com") { return raw.to_string(); }
    let Some((_, encoded)) = url.path().split_once("/RU=") else { return raw.to_string() };
    let encoded = encoded.split("/RK=").next().unwrap_or(encoded).split("/RS=").next().unwrap_or(encoded);
    // URL form decoding is data parsing only. Never evaluate search-page JS.
    let pair = format!("target={}", encoded.replace('+', "%2B"));
    let target = reqwest::Url::parse(&format!("https://example.invalid/?{pair}")).ok()
        .and_then(|u| u.query_pairs().find(|(k,_)| k == "target").map(|(_,v)| v.into_owned()));
    target.filter(|v| validate_public_url_syntax(v).is_ok()).unwrap_or_default()
}

fn parse_html_results(
    html: &str,
    provider: &str,
    row_selectors: &[&str],
    link_selectors: &[&str],
    snippet_selectors: &[&str],
) -> Vec<SearchHit> {
    let document = Html::parse_document(html);
    let mut hits = Vec::new();
    for row_selector in row_selectors {
        let Ok(row_selector) = Selector::parse(row_selector) else { continue };
        for row in document.select(&row_selector) {
            let Some((raw_url, title)) = first_link(row, link_selectors) else { continue };
            let url = match provider { "duckduckgo_html" => unwrap_ddg_url(&raw_url), "yahoo_web" => unwrap_yahoo_url(&raw_url), _ => raw_url };
            if validate_public_url_syntax(&url).is_err() || hits.iter().any(|hit: &SearchHit| hit.url == url) {
                continue;
            }
            hits.push(SearchHit {
                provider: provider.to_string(),
                title,
                url,
                snippet: first_text(row, snippet_selectors),
                rank: hits.len() + 1,
            });
            if hits.len() >= 20 { return hits; }
        }
        if !hits.is_empty() { break; }
    }
    hits
}

fn parse_brave_web(html: &str) -> Vec<SearchHit> {
    // Observed public HTML result cards. Exclude the AI answer box, related
    // questions and sublinks; do not depend on Svelte's private JS objects.
    let document = Html::parse_document(html);
    let rows = Selector::parse(".snippet[data-type='web']").unwrap();
    let titles = Selector::parse(".search-snippet-title").unwrap();
    let links = Selector::parse(".result-content > a[href]").unwrap();
    document.select(&rows).filter_map(|row| {
        let title = row.select(&titles).next()?.text().collect::<Vec<_>>().join(" ");
        let url = row.select(&links).next()?.value().attr("href")?.to_string();
        validate_public_url_syntax(&url).ok()?;
        Some(SearchHit { provider: "brave_web".into(), title: compact_text(&title,240), url,
            snippet: first_text(row, &[".generic-snippet", ".snippet-description"]), rank: 0 })
    }).take(20).enumerate().map(|(i,mut h)| {h.rank=i+1;h}).collect()
}

impl SearchProvider for BraveWebProvider {
    fn name(&self) -> &'static str { "brave_web" }
    fn index_family(&self) -> &'static str { "brave" }
    fn search<'a>(&'a self, client: &'a reqwest::Client, query: &'a str) -> SearchFuture<'a> {
        Box::pin(async move {
            let url = search_url("https://search.brave.com/search", query, &[("source", "web")])?;
            let page = safe_fetch(client, &url, self.name(), search_policy()).await;
            if page.evidence.status != EvidenceStatus::Ok { return Err(page.evidence.error); }
            let hits = parse_brave_web(&page.text);
            if hits.is_empty() { Err("Brave 公开网页未返回可解析结果（可能限流/验证），不绕过验证".into()) } else { Ok(hits) }
        })
    }
}

impl SearchProvider for YahooWebProvider {
    fn name(&self) -> &'static str { "yahoo_web" }
    fn index_family(&self) -> &'static str { "bing" }
    fn search<'a>(&'a self, client: &'a reqwest::Client, query: &'a str) -> SearchFuture<'a> {
        Box::pin(async move {
            let mut url = reqwest::Url::parse("https://search.yahoo.com/search").map_err(|e| e.to_string())?;
            url.query_pairs_mut().append_pair("p",query);
            let page = safe_fetch(client, url.as_str(), self.name(), search_policy()).await;
            if page.evidence.status != EvidenceStatus::Ok { return Err(page.evidence.error); }
            let hits = parse_html_results(&page.text, self.name(), &["div.algo-sr"], &[".compTitle a"], &[".compText"]);
            if hits.is_empty() { Err("Yahoo 公开网页未返回可解析结果（可能限流/验证），不绕过验证".into()) } else { Ok(hits) }
        })
    }
}

impl SearchProvider for BingRssProvider {
    fn name(&self) -> &'static str { "bing_rss" }
    fn index_family(&self) -> &'static str { "bing" }
    fn search<'a>(&'a self, client: &'a reqwest::Client, query: &'a str) -> SearchFuture<'a> {
        Box::pin(async move {
            let url = search_url("https://www.bing.com/search", query, &[("format", "rss")])?;
            let page = safe_fetch(client, &url, self.name(), search_policy()).await;
            if page.evidence.status != EvidenceStatus::Ok { return Err(page.evidence.error); }
            let hits = parse_bing_rss(&page.text);
            if hits.is_empty() { Err("Bing RSS 没有返回可解析结果".to_string()) } else { Ok(hits) }
        })
    }
}

impl SearchProvider for DuckDuckGoProvider {
    fn name(&self) -> &'static str { "duckduckgo_html" }
    fn index_family(&self) -> &'static str { "bing" }
    fn search<'a>(&'a self, client: &'a reqwest::Client, query: &'a str) -> SearchFuture<'a> {
        Box::pin(async move {
            let url = search_url("https://html.duckduckgo.com/html/", query, &[])?;
            let page = safe_fetch(client, &url, self.name(), search_policy()).await;
            if page.evidence.status != EvidenceStatus::Ok { return Err(page.evidence.error); }
            let hits = parse_html_results(&page.text, self.name(), &["div.result", ".web-result"], &["a.result__a", "h2 a"], &[".result__snippet", ".snippet"]);
            if hits.is_empty() { Err("DuckDuckGo 没有返回可解析结果".to_string()) } else { Ok(hits) }
        })
    }
}

impl SearchProvider for MojeekProvider {
    fn name(&self) -> &'static str { "mojeek" }
    fn index_family(&self) -> &'static str { "mojeek" }
    fn search<'a>(&'a self, client: &'a reqwest::Client, query: &'a str) -> SearchFuture<'a> {
        Box::pin(async move {
            let url = search_url("https://www.mojeek.com/search", query, &[])?;
            let page = safe_fetch(client, &url, self.name(), search_policy()).await;
            if page.evidence.status != EvidenceStatus::Ok { return Err(page.evidence.error); }
            let hits = parse_html_results(&page.text, self.name(), &["ul.results-standard li", "main li"], &["a.title", "h2 a"], &["p.s", ".snippet", "p"]);
            if hits.is_empty() { Err("Mojeek 没有返回可解析结果".to_string()) } else { Ok(hits) }
        })
    }
}

fn provider_family(provider: &str) -> &'static str {
    match provider {
        "bing_rss" | "duckduckgo_html" | "yahoo_web" => "bing",
        "brave_web" => "brave",
        "mojeek" => "mojeek",
        _ => "other",
    }
}

fn normalized_result_url(raw: &str) -> Option<String> {
    let mut url = validate_public_url_syntax(raw).ok()?;
    url.set_fragment(None);
    let retained = url.query_pairs().filter(|(key, _)| {
        let key = key.to_ascii_lowercase();
        !key.starts_with("utm_") && !matches!(key.as_str(), "gclid" | "fbclid" | "ref" | "source")
    }).map(|(key, value)| (key.into_owned(), value.into_owned())).collect::<Vec<_>>();
    url.set_query(None);
    if !retained.is_empty() {
        url.query_pairs_mut().extend_pairs(retained);
    }
    if url.path() != "/" {
        let path = url.path().trim_end_matches('/').to_string();
        url.set_path(&path);
    }
    Some(url.to_string())
}

async fn provider_search(provider: &dyn SearchProvider, client: &reqwest::Client, query: &str) -> Vec<SearchHit> {
    let name = provider.name().to_string();
    {
        let circuits = search_circuits().lock().await;
        if circuits.get(&name).is_some_and(|state| state.cooldown_until > now_timestamp()) {
            return Vec::new();
        }
    }
    let Ok(_permit) = provider_limiter(&name).acquire_owned().await else { return Vec::new() };
    let started = Instant::now();
    let result = provider.search(client, query).await;
    let mut circuits = search_circuits().lock().await;
    let state = circuits.entry(name).or_default();
    state.last_latency_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(items) => {
            state.successes += 1;
            state.consecutive_failures = 0;
            state.cooldown_until = 0;
            state.last_error.clear();
            items
        }
        Err(error) => {
            state.failures += 1;
            state.consecutive_failures += 1;
            state.last_error = compact_text(&error, 300);
            if state.consecutive_failures >= CIRCUIT_FAILURE_THRESHOLD {
                state.cooldown_until = now_timestamp() + CIRCUIT_COOLDOWN_SECS;
            }
            Vec::new()
        }
    }
}

/// Multi-source, cached evidence search. Consensus is based on independent
/// index families, so DDG + Bing never pretend to be two independent sources.
async fn collect_public_results(mut tasks: tokio::task::JoinSet<Vec<SearchHit>>, timeout: Duration) -> Vec<SearchHit> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut hits = Vec::new();
    while let Ok(Some(result)) = tokio::time::timeout_at(deadline,tasks.join_next()).await {
        if let Ok(mut completed) = result { hits.append(&mut completed); }
    }
    tasks.abort_all();
    hits
}

pub async fn multi_source_search(client: &reqwest::Client, query: &str, limit: usize) -> Vec<SourceEvidence> {
    let query = compact_text(query, 500);
    if query.is_empty() { return Vec::new(); }
    let key = query.clone();
    {
        let mut cache = search_cache().lock().await;
        cache.retain(|_, entry| now_timestamp() - entry.created_at <= SEARCH_CACHE_TTL_SECS);
        if let Some(entry) = cache.get(&key) {
            for provider in [&BingRssProvider as &dyn SearchProvider, &DuckDuckGoProvider, &MojeekProvider, &BraveWebProvider, &YahooWebProvider] {
                let mut circuits = search_circuits().lock().await;
                circuits.entry(provider.name().to_string()).or_default().cache_hits += 1;
            }
            return entry.items.iter().take(limit).cloned().collect();
        }
    }

    let mut tasks = tokio::task::JoinSet::new();
    for provider in [&BingRssProvider as &'static dyn SearchProvider, &DuckDuckGoProvider, &MojeekProvider, &BraveWebProvider, &YahooWebProvider] {
        let client=client.clone(); let query=query.clone();
        tasks.spawn(async move {provider_search(provider,&client,&query).await});
    }
    // Keep already completed sources when another source stalls. The caller's
    // task deadline must never throw away a successful fast provider wholesale.
    let completed = collect_public_results(tasks,Duration::from_secs(8)).await;
    #[derive(Default)]
    struct Merged { title: String, url: String, snippet: String, providers: HashSet<String>, families: HashSet<String>, rank_score: usize }
    let mut merged: HashMap<String, Merged> = HashMap::new();
    for hit in completed {
        let Some(normalized) = normalized_result_url(&hit.url) else { continue };
        let item = merged.entry(normalized.clone()).or_default();
        if item.title.is_empty() || hit.title.len() > item.title.len() { item.title = hit.title; }
        if item.snippet.is_empty() || hit.snippet.len() > item.snippet.len() { item.snippet = hit.snippet; }
        item.url = normalized;
        item.providers.insert(hit.provider.clone());
        item.families.insert(provider_family(&hit.provider).to_string());
        item.rank_score += 100usize.saturating_sub(hit.rank.min(99));
    }
    let mut ranked = merged.into_values().collect::<Vec<_>>();
    ranked.sort_by_key(|item| std::cmp::Reverse(item.families.len() * 1000 + item.providers.len() * 100 + item.rank_score));
    let mut host_counts = HashMap::<String, usize>::new();
    let mut items = Vec::new();
    for item in ranked {
        let host = reqwest::Url::parse(&item.url).ok().and_then(|url| url.host_str().map(str::to_string)).unwrap_or_default();
        let count = host_counts.entry(host).or_default();
        if *count >= 2 { continue; }
        *count += 1;
        let mut providers = item.providers.into_iter().collect::<Vec<_>>();
        providers.sort();
        items.push(SourceEvidence {
            provider: providers.first().cloned().unwrap_or_default(), query: query.clone(), title: item.title,
            url: item.url, snippet: item.snippet, fetched_at: now_timestamp(), status: EvidenceStatus::Ok,
            latency_ms: 0, http_status: None, content_type: "search/result".to_string(),
            consensus: item.families.len() as u32, providers, error: String::new(),
        });
        if items.len() >= limit.max(1) { break; }
    }
    {
        let mut cache = search_cache().lock().await;
        if cache.len() >= SEARCH_CACHE_MAX_ENTRIES {
            if let Some(oldest) = cache.iter().min_by_key(|(_, entry)| entry.created_at).map(|(key, _)| key.clone()) { cache.remove(&oldest); }
        }
        cache.insert(key, SearchCacheEntry { created_at: now_timestamp(), items: items.clone() });
    }
    items
}

#[tauri::command]
pub async fn get_web_search_health() -> Vec<SearchProviderHealth> {
    let circuits = search_circuits().lock().await;
    [(&BingRssProvider as &dyn SearchProvider), &DuckDuckGoProvider, &MojeekProvider, &BraveWebProvider, &YahooWebProvider]
        .into_iter().map(|provider| {
            let state = circuits.get(provider.name()).cloned().unwrap_or_default();
            SearchProviderHealth {
                provider: provider.name().to_string(), index_family: provider.index_family().to_string(),
                state: if state.cooldown_until > now_timestamp() { "open" } else { "healthy" }.to_string(),
                consecutive_failures: state.consecutive_failures, successes: state.successes, failures: state.failures,
                cache_hits: state.cache_hits, last_latency_ms: state.last_latency_ms, last_error: state.last_error,
                cooldown_until: state.cooldown_until,
            }
        }).collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteCrawlPage {
    pub url: String,
    pub title: String,
    pub text: String,
    pub evidence: SourceEvidence,
    pub is_pdf: bool,
    /// Original HTML is kept only inside the crawler so contact evidence in
    /// attributes, JSON-LD, scripts and `mailto:` links is not lost when the
    /// visible text is extracted. It is never serialized to the UI.
    #[serde(skip)]
    pub raw_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteCrawlResult {
    pub root_url: String,
    pub pages: Vec<SiteCrawlPage>,
    pub discovered_urls: usize,
    pub robots_respected: bool,
}

fn equivalent_site_host(left: &str, right: &str) -> bool {
    let left = left.trim_end_matches('.').trim_start_matches("www.").to_ascii_lowercase();
    let right = right.trim_end_matches('.').trim_start_matches("www.").to_ascii_lowercase();
    left == right
}

pub(super) fn same_site(root: &reqwest::Url, target: &reqwest::Url) -> bool {
    match (root.host_str(), target.host_str()) {
        (Some(left), Some(right)) => equivalent_site_host(left, right),
        _ => false,
    }
}

fn absolute_same_site_url(root: &reqwest::Url, current: &reqwest::Url, raw: &str) -> Option<reqwest::Url> {
    let raw = raw.trim();
    if raw.is_empty() || raw.starts_with('#') || raw.starts_with("mailto:") || raw.starts_with("tel:") || raw.starts_with("javascript:") {
        return None;
    }
    let mut target = current.join(raw).ok()?;
    if !matches!(target.scheme(), "http" | "https") || !same_site(root, &target) { return None; }
    target.set_fragment(None);
    validate_public_url_syntax(target.as_str()).ok()
}

fn visible_element_text(node: scraper::ElementRef<'_>) -> String {
    node.descendants().filter_map(|text| {
        let value = text.value().as_text()?;
        let hidden = text.ancestors().filter_map(scraper::ElementRef::wrap).any(|parent| {
            matches!(parent.value().name(), "script" | "style" | "noscript" | "template" | "svg" | "head")
                || parent.value().attr("hidden").is_some()
                || parent.value().attr("aria-hidden") == Some("true")
        });
        (!hidden).then_some(value.to_string())
    }).collect::<Vec<_>>().join(" ")
}

/// The extraction rules live in `pebble_websearch::content` so they are covered
/// by that crate's tests instead of needing a desktop runtime to run.
const MAX_PAGE_TEXT: usize = pebble_websearch::content::MAX_PAGE_TEXT;

pub(crate) fn html_page_content(html: &str, base: &reqwest::Url, root: &reqwest::Url) -> (String, String, Vec<String>) {
    let document = Html::parse_document(html);
    let title = Selector::parse("title").ok().and_then(|selector| document.select(&selector).next())
        .map(|node| compact_text(&node.text().collect::<Vec<_>>().join(" "), 240)).unwrap_or_default();
    let mut text = String::new();
    // Readability receives the whole visible body as fallback/supplement.
    // Taking <main> here first discarded the footer before address extraction.
    for selector_text in ["body", "main", "article"] {
        let Ok(selector) = Selector::parse(selector_text) else { continue };
        if let Some(node) = document.select(&selector).next() {
            text = compact_text(&visible_element_text(node), MAX_PAGE_TEXT);
            if !text.is_empty() { break; }
        }
    }
    let text = pebble_websearch::content::main_content_text(html, base.as_str(), &text);
    let mut links = Vec::new();
    if let Ok(selector) = Selector::parse("a[href]") {
        for node in document.select(&selector) {
            if let Some(url) = node.value().attr("href").and_then(|href| absolute_same_site_url(root, base, href)) {
                links.push(url.to_string());
            }
        }
    }
    links.sort();
    links.dedup();
    (title, text, links)
}

/// Discovery reads obey robots before reading content and keep all links as
/// untrusted candidates. Each subsequent target is independently SSRF-checked.
pub async fn research_robots_allowed(client:&reqwest::Client,url:&str)->Result<(),String>{
    static CACHE:OnceLock<tokio::sync::Mutex<HashMap<String,(Instant,Result<Vec<String>,String>)>>>=OnceLock::new();
    let parsed=validate_public_url_syntax(url)?;let robots_url=parsed.join("/robots.txt").map_err(|_|"robots地址无效".to_string())?;
    let cached={let mut cache=CACHE.get_or_init(Default::default).lock().await;
        cache.retain(|_,(at,result)|at.elapsed()<Duration::from_secs(if result.is_ok(){600}else{60}));
        cache.get(robots_url.as_str()).map(|(_,result)|result.clone())};
    let policy=if let Some(policy)=cached{policy}else{
        let robots=tokio::time::timeout(Duration::from_secs(7),safe_fetch(client,robots_url.as_str(),"research_robots",FetchPolicy{max_bytes:256*1024,timeout:Duration::from_secs(6),allow_pdf:false})).await;
        let policy=match robots{
            Ok(page) if matches!(page.evidence.http_status,Some(404)|Some(410))=>Ok(vec![]),
            Ok(page) if page.evidence.status==EvidenceStatus::Ok=>Ok(parse_robots(&page.text,&parsed).0),
            _=>Err("未取得robots访问政策，未绕过限制读取网页".into()),
        };
        let mut cache=CACHE.get_or_init(Default::default).lock().await;
        if cache.len()>=128{if let Some(key)=cache.keys().next().cloned(){cache.remove(&key);}}
        cache.insert(robots_url.to_string(),(Instant::now(),policy.clone()));policy
    };
    let rules=policy?;
    if robots_allows(&parsed,&rules){Ok(())}else{Err("robots禁止读取此页".into())}
}

pub(super) async fn read_discovery_page(client: &reqwest::Client, url: &str, session: Option<&super::search_router::SearchSession>) -> Option<(SiteCrawlPage, Vec<(String, String)>)> {
    let parsed = validate_public_url_syntax(url).ok()?;
    let robots_url = parsed.join("/robots.txt").ok()?;
    let robots = safe_fetch(client, robots_url.as_str(), "discovery_robots", FetchPolicy {
        max_bytes: 256 * 1024, timeout: Duration::from_secs(6), allow_pdf: false,
    }).await;
    // Do not silently ignore an unreachable or forbidden robots policy.
    let missing_robots = robots.evidence.http_status == Some(404) || robots.evidence.http_status == Some(410);
    if robots.evidence.status != EvidenceStatus::Ok && !missing_robots { return None; }
    let (disallowed, _) = parse_robots(&robots.text, &parsed);
    if !robots_allows(&parsed, &disallowed) { return None; }
    let mut page = safe_fetch(client, url, "lead_discovery", FetchPolicy {
        max_bytes: DEFAULT_HTML_LIMIT, timeout: Duration::from_secs(10), allow_pdf: false,
    }).await;
    let local_html=if let Some(session)=session {
        super::search_router::supplement_with_deepseek(session,client,url,&mut page,Duration::from_secs(4)).await
    }else{None};
    if page.evidence.status != EvidenceStatus::Ok { return None; }
    let base = validate_public_url_syntax(&page.final_url).ok()?;
    // Cross-host redirects are not accepted as proof for the original company.
    if !same_site(&parsed, &base) { return None; }
    let html=local_html.as_deref().unwrap_or(&page.text);
    let (local_title, local_text, _) = html_page_content(html, &base, &base);
    let document = Html::parse_document(html);
    let selector = Selector::parse("a[href]").ok()?;
    let links = document.select(&selector).filter_map(|a| {
        let mut url = base.join(a.value().attr("href")?).ok()?;
        url.set_fragment(None);
        let checked = validate_public_url_syntax(url.as_str()).ok()?;
        Some((checked.to_string(), compact_text(&visible_element_text(a), 120)))
    }).take(300).collect();
    let (title,text,raw_text)=match local_html {
        Some(html)=>(if page.evidence.title.is_empty(){local_title}else{page.evidence.title.clone()},page.text,html),
        None=>(local_title,local_text,page.text),
    };
    Some((SiteCrawlPage { url: page.final_url, title, text, evidence: page.evidence, is_pdf: false, raw_text }, links))
}

fn crawl_priority(url: &str) -> i32 {
    let lower = url.to_ascii_lowercase();
    let mut score = 0;
    for (keyword, weight) in [
        ("contact", 100), ("contact-us", 100), ("impressum", 95), ("dealer", 90),
        ("distributor", 90), ("stockist", 90), ("wholesale", 85), ("retailer", 80),
        ("about", 70), ("company", 65), ("team", 60), ("catalog", 55),
        ("download", 45), ("联系", 100), ("经销", 90), ("代理", 85), ("关于", 70),
    ] {
        if lower.contains(keyword) { score += weight; }
    }
    if lower.ends_with(".pdf") { score += 50; }
    score
}

fn parse_sitemap(xml: &str, root: &reqwest::Url, sitemap_url: &reqwest::Url) -> (Vec<String>, Vec<String>) {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut in_loc = false;
    let mut loc = String::new();
    let mut pages = Vec::new();
    let mut maps = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => in_loc = event.name().as_ref().eq_ignore_ascii_case(b"loc"),
            Ok(Event::Text(event)) if in_loc => loc.push_str(&decode_entities(&String::from_utf8_lossy(event.as_ref()))),
            Ok(Event::End(event)) if event.name().as_ref().eq_ignore_ascii_case(b"loc") => {
                in_loc = false;
                if let Some(url) = absolute_same_site_url(root, sitemap_url, &loc) {
                    if url.path().to_ascii_lowercase().ends_with(".xml") || url.path().to_ascii_lowercase().contains("sitemap") { maps.push(url.to_string()); }
                    else { pages.push(url.to_string()); }
                }
                loc.clear();
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    pages.sort(); pages.dedup(); maps.sort(); maps.dedup();
    (pages, maps)
}

fn parse_robots(text: &str, root: &reqwest::Url) -> (Vec<String>, Vec<String>) {
    let mut applies = false;
    let mut disallowed = Vec::new();
    let mut sitemaps = Vec::new();
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        let Some((key, value)) = line.split_once(':') else { continue };
        match key.trim().to_ascii_lowercase().as_str() {
            "user-agent" => applies = value.trim() == "*" || value.to_ascii_lowercase().contains("yaoaimail"),
            "disallow" if applies && !value.trim().is_empty() => disallowed.push(value.trim().to_string()),
            "sitemap" => {
                if let Ok(url) = reqwest::Url::parse(value.trim()) {
                    if same_site(root, &url) { sitemaps.push(url.to_string()); }
                }
            }
            _ => {}
        }
    }
    (disallowed, sitemaps)
}

fn robots_allows(url: &reqwest::Url, disallowed: &[String]) -> bool {
    !disallowed.iter().any(|path| path != "/" && url.path().starts_with(path))
        && !disallowed.iter().any(|path| path == "/")
}

async fn crawl_one(client: reqwest::Client, url: String) -> SiteCrawlPage {
    let allow_pdf = reqwest::Url::parse(&url).ok().is_some_and(|value| value.path().to_ascii_lowercase().ends_with(".pdf"));
    let page = safe_fetch(&client, &url, "same_site_crawl", FetchPolicy {
        max_bytes: if allow_pdf { DEFAULT_PDF_LIMIT } else { DEFAULT_HTML_LIMIT },
        timeout: Duration::from_secs(15), allow_pdf: true,
    }).await;
    let is_pdf = page.evidence.content_type.to_ascii_lowercase().starts_with("application/pdf") || page.bytes.starts_with(b"%PDF-");
    let raw_text = if !is_pdf && page.evidence.status == EvidenceStatus::Ok { page.text.clone() } else { String::new() };
    let (title, text) = if is_pdf && page.evidence.status == EvidenceStatus::Ok {
        let bytes = page.bytes.clone();
        let extracted = tokio::task::spawn_blocking(move || pdf_extract::extract_text_from_mem(&bytes).unwrap_or_default()).await.unwrap_or_default();
        (String::new(), compact_text(&extracted, 120_000))
    } else if page.evidence.status == EvidenceStatus::Ok {
        let base = reqwest::Url::parse(&page.final_url).ok();
        if let Some(base) = base { let (title, text, _) = html_page_content(&page.text, &base, &base); (title, text) } else { (String::new(), compact_text(&page.text, 120_000)) }
    } else { (String::new(), String::new()) };
    SiteCrawlPage { url: page.final_url, title, text, evidence: page.evidence, is_pdf, raw_text }
}

async fn collect_site_results(mut tasks:tokio::task::JoinSet<SiteCrawlPage>,deadline:tokio::time::Instant,root:&reqwest::Url)->Vec<SiteCrawlPage>{
    let mut pages=vec![];
    while !tasks.is_empty(){
        match tokio::time::timeout_at(deadline,tasks.join_next()).await{
            Ok(Some(Ok(page)))=>{if reqwest::Url::parse(&page.url).ok().is_some_and(|u|same_site(root,&u)){pages.push(page);}},
            Ok(Some(Err(_)))=>continue,_=>{tasks.abort_all();break;}
        }
    }
    pages
}

/// Bounded same-site research for official pages, sitemap entries and PDFs.
/// It never leaves the verified host and every fetch uses the SSRF guard.
pub async fn crawl_company_site(client: &reqwest::Client, website: &str, max_pages: usize) -> SiteCrawlResult {
    use tokio::time::{Instant,timeout_at};
    let deadline=Instant::now()+Duration::from_secs(35);
    let normalized=if website.starts_with("http://")||website.starts_with("https://"){website.to_string()}else{format!("https://{website}")};
    let empty=||SiteCrawlResult{root_url:normalized.clone(),pages:vec![],discovered_urls:0,robots_respected:false};
    let Ok(root)=validate_public_url_syntax(&normalized) else{return empty()};
    let origin=format!("{}://{}",root.scheme(),root.host_str().unwrap_or_default());
    let robots=safe_fetch(client,&format!("{origin}/robots.txt"),"robots",FetchPolicy{max_bytes:256*1024,timeout:Duration::from_secs(6),allow_pdf:false}).await;
    if robots.evidence.status!=EvidenceStatus::Ok && !matches!(robots.evidence.http_status,Some(404)|Some(410)){return empty();}
    let(disallowed,mut sitemaps)=parse_robots(&robots.text,&root);
    if !robots_allows(&root,&disallowed){return empty();}
    let mut pages=vec![];let mut queue=vec![];
    if let Ok(home)=timeout_at(deadline.min(Instant::now()+Duration::from_secs(10)),crawl_one(client.clone(),root.to_string())).await{
        if home.evidence.status==EvidenceStatus::Ok{
            if !same_site(&root,&reqwest::Url::parse(&home.url).unwrap_or_else(|_|root.clone())){return empty();}
            let base=reqwest::Url::parse(&home.url).unwrap_or_else(|_|root.clone());
            queue.extend(html_page_content(&home.raw_text,&base,&root).2);
        }
        pages.push(home);
    }
    for path in ["/contact","/contact-us","/about","/about-us","/team","/impressum","/wholesale","/catalog.pdf"]{
        if let Ok(url)=root.join(path){queue.push(url.to_string());}
    }
    if sitemaps.is_empty(){sitemaps.push(format!("{origin}/sitemap.xml"));}
    // Sitemap exploration must not consume the whole contact-discovery timeout.
    let map_deadline=deadline.min(Instant::now()+Duration::from_secs(5));
    for sitemap in sitemaps.into_iter().take(2){
        let fetched=timeout_at(map_deadline,safe_fetch(client,&sitemap,"sitemap",FetchPolicy{max_bytes:DEFAULT_HTML_LIMIT,timeout:Duration::from_secs(4),allow_pdf:false})).await;
        let Ok(page)=fetched else{break};
        if page.evidence.status!=EvidenceStatus::Ok{continue;}
        let base=reqwest::Url::parse(&page.final_url).unwrap_or_else(|_|root.clone());
        let(urls,children)=parse_sitemap(&page.text,&root,&base);queue.extend(urls);
        for child in children.into_iter().take(1){
            if let Ok(page)=timeout_at(map_deadline,safe_fetch(client,&child,"sitemap",FetchPolicy{max_bytes:DEFAULT_HTML_LIMIT,timeout:Duration::from_secs(3),allow_pdf:false})).await{
                if page.evidence.status==EvidenceStatus::Ok{
                    let base=reqwest::Url::parse(&page.final_url).unwrap_or_else(|_|root.clone());
                    queue.extend(parse_sitemap(&page.text,&root,&base).0);
                }
            }
        }
    }
    queue.sort_by_key(|u|std::cmp::Reverse(crawl_priority(u)));
    let mut seen=HashSet::from([normalized_result_url(root.as_str()).unwrap_or_else(||root.to_string())]);
    queue.retain(|u|seen.insert(normalized_result_url(u).unwrap_or_else(||u.clone())));
    let discovered_urls=queue.len();
    let selected=queue.into_iter().filter(|u|reqwest::Url::parse(u).ok().is_some_and(|u|same_site(&root,&u)&&robots_allows(&u,&disallowed)))
        .take(max_pages.clamp(1,20).saturating_sub(pages.len())).collect::<Vec<_>>();
    let semaphore=std::sync::Arc::new(tokio::sync::Semaphore::new(3));let mut tasks=tokio::task::JoinSet::new();
    for url in selected{
        let client=client.clone();let semaphore=semaphore.clone();
        tasks.spawn(async move{let _permit=semaphore.acquire_owned().await.ok();crawl_one(client,url).await});
    }
    pages.extend(collect_site_results(tasks,deadline,&root).await);
    pages.sort_by_key(|p|std::cmp::Reverse(crawl_priority(&p.url)));
    SiteCrawlResult{root_url:root.to_string(),pages,discovered_urls,robots_respected:true}
}

impl Default for FetchPolicy {
    fn default() -> Self {
        Self {
            max_bytes: DEFAULT_HTML_LIMIT,
            timeout: Duration::from_secs(20),
            allow_pdf: false,
        }
    }
}

pub fn build_research_client(proxy: Option<&HttpProxyConfig>) -> Result<reqwest::Client, PebbleError> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .pool_idle_timeout(Duration::from_secs(60))
        .user_agent("YaoAIMail/1.1 public-web-research");
    if let Some(proxy) = proxy {
        let uri = proxy.socks5h_uri().map_err(PebbleError::Network)?;
        builder = builder.proxy(
            reqwest::Proxy::all(&uri)
                .map_err(|error| PebbleError::Network(format!("Invalid proxy: {error}")))?,
        );
    }
    builder
        .build()
        .map_err(|error| PebbleError::Network(format!("Failed to build research client: {error}")))
}

fn normalize_ipv4_notation(host: &str) -> Option<Ipv4Addr> {
    let cleaned = host.trim_matches(['[', ']']);
    if cleaned.is_empty() {
        return None;
    }
    if cleaned.chars().all(|ch| ch.is_ascii_digit()) {
        let radix = if cleaned.len() > 1
            && cleaned.starts_with('0')
            && cleaned.chars().all(|ch| ('0'..='7').contains(&ch))
        {
            8
        } else {
            10
        };
        let value = u32::from_str_radix(cleaned, radix).ok()?;
        return Some(Ipv4Addr::from(value));
    }

    let parts = cleaned.split('.').collect::<Vec<_>>();
    if parts.is_empty() || parts.len() > 4 {
        return None;
    }
    let mut values = Vec::with_capacity(parts.len());
    for part in parts {
        if part.is_empty() {
            return None;
        }
        let (digits, radix) = if part.starts_with("0x") || part.starts_with("0X") {
            (&part[2..], 16)
        } else if part.len() > 1
            && part.starts_with('0')
            && part.chars().all(|ch| ('0'..='7').contains(&ch))
        {
            (part, 8)
        } else if part.chars().all(|ch| ch.is_ascii_digit()) {
            (part, 10)
        } else {
            return None;
        };
        values.push(u8::from_str_radix(digits, radix).ok()?);
    }
    let octets = match values.as_slice() {
        [a] => [0, 0, 0, *a],
        [a, b] => [*a, 0, 0, *b],
        [a, b, c] => [*a, *b, 0, *c],
        [a, b, c, d] => [*a, *b, *c, *d],
        _ => return None,
    };
    Some(Ipv4Addr::from(octets))
}

fn ipv4_is_public(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip == Ipv4Addr::BROADCAST
        || o[0] == 0
        || o[0] >= 240
        || (o[0] == 100 && (64..=127).contains(&o[1]))
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        || (o[0] == 192 && o[1] == 0 && o[2] == 2)
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
        || (o[0] == 198 && o[1] == 51 && o[2] == 100)
        || (o[0] == 203 && o[1] == 0 && o[2] == 113))
}

fn ipv6_is_public(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return ipv4_is_public(mapped);
    }
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

fn ip_is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ipv4_is_public(ip),
        IpAddr::V6(ip) => ipv6_is_public(ip),
    }
}

pub fn validate_public_url_syntax(raw: &str) -> Result<reqwest::Url, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("网址为空".to_string());
    }
    if raw.len() > MAX_URL_LENGTH {
        return Err("网址过长".to_string());
    }
    if raw.contains('\\') || raw.contains(['\r', '\n', '\0']) {
        return Err("网址包含不安全字符".to_string());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| "网址格式无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("只允许 http/https 网址".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("网址不能包含用户名或密码".to_string());
    }
    let host = url.host_str().ok_or_else(|| "网址缺少主机名".to_string())?;
    let lower = host.trim_end_matches('.').to_ascii_lowercase();
    const BLOCKED_HOSTS: &[&str] = &[
        "localhost",
        "localhost.localdomain",
        "metadata.google.internal",
        "metadata.azure.internal",
        "instance-data",
    ];
    const REBIND_SUFFIXES: &[&str] = &[".nip.io", ".sslip.io", ".xip.io", ".nip.name", ".1u.ms"];
    if BLOCKED_HOSTS.contains(&lower.as_str())
        || lower.ends_with(".localhost")
        || REBIND_SUFFIXES.iter().any(|suffix| lower.ends_with(suffix))
    {
        return Err("网址指向本机、云元数据或 DNS 重绑定服务".to_string());
    }
    if let Ok(ip) = lower.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>() {
        if !ip_is_public(ip) {
            return Err("网址指向内网或保留地址".to_string());
        }
    } else if let Some(ip) = normalize_ipv4_notation(&lower) {
        if !ipv4_is_public(ip) {
            return Err("网址使用了指向内网的非标准 IP 写法".to_string());
        }
    }
    Ok(url)
}

pub(crate) async fn validate_public_dns(url: &reqwest::Url) -> Result<Vec<SocketAddr>, String> {
    let host = url.host_str().ok_or_else(|| "网址缺少主机名".to_string())?;
    let port = url.port_or_known_default().unwrap_or(443);
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !ip_is_public(ip) {
            return Err("网址解析到内网或保留地址".to_string());
        }
        return Ok(vec![SocketAddr::new(ip, port)]);
    }
    let addresses = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| "DNS 查询超时".to_string())?
    .map_err(|_| "DNS 查询失败".to_string())?
    .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err("DNS 没有返回地址".to_string());
    }
    if addresses.iter().any(|address| !ip_is_public(address.ip())) {
        return Err("网址解析到内网、链路本地或保留地址".to_string());
    }
    Ok(addresses)
}

fn supported_content_type(content_type: &str, allow_pdf: bool) -> bool {
    let kind = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    kind.is_empty()
        || kind.starts_with("text/")
        || matches!(kind.as_str(), "application/xhtml+xml" | "application/xml" | "application/rss+xml" | "application/atom+xml" | "application/json")
        || (allow_pdf && kind == "application/pdf")
}

pub async fn safe_fetch(
    client: &reqwest::Client,
    raw_url: &str,
    provider: &str,
    policy: FetchPolicy,
) -> PageDocument {
    let started = Instant::now();
    let mut evidence = SourceEvidence::pending(provider, raw_url);
    let mut current = match validate_public_url_syntax(raw_url) {
        Ok(url) => url,
        Err(error) => {
            evidence.status = EvidenceStatus::Invalid;
            evidence.error = error;
            return PageDocument { evidence, bytes: Vec::new(), text: String::new(), final_url: raw_url.to_string() };
        }
    };
    let mut seen = HashSet::new();

    for redirect_count in 0..=MAX_REDIRECTS {
        evidence.url = current.as_str().to_string();
        if !seen.insert(evidence.url.clone()) {
            evidence.status = EvidenceStatus::Invalid;
            evidence.error = "检测到重定向循环".to_string();
            break;
        }
        if let Err(error) = validate_public_dns(&current).await {
            evidence.status = EvidenceStatus::Blocked;
            evidence.error = error;
            break;
        }

        let response = match client
            .get(current.clone())
            .timeout(policy.timeout)
            .header(reqwest::header::ACCEPT, if policy.allow_pdf { "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.8,*/*;q=0.2" } else { "text/html,application/xhtml+xml,text/plain,application/xml;q=0.8,*/*;q=0.1" })
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                evidence.status = if error.is_timeout() { EvidenceStatus::Timeout } else { EvidenceStatus::NetworkError };
                evidence.error = if error.is_timeout() { "网页请求超时".to_string() } else { format!("网页请求失败：{error}") };
                break;
            }
        };

        let status = response.status();
        evidence.http_status = Some(status.as_u16());
        if status.is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                evidence.status = EvidenceStatus::Invalid;
                evidence.error = "重定向次数过多".to_string();
                break;
            }
            let Some(location) = response.headers().get(reqwest::header::LOCATION) else {
                evidence.status = EvidenceStatus::HttpError;
                evidence.error = "重定向响应缺少 Location".to_string();
                break;
            };
            let Ok(location) = location.to_str() else {
                evidence.status = EvidenceStatus::Invalid;
                evidence.error = "重定向地址无效".to_string();
                break;
            };
            let next = match current.join(location).or_else(|_| reqwest::Url::parse(location)) {
                Ok(next) => next,
                Err(_) => {
                    evidence.status = EvidenceStatus::Invalid;
                    evidence.error = "重定向地址无法解析".to_string();
                    break;
                }
            };
            current = match validate_public_url_syntax(next.as_str()) {
                Ok(url) => url,
                Err(error) => {
                    evidence.status = EvidenceStatus::Blocked;
                    evidence.error = format!("已阻止不安全重定向：{error}");
                    break;
                }
            };
            continue;
        }
        if !status.is_success() {
            evidence.status = EvidenceStatus::HttpError;
            evidence.error = format!("网页返回 HTTP {}", status.as_u16());
            break;
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        evidence.content_type = content_type.clone();
        if !supported_content_type(&content_type, policy.allow_pdf) {
            evidence.status = EvidenceStatus::Unsupported;
            evidence.error = format!("不支持的网页内容类型：{content_type}");
            break;
        }
        if response.content_length().is_some_and(|length| length > policy.max_bytes as u64) {
            evidence.status = EvidenceStatus::TooLarge;
            evidence.error = format!("网页超过下载上限 {} KB", policy.max_bytes / 1024);
            break;
        }

        let mut response = response;
        let mut bytes = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if bytes.len().saturating_add(chunk.len()) > policy.max_bytes {
                        evidence.status = EvidenceStatus::TooLarge;
                        evidence.error = format!("网页超过下载上限 {} KB", policy.max_bytes / 1024);
                        evidence.latency_ms = started.elapsed().as_millis() as u64;
                        return PageDocument { evidence, bytes: Vec::new(), text: String::new(), final_url: current.to_string() };
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(error) => {
                    evidence.status = EvidenceStatus::NetworkError;
                    evidence.error = format!("读取网页正文失败：{error}");
                    evidence.latency_ms = started.elapsed().as_millis() as u64;
                    return PageDocument { evidence, bytes: Vec::new(), text: String::new(), final_url: current.to_string() };
                }
            }
        }
        let is_pdf = content_type.to_ascii_lowercase().starts_with("application/pdf")
            || bytes.starts_with(b"%PDF-");
        let text = if is_pdf { String::new() } else { String::from_utf8_lossy(&bytes).into_owned() };
        evidence.status = if bytes.is_empty() { EvidenceStatus::Empty } else { EvidenceStatus::Ok };
        evidence.latency_ms = started.elapsed().as_millis() as u64;
        evidence.url = current.to_string();
        return PageDocument { evidence, bytes, text, final_url: current.to_string() };
    }

    evidence.latency_ms = started.elapsed().as_millis() as u64;
    PageDocument { evidence, bytes: Vec::new(), text: String::new(), final_url: current.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_local_and_nonstandard_private_addresses() {
        for url in [
            "http://localhost/admin",
            "http://127.0.0.1/",
            "http://2130706433/",
            "http://0177.0.0.1/",
            "http://0x7f.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://10.2.3.4/",
            "http://router.127.0.0.1.nip.io/",
            "file:///etc/passwd",
            "http://user:pass@example.com/",
        ] {
            assert!(validate_public_url_syntax(url).is_err(), "accepted unsafe URL: {url}");
        }
    }

    #[test]
    fn accepts_normal_public_http_urls() {
        for url in ["https://example.com/contact", "http://93.184.216.34/"] {
            assert!(validate_public_url_syntax(url).is_ok(), "rejected public URL: {url}");
        }
    }

    #[test]
    fn blocks_private_ipv4_mapped_ipv6() {
        assert!(!ipv6_is_public("::ffff:127.0.0.1".parse().unwrap()));
        assert!(ipv6_is_public("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn content_type_policy_is_explicit() {
        assert!(supported_content_type("text/html; charset=utf-8", false));
        assert!(!supported_content_type("application/pdf", false));
        assert!(supported_content_type("application/pdf", true));
        assert!(!supported_content_type("application/octet-stream", true));
    }

    #[test]
    fn parses_bing_rss_fixture_without_string_slicing() {
        let xml = r#"<?xml version="1.0"?><rss><channel><item><title>Example &amp; Co</title><link>https://example.com/about</link><description><![CDATA[Wholesale distributor]]></description></item></channel></rss>"#;
        let hits = parse_bing_rss(xml);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Example & Co");
        assert_eq!(hits[0].url, "https://example.com/about");
    }
    #[tokio::test]
    async fn a_slow_source_does_not_discard_completed_public_results() {
        let mut tasks=tokio::task::JoinSet::new();
        tasks.spawn(async {vec![SearchHit {provider:"fast".into(),title:"Gift wholesaler".into(),url:"https://example.org".into(),snippet:String::new(),rank:1}]});
        tasks.spawn(async {std::future::pending::<Vec<SearchHit>>().await});
        let result=collect_public_results(tasks,Duration::from_millis(40)).await;
        assert_eq!(result.len(),1); assert_eq!(result[0].provider,"fast");
    }

    #[test]
    fn scripts_styles_and_hidden_markup_are_not_product_proof() {
        let root = reqwest::Url::parse("https://example.org/").unwrap();
        let html = r#"<body><script>industrial pump distributor</script><style>.pump {}</style><div hidden>industrial pump</div><div aria-hidden="true">importer</div><main>We sell dental chairs.</main></body>"#;
        let (_, text, _) = html_page_content(html, &root, &root);
        assert!(text.contains("dental chairs")); assert!(!text.contains("pump")); assert!(!text.contains("importer"));
    }

    #[test]
    fn parses_public_brave_cards_without_ai_answer_or_scripts() {
        let html = r#"<div id="llm-snippet"><a href="https://wrong.org">AI answer</a></div><div class="snippet" data-type="web"><div class="result-content"><a href="https://example.org/Products"><div class="search-snippet-title">Example Pumps</div></a><div class="generic-snippet">Industrial pumps importer</div></div></div><script>web={url:'https://fake.org'}</script>"#;
        let hits = parse_brave_web(html); assert_eq!(hits.len(),1);
        assert_eq!(hits[0].title,"Example Pumps"); assert_eq!(hits[0].url,"https://example.org/Products");
        assert!(hits[0].snippet.contains("importer")); assert_eq!(provider_family("brave_web"),"brave");
    }

    #[test]
    fn unwraps_yahoo_tracking_but_rejects_private_destinations() {
        assert_eq!(unwrap_yahoo_url("https://r.search.yahoo.com/_ylt=x/RU=https%3A%2F%2Fexample.org%2FA%2BB/RK=2/RS=x"), "https://example.org/A+B");
        let bad = unwrap_yahoo_url("https://r.search.yahoo.com/_ylt=x/RU=http%3A%2F%2F127.0.0.1%2F/RK=2/RS=x");
        assert!(bad.is_empty()); assert_eq!(provider_family("yahoo_web"),"bing");
    }

    #[test]
    fn parses_html_search_fixture_and_unwraps_ddg_redirect() {
        let html = r#"<div class="result"><h2><a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fcompany">Example Co</a></h2><div class="result__snippet">Importer and distributor</div></div>"#;
        let hits = parse_html_results(html, "duckduckgo_html", &["div.result"], &["a.result__a"], &[".result__snippet"]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://example.com/company");
    }

    #[test]
    fn sitemap_and_same_site_rules_are_bounded() {
        let root = reqwest::Url::parse("https://www.example.com/").unwrap();
        let map = reqwest::Url::parse("https://example.com/sitemap.xml").unwrap();
        let xml = "<urlset><url><loc>https://example.com/contact</loc></url><url><loc>https://evil.test/contact</loc></url></urlset>";
        let (pages, child_maps) = parse_sitemap(xml, &root, &map);
        assert_eq!(pages, vec!["https://example.com/contact".to_string()]);
        assert!(child_maps.is_empty());
        assert!(crawl_priority("https://example.com/contact") > crawl_priority("https://example.com/blog"));
    }

    #[test]
    fn robots_disallow_is_honored() {
        let root = reqwest::Url::parse("https://example.com/").unwrap();
        let (blocked, maps) = parse_robots("User-agent: *\nDisallow: /private\nSitemap: https://example.com/site.xml", &root);
        assert!(!robots_allows(&reqwest::Url::parse("https://example.com/private/a").unwrap(), &blocked));
        assert!(robots_allows(&reqwest::Url::parse("https://example.com/contact").unwrap(), &blocked));
        assert_eq!(maps.len(), 1);
    }

    #[test]
    fn crawl_page_keeps_non_visible_contact_attributes() {
        let root = reqwest::Url::parse("https://example.com/contact").unwrap();
        let html = r#"<html><body><a href="mailto:sales%40example.com">Contact sales</a></body></html>"#;
        let (_, visible, _) = html_page_content(html, &root, &root);
        assert!(!visible.contains("sales@example.com"));
        assert!(html.contains("sales%40example.com"));
    }

    #[tokio::test]
    async fn a_slow_contact_page_does_not_erase_completed_first_party_evidence() {
        let root=reqwest::Url::parse("https://example.org/").unwrap();
        let page=|url:&str| SiteCrawlPage{url:url.into(),title:"Example Company".into(),text:"Contact our company".into(),
            evidence:SourceEvidence::pending("fixture",url),is_pdf:false,raw_text:"<a href='mailto:sales@example.org'>Email</a>".into()};
        let mut tasks=tokio::task::JoinSet::new();
        let fast=page("https://example.org/contact");tasks.spawn(async move{fast});
        let unrelated=page("https://other.example/contact");tasks.spawn(async move{unrelated});
        tasks.spawn(async{std::future::pending::<SiteCrawlPage>().await});
        let result=collect_site_results(tasks,tokio::time::Instant::now()+Duration::from_millis(40),&root).await;
        assert_eq!(result.len(),1);assert!(result[0].raw_text.contains("sales@example.org"));
    }

    /// Real-world regression fixture supplied by the user. Run explicitly
    /// when network access is available; it verifies both reachability and
    /// that the contact page remains part of the crawl result.
    #[tokio::test]
    #[ignore]
    async fn crawls_ambiance_home_contact_page() {
        let client = build_research_client(None).unwrap();
        let site = crawl_company_site(&client, "https://www.ambiancehome.com/contact/", 6).await;
        assert!(site.pages.iter().any(|page| {
            page.evidence.status == EvidenceStatus::Ok
                && (page.text.contains("info@ocambiance.com") || page.raw_text.contains("info@ocambiance.com"))
        }), "crawl did not retain the public contact email: {site:#?}");
    }
}
