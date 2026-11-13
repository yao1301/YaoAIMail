use crate::commands::external_services::get_external_service_api_keys;
use crate::commands::network::get_global_proxy_raw;
use crate::state::AppState;
use pebble_core::{new_id, now_timestamp, PebbleError};
use pebble_translate::TranslateService;
use pebble_websearch::company_profile::{self, Dossier, RegistryCheck};
use pebble_websearch::leads::Page;
use pebble_websearch::Hit;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tauri::State;
use tokio::time::timeout_at;

const COMPANY_RESEARCH_KEY: &str = "company_research_reports_v1";
const LEAD_FINDER_DATA_KEY: &str = "lead_finder_data_v2";
const LEAD_DEV_RECORDS_KEY: &str = "lead_dev_records_v2";
static REPORTS_WRITE_LOCK:std::sync::Mutex<()>=std::sync::Mutex::new(());

#[tauri::command]
pub async fn load_lead_finder_data(
    state: State<'_, AppState>,
) -> Result<Option<Value>, PebbleError> {
    let Some(encrypted) = state.store.get_secure_user_data(LEAD_FINDER_DATA_KEY)? else {
        return Ok(None);
    };
    let plaintext = state.crypto.decrypt(&encrypted)?;
    let mut data:Value=serde_json::from_slice(&plaintext)
        .map_err(|error| PebbleError::Internal(format!("Invalid lead finder data: {error}")))?;
    super::lead_discovery::recover_deliveries(&state,&mut data)?;
    Ok(Some(data))
}

#[tauri::command]
pub async fn save_lead_finder_data(
    state: State<'_, AppState>,
    mut data: Value,
) -> Result<(), PebbleError> {
    super::lead_discovery::recover_deliveries(&state,&mut data)?;
    let plaintext = serde_json::to_vec(&data)
        .map_err(|error| PebbleError::Internal(format!("Failed to serialize lead finder data: {error}")))?;
    let encrypted = state.crypto.encrypt(&plaintext)?;
    state.store.set_secure_user_data(LEAD_FINDER_DATA_KEY, &encrypted)
}

#[tauri::command]
pub async fn load_lead_dev_records(
    state: State<'_, AppState>,
) -> Result<Option<Value>, PebbleError> {
    let Some(encrypted) = state.store.get_secure_user_data(LEAD_DEV_RECORDS_KEY)? else {
        return Ok(None);
    };
    let plaintext = state.crypto.decrypt(&encrypted)?;
    serde_json::from_slice(&plaintext)
        .map(Some)
        .map_err(|error| PebbleError::Internal(format!("Invalid lead development records: {error}")))
}

#[tauri::command]
pub async fn save_lead_dev_records(
    state: State<'_, AppState>,
    records: Value,
) -> Result<(), PebbleError> {
    let plaintext = serde_json::to_vec(&records)
        .map_err(|error| PebbleError::Internal(format!("Failed to serialize lead development records: {error}")))?;
    let encrypted = state.crypto.encrypt(&plaintext)?;
    state.store.set_secure_user_data(LEAD_DEV_RECORDS_KEY, &encrypted)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSource {
    pub title: String,
    pub url: String,
    pub status: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PublicCompanyMatch {
    #[serde(alias = "companyName")]
    pub legal_name: String,
    pub country: String,
    pub city: String,
    pub address: String,
    pub registration_status: String,
    pub lei: String,
    pub source_url: String,
    #[serde(default)]
    pub website: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub source_name: String,
    #[serde(default)]
    pub public_emails: Vec<String>,
    #[serde(default)]
    pub recommendation_reason: String,
    #[serde(default)]
    pub discovery_basis: Vec<String>,
    #[serde(default)]
    pub company_introduction: String,
    #[serde(default)]
    pub email_evidence: Vec<EmailEvidence>,
    #[serde(default)]
    pub contact_status: String,
    #[serde(default)]
    pub website_status: String,
    #[serde(default)]
    pub website_status_reason: String,
    #[serde(default)]
    pub contacts: Vec<pebble_websearch::contact_research::ContactPerson>,
    #[serde(default)]
    pub buying_signals: Vec<pebble_websearch::contact_research::BuyingSignal>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyResearchReport {
    pub id: String,
    pub company_name: String,
    pub website: String,
    pub country: String,
    pub website_title: String,
    pub website_description: String,
    pub public_emails: Vec<String>,
    pub legal_matches: Vec<PublicCompanyMatch>,
    pub sources: Vec<ResearchSource>,
    pub warnings: Vec<String>,
    #[serde(default)]
    pub analysis: String,
    pub created_at: i64,
    /// 结构化档案：只有能落回原文的结论才在这里。旧报告没有这些字段，读出来是默认值。
    #[serde(default)]
    pub dossier: pebble_websearch::company_profile::Dossier,
    /// 官方登记核验（VIES / SEC EDGAR / GLEIF），status 区分"查到""没查到""没查"
    #[serde(default)]
    pub registries: Vec<pebble_websearch::company_profile::RegistryCheck>,
    /// 该国相关的官方登记处直达检索入口（只在有对应国家时出现）
    #[serde(default)]
    pub registry_links: Vec<ResearchSource>,
    /// 实际读进证据窗口的页面数，用于界面说明"判断根据多少页原文"
    #[serde(default)]
    pub pages_read: usize,
    /// 报告结构版本；2 起为结构化报告，0/1 是旧的自由长文
    #[serde(default)]
    pub structure_version: u32,
    #[serde(default)]
    pub investigation: pebble_websearch::investigation::Investigation,
    #[serde(default)]
    pub contacts: Vec<pebble_websearch::contact_research::ContactPerson>,
    #[serde(default)]
    pub buying_signals: Vec<pebble_websearch::contact_research::BuyingSignal>,
    #[serde(default)]
    pub email_evidence: Vec<EmailEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct WebSearchItem {
    pub title: String,
    pub url: String,
    pub description: String,
}

fn load_reports(state: &AppState) -> Result<Vec<CompanyResearchReport>, PebbleError> {
    let Some(encrypted) = state.store.get_secure_user_data(COMPANY_RESEARCH_KEY)? else {
        return Ok(Vec::new());
    };
    let plaintext = state.crypto.decrypt(&encrypted)?;
    serde_json::from_slice(&plaintext).map_err(|_|PebbleError::Validation("调查历史读取失败，原记录未删除或覆盖".into()))
}

fn save_reports(state: &AppState, reports: &[CompanyResearchReport]) -> Result<(), PebbleError> {
    let plaintext = serde_json::to_vec(reports)
        .map_err(|error| PebbleError::Internal(format!("Failed to serialize company reports: {error}")))?;
    let encrypted = state.crypto.encrypt(&plaintext)?;
    state.store.set_secure_user_data(COMPANY_RESEARCH_KEY, &encrypted)
}


pub(crate) fn meta_description(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    for marker in ["name=\"description\"", "name='description'"] {
        if let Some(pos) = lower.find(marker) {
            // `pos` is a byte offset. The surrounding window may contain
            // multibyte text, so arbitrary subtraction/addition can land in
            // the middle of a UTF-8 character and panic the release build.
            let left = html.floor_char_boundary(pos.saturating_sub(180));
            let right = html.floor_char_boundary(pos.saturating_add(600).min(html.len()));
            let snippet = &html[left..right];
            let snippet_lower = snippet.to_ascii_lowercase();
            if let Some(content_pos) = snippet_lower.find("content=") {
                let value = &snippet[content_pos + 8..];
                let quote = value.chars().next().unwrap_or('"');
                if quote == '"' || quote == '\'' {
                    if let Some(end) = value[1..].find(quote) {
                        return value[1..end + 1].trim().to_string();
                    }
                }
            }
        }
    }
    String::new()
}

pub(crate) fn public_emails(html: &str) -> Vec<String> {
    // Cloudflare Email Protection keeps the address in a XOR-encoded
    // data-cfemail attribute. It is common on otherwise perfectly usable
    // company contact pages, so decode it before the ordinary parser runs.
    let mut cloudflare_emails = String::new();
    let lower = html.to_ascii_lowercase();
    let mut rest = lower.as_str();
    while let Some(start) = rest.find("data-cfemail=") {
        rest = &rest[start + "data-cfemail=".len()..];
        let quote = rest.chars().next().unwrap_or(' ');
        if quote != '\'' && quote != '"' {
            rest = rest.get(1..).unwrap_or_default();
            continue;
        }
        let value = &rest[1..];
        let Some(end) = value.find(quote) else { break; };
        let encoded = &value[..end];
        if encoded.len() >= 4 && encoded.len() % 2 == 0 {
            let bytes = (0..encoded.len())
                .step_by(2)
                .map(|index| u8::from_str_radix(&encoded[index..index + 2], 16))
                .collect::<Result<Vec<_>, _>>();
            if let Ok(bytes) = bytes {
                if let Some((&key, payload)) = bytes.split_first() {
                    let decoded = payload.iter().map(|byte| (byte ^ key) as char).collect::<String>();
                    cloudflare_emails.push(' ');
                    cloudflare_emails.push_str(&decoded);
                }
            }
        }
        rest = &value[end + 1..];
    }
    let normalized = format!("{html} {cloudflare_emails}")
        .replace("\\u0040", "@")
        .replace("\\u002e", ".")
        .replace("%2540", "@")
        .replace("%40", "@")
        .replace("%2E", ".")
        .replace("%2e", ".")
        .replace("&#64;", "@")
        .replace("&#x40;", "@")
        .replace("&commat;", "@")
        .replace("[at]", "@")
        .replace("(at)", "@")
        .replace(" [at] ", "@")
        .replace("[dot]", ".")
        .replace("(dot)", ".")
        // 链接形如 href="mailto:info@..."，剥掉 mailto: 前缀，避免前缀混进邮箱地址
        .replace("mailto:", "");
    let mut found = Vec::new();
    for token in normalized.split(|ch: char| ch.is_whitespace() || "<>\"'(),;".contains(ch)) {
        let clean = token
            .trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && !".@_+-".contains(ch))
            .to_lowercase();
        if clean.len() <= 120
            && clean.contains('@')
            && clean.split('@').count() == 2
            && clean.rsplit('.').next().is_some_and(|part| (2..=15).contains(&part.len()))
            && is_usable_discovered_email(&clean)
            && !found.contains(&clean)
        {
            found.push(clean);
            if found.len() == 12 {
                break;
            }
        }
    }
    found
}

/// 只把真实可投递形态的地址当作线索。搜索摘要常出现
/// first@domain、first.last@domain、***@domain 等示例/脱敏文本，
/// 它们不能进入开发信收件人列表。
pub(crate) fn is_usable_discovered_email(email: &str) -> bool {
    if email.contains('*') || email.contains('…') || email.contains(' ') {
        return false;
    }
    let Some((local, domain)) = email.split_once('@') else { return false; };
    if local.is_empty() || domain.is_empty() || !domain.contains('.') || domain.starts_with('.') || domain.ends_with('.') {
        return false;
    }
    let local = local.to_ascii_lowercase();
    const PLACEHOLDERS: &[&str] = &[
        "first", "last", "firstname", "lastname", "first.last", "firstlast",
        "first_last", "first-last", "f.last", "flast", "name", "yourname",
        "email", "user", "username", "example", "test",
    ];
    !PLACEHOLDERS.contains(&local.as_str())
        && !domain.contains("example.com")
        && local.chars().all(|ch| ch.is_ascii_alphanumeric() || ".!#$%&'*+/=?^_`{|}~-".contains(ch))
}

pub(crate) fn research_page_urls(html: &str, website: &str) -> Vec<String> {
    let base = reqwest::Url::parse(website).ok();
    let keywords = ["about", "product", "brand", "team", "supplier", "contact", "news", "company"];
    let mut urls = Vec::new();
    for marker in ["href=\"", "href='"] {
        let mut rest = html;
        while let Some(start) = rest.find(marker) {
            rest = &rest[start + marker.len()..];
            let end = rest.find(if marker.ends_with('"') { '"' } else { '\'' }).unwrap_or(rest.len());
            let raw = rest[..end].trim();
            rest = rest.get(end..).unwrap_or_default();
            if raw.is_empty() || raw.starts_with('#') || raw.starts_with("mailto:") || raw.starts_with("javascript:") { continue; }
            let Some(base_url) = base.as_ref() else { continue; };
            let Ok(url) = base_url.join(raw) else { continue; };
            if url.domain() != base_url.domain() || url.query().is_some() || url.fragment().is_some() { continue; }
            let lower = url.path().to_ascii_lowercase();
            if keywords.iter().any(|keyword| lower.contains(keyword)) && !urls.iter().any(|known| known == url.as_str()) {
                urls.push(url.to_string());
            }
        }
    }
    urls.sort_by_key(|url|(company_profile::research_page_priority(url),url.clone()));
    urls.truncate(16);
    urls
}


fn value_string(value: &Value, pointer: &str) -> String {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn parse_gleif(value: Value) -> Vec<PublicCompanyMatch> {
    value["data"].as_array().into_iter().flatten().take(10).map(|item| {
        let attrs = &item["attributes"];
        let entity = &attrs["entity"];
        let address = &entity["legalAddress"];
        PublicCompanyMatch {
            legal_name: value_string(entity, "/legalName/name"),
            country: value_string(address, "/country"),
            city: value_string(address, "/city"),
            address: address["addressLines"].as_array()
                .into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join(", "),
            registration_status: value_string(entity, "/status"),
            lei: value_string(attrs, "/lei"),
            source_url: item["links"]["self"].as_str().unwrap_or_default().to_string(),
            website: String::new(),
            description: String::new(),
            source_name: "GLEIF".to_string(),
            public_emails: Vec::new(),
            recommendation_reason: "通过 GLEIF 全球法人数据库找到相近法人主体；是否为目标客户仍需结合官网和业务证据核实。".to_string(),
            discovery_basis: vec!["GLEIF 全球法人识别编码数据库".to_string()],
            company_introduction: String::new(), email_evidence: Vec::new(),
            contact_status: "待补全".to_string(),
            website_status: "待核验".to_string(),
            website_status_reason: "GLEIF 只核验法人主体，尚未核验官网".to_string(),
            contacts: vec![], buying_signals: vec![],
        }
    }).collect()
}

pub(crate) async fn gleif_matches(
    client: &reqwest::Client,
    company_name: &str,
) -> Result<Vec<PublicCompanyMatch>, reqwest::Error> {
    let response = client
        .get("https://api.gleif.org/api/v1/lei-records")
        .query(&[
            ("filter[entity.legalName]", company_name),
            ("page[size]", "10"),
        ])
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    Ok(parse_gleif(response))
}


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailEvidence {
    pub email: String,
    pub source: String,
    pub source_url: String,
    pub confidence: Option<u64>,
    pub verification: String,
    /// 邮箱类型说明：通用联系邮箱（info/sales/contact 等）/
    /// 个人邮箱（含人名特征）/ 公共邮箱（gmail/yahoo 等）/ 其他
    pub email_type: String,
    /// 该邮箱对应的人与职位（如 "John Smith · Sales Manager"）。
    /// 帮助用户判断联系的是谁，写开发信时可用作个性化称呼。
    #[serde(default)]
    pub person: String,
    /// 是否适合作为外贸开发对象。人力资源、招聘、媒体等地址会明确标为不建议。
    pub suitability: String,
    #[serde(flatten, default)]
    pub research: pebble_websearch::contact_research::EmailResearch,
}


fn email_suitability(email: &str, person: &str) -> String {
    let local = email.split('@').next().unwrap_or("").to_ascii_lowercase();
    let role = person.to_ascii_lowercase();
    if ["hr", "career", "careers", "jobs", "recruit", "recruiting", "press", "media", "privacy", "legal", "abuse"]
        .iter().any(|value| local == *value || local.starts_with(&format!("{value}.")) || role.contains(value))
    {
        return "不建议开发：人事/招聘/媒体/法务等非采购岗位".into();
    }
    if ["purchasing", "procurement", "sourcing", "buyer", "owner", "founder", "director", "sales", "import"]
        .iter().any(|value| local.contains(value) || role.contains(value))
    {
        return "优先联系：采购/管理/业务相关".into();
    }
    "角色未确认：发送前请核对联系人职责".into()
}

/// 根据邮箱地址判断类型：role-based 通用邮箱 / 个人邮箱 / 公共邮箱域名。
/// 返回中文说明，供前端直接展示。
fn email_type_label(email: &str) -> String {
    let local = email.split('@').next().unwrap_or("").to_ascii_lowercase();
    let domain = email.rsplit('@').next().unwrap_or("").to_ascii_lowercase();
    // 公共邮箱域名：个人常用，不代表公司
    const PUBLIC_DOMAINS: &[&str] = &[
        "gmail.com", "yahoo.com", "yahoo.co.uk", "yahoo.com.cn", "hotmail.com",
        "outlook.com", "live.com", "icloud.com", "aol.com", "protonmail.com",
        "proton.me", "qq.com", "163.com", "126.com", "sina.com", "foxmail.com",
        "zoho.com", "gmx.com", "yandex.com", "hey.com", "me.com",
    ];
    if PUBLIC_DOMAINS.iter().any(|d| *d == domain) {
        return "公共邮箱（个人常用）".into();
    }
    // role-based 前缀
    const ROLE_PREFIXES: &[&str] = &[
        "info", "sales", "contact", "support", "service", "admin", "office",
        "hello", "hr", "marketing", "media", "press", "pr", "enquiry",
        "enquiries", "inquiry", "inquiries", "orders", "order", "booking",
        "reservations", "reception", "receptionist", "mail", "email", "cs",
        "customerservice", "accounting", "accounts", "billing", "finance",
        "purchasing", "purchase", "procurement", "export", "import", "sourcing",
        "technical", "tech", "webmaster", "recruiting", "careers", "job",
        "recruitment", "general", "feedback", "complaints", "dispatch",
        "logistics", "shipping", "delivery", "warehouse", "qa", "quality",
        "rd", "design", "it", "ithelp", "payments", "payment",
    ];
    let local_clean = local.trim_matches(|ch: char| !ch.is_ascii_alphanumeric());
    if ROLE_PREFIXES.iter().any(|p| *p == local_clean) {
        return "通用联系邮箱".into();
    }
    // 含 . 或 _ 分隔的姓名式地址（如 john.smith / j_smith / johnsmith）
    if local.contains('.') || local.contains('_') || local.contains('-') {
        return "个人邮箱".into();
    }
    if local.len() >= 5 {
        return "个人邮箱".into();
    }
    "其他".into()
}


fn website_domain(website: &str) -> String {
    let normalized = normalize_website(website);
    reqwest::Url::parse(&normalized)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_default()
        .trim_start_matches("www.")
        .to_ascii_lowercase()
}

struct CompanyContactDiscovery {
    emails: Vec<EmailEvidence>,
    page_summaries: Vec<String>,
    website_status: String,
    website_status_reason: String,
    review: pebble_websearch::contact_research::ContactReview,
}

async fn search_domain_email_sources(
    state: &AppState,
    client: &reqwest::Client,
    company_name: &str,
    domain: &str,
    _tavily_keys: &[String],
    _brave_keys: &[String],
) -> Vec<(String, WebSearchItem)> {
    let company = company_name.replace(['"', '\'', '\r', '\n'], " ");
    // This is the same proven domain-harvesting pattern used by mature OSINT
    // tools: one query searches the company's own indexed pages, the other
    // finds occurrences on PDFs, exhibitions, directories, press pages, etc.
    let own_query = format!("site:{domain} (email OR contact OR \"@{domain}\")");
    // The second query deliberately does not require the website domain:
    // brands often publish mailboxes on a parent/legacy domain.
    let broad_query = format!("\"{}\" (email OR contact OR sales OR purchasing OR \"@{domain}\")", company.trim());
    let people_query=format!("site:{domain} (team OR leadership OR purchasing OR procurement)");
    let (own,broad,people)=tokio::join!(super::search_router::search(state,client,&own_query),super::search_router::search(state,client,&broad_query),super::search_router::search(state,client,&people_query));

    let mut collected = Vec::new();
    for item in own.items.into_iter().chain(people.items).chain(broad.items) {
        collected.push((item.provider.clone(),WebSearchItem{title:item.title,url:item.url,description:item.description}));
    }
    let mut seen = HashSet::new();
    collected.retain(|(_, item)| seen.insert(item.url.clone()));
    collected.truncate(40);
    collected
}

fn consolidate_email_evidence(mut evidence: Vec<EmailEvidence>) -> Vec<EmailEvidence> {
    let mut grouped: HashMap<String, Vec<EmailEvidence>> = HashMap::new();
    for item in evidence.drain(..) {
        grouped.entry(item.email.to_ascii_lowercase()).or_default().push(item);
    }
    let mut merged = grouped.into_iter().map(|(email, mut items)| {
        items.sort_by_key(|item| {
            let official = item.source.contains("官网") as u8;
            let verified = matches!(item.research.delivery_status,pebble_websearch::contact_research::DeliveryStatus::Valid) as u8;
            std::cmp::Reverse((official, verified))
        });
        let count = items.iter().map(|item| item.source_url.as_str()).collect::<HashSet<_>>().len();
        let mut best = items.remove(0);
        let mut sources = vec![best.source.clone()];
        for item in items {
            if !sources.contains(&item.source) && sources.len() < 3 { sources.push(item.source); }
            // A provider's person label must not be attached to a different
            // publication and then presented as same-page identity evidence.
            if best.person.is_empty() && !item.person.is_empty() && best.source_url==item.source_url { best.person = item.person; }
            if best.confidence.is_none() { best.confidence = item.confidence; }
            if matches!(item.research.delivery_status,pebble_websearch::contact_research::DeliveryStatus::Invalid|pebble_websearch::contact_research::DeliveryStatus::Disposable|pebble_websearch::contact_research::DeliveryStatus::AcceptAll|pebble_websearch::contact_research::DeliveryStatus::Blocked) {
                best.research.delivery_status=item.research.delivery_status;
                best.research.verified_at=item.research.verified_at;
                best.research.verification_provider=item.research.verification_provider;
            }
        }
        best.email = email;
        best.source = sources.join(" + ");
        if !matches!(best.research.delivery_status,pebble_websearch::contact_research::DeliveryStatus::NotChecked) {
            best.verification=best.research.delivery_status.label().into();
        }else if count >= 2 {
            best.verification = format!("{count} 个公开页面交叉发现");
        }
        best
    }).collect::<Vec<_>>();
    merged.sort_by_key(|item| {
        let unsuitable = item.suitability.starts_with("不建议") as u8;
        let generic = item.email_type.contains("通用") as u8;
        (unsuitable, std::cmp::Reverse(generic), item.email.clone())
    });
    merged
}

fn email_domain_matches_company(email: &str, company_name: &str) -> bool {
    let email_domain = email.rsplit('@').next().unwrap_or("").to_ascii_lowercase();
    // Generic business/category words are not company identity. Treating words
    // such as "design" as a brand token made unrelated domains like
    // ifdesign.com look related to "Scandinavian Design Center".
    let ignored = [
        "the", "and", "company", "home", "group", "global", "international",
        "ltd", "limited", "inc", "llc", "design", "designs", "center", "centre",
        "shop", "store", "studio", "decor", "decoration", "gift", "gifts",
        "lighting", "furniture", "interior", "interiors", "official", "online",
    ];
    company_name.to_ascii_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .any(|token| token.len() >= 5 && !ignored.contains(&token) && email_domain.contains(token))
}

fn text_matches_company_identity(text: &str, company_name: &str, domain: &str) -> bool {
    let corpus = text.to_ascii_lowercase();
    if !domain.is_empty() && corpus.contains(domain.trim_start_matches("www.")) { return true; }
    let ignored = ["the", "and", "company", "co", "ltd", "limited", "inc", "llc", "corp", "corporation", "group", "home", "global"];
    let tokens = company_name.to_ascii_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| token.len() >= 3 && !ignored.contains(token))
        .map(str::to_string)
        .collect::<Vec<_>>();
    !tokens.is_empty() && tokens.iter().filter(|token| corpus.contains(token.as_str())).count() * 2 >= tokens.len()
}

fn email_evidence_belongs_to_company(item:&EmailEvidence,company_name:&str,domain:&str,identity_matches:bool)->bool {
    if !identity_matches || domain.is_empty() || !is_usable_discovered_email(&item.email){return false;}
    let host=item.email.rsplit('@').next().unwrap_or("").to_ascii_lowercase();
    if host==domain || host.ends_with(&format!(".{domain}")){return true;}
    let source=website_domain(&item.source_url);
    let first_party=(source==domain || source.ends_with(&format!(".{domain}"))) && item.source.contains("官网");
    const PUBLIC_HOSTS:&[&str]=&["gmail.com","yahoo.com","yahoo.co.uk","hotmail.com","outlook.com","live.com","icloud.com","aol.com","protonmail.com","proton.me","qq.com","163.com","126.com","sina.com","foxmail.com"];
    first_party && (email_domain_matches_company(&item.email,company_name) || PUBLIC_HOSTS.contains(&host.as_str()))
}

fn candidate_identity_matches(company_name: &str, _domain: &str, pages: &[crate::commands::web_research::SiteCrawlPage]) -> bool {
    let normalized_name = company_name.to_lowercase();
    let exact = normalized_name.split_whitespace().collect::<Vec<_>>().join(" ");
    let ignored = ["the", "and", "company", "co", "ltd", "limited", "inc", "llc", "corp", "corporation", "group", "gmbh", "srl", "sas", "sa"];
    let tokens = normalized_name
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|token| token.len() >= 3 && !ignored.contains(token))
        .collect::<Vec<_>>();
    pages.iter().filter(|page| page.evidence.status == crate::commands::web_research::EvidenceStatus::Ok).any(|page| {
        let corpus = format!("{} {}", page.title, page.text.chars().take(12_000).collect::<String>()).to_lowercase();
        (!exact.is_empty() && exact.len() >= 4 && corpus.contains(&exact))
            || (!tokens.is_empty() && tokens.iter().filter(|token| pebble_websearch::leads::contains_term(&corpus, token)).count() * 2 >= tokens.len())
    })
}

async fn discover_company_contact_evidence(
    state: &AppState,
    client: &reqwest::Client,
    company_name: &str,
    website: &str,
    source_url: &str,
) -> CompanyContactDiscovery {
    match super::search_router::scoped(state,async {Ok(discover_company_contact_evidence_inner(state,client,company_name,website,source_url).await)}).await {
        Ok(value)=>value,
        Err(_)=>CompanyContactDiscovery{emails:vec![],page_summaries:vec![],website_status:"待核验".into(),website_status_reason:"搜索配置读取失败".into(),review:Default::default()},
    }
}

async fn discover_company_contact_evidence_inner(state:&AppState,client:&reqwest::Client,company_name:&str,website:&str,source_url:&str)->CompanyContactDiscovery {
    let started = std::time::Instant::now();
    let domain = website_domain(website);
    if domain.is_empty() { return CompanyContactDiscovery { emails: Vec::new(), page_summaries: Vec::new(), website_status: "无法访问".into(), website_status_reason: "缺少可解析的网站域名".into(),review:Default::default() }; }

    let mut evidence: Vec<EmailEvidence> = Vec::new();
    // Preserve the exact search hit (often `/contact/`) instead of throwing it
    // away and restarting from the homepage. Only use it when it belongs to
    // the same host as the candidate website.
    let seed = if website_domain(source_url) == domain && !source_url.trim().is_empty() { source_url } else { website };
    let tavily_keys = get_external_service_api_keys(state, "tavily").unwrap_or_default();
    let brave_keys = get_external_service_api_keys(state, "brave").unwrap_or_default();
    // Public discovery must not consume Hunter credits. Paid verification is
    // available only from the explicit selected-mailbox command.
    let (mut site, search_items) = tokio::join!(
        crate::commands::web_research::crawl_company_site(client, seed, 8),
        async {tokio::time::timeout(Duration::from_secs(25),search_domain_email_sources(state,client,company_name,&domain,&tavily_keys,&brave_keys)).await.unwrap_or_default()},
    );
    // Only supplement URLs already admitted by the same-site/robots crawler.
    let mut supplements=0;
    for page in &mut site.pages {
        if supplements>=2 {break;}
        use super::web_research::EvidenceStatus;
        if page.text.chars().count()>=180 || !matches!(page.evidence.status,EvidenceStatus::Ok|EvidenceStatus::Empty|EvidenceStatus::Timeout|EvidenceStatus::HttpError|EvidenceStatus::NetworkError) {continue;}
        supplements+=1;
        if let Ok(Ok(Some((url,text))))=tokio::time::timeout(Duration::from_secs(2),super::search_router::tinyfish_fetch(state,&page.url)).await {
            if website_domain(&url)!=domain {continue;}
            page.url=url.clone();page.text=text;page.raw_text.clear();page.is_pdf=false;
            page.evidence.url=url;page.evidence.status=EvidenceStatus::Ok;page.evidence.provider="tinyfish_fetch".into();page.evidence.providers=vec!["tinyfish_fetch".into()];page.evidence.http_status=None;page.evidence.content_type="text/markdown".into();page.evidence.fetched_at=pebble_core::now_timestamp();page.evidence.error.clear();
        }
    }
    let reachable_pages = site.pages.iter()
        .filter(|page| page.evidence.status == crate::commands::web_research::EvidenceStatus::Ok)
        .collect::<Vec<_>>();
    let reachable_page_count = reachable_pages.len();
    let search_result_count = search_items.len();
    let identity_matches = candidate_identity_matches(company_name, &domain, &site.pages);
    let (website_status, website_status_reason) = if reachable_pages.is_empty() {
        ("无法访问".to_string(), "安全抓取未取得任何可读取页面".to_string())
    } else if identity_matches {
        ("已核验".to_string(), format!("已读取 {} 个同站页面，并核对公司名称/域名", reachable_pages.len()))
    } else {
        ("身份不匹配".to_string(), "网站可以访问，但页面内容无法与候选公司名称对应".to_string())
    };
    let mut research_pages = site.pages.iter()
        .filter(|p| p.evidence.status==crate::commands::web_research::EvidenceStatus::Ok)
        .map(|p| pebble_websearch::leads::Page {url:p.url.clone(),title:p.title.clone(),text:p.text.chars().take(7000).collect()}).collect::<Vec<_>>();
    let page_summaries = site.pages.iter()
        .filter(|page| page.evidence.status == crate::commands::web_research::EvidenceStatus::Ok && !page.text.trim().is_empty())
        .take(8)
        .map(|page| format!("页面：{}\n网址：{}\n正文：{}", page.title, page.url, page.text.chars().take(1800).collect::<String>()))
        .collect::<Vec<_>>();
    for page in site.pages.into_iter().filter(|page| page.evidence.status == crate::commands::web_research::EvidenceStatus::Ok) {
        let searchable_page = if page.raw_text.is_empty() {
            page.text.clone()
        } else {
            format!("{} {}", page.text, page.raw_text)
        };
        for email in public_emails(&searchable_page) {
            evidence.push(EmailEvidence {
                email_type: email_type_label(&email),
                person: String::new(),
                suitability: email_suitability(&email, ""),
                email,
                source: if page.is_pdf { "官网 PDF 文档".into() } else { format!("官网同站深挖（{}）",page.evidence.provider) },
                source_url: page.url.clone(),
                confidence: None,
                verification: "公开页面发现".into(),
                research: pebble_websearch::contact_research::EmailResearch {evidence_kind:pebble_websearch::contact_research::EvidenceKind::Published,..Default::default()},
            });
        }
    }


    // Search snippets and indexed public pages often expose addresses that are
    // absent from a JavaScript-rendered homepage. This is discovery only; the
    // original result URL is retained as evidence. 多路并行：官网站内 /
    // 通用联系邮箱 / 目录与展会 / PDF 文档，四路覆盖不同渠道。
    let mut seen_search = HashSet::new();
    let mut fetched_pages = 0;
    let mut fetch_queue: Vec<(String, WebSearchItem)> = Vec::new();
    for (provider, item) in search_items {
        if !seen_search.insert(item.url.clone()) {
            continue;
        }
        let searchable = format!("{} {}", item.title, item.description);
        let matches_company = text_matches_company_identity(
            &format!("{} {}", searchable, item.url),
            company_name,
            &domain,
        );
        if !matches_company { continue; }
        for email in public_emails(&searchable) {
            evidence.push(EmailEvidence {
    email_type: email_type_label(&email),
        person: String::new(),
                suitability: email_suitability(&email, ""),
                email,
                source: format!("{provider} 公司匹配网页检索"),
                source_url: item.url.clone(),
                confidence: None,
                verification: "搜索证据发现".into(),
                research: pebble_websearch::contact_research::EmailResearch {evidence_kind:pebble_websearch::contact_research::EvidenceKind::ProviderReported,..Default::default()},
            });
        }
        // 搜索结果页正文常含摘要里没有的邮箱（目录页/展会页/联系我们页）。
        // 有限抓取几个结果页面正文，再提取一次。
        if fetched_pages < 8
            && !["linkedin.com", "facebook.com", "instagram.com", "x.com/"]
                .iter().any(|blocked| item.url.contains(blocked))
        {
            fetched_pages += 1;
            fetch_queue.push((provider, item));
        }
    }
    let mut fetch_tasks = tokio::task::JoinSet::new();
    let search_session=super::search_router::session(state).ok();
    for (provider, item) in fetch_queue {
        let state=state.clone();
        let search_session=search_session.clone();
        let fetch_client = client.clone();
        fetch_tasks.spawn(async move {
            let future=super::search_router::fetch_with_optional_cloud(
                &state,
                &fetch_client,
                &item.url,
                "email_evidence_page",
                crate::commands::web_research::FetchPolicy {
                    max_bytes: crate::commands::web_research::DEFAULT_HTML_LIMIT,
                    timeout: Duration::from_secs(10),
                    allow_pdf: true,
                },
            );
            let page=match search_session {Some(session)=>super::search_router::scoped_session(session,future).await,None=>future.await};
            (provider, item, page)
        });
    }
    let extra_deadline=tokio::time::Instant::now()+Duration::from_secs(10);
    while !fetch_tasks.is_empty() {
        let (provider,item,page)=match tokio::time::timeout_at(extra_deadline,fetch_tasks.join_next()).await {
            Ok(Some(Ok(item)))=>item,Ok(Some(Err(_)))=>continue,_=>{fetch_tasks.abort_all();break;}
        };
        if page.evidence.status != crate::commands::web_research::EvidenceStatus::Ok { continue; }
        let searchable_page = if page.text.is_empty() && page.bytes.starts_with(b"%PDF-") {
            let bytes = page.bytes;
            tokio::time::timeout_at(extra_deadline,tokio::task::spawn_blocking(move || pdf_extract::extract_text_from_mem(&bytes).unwrap_or_default())).await.ok().and_then(Result::ok).unwrap_or_default()
        } else {
            page.text
        };
        if !text_matches_company_identity(&searchable_page, company_name, &domain) { continue; }
        research_pages.push(pebble_websearch::leads::Page{url:page.evidence.url.clone(),title:item.title.clone(),text:searchable_page.chars().take(7000).collect()});
        for email in public_emails(&searchable_page) {
            evidence.push(EmailEvidence {
                email_type: email_type_label(&email),
                person: String::new(),
                suitability: email_suitability(&email, ""),
                email,
                source: format!("{provider} 公司匹配结果页正文"),
                source_url: item.url.clone(),
                confidence: None,
                verification: "页面正文发现".into(),
                research: pebble_websearch::contact_research::EmailResearch {evidence_kind:pebble_websearch::contact_research::EvidenceKind::Published,..Default::default()},
            });
        }
    }

    // Name/brand similarity alone cannot bind a different company's domain.
    evidence.retain(|item|email_evidence_belongs_to_company(item,company_name,&domain,identity_matches));
    evidence = consolidate_email_evidence(evidence);

    evidence.truncate(15);
    tracing::info!(
        elapsed_ms = started.elapsed().as_millis() as u64,
        reachable_pages = reachable_page_count,
        search_results = search_result_count,
        accepted_emails = evidence.len(),
        identity_matches,
        website_status = website_status.as_str(),
        "company contact discovery completed"
    );
    let review=if identity_matches {super::research_evidence::review_pages(state,company_name,website,&research_pages).await}else{Default::default()};
    // People and mailboxes remain separate findings. Mere co-occurrence in a
    // paragraph cannot bind one person's role or another person's mailbox.
    // A future structured contact-card adapter must supply that attribution.
    CompanyContactDiscovery { emails: evidence, page_summaries, website_status, website_status_reason, review }
}

async fn discover_company_emails(
    state: &AppState,
    client: &reqwest::Client,
    company_name: &str,
    website: &str,
) -> Vec<EmailEvidence> {
    discover_company_contact_evidence(state, client, company_name, website, website).await.emails
}

fn is_non_customer_entity(name: &str, description: &str, website: &str) -> bool {
    let corpus = format!(" {name} {description} {website} ").to_ascii_lowercase();
    [
        " association", "association ", "industry association", "trade association",
        " chamber of commerce", " federation", " society", " institute", " council",
        " member directory", " business directory", " exhibitor directory", "trade show",
        " exhibition", " expo ", " magazine", " newspaper", " news ", " marketplace",
        "协会", "商会", "联合会", "行业组织", "会员名录", "企业名录", "展会", "博览会",
        "verband", "verein", "fédération", "annuaire", "asociación", "cámara de comercio",
        "directorio", "associazione", "federazione",
    ].iter().any(|signal| corpus.contains(signal))
}

async fn run_search_supplements(
    state: &AppState,
    client: &reqwest::Client,
    _tavily_keys: Vec<String>,
    _brave_keys: Vec<String>,
    _firecrawl_keys: Vec<String>,
    query: &str,
) -> (Vec<WebSearchItem>, Vec<WebSearchItem>, Vec<WebSearchItem>) {
    let result=super::search_router::search(state,client,query).await;
    (result.items.into_iter().map(|item|WebSearchItem{title:item.title,url:item.url,description:format!("[来源：{}] {}",item.provider,item.description)}).collect(),Vec::new(),Vec::new())
}

pub(crate) fn normalize_website(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        String::new()
    } else if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    }
}

fn parse_json_array(raw: &str) -> Vec<Value> {
    let text = raw.trim();
    let Some(start) = text.find('[') else { return Vec::new(); };
    let array_text = &text[start..];

    // 优先解析完整数组。模型有时会在 JSON 前后带少量说明或 markdown，
    // 因此只截取最外层看起来像数组的部分。
    if let Some(end) = array_text.rfind(']') {
        if let Ok(items) = serde_json::from_str::<Vec<Value>>(&array_text[..=end]) {
            return items;
        }
    }

    // Agent 达到工具调用上限时，常见情况是返回被截断的数组：
    // `[{完整公司1}, {完整公司2}, {尚未结束...`。
    // 不能因为最后一个对象不完整就丢掉前面已经完整返回的公司。
    // 这里按 JSON 字符串和大括号深度扫描，只恢复完整的对象；
    // 对象内部的数组/对象以及字符串中的大括号都会被正确忽略。
    let bytes = array_text.as_bytes();
    let mut recovered = Vec::new();
    let mut object_start: Option<usize> = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (index, byte) in bytes.iter().copied().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }

        match byte {
            b'"' => in_string = true,
            b'{' => {
                if depth == 0 {
                    object_start = Some(index);
                }
                depth += 1;
            }
            b'}' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    if let Some(start) = object_start.take() {
                        if let Ok(item) = serde_json::from_slice::<Value>(&bytes[start..=index]) {
                            recovered.push(item);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    recovered
}

fn requests_china_exclusion(instruction: &str) -> bool {
    let lower = instruction.to_ascii_lowercase();
    ["排除中国", "不要中国", "剔除中国", "中国公司除外", "非中国公司", "exclude 中国", "excluding 中国"]
        .iter().any(|signal| instruction.contains(signal))
        || ["exclude china", "excluding china", "no china", "non-china", "outside china"]
            .iter().any(|signal| lower.contains(signal))
}

fn candidate_is_mainland_china(candidate: &PublicCompanyMatch) -> bool {
    let country = candidate.country.trim().to_ascii_lowercase();
    if matches!(country.as_str(), "china" | "cn" | "prc" | "p.r.c." | "mainland china" | "中国" | "中国大陆" | "大陆") {
        return true;
    }
    let domain = website_domain(if candidate.website.trim().is_empty() { &candidate.source_url } else { &candidate.website });
    if domain.ends_with(".cn") { return true; }
    let corpus = format!("{} {} {} {} {}", candidate.legal_name, candidate.city, candidate.address, candidate.description, candidate.source_url).to_ascii_lowercase();
    [
        " mainland china", " people's republic of china", " prc", "中国大陆", "中国公司",
        "guangzhou", "shenzhen", "yiwu", "dongguan", "foshan", "ningbo", "xiamen", "hangzhou", "shanghai",
        "广州", "深圳", "义乌", "东莞", "佛山", "宁波", "厦门", "杭州", "上海",
    ].iter().any(|signal| corpus.contains(signal))
}

fn apply_hard_candidate_exclusions(candidates: &mut Vec<PublicCompanyMatch>, instruction: &str) {
    if requests_china_exclusion(instruction) {
        candidates.retain(|candidate| !candidate_is_mainland_china(candidate));
    }
}

fn search_exclusion_suffix(instruction: &str) -> &'static str {
    if requests_china_exclusion(instruction) { " -site:.cn -\"China company\" -\"Chinese manufacturer\"" } else { "" }
}

/// 当模型服务限流、超时或返回格式不合格时，不能把搜索引擎已经找到的
/// 公司线索全部丢掉。这个兜底只把明显的公司主页/公司页面展示出来，
/// 明确标记为“待核验”，不把搜索标题冒充成已验证客户。
fn fallback_search_candidates(
    items: &[WebSearchItem],
    product: &str,
    market: &str,
    buyer_type: &str,
) -> Vec<PublicCompanyMatch> {
    let blocked = [
        "google.", "youtube.", "linkedin.com", "facebook.com", "instagram.com",
        "wikipedia.org", "amazon.", "alibaba.", "made-in-china.com", "globalsources.com",
        "indiamart.com", "taobao.com", "tmall.com", "ebay.", "etsy.com", "hktdc.com",
        "news", "newspaper", "press", "directory", "catalog", "marketplace",
    ];
    let non_company_signals = [
        "add to cart", "buy now", "free shipping", "sold out", "best price", "coupon",
        "top 10", "top 100", "top 1000", "product details", "search results",
        "购物车", "立即购买", "免费送货", "已售", "促销价", "折扣", "商品详情",
        "淘宝", "天猫", "新聞", "新闻", "報紙", "报纸", "首頁", "首页",
        "industry association", "trade association", "chamber of commerce", "member directory",
        "business directory", "exhibitor directory", "协会", "商会", "联合会", "会员名录", "展会",
    ];
    let identity_path_signals = [
        "about", "about-us", "company", "company-profile", "corporate", "contact",
        "who-we-are", "our-company", "unternehmen", "societe", "empresa",
    ];
    let identity_text_signals = [
        " ltd", " limited", " inc", " llc", " corp", " company", " co.", " group",
        "manufacturer", "distributor", "wholesaler", "importer", "exporter", "supplier",
        "有限公司", "股份公司", "集团", "製造商", "制造商", "经销商", "進口商", "进口商",
    ];
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for item in items.iter().take(120) {
        let Ok(url) = reqwest::Url::parse(item.url.trim()) else { continue; };
        let Some(host) = url.host_str() else { continue; };
        let host_lower = host.to_lowercase();
        if blocked.iter().any(|part| host_lower.contains(part)) { continue; }
        let path = url.path().trim_matches('/').to_ascii_lowercase();
        let is_identity_page = path.is_empty()
            || identity_path_signals.iter().any(|signal| path.split('/').any(|part| part == *signal));
        if !is_identity_page { continue; }
        let page_text = format!("{} {}", item.title, item.description).to_lowercase();
        let excludes_china = requests_china_exclusion(product);
        if excludes_china && [" china", "chinese", "guangzhou", "shenzhen", "yiwu", "yunnan", "中国", "广州", "深圳", "义乌", "云南"]
            .iter()
            .any(|signal| page_text.contains(signal) || host_lower.contains(signal.trim()))
        {
            continue;
        }
        if non_company_signals.iter().any(|signal| page_text.contains(signal))
            || page_text.contains('$')
            || page_text.contains('¥')
            || page_text.contains('€')
            || page_text.contains('£')
        {
            continue;
        }
        if !pebble_websearch::leads::fallback_relevance(&page_text, product, buyer_type) {
            continue;
        }
        let name = item.title
            .split_once(" | ").map(|(left, _)| left)
            .or_else(|| item.title.split_once(" - ").map(|(left, _)| left))
            .unwrap_or(item.title.as_str())
            .trim();
        if is_non_customer_entity(name, &item.description, &item.url) { continue; }
        let word_count = name.split_whitespace().count();
        let has_identity_signal = identity_text_signals.iter().any(|signal| page_text.contains(signal));
        if name.len() < 3 || name.len() > 100 || (word_count <= 1 && !has_identity_signal) { continue; }
        let key = format!("{}|{}", name.to_lowercase(), host_lower);
        if !seen.insert(key) { continue; }
        let candidate_domain = host_lower.trim_start_matches("www.");
        let snippet_emails = public_emails(&page_text)
            .into_iter()
            .filter(|email| email.ends_with(&format!("@{candidate_domain}")))
            .collect::<Vec<_>>();
        let snippet_evidence = snippet_emails.iter().map(|email| EmailEvidence {
            email: email.clone(),
            source: "公开搜索摘要".to_string(),
            source_url: item.url.clone(),
            confidence: None,
            verification: "搜索摘要公开显示".to_string(),
            research: Default::default(),
            email_type: email_type_label(email),
            person: String::new(),
            suitability: email_suitability(email, ""),
        }).collect::<Vec<_>>();
        result.push(PublicCompanyMatch {
            legal_name: name.to_string(),
            country: market.to_string(),
            city: String::new(), address: String::new(),
            registration_status: "待核验".into(), lei: String::new(),
            source_url: item.url.clone(),
            website: format!("https://{host}"),
            description: if item.description.trim().is_empty() {
                format!("搜索结果显示其可能与 {product} 相关，需进一步核验主营业务")
            } else { item.description.chars().take(300).collect() },
            source_name: format!("公开公司网页线索（{}，待核验）", if buyer_type.trim().is_empty() { "候选线索" } else { buyer_type }),
            public_emails: snippet_emails,
            recommendation_reason: String::new(),
            discovery_basis: vec![format!("公开搜索结果：{}", item.url)],
            company_introduction: String::new(),
            email_evidence: snippet_evidence.clone(),
            contact_status: if snippet_evidence.is_empty() { "待补全" } else { "可联系" }.to_string(),
            website_status: "待核验".to_string(),
            website_status_reason: "尚未读取并核对网站".to_string(),
            contacts: vec![], buying_signals: vec![],
        });
        if result.len() >= 20 { break; }
    }
    result
}

fn company_candidate_key(company: &PublicCompanyMatch) -> String {
    let domain = website_domain(if company.website.trim().is_empty() {
        &company.source_url
    } else {
        &company.website
    });
    if !domain.is_empty() {
        return format!("domain:{domain}");
    }
    format!(
        "name:{}",
        company.legal_name.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
    )
}

#[tauri::command]
pub async fn enrich_lead_candidate(
    state: State<'_, AppState>,
    candidate: PublicCompanyMatch,
) -> Result<PublicCompanyMatch, PebbleError> {
    super::research_service::contacts(&state,candidate).await
}

pub(crate) async fn enrich_lead_candidate_core(state:&AppState,mut candidate:PublicCompanyMatch)->Result<PublicCompanyMatch,PebbleError>{
    if candidate.website.trim().is_empty() {
        candidate.contact_status = "待补全".to_string();
        return Ok(candidate);
    }
    let cached=super::research_evidence::cached_pages(state,&candidate.legal_name,&candidate.website);
    let domain=website_domain(&candidate.website);
    let mut cached_emails=vec![];
    for page in &cached {for email in public_emails(&page.page.text){
        let evidence=EmailEvidence{email_type:email_type_label(&email),person:String::new(),suitability:email_suitability(&email,""),email,source:"已读取的官网原文".into(),source_url:page.page.url.clone(),confidence:None,verification:"官网原文发现（未验证投递）".into(),research:pebble_websearch::contact_research::EmailResearch{evidence_kind:pebble_websearch::contact_research::EvidenceKind::Published,..Default::default()}};
        if email_evidence_belongs_to_company(&evidence,&candidate.legal_name,&domain,true){cached_emails.push(evidence);}
    }}
    if !cached_emails.is_empty(){
        candidate.email_evidence=consolidate_email_evidence(cached_emails);candidate.public_emails=candidate.email_evidence.iter().map(|e|e.email.clone()).collect();candidate.public_emails.sort();candidate.public_emails.dedup();
        candidate.contact_status="可联系".into();candidate.website_status="已核验".into();candidate.website_status_reason="复用本公司近期已核验官网原文，保留来源日期；邮箱投递未验证".into();
        let times=cached.iter().map(|p|(p.page.url.clone(),p.fetched_at)).collect();let pages=cached.iter().map(|p|p.page.clone()).collect::<Vec<_>>();
        let review=super::research_evidence::review_pages_at(state,&candidate.legal_name,&candidate.website,&pages,&times).await;
        candidate.contacts=review.contacts;candidate.buying_signals=review.buying_signals;return Ok(candidate);
    }
    let proxy = get_global_proxy_raw(&state.crypto, &state.store)?;
    let client = crate::commands::web_research::build_research_client(proxy.as_ref())?;
    let discovery = tokio::time::timeout(
        Duration::from_secs(75),
        discover_company_contact_evidence(&state, &client, &candidate.legal_name, &candidate.website, &candidate.source_url),
    ).await.unwrap_or(CompanyContactDiscovery { emails: Vec::new(), page_summaries: Vec::new(), website_status: "无法访问".into(), website_status_reason: "网站核验超时".into(),review:Default::default() });
    candidate.contacts=discovery.review.contacts;
    candidate.buying_signals=discovery.review.buying_signals;
    candidate.website_status = discovery.website_status.clone();
    candidate.website_status_reason = discovery.website_status_reason.clone();
    candidate.email_evidence = discovery.emails;
    candidate.public_emails = candidate.email_evidence.iter().map(|item| item.email.clone()).collect();
    candidate.public_emails.sort();
    candidate.public_emails.dedup();
    candidate.contact_status = if candidate.email_evidence.is_empty() { "待补全" } else { "可联系" }.to_string();

    let evidence_text = discovery.page_summaries.join("\n\n").chars().take(12_000).collect::<String>();
    if candidate.recommendation_reason.trim().is_empty() || candidate.company_introduction.trim().is_empty() {
      let system = "你是严谨的B2B客户研究编辑。只能根据给定公开证据，用自然、简洁的中文输出一个JSON对象：recommendationReason（为什么会找到这家以及与搜索目标可能相关之处，不足须说明）、discoveryBasis（2到5条字符串，逐条说明实际依据并包含网页类型或来源）、companyIntroduction（2到4句公司介绍）。不得输出HTML、Markdown、英文原文堆砌，不得编造业务、采购或邮箱。";
      let user = format!("公司：{}\n国家/地区：{}\n候选来源：{}\n原始线索摘要：{}\n公开网页证据：\n{}", candidate.legal_name, candidate.country, candidate.source_name, candidate.description, evidence_text);
      if let Ok(Ok(raw)) = tokio::time::timeout(Duration::from_secs(30), model_completion(&state, system, &user)).await {
        let cleaned = raw.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
        if let (Some(start), Some(end)) = (cleaned.find('{'), cleaned.rfind('}')) {
            if let Ok(value) = serde_json::from_str::<Value>(&cleaned[start..=end]) {
                candidate.recommendation_reason = value.get("recommendationReason").and_then(Value::as_str).unwrap_or_default().to_string();
                candidate.discovery_basis = value.get("discoveryBasis").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).take(5).collect();
                candidate.company_introduction = value.get("companyIntroduction").and_then(Value::as_str).unwrap_or_default().to_string();
            }
        }
      }
    }
    if candidate.discovery_basis.is_empty() {
        candidate.discovery_basis = discovery.page_summaries.iter().take(3).filter_map(|page| {
            let mut lines = page.lines();
            let title = lines.next()?.trim_start_matches("页面：").trim();
            let url = lines.next()?.trim_start_matches("网址：").trim();
            Some(format!("已读取官网页面“{}”：{}", if title.is_empty() { "未命名页面" } else { title }, url))
        }).collect();
    }
    if candidate.recommendation_reason.trim().is_empty() {
        candidate.recommendation_reason = "已找到可核验的公司网页线索；与本次目标的具体匹配仍需结合官网证据继续判断。".to_string();
    }
    if candidate.company_introduction.trim().is_empty() {
        candidate.company_introduction = "已取得该公司的公开网页，但本轮 AI 中文摘要未成功完成；为避免误导，不直接展示未经整理的网页原文。".to_string();
    }
    Ok(candidate)
}

/// One model request restructures a whole visible batch. This avoids one LLM
/// round-trip per company while keeping every statement tied to supplied search evidence.
#[tauri::command]
pub async fn summarize_lead_candidates(
    state: State<'_, AppState>,
    mut candidates: Vec<PublicCompanyMatch>,
) -> Result<Vec<PublicCompanyMatch>, PebbleError> {
    if candidates.is_empty() { return Ok(candidates); }
    candidates.truncate(30);
    let evidence = candidates.iter().enumerate().map(|(index, item)| format!(
        "编号：{}\n公司：{}\n国家：{}\n网址：{}\n来源：{}\n原始摘要：{}",
        index, item.legal_name, item.country, item.website, item.source_name, item.description
    )).collect::<Vec<_>>().join("\n\n");
    let system = "你是严谨的B2B客户研究编辑。将每条搜索线索整理成中文判断材料。只输出JSON数组；每项字段严格为 index、recommendationReason、discoveryBasis、companyIntroduction。recommendationReason说明为什么搜索会找到它及可能匹配点；discoveryBasis为2到4条依据；companyIntroduction为2到4句中文介绍。输入可能含HTML或外文，必须消除标签并归纳为中文。没有证据就明确待核验，禁止编造采购、规模、邮箱或官网身份。";
    if let Ok(Ok(raw)) = tokio::time::timeout(Duration::from_secs(35), model_completion(&state, system, &evidence)).await {
        for item in parse_json_array(&raw) {
            let Some(index) = item.get("index").and_then(Value::as_u64).map(|value| value as usize) else { continue };
            let Some(candidate) = candidates.get_mut(index) else { continue };
            candidate.recommendation_reason = item.get("recommendationReason").and_then(Value::as_str).unwrap_or_default().to_string();
            candidate.discovery_basis = item.get("discoveryBasis").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).take(5).collect();
            candidate.company_introduction = item.get("companyIntroduction").and_then(Value::as_str).unwrap_or_default().to_string();
        }
    }
    for candidate in &mut candidates {
        if candidate.recommendation_reason.trim().is_empty() { candidate.recommendation_reason = "该公司由公开搜索发现；具体产品与采购匹配仍需官网证据核实。".to_string(); }
        if candidate.discovery_basis.is_empty() { candidate.discovery_basis = vec![format!("公开搜索来源：{}", candidate.source_url)]; }
        if candidate.company_introduction.trim().is_empty() { candidate.company_introduction = "当前只有候选公司网页线索，尚未取得足够证据形成可靠公司介绍。".to_string(); }
        if candidate.contact_status.is_empty() { candidate.contact_status = "待补全".to_string(); }
    }
    Ok(candidates)
}




/// Run the configured LLM against a research prompt and return the text.
async fn model_completion(
    state: &AppState,
    system: &str,
    user: &str,
) -> std::result::Result<String, String> {
    let cfg = crate::commands::ai::load_active_provider_config(state)
        .map_err(|error| error.to_string())?;
    let proxy = get_global_proxy_raw(&state.crypto, &state.store)
        .map_err(|error| error.to_string())?;
    TranslateService::complete_with_proxy(&cfg, proxy.as_ref(), system, user)
        .await
        .map_err(|error| error.to_string())
}

/// Shared configured model transport for evidence-backed lead research.
/// No mail/body access, no extra service keys, no raw provider error persistence.
pub(crate) async fn lead_research_completion(state:&AppState,system:&str,user:&str)->Result<String,String> {
    let cfg=crate::commands::ai::load_active_provider_config(state).map_err(|_|"AI 模型配置不可用".to_string())?;
    let proxy=get_global_proxy_raw(&state.crypto,&state.store).map_err(|_|"研究代理配置不可用".to_string())?;
    match TranslateService::complete_fast_with_proxy(&cfg,proxy.as_ref(),system,user,6000).await {
        Ok(raw)=>Ok(raw),
        Err(error)=>{
            let text=error.to_string().to_lowercase();
            // A compatibility retry is only justified by a rejected parameter,
            // never by network/auth/quota failures. Never return provider bodies.
            if text.contains("400") && ["reasoning_effort","max_completion_tokens","unsupported parameter"].iter().any(|p|text.contains(p)) {
                return TranslateService::complete_with_proxy(&cfg,proxy.as_ref(),system,user).await.map_err(|_|"模型参数兼容请求失败".into());
            }
            let reason=if text.contains("401")||text.contains("403"){"模型认证或权限失败"}
                else if text.contains("output_limit"){"模型输出被截断，未当作没有客户"}
                else if text.contains("empty_content"){"模型未返回最终正文，未当作没有客户"}
                else if text.contains("429"){"模型限流或额度不足"}
                else if text.contains("400"){"模型请求参数被拒绝"}
                else if text.contains("404"){"模型或接口不存在"}
                else if text.contains("parse")||text.contains("content"){"模型未返回可解析内容"}
                else {"模型网络请求失败"};
            Err(reason.into())
        }
    }
}

#[tauri::command]
pub async fn research_company(
    state: State<'_, AppState>,
    webview: tauri::Webview,
    company_name: String,
    website: String,
    country: String,
    vat: Option<String>,
    on_progress: Option<tauri::ipc::JavaScriptChannelId>,
) -> Result<CompanyResearchReport, PebbleError> {
    // Channel implements CommandArg directly, not Deserialize. Optional IPC
    // channels must deserialize their ID then bind to the invoking Webview.
    let on_progress:Option<tauri::ipc::Channel<String>>=on_progress.map(|id|id.channel_on(webview));
    super::research_service::company(&state,company_name,website,country,vat.unwrap_or_default(),on_progress).await
}

/// 整轮调研的硬上限。到点就不再发起新请求，已有证据照常出报告。
const RESEARCH_DEADLINE_SECS: u64 = 300;
/// 进入证据窗口的页面上限。每页 6000 字（company_profile::EVIDENCE_CHARS_PER_PAGE）。
pub(crate) const MAX_EVIDENCE_PAGES: usize = 24;
pub(crate) const MAX_SITE_PAGES: usize = 5;
pub(crate) const MAX_EXTERNAL_PAGES: usize = 19;

/// 社交平台与登录墙站点：拿不到公司正文，读它只是浪费预算。
/// 这是传输层的可达性判断，不是按行业或公司类型做业务筛选。
pub(crate) fn unreadable_host(host: &str) -> bool {
    const BLOCKED: &[&str] = &[
        "facebook.com", "instagram.com", "linkedin.com", "youtube.com", "tiktok.com",
        "twitter.com", "x.com", "pinterest.com", "wa.me",
    ];
    BLOCKED.iter().any(|blocked| host == *blocked || host.ends_with(&format!(".{blocked}")))
}

/// 抓一页并抽出主内容。
///
/// 返回原始 HTML 是给标题/描述/邮箱解析用的；进入证据窗口的是 `Page.text`，
/// 已经过 Readability 主内容抽取。旧实现把原始 HTML 直接截 1800 字符喂给模型，
/// 等于让模型读 `<head>` 和 `<script>`。
pub(crate) async fn fetch_text_page(
    state: &AppState,
    client: &reqwest::Client,
    url: &str,
    deadline: tokio::time::Instant,
) -> Option<(String, String, Page)> {
    let checked = super::web_research::validate_public_url_syntax(url).ok()?;
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining < Duration::from_secs(4) {
        return None;
    }
    timeout_at(deadline,super::web_research::research_robots_allowed(client,url)).await.ok()?.ok()?;
    let policy = super::web_research::FetchPolicy {
        max_bytes: if checked.path().to_ascii_lowercase().ends_with(".pdf"){8*1024*1024}else{2*1024*1024},
        timeout: remaining.min(Duration::from_secs(12)),
        allow_pdf: true,
    };
    let mut page = timeout_at(deadline,super::search_router::fetch_with_optional_cloud(state, client, url, "company_research", policy)).await.ok()?;
    let thin=if page.evidence.status==super::web_research::EvidenceStatus::Ok && !page.bytes.starts_with(b"%PDF-") && !page.evidence.content_type.contains("markdown"){
        let (_,text,_)=super::web_research::html_page_content(&page.text,&checked,&checked);text.chars().count()<160
    }else{false};
    // Rendering is a fallback for thin/dynamic/failed public pages, never for
    // a forbidden, private, oversized or unsupported target.
    if thin || matches!(page.evidence.status,super::web_research::EvidenceStatus::Empty|super::web_research::EvidenceStatus::Timeout|super::web_research::EvidenceStatus::NetworkError){
        if let Ok(Ok(Some((final_url,html))))=timeout_at(deadline,super::search_router::firecrawl_fetch(state,url)).await{
            page.final_url=final_url;page.text=html;page.bytes.clear();page.evidence.status=super::web_research::EvidenceStatus::Ok;page.evidence.content_type="text/html".into();
        }
    }
    if page.evidence.status != super::web_research::EvidenceStatus::Ok {
        return None;
    }
    let base = super::web_research::validate_public_url_syntax(&page.final_url).ok()?;
    // 跨站跳转不能当成本公司的证据。
    if pebble_websearch::leads::host(&checked.to_string()) != pebble_websearch::leads::host(&base.to_string()) {
        return None;
    }
    let pdf=page.bytes.starts_with(b"%PDF-");
    let (title,text)=if pdf{
        let bytes=page.bytes.clone();
        ("PDF 公开资料".into(),timeout_at(deadline,tokio::task::spawn_blocking(move||pdf_extract::extract_text_from_mem(&bytes).unwrap_or_default())).await.ok()?.ok()?)
    }else if page.evidence.content_type.contains("markdown"){
        (if page.evidence.title.is_empty(){page.text.lines().next().unwrap_or("").trim_start_matches('#').trim().chars().take(150).collect()}else{page.evidence.title.clone()},page.text.clone())
    }else{let(title,text,_)=super::web_research::html_page_content(&page.text,&base,&base);(title,text)};
    if text.chars().count() < 80 {
        return None;
    }
    Some((page.final_url.clone(), page.text.clone(), Page { url: page.final_url, title, text }))
}

pub(crate) async fn search_one(
    state: &AppState,
    client: &reqwest::Client,
    query: &company_profile::ResearchQuery,
    deadline: tokio::time::Instant,
) -> pebble_websearch::SearchResult {
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining < Duration::from_secs(5) {
        return pebble_websearch::SearchResult{warning:"调研网页采集时间已到".into(),..Default::default()};
    }
    let limit = deadline.min(tokio::time::Instant::now() + Duration::from_secs(25));
    let search=async{if query.facet=="identity"{super::search_router::search(state,client,&query.text).await}else{super::search_router::search_company(state,client,&query.text).await}};
    match timeout_at(limit, search).await {
        Ok(mut result) => {for hit in &mut result.items{hit.provider=format!("{} / {}",query.facet,hit.provider);}result},
        Err(_) => pebble_websearch::SearchResult{warning:"部分公开检索超时".into(),..Default::default()},
    }
}

pub(crate) fn vat_country_code(country: &str) -> Option<&'static str> {
    match country.trim().to_ascii_lowercase().as_str() {
        "de" | "germany" | "德国" => Some("DE"),
        "fr" | "france" | "法国" => Some("FR"),
        "it" | "italy" | "意大利" => Some("IT"),
        "es" | "spain" | "西班牙" => Some("ES"),
        "nl" | "netherlands" | "holland" | "荷兰" => Some("NL"),
        "be" | "belgium" | "比利时" => Some("BE"),
        "pl" | "poland" | "波兰" => Some("PL"),
        "at" | "austria" | "奥地利" => Some("AT"),
        "se" | "sweden" | "瑞典" => Some("SE"),
        "dk" | "denmark" | "丹麦" => Some("DK"),
        "ie" | "ireland" | "爱尔兰" => Some("IE"),
        "pt" | "portugal" | "葡萄牙" => Some("PT"),
        "fi" | "finland" | "芬兰" => Some("FI"),
        "cz" | "czech" | "捷克" => Some("CZ"),
        "gr" | "greece" | "希腊" => Some("GR"),
        _ => None,
    }
}

/// 拆出（国家代码，税号）。用户填的税号带前缀就用前缀，否则用国家字段兜底。
pub(crate) fn vat_parts(country: &str, vat: &str) -> Option<(String, String)> {
    let cleaned: String = vat.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_uppercase();
    if cleaned.chars().count() < 4 {
        return None;
    }
    let prefix = &cleaned[..2];
    if prefix.chars().all(|c| c.is_ascii_alphabetic()) && vat_country_code(prefix).is_some() {
        return Some((prefix.to_string(), cleaned[2..].to_string()));
    }
    let code = vat_country_code(country)?;
    Some((code.to_string(), cleaned))
}

async fn vies_check(client: &reqwest::Client, country: &str, vat: &str) -> Vec<RegistryCheck> {
    const NAME: &str = "欧盟 VIES 增值税号";
    if vat.trim().is_empty() {
        return Vec::new();
    }
    let Some((code, number)) = vat_parts(country, vat) else {
        return vec![RegistryCheck::skipped(NAME, "税号需要带两位国家代码（例如 DE123456789），本次未校验")];
    };
    let url = format!("https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{code}/vat/{number}");
    match tokio::time::timeout(Duration::from_secs(15), client.get(&url).send()).await {
        Ok(Ok(response)) => {
            let body = response.text().await.unwrap_or_default();
            vec![company_profile::parse_vies(&code, &number, &body)]
        }
        _ => vec![RegistryCheck::failed(NAME, "VIES 服务暂时不可达，本次未完成校验", url)],
    }
}

/// 只在目标国家是美国（或没填国家）时才查，避免给每个非美国公司挂一条“没查到”。
async fn edgar_check(client: &reqwest::Client, country: &str, name: &str) -> Vec<RegistryCheck> {
    const NAME: &str = "美国 SEC EDGAR 申报";
    if name.trim().is_empty() {
        return Vec::new();
    }
    let country_lower = country.trim().to_ascii_lowercase();
    let is_us = matches!(country_lower.as_str(), "us" | "usa" | "united states" | "america" | "美国");
    if !is_us {
        return Vec::new();
    }
    let url = format!(
        "https://efts.sec.gov/LATEST/search-index?q=%22{}%22",
        name.trim().replace(' ', "%20")
    );
    // SEC 要求请求方声明可联系的代理标识，这里用产品名与官方站点，不伪造个人邮箱。
    let request = client
        .get(&url)
        .header("User-Agent", "YaoAIMail/1.1 (+https://yaowaimao.com)")
        .header("Accept", "application/json");
    match tokio::time::timeout(Duration::from_secs(15), request.send()).await {
        Ok(Ok(response)) => {
            let status = response.status().as_u16();
            if !(200..300).contains(&status) {
                return vec![RegistryCheck::failed(NAME, format!("SEC 返回 {status}，本次未完成查询"), url)];
            }
            let body = response.text().await.unwrap_or_default();
            vec![company_profile::parse_edgar(name, &body)]
        }
        _ => vec![RegistryCheck::failed(NAME, "SEC EDGAR 暂时不可达，本次未完成查询", url)],
    }
}

/// Parse the official legacy SDN XML, including aliases and address countries.
/// Reject partial/HTML/error documents rather than treating them as no matches.
fn parse_ofac_xml(raw:&str)->Result<(String,Vec<Value>),String>{
    use quick_xml::{Reader,events::Event};
    let mut reader=Reader::from_str(raw);reader.config_mut().trim_text(true);
    let mut path:Vec<String>=vec![];let mut rows=vec![];let mut root=false;let mut published=String::new();
    let(mut first,mut last,mut aka_first,mut aka_last,mut id)=(String::new(),String::new(),String::new(),String::new(),String::new());
    let(mut aliases,mut countries):(Vec<String>,Vec<String>)=(vec![],vec![]);
    loop{match reader.read_event(){
        Ok(Event::Start(e))=>{
            let name=String::from_utf8_lossy(e.local_name().as_ref()).to_string();
            if name=="sdnList"{root=true;}
            if name=="sdnEntry"{first.clear();last.clear();id.clear();aliases.clear();countries.clear();}
            if name=="aka"{aka_first.clear();aka_last.clear();}
            path.push(name);
        },
        Ok(Event::Text(e))=>{
            let value=e.unescape().map_err(|_|"制裁名单文本格式不正确".to_string())?;
            let name=path.last().map(String::as_str).unwrap_or("");let aka=path.iter().any(|p|p=="aka");
            match name{
                "Publish_Date"=>published.push_str(&value),
                "firstName" if aka=>aka_first.push_str(&value),"lastName" if aka=>aka_last.push_str(&value),
                "firstName"=>first.push_str(&value),"lastName"=>last.push_str(&value),
                "uid" if path.iter().rev().nth(1).is_some_and(|p|p=="sdnEntry")=>id.push_str(&value),
                "country"=>countries.push(value.into_owned()),_=>{},
            }
        },
        Ok(Event::End(e))=>{
            match e.local_name().as_ref(){
                b"aka"=>{let alias=format!("{} {}",aka_first,aka_last).trim().to_string();if !alias.is_empty(){aliases.push(alias);}},
                b"sdnEntry"=>{
                    let name=format!("{} {}",first,last).trim().to_string();if !name.is_empty(){
                        let mut names=vec![name];names.extend(aliases.clone());rows.push(serde_json::json!({"id":id,"names":names,"countries":countries}));
                    }
                },_=>{},
            }path.pop();
        },
        Ok(Event::DocType(_))=>return Err("不接受含外部实体定义的名单".into()),
        Ok(Event::Eof)=>break,Err(_)=>return Err("制裁名单不完整或XML格式错误".into()),_=>{},
    }}
    if !root || rows.is_empty() || !path.is_empty(){return Err("未取得完整的SDN名单，不能当作无匹配".into());}
    Ok((published,rows))
}

pub(crate) async fn ofac_check(client:&reqwest::Client,name:&str)->RegistryCheck{
    const NAME:&str="OFAC SDN 名称初筛";
    const URL:&str="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/sdn.xml";
    type Dataset=Result<(String,Vec<Value>),String>;
    static CACHE:std::sync::OnceLock<tokio::sync::Mutex<Option<(tokio::time::Instant,Dataset)>>>=std::sync::OnceLock::new();
    let target=company_profile::company_identity_key(name);
    if target.chars().count()<4{return RegistryCheck{name:NAME.into(),status:"skipped".into(),summary:"主体名称过短，未进行可能大量误报的精确名称初筛".into(),url:String::new(),items:vec![]};}
    let mut cache=CACHE.get_or_init(Default::default).lock().await;
    let fresh=cache.as_ref().is_some_and(|(at,result)|at.elapsed()<Duration::from_secs(if result.is_ok(){6*3600}else{60}));
    if !fresh{
        let response=super::web_research::safe_fetch(client,URL,"ofac_sdn",super::web_research::FetchPolicy{max_bytes:40*1024*1024,timeout:Duration::from_secs(75),allow_pdf:false});
        let result=match tokio::time::timeout(Duration::from_secs(80),response).await{
            Ok(page) if page.evidence.status==super::web_research::EvidenceStatus::Ok=>{
                tokio::task::spawn_blocking(move||parse_ofac_xml(&page.text)).await.unwrap_or_else(|_|Err("名单解析未完成".into()))
                    .and_then(|data|if data.1.len()<100{Err("名单规模异常，未据此作无匹配判断".into())}else{Ok(data)})
            },Ok(page)=>Err(format!("OFAC公开名单未能完整读取（{:?}，HTTP {:?}），本次未完成初筛",page.evidence.status,page.evidence.http_status)),
            Err(_)=>Err("OFAC公开名单读取超时，本次未完成初筛".into()),
        };
        *cache=Some((tokio::time::Instant::now(),result));
    }
    let Some((_,result))=cache.as_ref()else{return RegistryCheck::failed(NAME,"名单缓存不可用",URL);};
    let (published,rows)=match result{Ok(data)=>data,Err(error)=>return RegistryCheck::failed(NAME,error.clone(),URL)};
    let matched:Vec<_>=rows.iter().filter(|r|r["names"].as_array().into_iter().flatten().filter_map(Value::as_str).any(|n|company_profile::company_identity_key(n)==target)).take(5).collect();
    let items=matched.iter().map(|r|format!("名单编号{}；名称{}；列示国家{}",r["id"].as_str().unwrap_or(""),r["names"].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join(" / "),r["countries"].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join(" / "))).collect();
    RegistryCheck{name:NAME.into(),status:if matched.is_empty(){"screened"}else{"candidate"}.into(),
        summary:format!("已读取{}条SDN主体及别名，名单发布日期{}；{}。仅规范化精确名称初筛，未覆盖模糊别名、非SDN名单或其他国家制裁，不代表合规放行。",rows.len(),published,if matched.is_empty(){"未发现精确名称候选"}else{"发现名称候选，尚未核对地址/国别/登记号，不能认定为同一主体"}),url:URL.into(),items}
}

/// 把官方登记确认的事实补进档案。模型没读到、但 VIES 明确登记的名称/地址，
/// 属于比网页更硬的证据，这里直接标成已确认并带上登记处链接。
fn apply_registry_fields(dossier: &mut Dossier, registries: &[RegistryCheck]) {
    for registry in registries.iter().filter(|item| item.status == "checked") {
        let add = |dossier: &mut Dossier, key: &str, value: String| {
            if value.trim().is_empty() || dossier.profile.iter().any(|field| field.key == key) {
                return;
            }
            let Some(label) = company_profile::profile_label(key) else { return };
            dossier.profile.push(company_profile::ProfileField {
                key: key.into(),
                label: label.into(),
                value: value.chars().take(120).collect(),
                url: registry.url.clone(),
                quote: registry.summary.clone(),
                level: "confirmed".into(),
            });
        };
        for item in &registry.items {
            if let Some(address) = item.strip_prefix("登记地址：") {
                add(dossier, "address", address.to_string());
            }
        }
        if let Some(holder) = registry.summary.strip_prefix("税号有效，登记名称：") {
            add(dossier, "legalName", holder.to_string());
        }
    }
}

async fn build_analysis(state:&AppState,name:&str,website:&str,country:&str,emails:&[String],pages:&[Page],hits:&[Hit],registries:&[RegistryCheck],audit:&pebble_websearch::investigation::Investigation,warnings:&mut Vec<String>,deadline:tokio::time::Instant)->Result<String,String> {
    use pebble_websearch::company_report;
    if pages.is_empty() && !hits.iter().any(|h|company_profile::related_hit(name,website,h)){
        return Err("本次没有取得公司网页或相关检索线索，未生成无依据的调查正文".into());
    }
    let sources=company_report::sources(name,website,pages,hits,registries);
    let mut user=company_report::user(name,website,country,&chrono::Utc::now().format("%Y-%m-%d").to_string(),emails,&sources);
    let mut input:Value=serde_json::from_str(&user).map_err(|_|"调查证据序列化失败".to_string())?;
    input["investigationCoverage"]=serde_json::json!({"officialPages":audit.official_pages,"externalPages":audit.external_pages,"externalSites":audit.external_sites,"areas":audit.areas});
    input["coverageRules"]=serde_json::json!("材料已读不等于事实全部证实；searched_no_readable_evidence只代表查过但没拿到可读材料，不代表无风险或不存在记录；OFAC screened只覆盖当前SDN主体及别名的规范化精确名称初筛，不是模糊匹配、全球制裁或合规放行。主体相似候选仍须核对国家/地址/登记号。不同网站可能转载同一材料，外部站点数不是独立所有权证明。");
    user=input.to_string();
    // Full narrative + evidence-aware editing, never a field whitelist that
    // replaces the report. The editor removes unsupported reasoning/filler
    // without discarding valid company information. It adds one bounded call.
    for attempt in 0..2 {
        let raw=timeout_at(deadline,lead_research_completion(state,company_report::SYSTEM,&user)).await
            .map_err(|_|"完整调查分析超时，已读资料与旧报告均保留".to_string())??;
        match company_report::render(&raw,&sources){
            Ok(analysis)=>{
                if deadline.saturating_duration_since(tokio::time::Instant::now())<Duration::from_secs(15){
                    warnings.push("完整报告已生成，但本轮时限不足以完成独立复核，请结合来源审阅分析判断".into());return Ok(analysis);
                }
                let review=format!("{user}\n待复核完整报告：\n{raw}");
                let checked=timeout_at(deadline,lead_research_completion(state,company_report::EDIT_SYSTEM,&review)).await;
                if let Ok(Ok(text))=checked{if let Ok(edited)=company_report::render(&text,&sources){return Ok(edited);}}
                warnings.push("完整报告已保留，独立复核未完成；请结合来源审阅分析判断".into());
                return Ok(analysis);
            },
            Err(reason) if attempt==0=>{user.push_str(&format!("\n上次输出的引用格式未通过：{reason}。请重新输出完整Markdown调查报告，仅用给定编号如[S1]引用；不直接生成网址。资料没有变化，不增补事实。"));}
            Err(reason)=>return Err(reason.into()),
        }
    }
    unreachable!()
}

pub(crate) async fn research_company_inner(
    state: &AppState,
    company_name: String,
    website: String,
    country: String,
    vat: String,
    on_progress: Option<&(dyn Fn(String)+Send+Sync)>,
) -> Result<CompanyResearchReport, PebbleError> {
    if company_name.trim().is_empty() && website.trim().is_empty(){
        return Err(PebbleError::Validation("请填写公司名称或官网地址".into()));
    }
    let deadline=tokio::time::Instant::now()+Duration::from_secs(RESEARCH_DEADLINE_SECS);
    let proxy=get_global_proxy_raw(&state.crypto,&state.store)?;
    let client=super::web_research::build_research_client(proxy.as_ref())?;
    let name=company_name.trim().to_string();
    let website=normalize_website(&website);
    // The public SDN file is large. Download/cache it alongside discovery,
    // rather than imposing a second serial wait after gathering the evidence.
    let initial_query=if name.is_empty(){company_profile::domain_of(&website)}else{name.clone()};
    let (data,ofac)=tokio::join!(
        super::company_investigation::gather(state,&client,&name,&website,country.trim(),deadline-Duration::from_secs(110),on_progress),
        timeout_at(deadline-Duration::from_secs(90),ofac_check(&client,&initial_query))
    );
    let super::company_investigation::Gathered{website,country,title:website_title,description:website_description,
        emails:public_emails,pages,hits,mut audit,mut warnings,page_times}=data;
    let legal_query=if name.is_empty(){company_profile::domain_of(&website)}else{name.clone()};
    let registry_deadline=deadline.min(tokio::time::Instant::now()+Duration::from_secs(20));
    if let Some(c)=on_progress{c("正在核对官方记录".into());}
    let (vies,edgar,gleif)=tokio::join!(
        timeout_at(registry_deadline,vies_check(&client,&country,&vat)),
        timeout_at(registry_deadline,edgar_check(&client,&country,&name)),
        timeout_at(registry_deadline,gleif_matches(&client,&legal_query))
    );
    let mut registries=vec![];let mut legal_matches=vec![];
    if let Ok(items)=vies{registries.extend(items);}
    if let Ok(items)=edgar{registries.extend(items);}
    match gleif{
        Ok(Ok(items))=>{
            legal_matches=items.into_iter().filter(|item|company_profile::company_identity_key(&item.legal_name)==company_profile::company_identity_key(&legal_query)).collect();
            let mut url=reqwest::Url::parse("https://search.gleif.org/").expect("constant URL");
            url.set_fragment(Some(&format!("/search/simpleSearch={legal_query}")));
            if legal_matches.is_empty(){registries.push(RegistryCheck::no_match("GLEIF 全球法人识别码","没有名称一致的LEI记录；不能据此判断公司不存在或信用差",url.to_string()));}
            else{registries.push(RegistryCheck{name:"GLEIF 全球法人识别码".into(),status:"candidate".into(),
                summary:format!("找到{}个名称候选，仍需核对国家、地址与主体身份",legal_matches.len()),url:url.to_string(),
                items:legal_matches.iter().take(3).map(|i|format!("{} · {} {}",i.legal_name,i.country,i.city)).collect()});}
        },
        _=>registries.push(RegistryCheck::failed("GLEIF 全球法人识别码","本轮未完成法人检索，不能据此判断无记录",String::new())),
    }
    match ofac{Ok(check)=>registries.push(check),Err(_)=>registries.push(RegistryCheck::failed("OFAC SDN 名称初筛","名单读取超时，未完成初筛","https://ofac.treasury.gov/sanctions-list-service"))};
    audit.areas.push(pebble_websearch::investigation::CoverageArea{key:"sanctions".into(),label:"制裁名单名称初筛".into(),
        status:registries.iter().find(|r|r.name=="OFAC SDN 名称初筛").map(|r|r.status.clone()).unwrap_or_else(||"not_searched".into()),documents:0});
    if audit.external_pages==0{warnings.push("本轮未读到可归属该公司的外部正文；报告不能当作已完成独立资信核验".into());}
    if let Some(c)=on_progress{c("正在整理和复核调查报告".into());}
    let analysis=match build_analysis(state,&name,&website,&country,&public_emails,&pages,&hits,&registries,&audit,&mut warnings,deadline).await{
        Ok(text)=>text,Err(reason)=>{warnings.push(reason);String::new()}
    };
    let mut dossier=Dossier::default();apply_registry_fields(&mut dossier,&registries);
    // Persist only cited location/identity anchors, not narrative guesses.
    for anchor in &audit.anchors{
        let key=match anchor.kind.as_str(){"country"=>"country","city"=>"city","address"=>"address","registration"=>"registrationId",_=>continue};
        if dossier.profile.iter().any(|p|p.key==key){continue;}
        dossier.profile.push(company_profile::ProfileField{key:key.into(),label:company_profile::profile_label(key).unwrap_or(key).into(),
            value:anchor.value.clone(),url:anchor.url.clone(),quote:anchor.quote.clone(),
            level:if pebble_websearch::investigation::site_key(&anchor.url)==pebble_websearch::investigation::site_key(&website){"published"}else{"reported"}.into()});
    }
    let mut sources=pages.iter().map(|page|ResearchSource{title:format!("{}：{}",if pebble_websearch::investigation::site_key(&page.url)==pebble_websearch::investigation::site_key(&website){"官网正文"}else{"外部正文"},page.title.chars().take(90).collect::<String>()),url:page.url.clone(),status:"checked".into()}).collect::<Vec<_>>();
    sources.extend(registries.iter().filter(|r|!r.url.is_empty()).map(|r|ResearchSource{title:r.name.clone(),url:r.url.clone(),status:r.status.clone()}));
    for hit in hits.iter().filter(|h|pebble_websearch::investigation::related(&name,&website,&audit.anchors,&format!("{} {}",h.title,h.description),&h.url)){
        if sources.iter().any(|s|s.url==hit.url){continue;}
        if sources.iter().filter(|s|s.status=="search_only").count()>=24{break;}
        sources.push(ResearchSource{title:hit.title.clone(),url:hit.url.clone(),status:"search_only".into()});
    }
    let registry_links=company_profile::registry_links(&country,&name).into_iter().map(|(title,url)|ResearchSource{title,url,status:"suggested".into()}).collect();
    warnings.sort();warnings.dedup();
    if let Some(c)=on_progress{c("正在核对联系人与业务信号".into());}
    let review=timeout_at(deadline,super::research_evidence::review_pages_at(state,&name,&website,&pages,&page_times)).await.unwrap_or_default();
    let mut email_evidence=vec![];
    for page in pages.iter().filter(|p|pebble_websearch::investigation::site_key(&p.url)==pebble_websearch::investigation::site_key(&website)) {
        for email in self::public_emails(&page.text) {
            let item=EmailEvidence{email_type:email_type_label(&email),person:String::new(),suitability:email_suitability(&email,""),email,
                source:"官网已读正文".into(),source_url:page.url.clone(),confidence:None,verification:"公开页面发现，未验证可投递性".into(),
                research:pebble_websearch::contact_research::EmailResearch{evidence_kind:pebble_websearch::contact_research::EvidenceKind::Published,..Default::default()}};
            if email_evidence_belongs_to_company(&item,&name,&website_domain(&website),true){email_evidence.push(item);}
        }
    }
    let email_evidence=consolidate_email_evidence(email_evidence);
    let report=CompanyResearchReport{id:new_id(),company_name:name,website,country,website_title,website_description,public_emails,
        legal_matches,sources,warnings,analysis,created_at:now_timestamp(),dossier,registries,registry_links,pages_read:pages.len(),structure_version:6,investigation:audit,
        contacts:review.contacts,buying_signals:review.buying_signals,email_evidence};
    let _reports_guard=REPORTS_WRITE_LOCK.lock().map_err(|_|PebbleError::Internal("调查历史锁不可用".into()))?;
    let mut reports=load_reports(state)?;reports.insert(0,report.clone());reports.truncate(200);save_reports(state,&reports)?;
    Ok(report)
}

#[tauri::command]
pub async fn list_company_research(
    state: State<'_, AppState>,
) -> Result<Vec<CompanyResearchReport>, PebbleError> {
    load_reports(&state)
}

#[tauri::command]
pub async fn delete_company_research(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<CompanyResearchReport>, PebbleError> {
    let _guard=REPORTS_WRITE_LOCK.lock().map_err(|_|PebbleError::Internal("调查历史锁不可用".into()))?;
    let mut reports = load_reports(&state)?;
    reports.retain(|report| report.id != id);
    save_reports(&state, &reports)?;
    Ok(reports)
}

#[tauri::command]
pub async fn save_company_research_analysis(
    state: State<'_, AppState>,
    id: String,
    analysis: String,
) -> Result<CompanyResearchReport, PebbleError> {
    let _guard=REPORTS_WRITE_LOCK.lock().map_err(|_|PebbleError::Internal("调查历史锁不可用".into()))?;
    let mut reports = load_reports(&state)?;
    let report = reports
        .iter_mut()
        .find(|report| report.id == id)
        .ok_or_else(|| PebbleError::Validation("Company research report not found".into()))?;
    report.analysis = analysis.trim().to_string();
    let updated = report.clone();
    save_reports(&state, &reports)?;
    Ok(updated)
}

#[tauri::command]
pub async fn search_public_companies(
    query: String,
) -> Result<Vec<PublicCompanyMatch>, PebbleError> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(16))
        .user_agent("YaoAIMail/1.1 lead-finder")
        .build()
        .map_err(|error| PebbleError::Network(error.to_string()))?;
    gleif_matches(&client, query.trim())
        .await
        .map_err(|error| PebbleError::Network(error.to_string()))
}

async fn model_company_candidates(
    state: &AppState,
    product: &str,
    market: &str,
    buyer_type: &str,
) -> Vec<PublicCompanyMatch> {
    let started = std::time::Instant::now();
    let Ok(cfg) = crate::commands::ai::load_active_provider_config(state) else {
        tracing::warn!("lead discovery model stage skipped: provider_config_unavailable");
        return Vec::new();
    };
    let Ok(proxy) = get_global_proxy_raw(&state.crypto, &state.store) else {
        tracing::warn!("lead discovery model stage skipped: proxy_config_unavailable");
        return Vec::new();
    };
    let system = "你是外贸B2B客户开发专家。根据精炼后的产品关键词、目标市场、买家类型和本批次渠道重点，建立潜在采购公司候选池。用户写出的排除、不要、仅限等条件都是硬条件，违反硬条件的公司不得输出。\n\
    只输出严格 JSON 数组（不要 markdown），每项字段：name、country、city、website、description。description 必须用中文，最多一句话。\n\
    本批次请返回 12 到 18 家不同公司。宁可给出官网待核验的真实中小公司，也不要只返回一两家；但不得为了凑数输出与产品采购无关的公司。\n\
    候选阶段允许官网或业务匹配尚待核验，后续程序会继续验证；不要因此只返回一两家。不得输出商品名、商城、新闻媒体、行业目录或电商平台，不得编造邮箱。";
    let user = format!("精炼搜索条件与本批次渠道重点：{product}\n目标市场：{market}\n买家类型：{buyer_type}\n请输出 12 到 18 家不同公司，按匹配可能性排序。");
    let raw = match tokio::time::timeout(
        Duration::from_secs(180),
        TranslateService::complete_fast_with_proxy(&cfg, proxy.as_ref(), system, &user, 8_000),
    ).await {
        Err(_) => {
            tracing::warn!(
                elapsed_ms = started.elapsed().as_millis() as u64,
                "lead discovery model stage failed: timeout"
            );
            return Vec::new();
        }
        Ok(Err(error)) => {
            let message = error.to_string().to_ascii_lowercase();
            let reason = if message.contains("429") || message.contains("rate limit") {
                "rate_limited"
            } else if message.contains("401") || message.contains("403") {
                "authorization"
            } else if message.contains("reasoning_effort") || message.contains("unsupported") || message.contains("unknown parameter") {
                "unsupported_parameter"
            } else {
                "provider_request"
            };
            tracing::warn!(
                elapsed_ms = started.elapsed().as_millis() as u64,
                reason,
                "lead discovery model stage failed: provider_request"
            );
            return Vec::new();
        }
        Ok(Ok(raw)) => raw,
    };

    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for item in parse_json_array(&raw) {
        let name = item["name"].as_str().unwrap_or_default().trim();
        if name.len() < 2 || !seen.insert(name.to_lowercase()) {
            continue;
        }
        let website = item["website"].as_str().unwrap_or_default().trim().to_string();
        let description = item["description"].as_str().unwrap_or_default().trim();
        if is_non_customer_entity(name, description, &website) {
            continue;
        }
        result.push(PublicCompanyMatch {
            legal_name: name.to_string(),
            country: item["country"].as_str().unwrap_or_default().to_string(),
            city: item["city"].as_str().unwrap_or_default().to_string(),
            address: String::new(),
            registration_status: "待核验".to_string(),
            lei: String::new(),
            source_url: website.clone(),
            website,
            description: description.to_string(),
            source_name: "AI 公司候选（待核验）".to_string(),
            public_emails: Vec::new(),
            recommendation_reason: "由 AI 根据本次产品、市场和买家类型列入候选；公司身份与产品契合度仍需公开网页核验。".to_string(),
            discovery_basis: vec!["AI 多渠道候选池（待公开来源核验）".to_string()],
            company_introduction: item["description"].as_str().unwrap_or_default().to_string(), email_evidence: Vec::new(),
            contact_status: "待补全".to_string(),
            website_status: "待核验".to_string(),
            website_status_reason: "AI 提供的网址尚未经过可访问性与公司身份核验".to_string(),
            contacts: vec![], buying_signals: vec![],
        });
    }
    apply_hard_candidate_exclusions(&mut result, product);
    if result.is_empty() {
        tracing::warn!(
            elapsed_ms = started.elapsed().as_millis() as u64,
            response_bytes = raw.len(),
            "lead discovery model stage failed: no_parseable_candidates"
        );
    } else {
        tracing::info!(
            elapsed_ms = started.elapsed().as_millis() as u64,
            response_bytes = raw.len(),
            candidates = result.len(),
            "lead discovery model stage completed"
        );
    }
    result
}

/// AI-first company discovery: the model lists candidate buyers from its own
/// knowledge, then Tavily/Brave search results (when configured) and GLEIF
/// supplement the list. Every candidate keeps a visible source.
async fn find_companies(
    state: &AppState,
    product: String,
    market: String,
    buyer_type: String,
) -> Result<Vec<PublicCompanyMatch>, PebbleError> {
    super::search_router::scoped(state,find_companies_inner(state,product,market,buyer_type)).await
}

async fn find_companies_inner(state:&AppState,product:String,market:String,buyer_type:String)->Result<Vec<PublicCompanyMatch>,PebbleError> {
    let query_text = [product.trim(), market.trim(), buyer_type.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if query_text.trim().is_empty() {
        return Err(PebbleError::Validation("请输入产品或目标市场".to_string()));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(16))
        .user_agent("YaoAIMail/1.1 lead-finder")
        .build()
        .map_err(|error| PebbleError::Network(error.to_string()))?;
    let tavily_keys = get_external_service_api_keys(&state, "tavily").unwrap_or_default();
    let brave_keys = get_external_service_api_keys(&state, "brave").unwrap_or_default();
    // Firecrawl search+scrape consumes credits per result. Ordinary lead
    // discovery does not spend it; deep company research can still use it.
    let firecrawl_keys = Vec::new();
    // The configured reasoning provider may expose only one effective
    // concurrency slot. Three simultaneous model batches queued behind each
    // other and timed out. Use one quota-balanced request while public search
    // runs in parallel; this restores the old 30-company yield without three
    // serial waits.
    let diversified_request = format!(
        "{product}\n渠道重点：进口商/批发商/区域分销商；相关礼品、花艺、家居品牌；独立礼品精品店、小型电商及合理相邻采购渠道。"
    );

    // Search engines also receive several concise queries. Sending the entire
    // product card and exclusions as one giant query caused zero-result API
    // responses; the model still receives the complete constraints above.
    let mut product_lines = product.lines().map(str::trim).filter(|line| !line.is_empty());
    let core = product_lines.next().unwrap_or(product.trim());
    let aliases = product_lines.next().unwrap_or_default();
    let exclusion_suffix = search_exclusion_suffix(&product);
    let query_direct = format!("{core} {aliases} importer wholesaler distributor {market}{exclusion_suffix}");
    let query_specialty = format!("{aliases} gift boutique floral brand shop {market}{exclusion_suffix}");
    let query_adjacent = format!("{core} home decor seasonal gift supplier museum shop {market}{exclusion_suffix}");

    let model_batch = model_company_candidates(state, &diversified_request, &market, &buyer_type);
    let search_batches = async {
        tokio::join!(
            run_search_supplements(state, &client, tavily_keys.clone(), brave_keys.clone(), firecrawl_keys.clone(), &query_direct),
            run_search_supplements(state, &client, tavily_keys.clone(), brave_keys.clone(), firecrawl_keys.clone(), &query_specialty),
            run_search_supplements(state, &client, tavily_keys, brave_keys, firecrawl_keys, &query_adjacent),
        )
    };
    let (model_candidates, (search_direct, search_specialty, search_adjacent)) =
        tokio::join!(model_batch, search_batches);
    let mut matches = Vec::new();
    let mut model_seen = HashSet::new();
    for company in model_candidates {
        if model_seen.insert(company_candidate_key(&company)) {
            matches.push(company);
        }
    }
    let (mut tavily_items, mut brave_items, mut firecrawl_items) = search_direct;
    for (tavily, brave, firecrawl) in [search_specialty, search_adjacent] {
        tavily_items.extend(tavily);
        brave_items.extend(brave);
        firecrawl_items.extend(firecrawl);
    }
    let mut seen: HashSet<String> = matches.iter().map(company_candidate_key).collect();
    // Search hits are evidence, not companies. Only pages that pass strict,
    // deterministic company-identity checks may become lead cards. Avoiding
    // another model round-trip both prevents creative false positives and
    // keeps first-screen latency bounded.
    let mut search_items = Vec::new();
    search_items.extend(tavily_items.iter().cloned());
    search_items.extend(brave_items.iter().cloned());
    search_items.extend(firecrawl_items.iter().cloned());
    let normalized = fallback_search_candidates(&search_items, &product, &market, &buyer_type);
    for company in normalized {
        let key = company_candidate_key(&company);
        if seen.insert(key) { matches.push(company); }
    }

    // Large 24-32 item responses exceeded four minutes on reasoning models.
    // A second small, explicitly distinct pool is slower than one ideal call
    // but reliably preserves the first pool and reaches useful batch volume.
    let used_supplement = matches.len() < 25;
    if used_supplement {
        let exclusions = matches
            .iter()
            .map(|company| company.legal_name.as_str())
            .take(40)
            .collect::<Vec<_>>()
            .join(", ");
        let supplement_request = format!(
            "{product}\n第二批渠道重点：补充第一批较少覆盖的中小进口商、批发商、独立礼品/花艺/家居品牌和精品渠道。必须排除已找到公司：{exclusions}"
        );
        for company in model_company_candidates(state, &supplement_request, &market, &buyer_type).await {
            if seen.insert(company_candidate_key(&company)) {
                matches.push(company);
            }
            if matches.len() >= 40 {
                break;
            }
        }
    }

    apply_hard_candidate_exclusions(&mut matches, &product);
    matches.truncate(40);
    tracing::info!(
        "ai_find_companies: search_items={}, accepted_candidates={}, used_supplement={}",
        search_items.len(),
        matches.len(),
        used_supplement
    );

    // Deep registry/contact enrichment is intentionally not on the first
    // screen path. The UI can enrich accepted companies after rendering.
    Ok(matches)
}

#[tauri::command]
pub async fn ai_find_companies(
    state: State<'_, AppState>,
    product: String,
    market: String,
    buyer_type: String,
) -> Result<Vec<PublicCompanyMatch>, PebbleError> {
    find_companies(&state, product, market, buyer_type).await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeadResearchQuery {
    channel: String,
    query: String,
}

fn fallback_research_queries(product: &str, market: &str, buyer_type: &str) -> Vec<LeadResearchQuery> {
    let lines = product.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>();
    let core = lines.first().copied().unwrap_or(product.trim());
    let aliases = lines.get(1).copied().unwrap_or_default().split(" OR ").filter(|value| !value.is_empty()).take(4).collect::<Vec<_>>();
    let suffix = search_exclusion_suffix(product);
    let mut queries = vec![
        ("直接买家", format!("{core} {buyer_type} importer wholesaler distributor {market}")),
        ("协会名录", format!("{core} association members distributors {market}")),
        ("展会名录", format!("{core} trade show exhibitors buyers {market}")),
        ("经销商页面", format!("{core} dealers distributors stockists {market}")),
        ("公开职业网络", format!("site:linkedin.com/company {core} distributor {market}")),
        ("进口采购", format!("{core} importer consignee buyer procurement {market}")),
        ("本地商业目录", format!("{core} business directory wholesaler {market}")),
        ("地图与门店", format!("{core} store shop distributor near {market}")),
    ];
    for alias in aliases { queries.push(("产品别名", format!("{alias} importer wholesaler distributor {market}"))); }
    queries.into_iter().map(|(channel, query)| LeadResearchQuery { channel: channel.to_string(), query: format!("{query}{suffix}") }).collect()
}

async fn model_research_queries(
    state: &AppState,
    product: &str,
    market: &str,
    buyer_type: &str,
) -> Vec<LeadResearchQuery> {
    let Ok(cfg) = crate::commands::ai::load_active_provider_config(state) else { return Vec::new() };
    let Ok(proxy) = get_global_proxy_raw(&state.crypto, &state.store) else { return Vec::new() };
    let system = "你是B2B公开网络研究规划器。只生成检索计划，不生成公司。根据产品、市场和买家类型，覆盖普通网页、当地语言、协会会员、展会参展商、经销商/stockist、公开LinkedIn公司页索引、地图/本地目录、进口商/consignee/采购公告等不同渠道。只输出JSON数组，每项为{\"channel\":\"中文渠道名\",\"query\":\"可直接给搜索引擎的精炼查询\"}。不得承诺结果数量，不得编造公司或邮箱。";
    let user = format!("产品：{product}\n市场：{market}\n买家类型：{buyer_type}\n请生成互补而非同义重复的查询计划。");
    let raw = match tokio::time::timeout(
        Duration::from_secs(15),
        TranslateService::complete_fast_with_proxy(&cfg, proxy.as_ref(), system, &user, 5_000),
    ).await {
        Ok(Ok(raw)) => raw,
        _ => return Vec::new(),
    };
    parse_json_array(&raw).into_iter().filter_map(|item| {
        let channel = item.get("channel")?.as_str()?.trim();
        let query = item.get("query")?.as_str()?.trim();
        if channel.is_empty() || query.len() < 3 || query.len() > 500 { return None; }
        Some(LeadResearchQuery { channel: channel.to_string(), query: query.to_string() })
    }).take(16).collect()
}

/// Fast, deterministic first screen. This never waits for the configured LLM
/// and is safe to render while AI batches continue in the background.
#[tauri::command]
pub async fn search_lead_companies(
    state: State<'_, AppState>,
    product: String,
    market: String,
    buyer_type: String,
    batch_mode: bool,
) -> Result<Vec<PublicCompanyMatch>, PebbleError> {
    super::search_router::scoped(&state,search_lead_companies_inner(&state,product,market,buyer_type,batch_mode)).await
}

async fn search_lead_companies_inner(state:&AppState,product:String,market:String,buyer_type:String,batch_mode:bool)->Result<Vec<PublicCompanyMatch>,PebbleError> {
    if product.trim().is_empty() && market.trim().is_empty() && buyer_type.trim().is_empty() {
        return Err(PebbleError::Validation("请输入产品或目标市场".to_string()));
    }
    let client = crate::commands::web_research::build_research_client(None)?;
    let tavily_keys = get_external_service_api_keys(&state, "tavily").unwrap_or_default();
    let brave_keys = get_external_service_api_keys(&state, "brave").unwrap_or_default();
    let (mut queries, planned) = tokio::join!(
        async { fallback_research_queries(&product, &market, &buyer_type) },
        model_research_queries(&state, &product, &market, &buyer_type),
    );
    queries.extend(planned);
    let exclusion_suffix = search_exclusion_suffix(&product);
    if !exclusion_suffix.is_empty() {
        for item in &mut queries {
            if !item.query.contains("-site:.cn") { item.query.push_str(exclusion_suffix); }
        }
    }
    let mut seen_queries = HashSet::new();
    queries.retain(|item| seen_queries.insert(item.query.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase()));
    queries.truncate(if batch_mode { 18 } else { 8 });

    let mut tasks = tokio::task::JoinSet::new();
    let search_session=super::search_router::session(state)?;
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
    for plan in queries {
        let state=state.clone();
        let search_session=search_session.clone();
        let client = client.clone();
        let tavily_keys = tavily_keys.clone();
        let brave_keys = brave_keys.clone();
        let semaphore = semaphore.clone();
        tasks.spawn(async move {
            let _permit = semaphore.acquire_owned().await.ok();
            let results = super::search_router::scoped_session(search_session,run_search_supplements(&state,&client,tavily_keys,brave_keys,Vec::new(),&plan.query)).await;
            (plan.channel, results)
        });
    }
    let mut search_items = Vec::new();
    while let Some(result) = tasks.join_next().await {
        if let Ok((_channel, (tavily, brave, firecrawl))) = result {
            search_items.extend(tavily);
            search_items.extend(brave);
            search_items.extend(firecrawl);
        }
    }
    let candidates = fallback_search_candidates(&search_items, &product, &market, &buyer_type);
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for candidate in candidates {
        if seen.insert(company_candidate_key(&candidate)) {
            unique.push(candidate);
        }
    }
    apply_hard_candidate_exclusions(&mut unique, &product);
    tracing::info!(
        search_items = search_items.len(),
        candidates = unique.len(),
        batch_mode,
        "lead first-screen public search completed"
    );
    Ok(unique)
}

/// One independent AI pool. The frontend can publish each completed pool and
/// request another with exclusions, so a timeout never blanks earlier results.
#[tauri::command]
pub async fn ai_find_company_batch(
    state: State<'_, AppState>,
    product: String,
    market: String,
    buyer_type: String,
    focus: String,
    exclusions: Vec<String>,
) -> Result<Vec<PublicCompanyMatch>, PebbleError> {
    let exclusions = exclusions.into_iter().take(50).collect::<Vec<_>>().join(", ");
    let request = format!(
        "{product}\n本批次渠道重点：{focus}\n{}",
        if exclusions.is_empty() { String::new() } else { format!("必须排除已找到公司：{exclusions}") }
    );
    Ok(model_company_candidates(&state, &request, &market, &buyer_type).await)
}

// ─── Agent 驱动：开发客户 / 资信调研（Tool Calling）────────────────────────

/// Agent-driven lead discovery: the model autonomously searches the target
/// market (web_search / fetch_url / GLEIF), then returns a structured JSON
/// array of companies with contact details.
#[tauri::command]
pub async fn find_companies_agent(
    state: State<'_, AppState>,
    industry: String,
    market: String,
    keywords: Option<String>,
) -> Result<Vec<serde_json::Value>, PebbleError> {
    let market_text = market.trim();
    let industry_text = industry.trim();
    if industry_text.is_empty() && market_text.is_empty() {
        return Err(PebbleError::Validation("请输入行业和/或目标市场".to_string()));
    }
    // Keep this shareable across industries: product interpretation is supplied
    // dynamically by the caller for each search session. Never embed a product,
    // company or developer-specific example in the system prompt.
    let system = r#"你是资深B2B外贸客户开发研究员。请先读取用户本次提供的“动态产品理解卡”，再生成多组搜索策略并联网寻找真实、可核实的潜在客户。产品理解卡中的核心品类、必要限定、用途、相邻采购渠道和排除信号只属于本次任务，不能泛化成更宽的行业，也不能沿用其他任务的产品假设。

候选公司必须有真实公司身份和公开来源证据。分别核实其主营产品、采购/分销渠道、目标市场和与本次产品的契合点；仅因行业大类相同不能判为高匹配。若只命中相邻采购渠道，须明确写出仍待核实的产品匹配；命中排除信号时降级或排除。不得复述用户指令、参考邮件、附件原文、搜索策略或产品理解卡。

【硬性要求语言】所有描述性字段（description、background、products、reason、fitSummary、customerType、fitSignals、unknowns、contactRoles）**必须用中文输出**。即使公司来源是英法德日等市场、官网是外文，描述也必须翻译/归纳成中文，不允许原样保留英文/法文/德文描述——这样搜索结果界面统一中文、用户能直接读懂。专有名词（公司名 website/companyName、官网域名、英文行业术语如 importer/distributor）可保留原文，但描述主体必须是中文。

只输出严格JSON数组，不要markdown。每个元素字段为：companyName、website、country、customerType、description、background、products、reason、fitSummary、fitScore、fitSignals、unknowns、contactRoles、emails、source。fitScore为0到100；fitSignals只写有公开证据的匹配点；unknowns写待核实事实；emails只放公开找到的邮箱，找不到就用空数组。按研究计划覆盖多个渠道并按匹配度排序；继续搜索时避开用户列出的已有公司。信息充分或当前阶段预算用尽后立即输出。宁缺毋滥，禁止编造公司、网址、邮箱或业务事实。"#;
    let system = format!("{}\nAdditional output rules: include fitScore from 0 to 100, fitSignals as a short array of evidence-backed matches, and unknowns as a short array of facts that still need verification. Do not turn missing evidence into a positive claim.", system);
    let task_guidance = "Treat the supplemental user text as a natural-language lead-development brief, not just keywords. Extract target buyer type, positive fit signals, exclusion conditions, product use cases, purchasing signals, company/channel preferences, and unknowns to verify. Use the selected context only as evidence for research. Never echo that context in the final result. Build multiple search strategies, deduplicate company entities, and return only candidates with evidence of a real company identity.";
    let user = format!(
        "行业/产品：{}\n目标市场：{}\n{}",
        industry_text,
        market_text,
        keywords
            .clone()
            .filter(|k| !k.trim().is_empty())
            .map(|k| format!("补充关键词：{k}"))
            .unwrap_or_default()
    );

    let enriched_user = format!("{}\n\n{}", user, task_guidance);
    let result = tokio::time::timeout(
        Duration::from_secs(150),
        crate::commands::agent::run_agent_with_budget(
            &state,
            &system,
            &enriched_user,
            crate::commands::agent::AgentBudget { max_turns: 36, max_tool_calls: 32 },
        ),
    )
    .await
    .map_err(|_| PebbleError::Internal("开发客户联网搜索超过 150 秒，已停止本轮深度搜索，请稍后重试或缩小条件".to_string()))??;
    let mut array = parse_json_array(&result.content);
    if array.is_empty() {
        let preview: String = result.content.chars().take(400).collect();
        tracing::warn!(
            "find_companies_agent: no JSON array parsed; tool_calls={}, content={:?}",
            result.tool_calls,
            preview
        );
        // 工具代理可能在达到调用上限后只返回“思考轮数已用尽”，不能因此让页面变成空白。
        // 退回到同一套 AI+公开搜索+官网归一化管线，确保即使代理输出解析失败也能返回可用候选。
        let fallback_buyer_type = recognized_buyer_type(keywords.as_deref().unwrap_or_default());
        let fallback = ai_find_companies(
            state,
            industry_text.to_string(),
            market_text.to_string(),
            fallback_buyer_type.clone(),
        )
        .await?;
        let mut fallback_items = fallback
            .into_iter()
            .map(|item| {
                serde_json::json!({
                    "companyName": item.legal_name,
                    "website": item.website,
                    "country": item.country,
                    "customerType": fallback_buyer_type,
                    "description": item.description,
                    "reason": "已通过 AI 与公开来源归一化，建议继续核验官网和联系人",
                    "emails": item.public_emails,
                    "source": item.source_name,
                    "sourceUrl": item.source_url,
                })
            })
            .collect();
        sanitize_lead_output(&mut fallback_items);
        return Ok(fallback_items);
    }
    // The model is good at identifying companies but weak at finding public
    // mailboxes in a limited tool budget. Enrich the best candidates through
    // a deterministic discovery pipeline: official site pages, indexed public
    // pages and public search. Hunter verification requires an explicit user action. Every address
    // keeps its source and verification state; guessed permutations are never
    // presented as discovered email addresses.
    let proxy = get_global_proxy_raw(&state.crypto, &state.store)?;
    let email_client = TranslateService::http_client_with_proxy(proxy.as_ref())?;
    // Email discovery can fan out to several web pages per company. Keep the
    // first response fast and bounded instead of serially enriching 12 leads.
    for item in array.iter_mut().take(4) {
        let company_name = item.get("companyName").and_then(Value::as_str).unwrap_or_default();
        let website = item.get("website").and_then(Value::as_str).unwrap_or_default();
        if website.trim().is_empty() { continue; }
        let discovered = tokio::time::timeout(
            Duration::from_secs(25),
            discover_company_emails(&state, &email_client, company_name, website),
        ).await.unwrap_or_default();
        if discovered.is_empty() { continue; }
        let mut emails = item
            .get("emails")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut seen = emails
            .iter()
            .filter_map(Value::as_str)
            .map(|value| value.to_ascii_lowercase())
            .collect::<HashSet<_>>();
        for found in &discovered {
            if seen.insert(found.email.clone()) {
                emails.push(Value::String(found.email.clone()));
            }
        }
        if let Some(object) = item.as_object_mut() {
            object.insert("emails".into(), Value::Array(emails));
            object.insert(
                "emailEvidence".into(),
                serde_json::to_value(&discovered).unwrap_or_else(|_| Value::Array(Vec::new())),
            );
            object.insert(
                "emailDiscoverySummary".into(),
                Value::String(format!("发现 {} 个公开企业域名邮箱，已保留来源和验证状态", discovered.len())),
            );
        }
    }
    sanitize_lead_output(&mut array);
    Ok(array)
}

fn recognized_buyer_type(value: &str) -> String {
    let lower = value.to_lowercase();
    for (needles, label) in [
        (&["distributor", "经销商", "代理商"][..], "经销商"),
        (&["wholesaler", "批发商"][..], "批发商"),
        (&["importer", "进口商"][..], "进口商"),
        (&["retailer", "零售商"][..], "零售商"),
        (&["contractor", "承包商", "工程商"][..], "工程商/承包商"),
        (&["brand", "品牌商"][..], "品牌商"),
        (&["factory", "manufacturer", "工厂", "制造商"][..], "工厂"),
    ] {
        if needles.iter().any(|needle| lower.contains(needle)) { return label.to_string(); }
    }
    String::new()
}

fn sanitize_lead_output(items: &mut Vec<Value>) {
    const FORBIDDEN: &[&str] = &[
        "这是第", "不要重复", "补充关键词", "线索渠道", "用户指令",
        "参考邮件", "上下文内容", "查找跟", "排除那些", "给他们推销",
    ];
    items.retain_mut(|item| {
        let Some(object) = item.as_object_mut() else { return false; };
        let name = object.get("companyName").and_then(Value::as_str).unwrap_or_default().trim();
        if name.is_empty() { return false; }
        let description = object.get("description").and_then(Value::as_str).unwrap_or_default();
        let website = object.get("website").and_then(Value::as_str).unwrap_or_default();
        if is_non_customer_entity(name, description, website) { return false; }
        for key in ["customerType", "description", "background", "products", "reason", "fitSummary"] {
            let should_clear = object.get(key).and_then(Value::as_str).is_some_and(|text| {
                text.chars().count() > 1200 || FORBIDDEN.iter().any(|marker| text.contains(marker))
            });
            if should_clear { object.insert(key.to_string(), Value::String(String::new())); }
        }
        if let Some(emails) = object.get_mut("emails").and_then(Value::as_array_mut) {
            emails.retain(|value| value.as_str().is_some_and(is_usable_discovered_email));
            let mut seen = HashSet::new();
            emails.retain(|value| seen.insert(value.as_str().unwrap_or_default().to_ascii_lowercase()));
        }
        if let Some(evidence) = object.get_mut("emailEvidence").and_then(Value::as_array_mut) {
            evidence.retain(|value| value.get("email").and_then(Value::as_str).is_some_and(is_usable_discovered_email));
        }
        true
    });
}

/// Agent-driven deep credit/diligence research: the model autonomously digs
/// into a company (website, news, scale, GLEIF) and produces a structured
/// report suited for pre-order verification.
#[tauri::command]
pub async fn research_company_agent(
    state: State<'_, AppState>,
    company_name: String,
    website: Option<String>,
) -> Result<serde_json::Value, PebbleError> {
    let company = company_name.trim();
    if company.is_empty() {
        return Err(PebbleError::Validation("请输入公司名称".to_string()));
    }
    let system = "你是一名资深外贸资信调研专家。你的任务是对指定客户公司做下单前的深度尽调。
你可以使用 web_search / fetch_url / gleif_company 工具自主联网调研（公司官网、关于我们、新闻动态、LinkedIn、行业报道、GLEIF 法人信息等）。
最后必须输出严格 JSON 对象（不要 markdown、不要多余文字），结构：
{\"summary\":\"一句话结论\",\"companyProfile\":\"公司概况(成立时间/规模/所在国/主营)\",\"capability\":\"公司实力(工厂/资质/客户群/展会参展等证据)\",\"supplyChain\":\"采购与供应链线索(集中/分散采购、已知供应商或代工关系，找不到就说明)\",\"riskSignals\":\"风险信号(负面新闻/诉讼/失联风险/付款风险，无则写无)\",\"verification\":\"建议核实事项(如海关数据、银行信息、第三方验厂)\",\"verdict\":\"合作建议(建议合作/需谨慎/不建议)\",\"sources\":[\"信息来源网址\"]}
要求：
1. 只陈述有证据支撑的事实；推测必须标注(推测)。
2. 信息不足的字段写\"缺失：xxx\"，绝不编造。";
    let user = format!(
        "公司名称：{}\n{}",
        company,
        website
            .filter(|w| !w.trim().is_empty())
            .map(|w| format!("官网：{w}"))
            .unwrap_or_default()
    );

    let result = crate::commands::agent::run_agent(&state, system, &user).await?;
    let cleaned = result
        .content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let parsed: serde_json::Value = serde_json::from_str(cleaned).or_else(|_| {
        parse_json_array(&result.content)
            .first()
            .cloned()
            .ok_or_else(|| PebbleError::Translate("AI 未能解析出资信报告，请重试".to_string()))
    })?;
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::{email_domain_matches_company, email_evidence_belongs_to_company, fallback_search_candidates, find_companies, is_non_customer_entity, meta_description, public_emails, recognized_buyer_type, requests_china_exclusion, sanitize_lead_output, website_domain, EmailEvidence, WebSearchItem, LEAD_FINDER_DATA_KEY};

    #[test]
    fn extracts_meta_description_next_to_multibyte_text_without_panicking() {
        let prefix = "中文网页内容".repeat(31);
        let html = format!(
            "<html><head>{prefix}<meta name=\"description\" content=\"一家真实的照明设备经销企业\"></head></html>"
        );

        assert_eq!(meta_description(&html), "一家真实的照明设备经销企业");
    }

    #[test]
    fn extracts_plain_encoded_and_obfuscated_public_emails() {
        let emails = public_emails(
            r#"Contact sales@fixture-mail.invalid, support%40fixture-mail.invalid, export[at]fixture-mail.invalid or <a href="mailto:info%40fixture-mail.invalid">write us</a>."#,
        );
        assert!(emails.contains(&"sales@fixture-mail.invalid".to_string()));
        assert!(emails.contains(&"support@fixture-mail.invalid".to_string()));
        assert!(emails.contains(&"export@fixture-mail.invalid".to_string()));
        assert!(emails.contains(&"info@fixture-mail.invalid".to_string()));
        let key = 0x12u8;
        let encoded = format!("{key:02x}{}", "sales@fixture-mail.invalid".bytes().map(|byte| format!("{:02x}", byte ^ key)).collect::<String>());
        let cloudflare = public_emails(&format!(r#"<span data-cfemail="{encoded}">protected</span> contact[at]fixture-mail[dot]invalid"#));
        assert!(cloudflare.contains(&"sales@fixture-mail.invalid".to_string()));
        assert!(cloudflare.contains(&"contact@fixture-mail.invalid".to_string()));
    }

    #[test]
    fn recognizes_china_exclusion_as_a_hard_constraint() {
        for instruction in ["排除中国公司", "不要中国供应商", "中国公司除外", "exclude 中国公司", "exclude China companies", "non-China buyers"] {
            assert!(requests_china_exclusion(instruction), "not recognized: {instruction}");
        }
    }

    #[test]
    fn associations_and_directories_are_sources_not_customer_entities() {
        assert!(is_non_customer_entity(
            "National Gift Association",
            "Industry association member directory",
            "https://giftassociation.example/members",
        ));
        assert!(is_non_customer_entity("德国礼品商会", "会员名录", "https://example.org"));
        assert!(!is_non_customer_entity(
            "Ambiance Home",
            "A distributor of high-end furniture and home decor",
            "https://www.ambiancehome.com/contact/",
        ));
    }

    #[test]
    fn accepts_branded_mail_domain_without_requiring_exact_website_suffix() {
        assert!(email_domain_matches_company("info@ocambiance.com", "Ambiance Home"));
        assert!(!email_domain_matches_company("sales@unrelated-example.com", "Ambiance Home"));
    }

    #[test]
    fn same_name_mail_domains_require_verified_first_party_publication(){
        let mut item=EmailEvidence{email:"info@examplebotanical-albums.com".into(),source:"公司匹配结果页正文".into(),source_url:"https://examplebotanical-albums.com/contact".into(),confidence:None,verification:String::new(),email_type:String::new(),person:String::new(),suitability:String::new(),research:Default::default()};
        assert!(!email_evidence_belongs_to_company(&item,"Example Botanical","example-botanical.com",true));
        item.source="官网同站深挖".into();assert!(!email_evidence_belongs_to_company(&item,"Example Botanical","example-botanical.com",true));
        item.source_url="https://example-botanical.com/contact".into();assert!(email_evidence_belongs_to_company(&item,"Example Botanical","example-botanical.com",true));
        assert!(!email_evidence_belongs_to_company(&item,"Example Botanical","example-botanical.com",false));
        item.email="owner@gmail.com".into();assert!(email_evidence_belongs_to_company(&item,"Example Botanical","example-botanical.com",true));
        item.source_url="https://example-botanical.com.unrelated.invalid/contact".into();assert!(!email_evidence_belongs_to_company(&item,"Example Botanical","example-botanical.com",true));
        item.email="info@example-botanical.com".into();assert!(email_evidence_belongs_to_company(&item,"Example Botanical","example-botanical.com",true));
    }

    #[test]
    fn generic_category_words_do_not_bind_unrelated_email_domains() {
        assert!(!email_domain_matches_company("hello@ifdesign.com", "Scandinavian Design Center"));
        assert!(!email_domain_matches_company("service.tw@eifdesign.com", "Scandinavian Design Center"));
        assert!(email_domain_matches_company("hello@scandinaviandesign.com", "Scandinavian Design Center"));
    }

    #[test]
    fn normalizes_company_website_domain() {
        assert_eq!(website_domain("https://www.example.com/contact"), "example.com");
        assert_eq!(website_domain("example.co.uk"), "example.co.uk");
    }

    #[test]
    fn fallback_does_not_use_the_whole_instruction_as_customer_type() {
        assert_eq!(recognized_buyer_type("找德国 importer，并排除零售店"), "进口商");
        assert_eq!(recognized_buyer_type("这是第 2 页，不要重复公司"), "");
    }

    #[test]
    fn removes_instruction_echo_from_lead_fields() {
        let mut items = vec![serde_json::json!({
            "companyName": "Example Ltd",
            "customerType": "查找跟精密工具有关的进口商，给他们推销",
            "description": "A real company"
        })];
        sanitize_lead_output(&mut items);
        assert_eq!(items[0]["customerType"], "");
        assert_eq!(items[0]["description"], "A real company");
    }

    #[test]
    fn raw_search_fallback_keeps_company_identity_and_rejects_content_pages() {
        let items = vec![
            WebSearchItem {
                title: "Acme Lighting Ltd | Wholesale Distributor".into(),
                url: "https://acme-lighting.example/about-us".into(),
                description: "Acme Lighting Ltd is a wholesale distributor and importer.".into(),
            },
            WebSearchItem {
                title: "Top 100 crystal night lights - buy now".into(),
                url: "https://shop.example/products/crystal-night-light".into(),
                description: "$29.99 free shipping, 1000 sold".into(),
            },
            WebSearchItem {
                title: "Lamp".into(),
                url: "https://generic.example/".into(),
                description: "30W COB down light".into(),
            },
            WebSearchItem {
                title: "Daily News - Home".into(),
                url: "https://daily-news.example/".into(),
                description: "Latest newspaper headlines".into(),
            },
        ];

        let result = fallback_search_candidates(&items, "lighting", "Germany", "distributor");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].legal_name, "Acme Lighting Ltd");
    }

    #[test]
    fn raw_search_fallback_uses_task_terms_not_a_fixed_product_industry() {
        let items = vec![
            WebSearchItem {
                title: "Example Pumps Ltd".into(),
                url: "https://pumps.example/about".into(),
                description: "Industrial pump engineering company".into(),
            },
            WebSearchItem {
                title: "Example Floral Ltd".into(),
                url: "https://floral.example/about".into(),
                description: "Floral gift and home decor company".into(),
            },
            WebSearchItem {
                title: "Example Metals Ltd".into(),
                url: "https://metals.example/about".into(),
                description: "Metal component procurement specialist company".into(),
            },
        ];
        let pumps = fallback_search_candidates(&items, "industrial pump", "", "");
        assert_eq!(pumps.len(), 1);
        assert_eq!(pumps[0].legal_name, "Example Pumps Ltd");
        let floral = fallback_search_candidates(&items, "floral gift", "", "");
        assert_eq!(floral.len(), 1);
        assert_eq!(floral[0].legal_name, "Example Floral Ltd");
        let requested_role = fallback_search_candidates(&items, "precision tools", "", "procurement specialist");
        assert_eq!(requested_role.len(), 1);
        assert_eq!(requested_role[0].legal_name, "Example Metals Ltd");
        assert!(fallback_search_candidates(&items, "medical scanner", "", "").is_empty());
    }

    #[test]
    fn raw_search_fallback_applies_relevance_and_explicit_china_exclusion() {
        let items = vec![
            WebSearchItem {
                title: "Yunnan Preserved Flower Co., Ltd".into(),
                url: "https://yunnanflowers.example/about".into(),
                description: "China preserved flower wholesaler".into(),
            },
            WebSearchItem {
                title: "Luxury Casino Resort LLC".into(),
                url: "https://casino.example/about".into(),
                description: "Hotel, casino and entertainment company".into(),
            },
            WebSearchItem {
                title: "Independent Floral Gifts Ltd".into(),
                url: "https://floralgifts.example/about-us".into(),
                description: "Independent floral gift importer and wholesaler".into(),
            },
        ];

        let result = fallback_search_candidates(
            &items,
            "preserved flower lamp exclude china 排除中国公司",
            "",
            "importer",
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].legal_name, "Independent Floral Gifts Ltd");
    }

    /// End-to-end diagnostic for a real local profile. It is ignored during
    /// normal test runs and logs only public candidate fields, never the
    /// user's prompt, AI credentials, or private reference documents.
    #[tokio::test]
    #[ignore]
    async fn replay_latest_saved_lead_search() {
        let profile = std::env::var("PEBBLE_PROFILE_DIR")
            .expect("PEBBLE_PROFILE_DIR must point to the profile being diagnosed");
        let store = pebble_store::Store::open(
            &std::path::Path::new(&profile).join("db").join("pebble.db"),
        ).expect("open profile database");
        let crypto = pebble_crypto::CryptoService::init().expect("initialize profile crypto");
        let encrypted = store
            .get_secure_user_data(LEAD_FINDER_DATA_KEY)
            .expect("load encrypted lead history")
            .expect("lead history exists");
        let data: serde_json::Value = serde_json::from_slice(
            &crypto.decrypt(&encrypted).expect("decrypt lead history"),
        ).expect("parse lead history");
        let latest = &data["searchSessions"][0];
        let brief = &latest["productBrief"];
        let strings = |field: &str, limit: usize| {
            brief[field]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|value| value.as_str())
                .take(limit)
                .collect::<Vec<_>>()
                .join(" OR ")
        };
        let product = [
            brief["coreCategory"].as_str().unwrap_or_default().to_string(),
            strings("searchAliases", 5),
            strings("adjacentBuyerChannels", 3),
            format!("exclude {}", strings("exclusionSignals", 5)),
            latest["buyerType"].as_str().unwrap_or_default().to_string(),
            latest["market"].as_str().unwrap_or_default().to_string(),
            "distributor wholesaler importer; industry association member directory; trade show exhibitor buyer; import data buyer consignee".to_string(),
        ].into_iter().filter(|value| !value.trim().is_empty()).collect::<Vec<_>>().join("\n");

        let temp_root = std::env::temp_dir().join(format!(
            "pebble-lead-replay-{}",
            std::process::id()
        ));
        let search = pebble_search::TantivySearch::open(&temp_root.join("search"))
            .expect("open temporary search index");
        let (snooze_tx, _snooze_rx) = std::sync::mpsc::channel();
        let state = crate::state::AppState::new(
            store,
            search,
            crypto,
            snooze_tx,
            temp_root.join("attachments"),
        );
        let started = std::time::Instant::now();
        let results = find_companies(
            &state,
            product,
            latest["market"].as_str().unwrap_or_default().to_string(),
            latest["buyerType"].as_str().unwrap_or_default().to_string(),
        ).await.expect("replay lead discovery");

        println!(
            "LEAD_REPLAY_RESULT elapsed_ms={} candidates={}",
            started.elapsed().as_millis(),
            results.len()
        );
        for item in results {
            println!(
                "LEAD_REPLAY_CANDIDATE name={:?} website={:?} source={:?}",
                item.legal_name, item.website, item.source_name
            );
        }
    }
}
    #[test]
    fn ofac_aliases_are_parsed_but_corrupt_documents_are_not_a_clearance() {
        let raw=r#"<sdnList><publshInformation><Publish_Date>2026-10-18</Publish_Date></publshInformation><sdnEntry><uid>12</uid><lastName>Example Trading</lastName><akaList><aka><uid>77</uid><lastName>Other Example</lastName></aka></akaList><addressList><address><country>Example Country</country></address></addressList></sdnEntry></sdnList>"#;
        let (date,rows)=self::parse_ofac_xml(raw).unwrap();assert_eq!(date,"2026-10-18");assert_eq!(rows.len(),1);assert_eq!(rows[0]["id"],"12");assert_eq!(rows[0]["names"][1],"Other Example");assert_eq!(rows[0]["countries"][0],"Example Country");
        for invalid in ["<html>unavailable</html>","<sdnList></sdnList>",&raw[..raw.len()-10],"<!DOCTYPE sdnList [<!ENTITY x SYSTEM 'file:///private'>]><sdnList/>"]{assert!(self::parse_ofac_xml(invalid).is_err());}
    }
