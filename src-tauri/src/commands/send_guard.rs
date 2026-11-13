use crate::commands::network::get_global_proxy_raw;
use crate::commands::translate::decrypt_config;
use crate::state::AppState;
use pebble_core::{FolderRole, PebbleError};
use pebble_translate::types::TranslateProviderConfig;
use pebble_translate::TranslateService;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tauri::State;

/// Key under which the send-guard config (enabled + mode) is stored.
const GUARD_CONFIG_KEY: &str = "send_guard_config";
/// Key under which the per-contact role map is stored (encrypted user data KV).
const CONTACT_ROLES_KEY: &str = "send_guard_roles";
/// Cap on how many contacts the full-AI bulk pass will touch in one run.
const BULK_AI_LIMIT: usize = 400;

// ─── Data model ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ContactRole {
    /// A buyer / distributor / end-customer we sell to.
    Customer,
    /// A factory / manufacturer / supplier we buy from or subcontract.
    Supplier,
    /// Third-party service provider: freight forwarder, customs broker, carrier,
    /// inspection / certification body (SGS, BV, Intertek, TUV, CE/ROHS), bank,
    /// B2B platform, insurer, translator. Never involved in the
    /// customer/factory mix-up, so the guard always skips them.
    Service,
    /// Internal / our own address — never warn.
    Neutral,
    /// Not yet classified.
    Unknown,
}

impl ContactRole {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            ContactRole::Customer => "customer",
            ContactRole::Supplier => "supplier",
            ContactRole::Service => "service",
            ContactRole::Neutral => "neutral",
            ContactRole::Unknown => "unknown",
        }
    }
    fn from_str(s: &str) -> ContactRole {
        match s {
            "customer" => ContactRole::Customer,
            "supplier" => ContactRole::Supplier,
            "service" => ContactRole::Service,
            "neutral" => ContactRole::Neutral,
            _ => ContactRole::Unknown,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GuardMode {
    /// Soft warning: user may still send after confirming.
    Soft,
    /// Strict: high-confidence mismatches block send (override still possible).
    Strict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendGuardConfig {
    pub enabled: bool,
    pub mode: GuardMode,
}

impl Default for SendGuardConfig {
    fn default() -> Self {
        SendGuardConfig {
            enabled: false,
            mode: GuardMode::Soft,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RoleSource {
    /// Set by the user in settings (a correction on top of AI).
    Manual,
    /// Produced by AI / heuristic inference.
    Inferred,
    /// Imported from an existing customer memory.
    Imported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactRoleEntry {
    pub email: String,
    pub role: ContactRole,
    pub source: RoleSource,
    /// 0..1 confidence of the inferred role (1.0 for manual).
    #[serde(default)]
    pub confidence: f32,
    /// Short human-readable reasons behind the classification.
    #[serde(default)]
    pub reasons: Vec<String>,
    /// Unix seconds when this entry was last computed.
    #[serde(default)]
    pub inferred_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipientRole {
    pub email: String,
    pub role: ContactRole,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendGuardVerdict {
    /// "ok" | "warn" | "block"
    pub level: String,
    pub reasons: Vec<String>,
    pub recipients: Vec<RecipientRole>,
    /// What the draft looks like it is intended for: "customer" | "supplier" | "unknown".
    #[serde(default)]
    pub draft_intent: String,
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn load_config(state: &AppState) -> SendGuardConfig {
    match state.store.get_secure_user_data(GUARD_CONFIG_KEY) {
        Ok(Some(enc)) => match state.crypto.decrypt(&enc) {
            Ok(plain) => serde_json::from_slice(&plain).unwrap_or_default(),
            Err(_) => SendGuardConfig::default(),
        },
        _ => SendGuardConfig::default(),
    }
}

fn save_config(state: &AppState, cfg: &SendGuardConfig) -> std::result::Result<(), PebbleError> {
    let plain = serde_json::to_vec(cfg)
        .map_err(|e| PebbleError::Internal(format!("Failed to serialize guard config: {e}")))?;
    let enc = state.crypto.encrypt(&plain)?;
    state.store.set_secure_user_data(GUARD_CONFIG_KEY, &enc)
}

pub(crate) fn load_roles(state: &AppState) -> Vec<ContactRoleEntry> {
    match state.store.get_secure_user_data(CONTACT_ROLES_KEY) {
        Ok(Some(enc)) => match state.crypto.decrypt(&enc) {
            Ok(plain) => serde_json::from_slice(&plain).unwrap_or_default(),
            Err(_) => Vec::new(),
        },
        _ => Vec::new(),
    }
}

pub(crate) fn save_roles(
    state: &AppState,
    roles: &[ContactRoleEntry],
) -> std::result::Result<(), PebbleError> {
    let plain = serde_json::to_vec(roles)
        .map_err(|e| PebbleError::Internal(format!("Failed to serialize contact roles: {e}")))?;
    let enc = state.crypto.encrypt(&plain)?;
    state.store.set_secure_user_data(CONTACT_ROLES_KEY, &enc)
}

fn role_index(roles: &[ContactRoleEntry]) -> HashMap<String, usize> {
    roles
        .iter()
        .enumerate()
        .map(|(i, r)| (r.email.trim().to_lowercase(), i))
        .collect()
}

pub(crate) fn set_manual_contact_role(
    state: &AppState,
    email: &str,
    role: ContactRole,
) -> std::result::Result<(), PebbleError> {
    let email = email.trim().to_string();
    if email.is_empty() {
        return Err(PebbleError::Validation("邮箱不能为空".to_string()));
    }
    let mut roles = load_roles(state);
    let email_lc = email.to_lowercase();
    match roles.iter_mut().find(|entry| entry.email.to_lowercase() == email_lc) {
        Some(existing) => {
            existing.role = role;
            existing.source = RoleSource::Manual;
            existing.confidence = 1.0;
            existing.reasons = vec!["在地址本中手动标记".to_string()];
            existing.inferred_at = now_secs();
        }
        None => roles.push(ContactRoleEntry {
            email,
            role,
            source: RoleSource::Manual,
            confidence: 1.0,
            reasons: vec!["在地址本中手动标记".to_string()],
            inferred_at: now_secs(),
        }),
    }
    save_roles(state, &roles)
}

pub(crate) fn delete_stored_contact_role(
    state: &AppState,
    email: &str,
) -> std::result::Result<(), PebbleError> {
    let email_lc = email.trim().to_lowercase();
    let mut roles = load_roles(state);
    roles.retain(|entry| entry.email.to_lowercase() != email_lc);
    save_roles(state, &roles)
}

// ─── Commands: config ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_send_guard_config(
    state: State<'_, AppState>,
) -> std::result::Result<SendGuardConfig, PebbleError> {
    Ok(load_config(&state))
}

#[tauri::command]
pub async fn set_send_guard_config(
    state: State<'_, AppState>,
    config: SendGuardConfig,
) -> std::result::Result<SendGuardConfig, PebbleError> {
    save_config(&state, &config)?;
    Ok(config)
}

// ─── Commands: contact roles ───────────────────────────────────────────────────

#[tauri::command]
pub async fn list_contact_roles(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<ContactRoleEntry>, PebbleError> {
    Ok(load_roles(&state))
}

#[tauri::command]
pub async fn set_contact_role(
    state: State<'_, AppState>,
    email: String,
    role: String,
) -> std::result::Result<Vec<ContactRoleEntry>, PebbleError> {
    let email = email.trim().to_string();
    if email.is_empty() {
        return Err(PebbleError::Internal("邮箱不能为空".to_string()));
    }
    set_manual_contact_role(&state, &email, ContactRole::from_str(&role))?;
    Ok(load_roles(&state))
}

#[tauri::command]
pub async fn delete_contact_role(
    state: State<'_, AppState>,
    email: String,
) -> std::result::Result<Vec<ContactRoleEntry>, PebbleError> {
    delete_stored_contact_role(&state, &email)?;
    let roles = load_roles(&state);
    Ok(roles)
}

// ─── Multi-dimensional signal extraction (cheap, no AI) ────────────────────────

/// Domain fragments that identify a third-party SERVICE provider rather than a
/// trading counterparty. Split by trade so the reason string can be specific.
fn service_domain_groups() -> &'static [(&'static str, &'static [&'static str])] {
    &[
        (
            "货代/物流/船公司",
            &[
                "logistic", "freight", "forwarder", "forwarding", "shipping", "shipline",
                "cargo", "transport", "express", "courier", "supplychain", "warehous",
                "dhl", "fedex", "ups.com", "tnt", "maersk", "cosco", "msc.com", "evergreen",
                "oocl", "hapag", "cma-cgm", "sinotrans", "kuehne", "dsv", "expeditors",
                "yusen", "kerrylogistics", "jas.com", "sfexpress", "yto", "shunfeng",
            ],
        ),
        (
            "报关/清关",
            &["customs", "broker", "clearance", "declaration", "baoguan", "报关"],
        ),
        (
            "认证/检验机构",
            &[
                "sgs", "bureauveritas", "bureau-veritas", "intertek", "tuv", "tuv-sud",
                "tuvsud", "tuvrheinland", "rheinland", "dekra", "ul.com", "ulprospector",
                "eurofins", "dnv", "lloyd", "ccic", "cqc", "certification", "certif",
                "inspection", "testing", "labtest", "compliance", "notifiedbody",
                "认证", "检测",
            ],
        ),
        (
            "银行/保险/金融",
            &[
                "bank", "hsbc", "citibank", "standardchartered", "dbs.com", "paypal",
                "payoneer", "wise.com", "westernunion", "sinosure", "insurance", "pingan",
                "icbc", "boc.cn", "ccb.com", "cmbchina", "abchina",
            ],
        ),
        (
            "B2B平台/服务商",
            &[
                "alibaba", "aliyun", "made-in-china", "globalsources", "1688", "amazon",
                "ebay.com", "shopify", "linkedin", "gmail-noreply", "noreply", "no-reply",
                "mailer-daemon", "notification", "support@", "service@", "billing",
                "invoice@", "newsletter",
            ],
        ),
        (
            "展会/咨询/其他服务",
            &[
                "cantonfair", "fairtrade", "expo", "exhibition", "canton-fair", "messe",
                "consult", "lawfirm", "attorney", "translat", "accounting", "audit",
                "trademark", "patent", "ipoffice",
            ],
        ),
    ]
}

/// Returns Some(trade label) when the address clearly belongs to a service provider.
fn service_hit(email: &str) -> Option<&'static str> {
    let lower = email.to_lowercase();
    let (domain, _) = email_domain(&lower);
    for (label, kws) in service_domain_groups() {
        for k in *kws {
            // Platform/system markers may appear in the local part (support@, noreply@).
            let hay: &str = if k.contains('@') || k.starts_with("no") {
                &lower
            } else {
                &domain
            };
            if hay.contains(k) {
                return Some(label);
            }
        }
    }
    None
}

/// Automated/system senders and obvious abuse addresses are not business
/// contacts. Keep them unclassified instead of dressing them up as a customer,
/// supplier or service provider.
fn ignored_sender_hit(email: &str) -> Option<&'static str> {
    let local = email
        .split('@')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let markers = [
        "noreply", "no-reply", "do-not-reply", "donotreply", "mailer-daemon",
        "postmaster", "bounce", "bounces", "abuse", "phishing", "spam", "newsletter",
        "notification", "notifications", "alert", "alerts",
    ];
    markers
        .iter()
        .find(|marker| local == **marker || local.starts_with(&format!("{marker}.")))
        .copied()
}

fn suspicious_message_signals(subject: &str, body: &str) -> usize {
    let text = format!("{subject}\n{body}").to_lowercase();
    [
        "verify your account", "account will be suspended", "password expires",
        "unusual sign-in", "unusual activity", "click here immediately", "claim your prize",
        "lottery winner", "gift card", "cryptocurrency investment", "wallet address",
        "bank account has changed", "update payment details", "wire funds urgently",
        "确认您的账户", "账户将被停用", "密码即将过期", "异常登录", "点击链接验证",
        "中奖", "领取奖金", "虚拟货币投资", "收款账户已变更", "紧急汇款",
    ]
    .iter()
    .filter(|signal| text.contains(**signal))
    .count()
}

/// Content words typical of service-provider correspondence (freight, customs,
/// certification, banking). Used as a secondary signal on message history.
fn service_corpus_words() -> &'static [&'static str] {
    &[
        "bill of lading", "b/l", "booking", "container", "etd", "eta", "vessel", "sailing",
        "customs clearance", "hbl", "mbl", "telex release", "demurrage", "chargeable weight",
        "awb", "airway bill", "inspection report", "test report", "certificate of conformity",
        "ce marking", "rohs", "reach", "iso 9001", "audit report", "swift", "remittance",
        "letter of credit issuing", "beneficiary",
        "订舱", "提单", "报关", "清关", "柜", "船期", "报关单", "熏蒸", "产地证",
        "验货报告", "检测报告", "认证证书", "年审", "工厂审核", "水单", "汇款", "结汇",
        "退税", "保险单", "报检",
    ]
}

fn email_domain(email: &str) -> (String, String) {
    let domain = email
        .rsplit('@')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let tld = domain
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase();
    // handle two-level ccTLDs like co.uk / com.cn
    let tld = if let Some(prev) = domain.rsplit('.').nth(1) {
        match (prev, tld.as_str()) {
            ("co", "uk") | ("com", "cn") | ("com", "br") | ("co", "in") | ("com", "mx")
            | ("com", "au") | ("co", "kr") | ("com", "za") => format!("{}.{}", prev, tld),
            _ => tld,
        }
    } else {
        tld
    };
    (domain, tld)
}

/// Lightweight, AI-free role guess purely from the email address.
/// Returns (role, confidence 0..1, reasons).
fn cheap_role_from_address(email: &str) -> (ContactRole, f32, Vec<String>) {
    let (domain, _) = email_domain(email);
    if domain.is_empty() {
        return (ContactRole::Unknown, 0.0, vec![]);
    }
    if let Some(marker) = ignored_sender_hit(email) {
        return (
            ContactRole::Unknown,
            0.0,
            vec![format!("系统/群发地址特征（{marker}），不自动归入业务联系人")],
        );
    }
    // Service providers are checked FIRST: a freight forwarder on a .cn domain
    // would otherwise be mislabelled as a factory and trigger false alarms.
    if let Some(label) = service_hit(email) {
        return (
            ContactRole::Service,
            0.9,
            vec![format!("邮箱域名匹配{label}特征，判定为第三方服务商（不参与客户/工厂发错判断）")],
        );
    }
    // Country suffix, language, public mailbox provider and words in a domain
    // are not proof of the commercial relationship. In particular, .cn must
    // never mean "supplier". Customer/supplier needs correspondence evidence.
    (
        ContactRole::Unknown,
        0.0,
        vec!["邮箱地址本身不能证明客户或供应商关系，需要结合往来内容".to_string()],
    )
}

// ─── Lexicons for content-based judgment ───────────────────────────────────────

/// Words that, in the OUTGOING DRAFT, signal a "selling to customer" intent.
fn draft_customer_words() -> &'static [&'static str] {
    &[
        "we can supply", "our price", "quotation for you", "we will ship", "proforma invoice",
        "your order", "attached catalog", "customize for you", "your market", "your logo",
        "fob", "cif", "moq", "we are pleased to quote", "quote you", "ship to your",
        "报价", "贵司", "贵公司", "您的市场", "形式发票", "发货", "目录", "定制", "您下单",
        "我们可以供货", "我司报价", "为您报价",
    ]
}

/// Words that, in the OUTGOING DRAFT, signal a "sourcing from factory" intent.
fn draft_supplier_words() -> &'static [&'static str] {
    &[
        "please quote", "your factory", "your cost", "ex-factory price", "production schedule",
        "tooling cost", "mold cost", "raw material", "lead time", "can you produce",
        "our order to you", "deposit", "tooling", "mould", "capacity", "your workshop",
        "请报价", "贵厂", "成本", "出厂价", "产线", "工价", "模具", "原材料", "交期",
        "产能", "定金", "尾款", "贵司工厂", "你们工厂",
    ]
}

/// A message received from a buyer/customer asking us to sell or quote.
fn incoming_customer_words() -> &'static [&'static str] {
    &[
        "please quote", "send your quotation", "we are interested", "interested in your",
        "we would like to buy", "we want to buy", "need your price", "price list", "catalog",
        "catalogue", "minimum order", "moq", "sample", "place an order", "purchase order",
        "our market", "our stores", "our customers", "our warehouse", "delivery to",
        "请报价", "询价", "采购", "有兴趣", "价格表", "目录", "样品", "起订量", "下单",
    ]
}

/// A message received from a factory/supplier offering production and cost.
fn incoming_supplier_words() -> &'static [&'static str] {
    &[
        "our quotation", "our price", "unit price", "ex-factory", "factory price",
        "production schedule", "production lead time", "our factory", "our workshop",
        "our capacity", "raw material", "tooling cost", "mold cost", "mould cost",
        "报价单", "我司报价", "出厂价", "单价", "成本", "排产", "生产交期", "工厂",
        "车间", "产能", "原材料", "模具费", "加工费",
    ]
}

fn count_signals(text: &str, signals: &[&str]) -> usize {
    let lower = text.to_lowercase();
    signals.iter().filter(|s| lower.contains(*s)).count()
}

/// Intent of a draft: are we selling to a customer, or sourcing from a factory?
fn draft_intent(text: &str) -> (String, Vec<String>) {
    let cust = count_signals(text, draft_customer_words());
    let supp = count_signals(text, draft_supplier_words());
    if cust >= 2 && cust > supp {
        (
            "customer".to_string(),
            vec![format!("草稿含 {cust} 处销售/对客户用语（报价、发货、定制等）")],
        )
    } else if supp >= 2 && supp > cust {
        (
            "supplier".to_string(),
            vec![format!("草稿含 {supp} 处采购/对工厂用语（成本、产线、模具等）")],
        )
    } else {
        ("unknown".to_string(), vec![])
    }
}

// ─── Command: light auto-classify all contacts (free, instant) ─────────────────

/// Classify only unmistakable third-party service contacts from the address.
/// This is the "lightweight, no-burden" pass that runs automatically when the
/// guard is enabled. Country/TLD/mailbox-provider guesses are intentionally
/// forbidden; customer/supplier requires correspondence evidence.
#[tauri::command]
pub async fn auto_classify_contacts(
    state: State<'_, AppState>,
    account_id: String,
) -> std::result::Result<Vec<ContactRoleEntry>, PebbleError> {
    let contacts = state
        .store
        .list_known_contacts(&account_id, "", 2000)
        .unwrap_or_default();

    let mut roles = load_roles(&state);
    let mut index = role_index(&roles);
    let ts = now_secs();

    for c in contacts {
        let email = c.address.trim().to_lowercase();
        if email.is_empty() {
            continue;
        }
        let (role, conf, reasons) = cheap_role_from_address(&email);
        if let Some(&i) = index.get(&email) {
            // The user's own correction always wins.
            if roles[i].source == RoleSource::Manual {
                continue;
            }
            // A service provider match repairs an earlier mis-label: a freight
            // forwarder on a .cn domain used to be tagged as a factory, which
            // caused false alarms. Otherwise keep the existing judgment.
            let repairs_mislabel =
                role == ContactRole::Service && roles[i].role != ContactRole::Service;
            if roles[i].role != ContactRole::Unknown && !repairs_mislabel {
                continue;
            }
        }
        if role == ContactRole::Unknown {
            continue; // light pass only fills confident cases
        }
        let entry = ContactRoleEntry {
            email: c.address.clone(),
            role,
            source: RoleSource::Inferred,
            confidence: conf,
            reasons,
            inferred_at: ts,
        };
        match index.get(&email).copied() {
            Some(i) => roles[i] = entry,
            None => {
                roles.push(entry);
                index.insert(email, roles.len() - 1);
            }
        }
    }
    save_roles(&state, &roles)?;
    Ok(roles)
}

// ─── Command: full multi-dimensional AI inference for ONE contact ──────────────

/// Core multi-dimensional role inference shared by the single and bulk commands.
///
/// Dimensions: L1 address signals, L2 historical language + trade direction,
/// then L3 AI semantic judgment that weighs all of the above. Falls back to a
/// rule-based heuristic when no LLM is configured or the call fails.
async fn resolve_contact_role(
    state: &AppState,
    account_id: &str,
    email: &str,
    allow_web_research: bool,
) -> std::result::Result<ContactRoleEntry, PebbleError> {
    let email = email.trim().to_string();
    if email.is_empty() {
        return Err(PebbleError::Internal("邮箱不能为空".to_string()));
    }
    let email_lc = email.to_lowercase();
    let ts = now_secs();

    // Gather a corpus of recent messages involving this contact.
    let search = state.search.clone();
    let q = email.clone();
    let hits = tokio::task::spawn_blocking(move || search.search(&q, 40))
        .await
        .map_err(|e| PebbleError::Internal(format!("Search task join error: {e}")))??;
    let all_ids: Vec<String> = hits.iter().map(|h| h.message_id.clone()).collect();
    let ignored_folder_ids: HashSet<String> = state
        .store
        .list_folders(account_id)
        .unwrap_or_default()
        .into_iter()
        .filter(|folder| {
            matches!(
                folder.role,
                Some(FolderRole::Spam | FolderRole::Trash | FolderRole::Drafts)
            )
        })
        .map(|folder| folder.id)
        .collect();
    let folder_map = state
        .store
        .get_message_folder_ids_batch(&all_ids)
        .unwrap_or_default();
    let ids: Vec<String> = all_ids
        .into_iter()
        .filter(|id| {
            !folder_map
                .get(id)
                .is_some_and(|folders| folders.iter().any(|folder| ignored_folder_ids.contains(folder)))
        })
        .collect();
    let messages = state.store.get_messages_batch(&ids)?;

    let own_email = state
        .store
        .get_account(&account_id)
        .ok()
        .flatten()
        .map(|a| a.email.trim().to_lowercase())
        .unwrap_or_default();

    let mut corpus = String::new();
    let mut direction_score: f32 = 0.0; // >0 customer, <0 supplier
    let mut service_signals = 0usize;
    let mut trade_signals = 0usize;
    let mut suspicious_messages = 0usize;
    for m in &messages {
        let involves = m.from_address.to_lowercase() == email_lc
            || m.to_list
                .iter()
                .any(|a| a.address.to_lowercase() == email_lc);
        if !involves {
            continue;
        }
        let body = m.body_text.trim();
        if body.len() < 15 {
            continue;
        }
        if suspicious_message_signals(&m.subject, body) >= 2 {
            suspicious_messages += 1;
            continue;
        }
        let is_outgoing = m.from_address.trim().eq_ignore_ascii_case(&own_email)
            && !own_email.is_empty();
        let lower = body.to_lowercase();
        let (c, s) = if is_outgoing {
            (
                count_signals(&lower, draft_customer_words()) as f32,
                count_signals(&lower, draft_supplier_words()) as f32,
            )
        } else {
            (
                count_signals(&lower, incoming_customer_words()) as f32,
                count_signals(&lower, incoming_supplier_words()) as f32,
            )
        };
        service_signals += count_signals(&lower, service_corpus_words());
        trade_signals += (c + s) as usize;
        direction_score += c - s;
        corpus.push_str(&format!(
            "[{}]\n主题: {}\n{}\n\n",
            if is_outgoing { "我方发出" } else { "对方发来" },
            m.subject,
            body
        ));
        if corpus.len() >= 6000 {
            break;
        }
    }

    // L1 + L2 structured signal summary (feeds the AI as context).
    let (addr_role, addr_conf, addr_reasons) = cheap_role_from_address(&email);

    // Content-level service detection: correspondence dominated by booking /
    // customs / inspection / banking vocabulary means a service provider even
    // when the domain looks like an ordinary company.
    let content_is_service = service_signals >= 3 && service_signals > trade_signals;
    if addr_role == ContactRole::Service || content_is_service {
        let mut reasons = if addr_reasons.is_empty() {
            Vec::new()
        } else {
            addr_reasons.clone()
        };
        if content_is_service {
            reasons.push(format!(
                "往来邮件含 {service_signals} 处订舱/报关/检验认证/结汇类用语，属于第三方服务往来"
            ));
        }
        return Ok(ContactRoleEntry {
            email,
            role: ContactRole::Service,
            source: RoleSource::Inferred,
            confidence: if addr_role == ContactRole::Service { 0.9 } else { 0.8 },
            reasons,
            inferred_at: ts,
        });
    }

    let mut signal_summary = String::new();
    signal_summary.push_str(&format!(
        "邮箱地址特征: {}\n按收发方向提取的交易关系分数(>0偏客户, <0偏供应商): {:.1}\n有效交易用语: {} 处\n服务类用语: {} 处（订舱/报关/检验/结汇）\n已排除的疑似垃圾/欺诈邮件: {} 封\n",
        addr_reasons.join("；"),
        direction_score,
        trade_signals,
        service_signals,
        suspicious_messages
    ));

    // Resolve a friendly name from the contacts index.
    let name = state
        .store
        .list_known_contacts(&account_id, &email, 1)
        .ok()
        .and_then(|mut v| v.pop())
        .and_then(|c| c.name)
        .unwrap_or_default();

    let initial = if corpus.trim().is_empty() {
        let mut reasons = addr_reasons;
        reasons.push(if suspicious_messages > 0 {
            "现有样本均疑似垃圾、欺诈或系统邮件，已排除并保持未分类".to_string()
        } else {
            "没有可用的正常往来邮件，不能仅凭域名或国家判断".to_string()
        });
        (ContactRole::Unknown, RoleSource::Inferred, 0.0, reasons)
    } else if let Some(cfg) = try_load_provider(&state) {
        match ai_classify_role(&state, &cfg, &email, &name, &signal_summary, &corpus).await {
            Ok((role, source, confidence, reasons))
                if !matches!(role, ContactRole::Customer | ContactRole::Supplier)
                    || confidence >= 0.72 => (role, source, confidence, reasons),
            Ok((_role, _source, confidence, mut reasons)) => {
                reasons.push(format!("模型置信度仅 {:.0}%，为避免误判暂不分类", confidence * 100.0));
                (ContactRole::Unknown, RoleSource::Inferred, confidence, reasons)
            }
            Err(_) => heuristic_role(direction_score, addr_role, addr_conf, addr_reasons),
        }
    } else {
        heuristic_role(direction_score, addr_role, addr_conf, addr_reasons)
    };

    // Search is deliberately the LAST resort and is budgeted by the bulk
    // caller. It only runs when normal correspondence analysis stayed unknown,
    // and only a high-confidence result is accepted.
    let (role, source, confidence, reasons) = if initial.0 == ContactRole::Unknown
        && allow_web_research
        && !corpus.trim().is_empty()
        && ignored_sender_hit(&email).is_none()
    {
        if let Some(cfg) = try_load_provider(&state) {
            match web_research_contact_role(
                state,
                &cfg,
                &email,
                &name,
                &signal_summary,
                &corpus,
            )
            .await
            {
                Some(researched) => researched,
                None => {
                    let mut unchanged = initial;
                    unchanged
                        .3
                        .push("联网核验未得到足够可靠的直接证据，保持未分类".to_string());
                    unchanged
                }
            }
        } else {
            initial
        }
    } else {
        initial
    };

    let entry = ContactRoleEntry {
        email: email.clone(),
        role,
        source,
        confidence,
        reasons,
        inferred_at: ts,
    };

    Ok(entry)
}

/// Public command: infer ONE contact's role (multi-dimensional AI).
/// Manual tags are respected as the user's explicit correction.
#[tauri::command]
pub async fn infer_contact_role(
    state: State<'_, AppState>,
    account_id: String,
    email: String,
) -> std::result::Result<ContactRoleEntry, PebbleError> {
    let email_lc = email.trim().to_lowercase();
    // Manual override is the user's explicit correction → respect it.
    if let Some(e) = load_roles(&state)
        .into_iter()
        .find(|r| r.email.to_lowercase() == email_lc)
    {
        if e.source == RoleSource::Manual {
            return Ok(e);
        }
    }
    let entry = resolve_contact_role(&state, &account_id, &email, true).await?;
    let mut roles = load_roles(&state);
    match roles.iter_mut().find(|r| r.email.to_lowercase() == email_lc) {
        Some(e) => *e = entry.clone(),
        None => roles.push(entry.clone()),
    }
    save_roles(&state, &roles)?;
    Ok(entry)
}

/// Bulk full-AI inference for all contacts (best quality, costs API calls).
/// Every inferred result is re-evaluated when the user explicitly clicks the
/// one-click action; only real manual corrections remain untouched.
#[tauri::command]
pub async fn infer_all_contact_roles(
    state: State<'_, AppState>,
    account_id: String,
) -> std::result::Result<Vec<ContactRoleEntry>, PebbleError> {
    let contacts = state
        .store
        .list_known_contacts(&account_id, "", 2000)
        .unwrap_or_default();
    let mut roles = load_roles(&state);
    let mut count = 0usize;
    let mut web_lookups = 0usize;
    for c in contacts {
        if count >= BULK_AI_LIMIT {
            break;
        }
        let email = c.address.trim().to_string();
        if email.is_empty() {
            continue;
        }
        let email_lc = email.to_lowercase();
        // The user's explicit correction always wins. Automatic judgments are
        // deliberately refreshed so newly synced correspondence can repair an
        // earlier weak or wrong result.
        let skip = roles
            .iter()
            .any(|r| r.email.to_lowercase() == email_lc && r.source == RoleSource::Manual);
        if skip {
            continue;
        }
        if let Ok(entry) = resolve_contact_role(
            &state,
            &account_id,
            &email,
            web_lookups < 20,
        )
        .await
        {
            if entry.reasons.iter().any(|reason| reason.starts_with("联网核验")) {
                web_lookups += 1;
            }
            count += 1;
            let lc = entry.email.to_lowercase();
            match roles.iter_mut().find(|r| r.email.to_lowercase() == lc) {
                Some(e) => *e = entry,
                None => roles.push(entry),
            }
        }
    }
    save_roles(&state, &roles)?;
    Ok(roles)
}

/// Import every existing customer memory as a `customer` role entry.
#[tauri::command]
pub async fn import_customer_roles(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<ContactRoleEntry>, PebbleError> {
    let memories: Vec<crate::commands::customer_memory::CustomerMemory> = match state
        .store
        .get_secure_user_data(crate::commands::customer_memory::CUSTOMER_MEMORIES_KEY)
    {
        Ok(Some(enc)) => match state.crypto.decrypt(&enc) {
            Ok(plain) => serde_json::from_slice(&plain).unwrap_or_default(),
            Err(_) => Vec::new(),
        },
        _ => Vec::new(),
    };

    let ts = now_secs();
    let mut roles = load_roles(&state);
    for m in memories {
        let email_lc = m.email.trim().to_lowercase();
        if email_lc.is_empty() {
            continue;
        }
        match roles.iter_mut().find(|r| r.email.to_lowercase() == email_lc) {
            Some(e) => {
                if e.source != RoleSource::Manual {
                    e.role = ContactRole::Customer;
                    e.source = RoleSource::Imported;
                    e.reasons = vec!["从客户记忆导入".to_string()];
                    e.inferred_at = ts;
                }
            }
            None => roles.push(ContactRoleEntry {
                email: m.email,
                role: ContactRole::Customer,
                source: RoleSource::Imported,
                confidence: 0.8,
                reasons: vec!["从客户记忆导入".to_string()],
                inferred_at: ts,
            }),
        }
    }
    save_roles(&state, &roles)?;
    Ok(roles)
}

// ─── Command: the actual pre-send check ────────────────────────────────────────

#[tauri::command]
pub async fn check_send_guard(
    state: State<'_, AppState>,
    account_id: String,
    to: Vec<String>,
    cc: Vec<String>,
    bcc: Vec<String>,
    subject: String,
    body_text: String,
) -> std::result::Result<SendGuardVerdict, PebbleError> {
    let cfg = load_config(&state);
    if !cfg.enabled {
        return Ok(SendGuardVerdict {
            level: "ok".to_string(),
            reasons: vec![],
            recipients: vec![],
            draft_intent: "unknown".to_string(),
        });
    }

    // Collect recipients, dedupe, lowercase.
    let mut raw: Vec<String> = Vec::new();
    raw.extend(to);
    raw.extend(cc);
    raw.extend(bcc);
    let mut seen = std::collections::HashSet::new();
    let recipients: Vec<String> = raw
        .into_iter()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .filter(|s| seen.insert(s.clone()))
        .collect();

    // Resolve our own domain so we never warn on internal mail.
    let own_domain = state
        .store
        .get_account(&account_id)
        .ok()
        .flatten()
        .and_then(|a| a.email.split('@').nth(1).map(|d| d.to_lowercase()));

    let roles = load_roles(&state);
    let role_map: HashMap<String, (ContactRole, RoleSource)> = roles
        .iter()
        .map(|r| (r.email.trim().to_lowercase(), (r.role, r.source)))
        .collect();

    // A cached role may predate the service-provider category, so an obvious
    // forwarder/certification address could still be stored as "supplier".
    // Trust the address over a stale inference (but never over a manual tag).
    let effective_role = |addr: &str| -> ContactRole {
        match role_map.get(addr) {
            Some((role, RoleSource::Manual)) => *role,
            Some((role, _)) => {
                if *role != ContactRole::Service && service_hit(addr).is_some() {
                    ContactRole::Service
                } else {
                    *role
                }
            }
            None => cheap_role_from_address(addr).0,
        }
    };

    let mut recipient_roles: Vec<RecipientRole> = Vec::new();
    let mut checkable: Vec<(String, ContactRole)> = Vec::new();
    for addr in &recipients {
        let role = if let Some(d) = &own_domain {
            if addr.ends_with(&format!("@{}", d)) {
                ContactRole::Neutral
            } else {
                effective_role(addr)
            }
        } else {
            effective_role(addr)
        };
        recipient_roles.push(RecipientRole {
            email: addr.clone(),
            role,
        });
        if role == ContactRole::Customer || role == ContactRole::Supplier {
            checkable.push((addr.clone(), role));
        }
    }

    if checkable.is_empty() {
        return Ok(SendGuardVerdict {
            level: "ok".to_string(),
            reasons: vec![],
            recipients: recipient_roles,
            draft_intent: "unknown".to_string(),
        });
    }

    let content = format!("主题: {subject}\n\n{body_text}");
    let (draft_intent, _draft_reasons) = draft_intent(&content);

    let (mut level, reasons) = if let Some(cfg) = try_load_provider(&state) {
        match ai_check(&state, &cfg, &content, &draft_intent, &checkable).await {
            Ok(v) => v,
            Err(_) => heuristic_check(&draft_intent, &checkable),
        }
    } else {
        heuristic_check(&draft_intent, &checkable)
    };

    // Soft mode never hard-blocks.
    if cfg.mode == GuardMode::Soft && level == "block" {
        level = "warn".to_string();
    }

    Ok(SendGuardVerdict {
        level,
        reasons,
        recipients: recipient_roles,
        draft_intent,
    })
}

// ─── AI / heuristic internals ──────────────────────────────────────────────────

fn try_load_provider(state: &AppState) -> Option<TranslateProviderConfig> {
    let stored = state.store.get_translate_config().ok().flatten()?;
    if !stored.is_enabled {
        return None;
    }
    let decrypted = decrypt_config(state, &stored.config).ok()?;
    serde_json::from_str(&decrypted).ok()
}

async fn web_research_contact_role(
    state: &AppState,
    cfg: &TranslateProviderConfig,
    email: &str,
    name: &str,
    signal_summary: &str,
    corpus: &str,
) -> Option<(ContactRole, RoleSource, f32, Vec<String>)> {
    let (domain, _) = email_domain(email);
    if domain.is_empty() {
        return None;
    }
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(14))
        .user_agent("YaoAIMail/1.1 contact-role-research");
    if let Ok(Some(proxy)) = get_global_proxy_raw(&state.crypto, &state.store) {
        if let Ok(uri) = proxy.socks5h_uri() {
            if let Ok(reqwest_proxy) = reqwest::Proxy::all(&uri) {
                builder = builder.proxy(reqwest_proxy);
            }
        }
    }
    let client = builder.build().ok()?;
    // Search the company domain, not the full personal mailbox, so the lookup
    // is useful without sending a contact's local-part to public search engines.
    let query = format!(
        "\"{domain}\" company products manufacturer distributor importer retailer"
    );
    let items = crate::commands::search_router::search_free(state, &client, &query).await.items;
    let email_lc = email.to_ascii_lowercase();
    let domain_lc = domain.to_ascii_lowercase();
    let relevant: Vec<_> = items
        .into_iter()
        .filter(|item| {
            let haystack = format!("{} {} {}", item.title, item.url, item.description)
                .to_ascii_lowercase();
            haystack.contains(&email_lc) || haystack.contains(&domain_lc)
        })
        .take(6)
        .collect();
    if relevant.is_empty() {
        return None;
    }
    let evidence = relevant
        .iter()
        .map(|item| format!("- {}\n  {}\n  {}", item.title, item.url, item.description))
        .collect::<Vec<_>>()
        .join("\n");
    let web_summary = format!(
        "{signal_summary}\n联网搜索补充（仅可作为佐证，不能覆盖真实往来）：\n{evidence}"
    );
    let (role, source, confidence, mut reasons) = ai_classify_role(
        state,
        cfg,
        email,
        name,
        &web_summary,
        corpus,
    )
    .await
    .ok()?;
    let accepted = match role {
        ContactRole::Customer | ContactRole::Supplier => confidence >= 0.82,
        ContactRole::Service => confidence >= 0.85,
        ContactRole::Neutral | ContactRole::Unknown => false,
    };
    if !accepted {
        return None;
    }
    reasons.insert(
        0,
        format!("联网核验：找到 {} 条与该邮箱域名直接相关的公开结果", relevant.len()),
    );
    Some((role, source, confidence, reasons))
}

async fn ai_classify_role(
    state: &AppState,
    cfg: &TranslateProviderConfig,
    email: &str,
    name: &str,
    signal_summary: &str,
    corpus: &str,
) -> std::result::Result<(ContactRole, RoleSource, f32, Vec<String>), PebbleError> {
    let proxy = get_global_proxy_raw(&state.crypto, &state.store)?;
    let system = "You are a conservative foreign-trade contact classifier. Decide the role of an email contact \
relative to the user's company from actual correspondence. Never infer customer vs supplier from country, \
domain suffix (.cn included), mailbox provider, language, nationality, or a company-sounding domain. \
Those are not evidence of the commercial relationship. Use these rules:\n\
1) Trade direction: who pays / who issues documents? We send THEM quotes/PI/proforma/dispatch => they are a CUSTOMER. \
They send US cost/ex-factory price/production schedule => they are a SUPPLIER.\n\
2) Communication content: their inquiries for price/samples/orders/customization/branding => CUSTOMER; \
talk of production line/tooling/materials/capacity/margin => SUPPLIER.\n\
3) Every sample is labelled [我方发出] or [对方发来]. Respect that direction and do not let quoted text \
inside a reply override the newest message's actual direction.\n\
4) SERVICE PROVIDER check (do this FIRST): if the contact is a third party that neither buys from nor sells \
goods to us — freight forwarder, shipping line, customs broker, courier, inspection/certification body \
(SGS, Bureau Veritas, Intertek, TUV, UL, CCIC, CE/ROHS/REACH testing labs), bank/insurer/payment platform, \
B2B platform or system notification, exhibition organiser, law/accounting firm — then role is 'service'. \
Typical clues: talk of booking, containers, bill of lading, customs clearance, vessel/ETD, inspection or \
test reports, certificates, audits, remittance/LC handling, platform notices. A Chinese domain does NOT \
make a forwarder a factory. Automated, bulk, phishing or fraud mail is 'unknown', not a service provider.\n\
5) If evidence is missing, mixed, indirect, or could fit both sides, return 'unknown'. Precision is more \
important than coverage. Do not classify merely to fill the address book.\n\
Return STRICT JSON (no markdown) with: 'role' = exactly one of 'customer' | 'supplier' | 'service' | 'neutral' | 'unknown'; \
'confidence' = 0.0-1.0; 'reasons' = array of short Chinese sentences explaining the decision.";
    let user = format!(
        "邮箱: {email}\n姓名: {name}\n\n已提取的信号:\n{signal_summary}\n\n往来邮件样本:\n{corpus}\n\n请判断并输出 JSON。"
    );
    let raw = TranslateService::complete_with_proxy(cfg, proxy.as_ref(), &system, &user).await?;
    let parsed: serde_json::Value = parse_json(&raw);
    let role = parsed
        .get("role")
        .and_then(|v| v.as_str())
        .map(ContactRole::from_str)
        .unwrap_or(ContactRole::Unknown);
    let confidence = parsed
        .get("confidence")
        .and_then(|v| v.as_f64())
        .map(|f| f as f32)
        .unwrap_or(0.5);
    let reasons = parsed
        .get("reasons")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok((role, RoleSource::Inferred, confidence, reasons))
}

async fn ai_check(
    state: &AppState,
    cfg: &TranslateProviderConfig,
    content: &str,
    draft_intent: &str,
    checkable: &[(String, ContactRole)],
) -> std::result::Result<(String, Vec<String>), PebbleError> {
    let proxy = get_global_proxy_raw(&state.crypto, &state.store)?;
    let recipients_desc: Vec<String> = checkable
        .iter()
        .map(|(email, role)| format!("- {email} （已识别为：{}）", role.as_str()))
        .collect();
    let recipients_text = recipients_desc.join("\n");
    let system = "You are a foreign-trade email 'mis-send' guard. You receive one outgoing email's \
content and a list of recipients with their known business role, plus the detected draft intent. \
Decide whether the email might be addressed to the WRONG party. Examples of mis-sends: (a) the recipient \
is a factory/supplier but the content is clearly written for a buyer — e.g. it quotes selling prices, \
discusses the buyer's market, shipment to the buyer, or end-customer details; (b) the recipient is a \
customer/buyer but the content leaks factory-internal info — e.g. our cost, margin, production schedule, \
ex-factory price, or sub-supplier details. Return STRICT JSON (no markdown) with: 'level' = 'ok' (no \
concern), 'warn' (possible mis-send, user should double check), or 'block' (very high confidence mis-send, \
especially if sensitive cost/margin is sent to a customer); and 'reasons' = array of short, specific Chinese \
sentences explaining each concern (empty if ok).";
    let user = format!(
        "收件人及角色:\n{recipients_text}\n\n检测到的草稿意图: {draft_intent}\n\n邮件内容:\n{content}\n\n请判断并输出 JSON。"
    );
    let raw = TranslateService::complete_with_proxy(cfg, proxy.as_ref(), &system, &user).await?;
    let parsed: serde_json::Value = parse_json(&raw);
    let level = parsed
        .get("level")
        .and_then(|v| v.as_str())
        .unwrap_or("ok")
        .to_string();
    let level = if level == "warn" || level == "block" {
        level
    } else {
        "ok".to_string()
    };
    let reasons = parsed
        .get("reasons")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok((level, reasons))
}

/// Rule-based role when AI is unavailable or history is thin.
fn heuristic_role(
    direction_score: f32,
    addr_role: ContactRole,
    addr_conf: f32,
    addr_reasons: Vec<String>,
) -> (ContactRole, RoleSource, f32, Vec<String>) {
    // A service provider identified from the address is decisive: no amount of
    // language / trade-direction signal turns a forwarder into a customer.
    if addr_role == ContactRole::Service {
        return (ContactRole::Service, RoleSource::Inferred, addr_conf.max(0.8), addr_reasons);
    }
    let mut score: f32 = 0.0;
    let mut reasons = Vec::new();
    if direction_score >= 2.0 {
        score += direction_score.min(5.0);
        reasons.push("沟通中由我们向其报价/发货，倾向于是客户".to_string());
    } else if direction_score <= -2.0 {
        score += direction_score.max(-5.0);
        reasons.push("沟通中由其向我们报成本/排产，倾向于是供应商".to_string());
    }
    // Blend with the address signal.
    if addr_role != ContactRole::Unknown && addr_conf > 0.0 {
        score += if addr_role == ContactRole::Customer { addr_conf } else { -addr_conf };
        reasons.extend(addr_reasons);
    }

    if score >= 2.0 {
        (ContactRole::Customer, RoleSource::Inferred, (score / 5.0).min(0.85), reasons)
    } else if score <= -2.0 {
        (ContactRole::Supplier, RoleSource::Inferred, (score.abs() / 5.0).min(0.85), reasons)
    } else {
        (ContactRole::Unknown, RoleSource::Inferred, 0.0, vec!["信息不足，无法判断".to_string()])
    }
}

fn heuristic_check(draft_intent: &str, checkable: &[(String, ContactRole)]) -> (String, Vec<String>) {
    let mut reasons: Vec<String> = Vec::new();
    for (email, role) in checkable {
        if *role == ContactRole::Supplier && draft_intent == "customer" {
            reasons.push(format!(
                "收件人 {email} 被识别为工厂/供应商，但这封邮件的内容看起来是写给客户的（含报价、发货、客户市场等销售内容），疑似发错对象。"
            ));
        } else if *role == ContactRole::Customer && draft_intent == "supplier" {
            reasons.push(format!(
                "收件人 {email} 被识别为客户，但邮件内容包含工厂/成本/产线等对内采购内容，疑似发错对象。"
            ));
        }
    }
    let level = if reasons.is_empty() {
        "ok".to_string()
    } else {
        "warn".to_string()
    };
    (level, reasons)
}

/// Extract the first JSON object from an LLM reply (tolerant of ```json fences).
fn parse_json(raw: &str) -> serde_json::Value {
    let text = raw.trim();
    let start = text.find('{').unwrap_or(0);
    let end = text.rfind('}').map(|i| i + 1).unwrap_or(text.len());
    let json = &text[start..end];
    serde_json::from_str::<serde_json::Value>(json).unwrap_or(serde_json::Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn country_domain_never_decides_business_role() {
        let (cn_role, cn_confidence, _) = cheap_role_from_address("buyer@example.cn");
        let (de_role, de_confidence, _) = cheap_role_from_address("factory@example.de");
        let (qq_role, qq_confidence, _) = cheap_role_from_address("person@qq.com");
        assert_eq!(cn_role, ContactRole::Unknown);
        assert_eq!(de_role, ContactRole::Unknown);
        assert_eq!(qq_role, ContactRole::Unknown);
        assert_eq!(cn_confidence, 0.0);
        assert_eq!(de_confidence, 0.0);
        assert_eq!(qq_confidence, 0.0);
    }

    #[test]
    fn automated_sender_is_not_a_business_contact() {
        let (role, confidence, reasons) = cheap_role_from_address("no-reply@shop.example");
        assert_eq!(role, ContactRole::Unknown);
        assert_eq!(confidence, 0.0);
        assert!(reasons.iter().any(|reason| reason.contains("系统/群发")));
    }

    #[test]
    fn clear_service_domain_remains_service() {
        let (role, confidence, _) = cheap_role_from_address("booking@sample-logistics.com");
        assert_eq!(role, ContactRole::Service);
        assert!(confidence >= 0.8);
    }

    #[test]
    fn heuristic_requires_correspondence_margin() {
        let weak = heuristic_role(1.0, ContactRole::Unknown, 0.0, Vec::new());
        let customer = heuristic_role(3.0, ContactRole::Unknown, 0.0, Vec::new());
        let supplier = heuristic_role(-3.0, ContactRole::Unknown, 0.0, Vec::new());
        assert_eq!(weak.0, ContactRole::Unknown);
        assert_eq!(customer.0, ContactRole::Customer);
        assert_eq!(supplier.0, ContactRole::Supplier);
    }

    #[test]
    fn obvious_phishing_requires_multiple_independent_markers() {
        assert_eq!(suspicious_message_signals("hello", "ordinary business message"), 0);
        assert!(suspicious_message_signals(
            "Unusual activity",
            "Verify your account now because your password expires today"
        ) >= 2);
    }
}
