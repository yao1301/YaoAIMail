//! Bounded candidate selection and source-checked business items. No model,
//! crypto, network, mutations of mail, or UI dependencies live in this module.
use super::mail_assistant::{body_text, AssistantResult, EvidenceReport};
use pebble_core::{FolderRole, Message, PebbleError, Result};
use pebble_store::Store;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Bucket { NeedsAction, Waiting, Risk }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proof {
    pub message_id: String,
    pub label: String,
    pub sender: String,
    pub date: i64,
    pub quote: String,
    pub folder_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewItem {
    pub id: String,
    #[serde(default)] pub revision: String,
    pub bucket: Bucket,
    pub title: String,
    pub summary: String,
    pub next_action: String,
    pub due_text: Option<String>,
    pub needs_verification: bool,
    pub latest_date: i64,
    pub proofs: Vec<Proof>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub window_days: u32,
    pub from: i64,
    pub to: i64,
    pub scanned: usize,
    pub filtered_bulk: usize,
    pub ignored: usize,
    pub selected: usize,
    pub pinned_outside_window: usize,
    pub scan_limited: bool,
    pub selection_limited: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub account_id: String,
    pub generated_at: i64,
    pub revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_fingerprint: Option<String>,
    pub scope: Scope,
    pub items: Vec<OverviewItem>,
    pub evidence_report: EvidenceReport,
    pub warnings: Vec<String>,
}

impl Snapshot {
    pub(super) fn refresh_scope(&mut self, selection: Selection) {
        self.revision = selection.revision;
        self.scope = selection.scope;
        for item in &mut self.items {
            if let Some(revision) = selection.thread_revisions.get(&item.id) {
                item.revision.clone_from(revision);
            }
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Feedback {
    pub id: String,
    pub label: String,
    pub source_message_id: String,
    pub pinned: bool,
    pub ignored_through: Option<i64>,
    #[serde(default)] pub ignored_revision: Option<String>,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub version: u8,
    pub account_id: String,
    pub snapshot: Option<Snapshot>,
    pub feedback: Vec<Feedback>,
    #[serde(default)] pub settings: OverviewSettings,
    #[serde(default)] pub background_opt_in: bool,
    #[serde(default)] pub last_attempt: Option<i64>,
    #[serde(default)] pub auto_error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewSettings { pub auto_generate: bool, pub window_days: u32 }
impl Default for OverviewSettings {
    fn default() -> Self { Self { auto_generate: false, window_days: 7 } }
}
impl OverviewSettings {
    pub fn check(&self) -> Result<()> {
        if ![7,30,90].contains(&self.window_days) {
            return Err(PebbleError::Validation("请选择 7、30 或 90 天窗口".into()));
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewView {
    pub account_id: String,
    pub snapshot: Option<Snapshot>,
    pub feedback: Vec<Feedback>,
    pub stale: bool,
    pub settings: OverviewSettings,
    pub next_auto_at: Option<i64>,
    pub auto_error: Option<String>,
    pub last_attempt: Option<i64>,
}

impl Record {
    pub fn empty(account: &str) -> Self {
        Self { version: 1, account_id: account.into(), snapshot: None, feedback: vec![],
            settings: OverviewSettings::default(), background_opt_in: false, last_attempt: None, auto_error: None }
    }

    pub fn check(&self, account: &str) -> Result<()> {
        if self.version != 1 || self.account_id != account
            || self.snapshot.as_ref().is_some_and(|s| s.account_id != account) {
            return Err(PebbleError::Validation("账户事项缓存的版本或归属不匹配，未加载其他账户数据".into()));
        }
        self.settings.check()
    }

    pub fn view(&self, revision: &str) -> OverviewView {
        OverviewView {
            account_id: self.account_id.clone(), snapshot: self.snapshot.clone(), feedback: self.feedback.clone(),
            stale: self.snapshot.as_ref().is_some_and(|s| s.revision != revision
                || s.scope.window_days != self.settings.window_days
                || s.generated_at.saturating_add(21_600) <= pebble_core::now_timestamp()) || self.auto_error.is_some(),
            settings: OverviewSettings { auto_generate: self.auto_enabled(), ..self.settings.clone() },
            next_auto_at: self.next_auto_at(revision), auto_error: self.auto_error.clone(), last_attempt: self.last_attempt,
        }
    }

    /// The database is authoritative across StrictMode, remounts and windows.
    /// Reuse fresh results for six hours; changes/failures have a 15-minute
    /// minimum interval. Manual refresh remains available at any time.
    pub fn auto_enabled(&self) -> bool { self.background_opt_in && self.settings.auto_generate }

    pub fn cooldown_until(&self) -> i64 {
        let Some(last) = self.last_attempt else { return 0; };
        // Opening before the first sync finishes is not a paid attempt.
        if self.auto_error.as_deref().is_some_and(|error| error.contains("候选邮件暂无可用正文"))
            || (self.auto_error.is_none() && self.snapshot.as_ref().is_some_and(|s| s.scope.selected == 0 && s.generated_at >= last)) {
            return last.saturating_add(60);
        }
        last.saturating_add(900)
    }

    pub fn next_auto_at(&self, revision: &str) -> Option<i64> {
        if !self.auto_enabled() { return None; }
        let cooldown = self.cooldown_until();
        let fresh_until = self.snapshot.as_ref().filter(|_|self.auto_error.is_none()).filter(|s| s.revision == revision
            && s.scope.window_days == self.settings.window_days)
            .map(|s| s.generated_at.saturating_add(21_600)).unwrap_or(0);
        Some(cooldown.max(fresh_until))
    }
}

pub fn thread_key(message: &Message) -> String {
    match message.thread_id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => format!("thread:{id}"), None => format!("mail:{}", message.id),
    }
}

/// Conservative hints only. A generic noreply sender is NEVER a bulk signal.
/// Transactional/security subjects and user-starred mail bypass this prefilter.
pub fn obvious_bulk(message: &Message) -> bool {
    if message.is_starred { return false; }
    let subject = message.subject.to_lowercase();
    if ["order", "invoice", "payment", "paid", "shipment", "delivery", "quote", "quotation", "purchase", "security", "login", "verification", "password",
        "订单", "付款", "发票", "支付", "交期", "报价", "询盘", "安全", "登录", "验证码", "密码"].iter().any(|word| subject.contains(word)) {
        return false;
    }
    let snippet = message.snippet.to_lowercase();
    let bulk_title = ["newsletter", "weekly digest", "daily digest", "marketing update", "exclusive offer", "limited time offer", "每日简报", "每周简报", "订阅周刊", "限时促销"].iter().any(|word| subject.contains(word));
    let opt_out = ["unsubscribe", "manage preferences", "退订", "取消订阅"].iter().any(|word| snippet.contains(word));
    bulk_title && opt_out
}

pub(super) fn eligible(store: &Store, account: &str, message: &Message) -> Result<bool> {
    if message.account_id != account || message.is_deleted || message.is_draft { return Ok(false); }
    let ids = store.get_message_folder_ids(&message.id)?;
    Ok(!store.list_folders(account)?.iter().any(|folder| ids.contains(&folder.id)
        && matches!(folder.role, Some(FolderRole::Spam | FolderRole::Trash | FolderRole::Drafts))))
}

pub struct Selection { pub ids: Vec<String>, pub scope: Scope, pub revision: String, pub thread_revisions: BTreeMap<String,String> }

pub fn select_candidates(store: &Store, account: &str, days: u32, now: i64, record: &Record) -> Result<Selection> {
    record.check(account)?;
    if ![7,30,90].contains(&days) { return Err(PebbleError::Validation("请选择 7、30 或 90 天窗口".into())); }
    let revision = store.account_evidence_revision(account)?;
    let from = now.saturating_sub(days as i64 * 86_400);
    let mut headers = store.list_overview_evidence_headers(account, from, now)?;
    let scan_limited = headers.len() > 120;
    headers.truncate(120);
    let mut scope = Scope { window_days: days, from, to: now, scanned: headers.len(), filtered_bulk: 0, ignored: 0,
        selected: 0, pinned_outside_window: 0, scan_limited, selection_limited: false };
    let feedback: BTreeMap<_,_> = record.feedback.iter().map(|f| (f.id.clone(),f)).collect();
    let mut candidates = vec![];
    let mut thread_revisions = BTreeMap::new();
    // Pinned old business must not disappear merely because the window moves.
    for entry in record.feedback.iter().filter(|f| f.pinned) {
        if let Some(mail) = store.get_message_evidence_header(&entry.source_message_id)? {
            if eligible(store,account,&mail)? && mail.date < from {
                scope.pinned_outside_window += 1;
                candidates.push(mail);
            }
        }
    }
    for mail in headers {
        let key = thread_key(&mail);
        let feedback = feedback.get(&key);
        if let Some(ignored_revision) = feedback.filter(|f| f.ignored_through.is_some()).and_then(|f| f.ignored_revision.as_ref()) {
            let revision = match thread_revisions.entry(key) {
                std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::btree_map::Entry::Vacant(entry) => entry.insert(store.thread_evidence_revision(
                    account,mail.thread_id.as_deref().filter(|id| !id.is_empty()),&mail.id)?),
            };
            if ignored_revision.as_str() == revision.as_str() { scope.ignored += 1; continue; }
        }
        if !feedback.is_some_and(|f| f.pinned) && obvious_bulk(&mail) {
            scope.filtered_bulk += 1;
        } else { candidates.push(mail); }
    }
    candidates.sort_by(|a,b| {
        let priority = |m: &Message| (feedback.get(&thread_key(m)).is_some_and(|f| f.pinned), m.is_starred);
        priority(b).cmp(&priority(a)).then_with(|| b.date.cmp(&a.date)).then_with(|| a.id.cmp(&b.id))
    });
    let mut per_thread = BTreeMap::<String,usize>::new();
    let mut seen = HashSet::new();
    let mut ids = vec![];
    let candidate_count = candidates.len();
    for mail in candidates {
        if ids.len() >= 24 { break; }
        let key = thread_key(&mail);
        let count = per_thread.entry(key.clone()).or_default();
        if *count < 2 && seen.insert(mail.id.clone()) {
            if let std::collections::btree_map::Entry::Vacant(entry) = thread_revisions.entry(key) {
                entry.insert(store.thread_evidence_revision(account,mail.thread_id.as_deref().filter(|id| !id.is_empty()),&mail.id)?);
            }
            *count += 1; ids.push(mail.id);
        }
    }
    scope.selected = ids.len();
    scope.selection_limited = candidate_count > ids.len();
    Ok(Selection { ids, scope, revision, thread_revisions })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposedProof { #[serde(alias = "message_id")] message_id: String, quote: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposedItem {
    bucket: Bucket, title: String, summary: String,
    #[serde(alias = "next_action")] next_action: String,
    #[serde(default, alias = "due_text")] due_text: Option<String>,
    #[serde(default)] uncertain: bool,
    proofs: Vec<ProposedProof>,
}
#[derive(Deserialize)]
struct ProposedOverview { items: Vec<serde_json::Value> }
fn normalized(text: &str) -> String { text.split_whitespace().collect::<Vec<_>>().join(" ") }
fn clipped(text: &str, max: usize) -> String { text.trim().chars().take(max).collect() }

fn parse_proposals(content: &str) -> Result<(Vec<ProposedItem>, usize)> {
    let text = content.trim();
    if text.len() > 100_000 { return Err(PebbleError::Validation("事项结果过大，旧结果已保留".into())); }
    let text = if text.starts_with("```") {
        text.split_once('\n').and_then(|(_,s)| s.strip_suffix("```")).unwrap_or(text).trim()
    } else { text };
    let proposed: ProposedOverview = serde_json::from_str(text)
        .map_err(|_| PebbleError::Validation("模型未返回有效的事项结构，旧结果已保留，请重试".into()))?;
    if proposed.items.len() > 24 { return Err(PebbleError::Validation("模型返回过多事项，旧结果已保留".into())); }
    let count = proposed.items.len();
    let items: Vec<ProposedItem> = proposed.items.into_iter().filter_map(|item| serde_json::from_value(item).ok()).collect();
    if count > 0 && items.is_empty() {
        return Err(PebbleError::Validation("模型返回的事项字段不完整，旧结果已保留".into()));
    }
    Ok((items, count))
}

/// Retry only when a second, smaller answer can fix the response. A timeout,
/// authentication error or rate limit never triggers another paid request.
pub(super) async fn request_summary<F, Fut>(limits: [std::time::Duration; 2], mut send: F) -> Result<(String, usize)>
where
    F: FnMut(bool) -> Fut,
    Fut: std::future::Future<Output = Result<String>>,
{
    for (attempt, limit) in limits.into_iter().enumerate() {
        match tokio::time::timeout(limit, send(attempt == 1)).await {
            Ok(Ok(content)) if parse_proposals(&content).is_ok() => return Ok((content, attempt + 1)),
            Ok(Ok(_)) => continue,
            Ok(Err(PebbleError::Translate(message))) if message.contains("output_limit") || message.contains("empty_content") => {
                if attempt == 1 { return Err(PebbleError::Translate("事项模型未返回完整答案".into())); }
            }
            Ok(Err(error)) => return Err(error),
            Err(_) => return Err(PebbleError::Translate("事项模型响应超时".into())),
        }
    }
    Err(PebbleError::Validation("模型未返回有效的事项结构".into()))
}

pub fn build_snapshot(store: &Store, account: &str, selection: Selection, result: AssistantResult, now: i64, record: &Record) -> Result<Snapshot> {
    record.check(account)?;
    let (proposed, proposed_count) = parse_proposals(&result.content)?;
    let mut selected_threads = HashSet::new();
    for id in &selection.ids {
        if let Some(mail) = store.get_message_evidence_header(id)? { selected_threads.insert(thread_key(&mail)); }
    }
    let coverage: BTreeMap<_,_> = result.evidence_report.resources.iter().filter(|r| r.kind == "mail" && r.read_chars > 0).map(|r| (r.id.as_str(),r)).collect();
    let approved: HashSet<_> = result.mail_references.iter().filter(|r| r.account_id == account).map(|r| r.id.as_str()).collect();
    let mut items = vec![];
    let mut warnings = vec![];
    let mut rejected = proposed_count - proposed.len();
    let mut keys = HashSet::new();
    for proposal in proposed {
        if proposal.proofs.is_empty() || proposal.proofs.len() > 5 || proposal.title.trim().is_empty()
            || proposal.summary.trim().is_empty() || proposal.next_action.trim().is_empty() { rejected += 1; continue; }
        let mut proofs = vec![];
        let mut anchors = vec![];
        let mut complete = true;
        for proof in &proposal.proofs {
            let Some(read) = coverage.get(proof.message_id.as_str()) else { break; };
            if !approved.contains(proof.message_id.as_str()) || proof.quote.chars().count() > 400 || normalized(&proof.quote).is_empty() { break; }
            let Some(mail) = store.get_overview_evidence_message(account, &proof.message_id)? else { break; };
            if !selected_threads.contains(&thread_key(&mail)) || mail.remote_version.as_deref() == Some("headers-only") { break; }
            let quote = normalized(&proof.quote);
            let original = body_text(&mail);
            let excerpt: String = original.chars().take(read.read_chars).collect();
            let body = normalized(&excerpt);
            // Short business replies such as “已开票” are legitimate evidence,
            // but a tiny substring from a longer body is not a useful citation.
            if !body.contains(&quote) || (quote.chars().count() < 8 && (!read.complete || quote != body)) { break; }
            let pinned = record.feedback.iter().any(|f| f.id == thread_key(&mail) && f.pinned);
            if !pinned && obvious_bulk(&mail) { break; }
            complete &= read.complete && quote.chars().count() >= 8;
            let folders = store.get_message_folder_ids(&mail.id)?;
            proofs.push(Proof { message_id: mail.id.clone(), label: clipped(&mail.subject,180), sender: clipped(&mail.from_address,180), date: mail.date,
                quote: proof.quote.trim().into(), folder_id: folders.first().cloned() });
            anchors.push(mail);
        }
        if proofs.len() != proposal.proofs.len() { rejected += 1; continue; }
        anchors.sort_by(|a,b| b.date.cmp(&a.date).then_with(|| a.id.cmp(&b.id)));
        proofs.sort_by(|a,b| b.date.cmp(&a.date).then_with(|| a.message_id.cmp(&b.message_id)));
        let id = thread_key(&anchors[0]);
        if anchors.iter().any(|mail| thread_key(mail) != id) { rejected += 1; continue; }
        if !keys.insert(id.clone()) { rejected += 1; continue; }
        let due_text = proposal.due_text.filter(|due| !due.trim().is_empty() && due.chars().count() <= 120
            && proofs.iter().any(|proof| normalized(&proof.quote).contains(&normalized(due))));
        let revision = selection.thread_revisions.get(&id).cloned().unwrap_or_default();
        items.push(OverviewItem { id, revision, bucket: proposal.bucket, title: clipped(&proposal.title,100), summary: clipped(&proposal.summary,600),
            next_action: clipped(&proposal.next_action,400), due_text, needs_verification: proposal.uncertain || !complete
                || result.evidence_report.budget_exhausted || result.evidence_report.tool_fallback,
            latest_date: anchors[0].date, proofs });
    }
    if proposed_count > 0 && items.is_empty() {
        return Err(PebbleError::Validation("本次事项均未通过原信核验，旧结果已保留；请缩小窗口或指定相关邮件后重试".into()));
    }
    if rejected > 0 { warnings.push(format!("{rejected} 条结果因引用缺失、原文不匹配、重复往来或非业务范围而未展示")); }
    if selection.scope.scan_limited || selection.scope.selection_limited { warnings.push("本轮为有上限的抽样取证，未覆盖窗口内所有邮件；可缩小窗口或在工作台指定客户/订单继续查".into()); }
    warnings.push("这是 AI 事项建议，不是业务完成凭证；空列表也不代表没有待办。候选从所选时间窗口开始，补查往来可能更早。".into());
    Ok(Snapshot { account_id: account.into(), generated_at: now, revision: selection.revision, evidence_fingerprint: None, scope: selection.scope,
        items, evidence_report: result.evidence_report, warnings })
}

pub fn apply_feedback(record: &mut Record, id: &str, action: &str, now: i64) -> Result<()> {
    if !["pin","unpin","ignore","restore"].contains(&action) { return Err(PebbleError::Validation("不支持的事项操作".into())); }
    let item = record.snapshot.as_ref().and_then(|s| s.items.iter().find(|i| i.id == id));
    let existing = record.feedback.iter().position(|f| f.id == id);
    if item.is_none() && existing.is_none() { return Err(PebbleError::Validation("事项不属于当前账户已生成的结果".into())); }
    if existing.is_none() && record.feedback.len() >= 300 { return Err(PebbleError::Validation("事项反馈记录已达上限，请先恢复不再需要的忽略或重点记录".into())); }
    let mut entry = existing.map(|i| record.feedback[i].clone()).unwrap_or_else(|| {
        let item = item.expect("checked item exists");
        Feedback { id: id.into(), label: item.title.clone(), source_message_id: item.proofs[0].message_id.clone(), pinned: false, ignored_through: None, ignored_revision: None, updated_at: now }
    });
    match action {
        "pin" => { entry.pinned = true; entry.ignored_through = None; entry.ignored_revision = None; }
        "unpin" => entry.pinned = false,
        "ignore" => { entry.pinned = false; entry.ignored_through = Some(item.map(|i| i.latest_date).unwrap_or(now)); entry.ignored_revision = item.map(|i| i.revision.clone()); }
        "restore" => { entry.ignored_through = None; entry.ignored_revision = None; }
        _ => unreachable!(),
    }
    entry.updated_at = now;
    if let Some(i) = existing { record.feedback.remove(i); }
    if entry.pinned || entry.ignored_through.is_some() { record.feedback.push(entry); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::mail_assistant::{MailReference, ResourceCoverage};
    use pebble_core::{Account, Folder};
    use serde_json::{json, Value};
    const NOW: i64 = 2_000_000_000;

    fn mail(id: &str, account: &str, thread: &str, date: i64, subject: &str, body: &str) -> Message {
        serde_json::from_value(json!({"id":id,"account_id":account,"remote_id":id,"message_id_header":format!("<{id}@example.com>"),
            "in_reply_to":null,"references_header":null,"thread_id":thread,"subject":subject,"snippet":"An example business preview",
            "from_address":"buyer@example.com","from_name":"Example buyer","to_list":[],"cc_list":[],"bcc_list":[],
            "body_text":body,"body_html_raw":"","has_attachments":false,"is_read":false,"is_starred":false,"is_draft":false,
            "date":date,"remote_version":null,"is_deleted":false,"deleted_at":null,"created_at":1,"updated_at":1})).unwrap()
    }
    fn fixture() -> Store {
        let store = Store::open_in_memory().unwrap();
        for account in ["a","b"] {
            let account: Account = serde_json::from_value(json!({"id":account,"email":format!("{account}@example.com"),"display_name":account,"color":null,"provider":"imap","created_at":1,"updated_at":1})).unwrap();
            store.insert_account(&account).unwrap();
            for role in ["inbox","sent","spam","trash","drafts","archive"] {
                let folder: Folder = serde_json::from_value(json!({"id":format!("{role}-{}",account.id),"account_id":account.id,"remote_id":role,"name":role,"folder_type":"folder","role":role,"parent_id":null,"color":null,"is_system":true,"sort_order":0})).unwrap();
                store.insert_folder(&folder).unwrap();
            }
        }
        for (id,account,thread,date,subject,body,role) in [
            ("request","a","order-a",NOW-300,"Order A","Please confirm shipment by Friday for order A.","inbox"),
            ("sent","a","order-wait",NOW-200,"Purchase order","Please send the signed purchase order by Monday.","sent"),
            ("bulk","a","bulk",NOW-100,"Weekly digest","Read our latest articles.","inbox"),
            ("security","a","security",NOW-20,"New login activity","New login from unrecognized location. Confirm this activity.","inbox"),
            ("spam","a","order-a",NOW-10,"Order A","Unwanted business quotation in spam.","spam"),
            ("trash","a","order-a",NOW-5,"Order A","Deleted business quotation.","trash"),
            ("draft","a","order-a",NOW-4,"Order A","Unsent business commitment.","drafts"),
            ("foreign","b","order-a",NOW-2,"Order A","Foreign account business detail.","inbox"),
            ("old","a","old",NOW-100*86_400,"Order Old","Old pending business request needs confirmation.","archive"),
        ] {
            let mut message = mail(id,account,thread,date,subject,body);
            if id == "bulk" { message.snippet = "Manage preferences or unsubscribe".into(); }
            if id == "security" { message.from_address = "noreply@example.com".into(); }
            if id == "sent" { message.from_address = "a@example.com".into(); }
            store.insert_message(&message,&[format!("{role}-{account}")]).unwrap();
        }
        store
    }
    fn proposal(id: &str, quote: &str) -> Value {
        json!({"bucket":"needs_action","title":"Confirm shipment","summary":"The customer requests shipment confirmation.",
            "nextAction":"Check the schedule and prepare a reply for review.","dueText":"Friday","uncertain":false,
            "proofs":[{"messageId":id,"quote":quote}]})
    }
    fn result(store: &Store, content: Value, ids: &[&str], complete: bool) -> AssistantResult {
        AssistantResult { content:content.to_string(), sources:vec![], tool_calls:0,
            mail_references:ids.iter().map(|id| {
                let m = store.get_message(id).unwrap().unwrap();
                MailReference { id:id.to_string(),account_id:m.account_id,label:m.subject,subtitle:String::new(),folder_id:None }
            }).collect(),knowledge_references:vec![],customer_references:vec![],
            evidence_report:EvidenceReport { resources:ids.iter().map(|id| ResourceCoverage { kind:"mail".into(),id:id.to_string(),label:id.to_string(),total_chars:100,read_chars:if complete {100}else{10},complete,body_status:"available".into() }).collect(),..Default::default() } }
    }
    fn snapshot(store: &Store) -> Snapshot {
        let record = Record::empty("a");
        let selection = select_candidates(store,"a",30,NOW,&record).unwrap();
        build_snapshot(store,"a",selection,result(store,json!({"items":[proposal("request","Please confirm shipment by Friday for order A.")]}),&["request"],true),NOW,&record).unwrap()
    }

    #[test]
    fn reusing_verified_cards_updates_scope_without_changing_when_they_were_generated() {
        let store = fixture();
        let mut snapshot = snapshot(&store);
        let mut selection = select_candidates(&store, "a", 30, NOW + 60, &Record::empty("a")).unwrap();
        selection.revision = "mailbox-changed-outside-evidence".into();
        selection.thread_revisions.insert(snapshot.items[0].id.clone(), "thread-revision".into());

        snapshot.refresh_scope(selection);

        assert_eq!(snapshot.generated_at, NOW);
        assert_eq!(snapshot.scope.to, NOW + 60);
        assert_eq!(snapshot.revision, "mailbox-changed-outside-evidence");
        assert_eq!(snapshot.items[0].revision, "thread-revision");
        assert_eq!(snapshot.items[0].proofs[0].message_id, "request");
    }

    #[test]
    fn local_overview_uses_html_only_when_there_is_no_plain_body() {
        let store = fixture();
        store.update_message_content("request", "Readable text", "<p>Redundant HTML</p>", "", false, None).unwrap();
        let plain = store.get_overview_evidence_message("a", "request").unwrap().unwrap();
        assert_eq!(plain.body_text, "Readable text");
        assert!(plain.body_html_raw.is_empty());

        store.update_message_content("request", "\n\t", "<p>HTML-only reply</p>", "", false, None).unwrap();
        let html = store.get_overview_evidence_message("a", "request").unwrap().unwrap();
        assert_eq!(html.body_html_raw, "<p>HTML-only reply</p>");
        assert!(store.get_overview_evidence_message("a", "foreign").unwrap().is_none());
        assert!(store.get_overview_evidence_message("a", "spam").unwrap().is_none());
    }

    #[test]
    fn old_defaults_do_not_opt_in_to_startup_analysis_or_drop_the_snapshot() {
        let record: Record = serde_json::from_value(json!({"version":1,"accountId":"a","snapshot":null,"feedback":[]})).unwrap();
        record.check("a").unwrap();
        assert!(!record.settings.auto_generate); assert_eq!(record.settings.window_days,7);
        assert_eq!(record.next_auto_at("r"),None);
        assert!(record.last_attempt.is_none());
        let store = fixture(); let old_snapshot = snapshot(&store);
        let record: Record = serde_json::from_value(json!({"version":1,"accountId":"a","snapshot":old_snapshot,"feedback":[],"settings":{"autoGenerate":true,"windowDays":7}})).unwrap();
        assert_eq!(record.snapshot.as_ref().unwrap().scope.window_days,30);
        assert_eq!(record.settings.window_days,7);
        let revision = &record.snapshot.as_ref().unwrap().revision;
        assert_eq!(record.next_auto_at(revision),None);
        assert!(!record.view(revision).settings.auto_generate);
    }
    #[test]
    fn automatic_refresh_reuses_cache_and_persists_a_failure_cooldown_across_serialization() {
        let store = fixture(); let mut record = Record::empty("a");
        record.background_opt_in = true; record.settings.auto_generate = true;
        record.settings.window_days = 30;
        record.snapshot = Some(snapshot(&store)); record.last_attempt = Some(NOW);
        let revision = record.snapshot.as_ref().unwrap().revision.clone();
        assert_eq!(record.next_auto_at(&revision),Some(NOW+21_600));
        assert_eq!(record.next_auto_at("changed-mail"),Some(NOW+900));
        record.snapshot = None; record.auto_error = Some("Example failure".into());
        let reloaded: Record = serde_json::from_slice(&serde_json::to_vec(&record).unwrap()).unwrap();
        assert_eq!(reloaded.next_auto_at(&revision),Some(NOW+900));
        record.settings.auto_generate = false;
        assert_eq!(record.next_auto_at("changed-mail"),None);
        record.settings.window_days = 365;
        assert!(record.check("a").is_err());
    }
    #[test]
    fn failed_refresh_does_not_hide_behind_the_six_hour_success_cache() {
        let store=fixture();let mut record=Record::empty("a");record.settings.window_days=30;
        record.background_opt_in = true; record.settings.auto_generate = true;
        record.snapshot=Some(snapshot(&store));record.last_attempt=Some(NOW+60);
        let revision=record.snapshot.as_ref().unwrap().revision.clone();
        record.auto_error=Some("structured response failed".into());
        assert_eq!(record.next_auto_at(&revision),Some(NOW+60+900));
        assert!(record.view(&revision).stale);
    }

    #[test]
    fn local_only_body_wait_does_not_use_the_paid_retry_cooldown() {
        let mut record = Record::empty("a");
        record.background_opt_in = true;
        record.settings.auto_generate = true;
        record.last_attempt = Some(NOW);
        record.auto_error = Some("Validation error: 候选邮件暂无可用正文，正文下载后再更新".into());
        assert_eq!(record.next_auto_at("new-body"), Some(NOW + 60));
    }

    #[tokio::test]
    async fn overview_accepts_one_summary_and_only_repairs_bad_output_once() {
        let limits = [std::time::Duration::from_secs(1); 2];
        let mut calls = vec![];
        let (_, requests) = request_summary(limits, |repair| {
            calls.push(repair);
            std::future::ready(Ok(r#"{"items":[]}"#.into()))
        }).await.unwrap();
        assert_eq!(requests, 1);
        assert_eq!(calls, [false]);

        calls.clear();
        let (_, requests) = request_summary(limits, |repair| {
            calls.push(repair);
            std::future::ready(Ok(if repair { r#"{"items":[]}"# } else { "invalid reply" }.into()))
        }).await.unwrap();
        assert_eq!(requests, 2);
        assert_eq!(calls, [false, true]);
    }

    #[tokio::test]
    async fn overview_does_not_retry_timeouts_or_rate_limits() {
        let limits = [std::time::Duration::from_millis(10); 2];
        let mut calls = 0;
        let error = request_summary(limits, |_| {
            calls += 1;
            std::future::pending()
        }).await.unwrap_err();
        assert_eq!(calls, 1);
        assert!(error.to_string().contains("超时"));

        calls = 0;
        let error = request_summary(limits, |_| {
            calls += 1;
            std::future::ready(Err(PebbleError::Translate("HTTP 429".into())))
        }).await.unwrap_err();
        assert_eq!(calls, 1);
        assert!(error.to_string().contains("429"));
    }

    #[test]
    fn overview_thread_prefetch_is_newest_first_and_skips_private_folders_and_other_accounts() {
        let store = fixture();
        let newer = mail("newer","a","order-a",NOW-1,"Order A","A newer shipment update.");
        store.insert_message(&newer,&["sent-a".into()]).unwrap();
        let headers = store.list_recent_overview_thread_headers("a","order-a").unwrap();
        assert_eq!(headers.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["newer","request"]);
        assert!(headers.iter().all(|m| m.body_text.is_empty()));
    }

    #[test]
    fn window_is_account_bound_body_free_and_excludes_role_drafts_spam_trash() {
        let store = fixture();
        let headers = store.list_overview_evidence_headers("a",NOW-30*86_400,NOW).unwrap();
        assert_eq!(headers.len(),4);
        assert!(headers.iter().all(|m| m.account_id == "a" && m.body_text.is_empty() && m.body_html_raw.is_empty()));
        let selection = select_candidates(&store,"a",30,NOW,&Record::empty("a")).unwrap();
        assert_eq!(selection.scope.filtered_bulk,1);
        assert_eq!(selection.ids.len(),3); assert!(selection.ids.contains(&"security".into()));
        assert!(!selection.ids.contains(&"old".into()));
    }
    #[test]
    fn conservative_bulk_filter_preserves_transactions_security_stars_and_generic_noreply() {
        let store = fixture();
        let mut bulk = store.get_message("bulk").unwrap().unwrap();
        assert!(obvious_bulk(&bulk));
        for subject in ["Newsletter: payment received", "订单付款通知", "New login activity"] {
            bulk.subject = subject.into(); assert!(!obvious_bulk(&bulk));
        }
        bulk.subject = "Weekly digest".into(); bulk.is_starred = true; assert!(!obvious_bulk(&bulk));
        assert!(!obvious_bulk(&store.get_message("security").unwrap().unwrap()));
    }
    #[test]
    fn a_message_with_both_inbox_and_spam_labels_is_still_excluded() {
        let store = fixture(); let message = mail("mixed","a","mixed",NOW-1,"Order A","A multi-label business message.");
        store.insert_message(&message,&["inbox-a".into(),"spam-a".into()]).unwrap();
        assert!(!select_candidates(&store,"a",30,NOW,&Record::empty("a")).unwrap().ids.contains(&"mixed".into()));
    }
    #[test]
    fn scan_and_seed_limits_are_reported_not_claimed_as_full_mailbox() {
        let store = fixture();
        for i in 0..130 {
            let message = mail(&format!("more-{i}"),"a",&format!("thread-{i}"),NOW-1,"Order B","Please confirm an example purchase order.");
            store.insert_message(&message,&["inbox-a".into()]).unwrap();
        }
        let selection = select_candidates(&store,"a",7,NOW,&Record::empty("a")).unwrap();
        assert_eq!(selection.scope.scanned,120); assert_eq!(selection.ids.len(),24);
        assert!(selection.scope.scan_limited && selection.scope.selection_limited);
    }
    #[test]
    fn pinned_old_mail_survives_window_but_not_trash_or_foreign_scope() {
        let store = fixture(); let mut record = Record::empty("a");
        record.feedback.push(Feedback { id:"thread:old".into(),label:"Old".into(),source_message_id:"old".into(),pinned:true,ignored_through:None,ignored_revision:None,updated_at:NOW });
        record.feedback.push(Feedback { id:"thread:order-a".into(),label:"Foreign".into(),source_message_id:"foreign".into(),pinned:true,ignored_through:None,ignored_revision:None,updated_at:NOW });
        let selection = select_candidates(&store,"a",7,NOW,&record).unwrap();
        assert!(selection.ids.contains(&"old".into())); assert!(!selection.ids.contains(&"foreign".into()));
        assert_eq!(selection.scope.pinned_outside_window,1);
    }
    #[test]
    fn source_quotes_and_due_text_are_checked_against_real_mail() {
        let store = fixture(); let snapshot = snapshot(&store);
        assert_eq!(snapshot.items.len(),1); assert_eq!(snapshot.items[0].id,"thread:order-a");
        assert_eq!(snapshot.items[0].due_text.as_deref(),Some("Friday"));
        assert_eq!(snapshot.items[0].proofs[0].message_id,"request");
        assert!(!store.get_message("request").unwrap().unwrap().is_read);
    }
    #[test]
    fn unread_fabricated_foreign_draft_and_bulk_proofs_do_not_create_business_items() {
        let store = fixture();
        for (id,quote,ids) in [
            ("request","Please confirm shipment by Friday for order A.",vec![]),
            ("request","A completely invented confirmation of payment.",vec!["request"]),
            ("foreign","Foreign account business detail.",vec!["foreign"]),
            ("draft","Unsent business commitment.",vec!["draft"]),
            ("bulk","Read our latest articles.",vec!["bulk"]),
            ("old","Old pending business request needs confirmation.",vec!["old"]),
        ] {
            let record = Record::empty("a"); let selection = select_candidates(&store,"a",30,NOW,&record).unwrap();
            assert!(build_snapshot(&store,"a",selection,result(&store,json!({"items":[proposal(id,quote)]}),&ids,true),NOW,&record).is_err(),"{id} must not be accepted");
        }
    }
    #[test]
    fn partial_reads_and_uncertain_model_outputs_remain_visibly_unverified() {
        let store = fixture(); let record = Record::empty("a"); let selection = select_candidates(&store,"a",30,NOW,&record).unwrap();
        let quote = "Please confirm shipment by Friday for order A.";
        let mut outcome = result(&store,json!({"items":[proposal("request",quote)]}),&["request"],false);
        outcome.evidence_report.resources[0].read_chars = quote.chars().count();
        let snapshot = build_snapshot(&store,"a",selection,outcome,NOW,&record).unwrap();
        assert!(snapshot.items[0].needs_verification);
    }
    #[test]
    fn malformed_row_does_not_discard_a_verified_card_or_allow_an_unread_quote() {
        let store = fixture(); let record = Record::empty("a");
        let content = json!({"items":[{"bucket":"bad"},proposal("request","Please confirm shipment by Friday for order A.")]});
        for complete in [true,false] {
            let selection = select_candidates(&store,"a",30,NOW,&record).unwrap();
            let outcome = build_snapshot(&store,"a",selection,result(&store,content.clone(),&["request"],complete),NOW,&record);
            if complete { assert_eq!(outcome.unwrap().items.len(),1); } else { assert!(outcome.is_err()); }
        }
    }
    #[test]
    fn invented_deadline_is_not_kept_even_when_the_item_has_a_valid_quote() {
        let store = fixture(); let record = Record::empty("a"); let selection = select_candidates(&store,"a",30,NOW,&record).unwrap();
        let mut item = proposal("request","Please confirm shipment by Friday for order A."); item["dueText"] = json!("2033-05-18");
        let snapshot = build_snapshot(&store,"a",selection,result(&store,json!({"items":[item]}),&["request"],true),NOW,&record).unwrap();
        assert!(snapshot.items[0].due_text.is_none());
    }
    #[test]
    fn duplicate_thread_cards_are_not_shown_in_multiple_buckets() {
        let store = fixture(); let record = Record::empty("a"); let selection = select_candidates(&store,"a",30,NOW,&record).unwrap();
        let first = proposal("request","Please confirm shipment by Friday for order A."); let mut second = first.clone(); second["bucket"] = json!("risk");
        let snapshot = build_snapshot(&store,"a",selection,result(&store,json!({"items":[first,second]}),&["request"],true),NOW,&record).unwrap();
        assert_eq!(snapshot.items.len(),1);
    }
    #[test]
    fn ignore_applies_only_to_old_knowledge_and_new_mail_can_reappear() {
        let store = fixture(); let mut record = Record::empty("a"); record.snapshot = Some(snapshot(&store));
        apply_feedback(&mut record,"thread:order-a","ignore",NOW).unwrap();
        assert!(!select_candidates(&store,"a",30,NOW,&record).unwrap().ids.contains(&"request".into()));
        let newer = mail("newer","a","order-a",NOW-1,"Order A","The customer has a new shipment requirement.");
        store.insert_message(&newer,&["inbox-a".into()]).unwrap();
        assert!(select_candidates(&store,"a",30,NOW,&record).unwrap().ids.contains(&"newer".into()));
        apply_feedback(&mut record,"thread:order-a","restore",NOW).unwrap();
        assert!(record.feedback.is_empty());
    }
    #[test]
    fn feedback_is_local_restorable_and_does_not_change_mail_flags() {
        let store = fixture(); let mut record = Record::empty("a"); record.snapshot = Some(snapshot(&store));
        assert!(apply_feedback(&mut record,"foreign-key","pin",NOW).is_err());
        assert!(apply_feedback(&mut record,"thread:order-a","delete",NOW).is_err());
        apply_feedback(&mut record,"thread:order-a","pin",NOW).unwrap(); assert!(record.feedback[0].pinned);
        apply_feedback(&mut record,"thread:order-a","unpin",NOW).unwrap(); assert!(record.feedback.is_empty());
        let mail = store.get_message("request").unwrap().unwrap(); assert!(!mail.is_read && !mail.is_deleted);
        assert_eq!(store.get_message_folder_ids("request").unwrap(),vec!["inbox-a"]);
    }
    #[test]
    fn cache_roundtrip_preserves_items_feedback_and_account_identity() {
        let store = fixture(); let mut record = Record::empty("a"); record.snapshot = Some(snapshot(&store));
        apply_feedback(&mut record,"thread:order-a","pin",NOW).unwrap();
        let restored: Record = serde_json::from_slice(&serde_json::to_vec(&record).unwrap()).unwrap();
        restored.check("a").unwrap(); assert!(restored.check("b").is_err());
        assert_eq!(restored.snapshot.unwrap().items.len(),1); assert!(restored.feedback[0].pinned);
    }
    #[test]
    fn revision_is_account_scoped_and_new_mail_marks_cached_snapshot_stale() {
        let store = fixture(); let mut record = Record::empty("a"); record.snapshot = Some(snapshot(&store));
        record.settings.window_days = 30;
        let revision = store.account_evidence_revision("a").unwrap(); assert!(!record.view(&revision).stale);
        store.insert_message(&mail("b-new","b","other",NOW,"Other","A separate account update."),&["inbox-b".into()]).unwrap();
        assert_eq!(store.account_evidence_revision("a").unwrap(),revision);
        store.insert_message(&mail("a-new","a","other",NOW,"Other","An own account update."),&["inbox-a".into()]).unwrap();
        assert!(record.view(&store.account_evidence_revision("a").unwrap()).stale);
    }
    #[test]
    fn invalid_windows_cache_versions_and_model_shapes_fail_without_overwriting_record() {
        let store = fixture(); let mut record = Record::empty("a"); record.snapshot = Some(snapshot(&store));
        assert!(select_candidates(&store,"a",365,NOW,&record).is_err());
        let selection = select_candidates(&store,"a",30,NOW,&record).unwrap();
        assert!(build_snapshot(&store,"a",selection,result(&store,json!({"text":"Not structured"}),&[],true),NOW,&record).is_err());
        assert_eq!(record.snapshot.as_ref().unwrap().items.len(),1);
        record.version = 99; assert!(record.check("a").is_err());
    }

    #[test]
    fn partial_reply_in_sent_does_not_automatically_close_the_original_request() {
        let store = fixture();
        let mut reply = mail("partial-reply","a","order-a",NOW-1,"Order A","Thank you. We will review the schedule and reply later.");
        reply.from_address = "a@example.com".into(); reply.in_reply_to = Some("<request@example.com>".into());
        store.insert_message(&reply,&["sent-a".into()]).unwrap();
        let record = Record::empty("a"); let selection = select_candidates(&store,"a",30,NOW,&record).unwrap();
        assert!(selection.ids.contains(&"request".into()) && selection.ids.contains(&"partial-reply".into()));
        let snapshot = build_snapshot(&store,"a",selection,result(&store,json!({"items":[proposal("request","Please confirm shipment by Friday for order A.")]}),&["request"],true),NOW,&record).unwrap();
        assert_eq!(snapshot.items[0].bucket,Bucket::NeedsAction);
    }

    #[test]
    fn ignored_threads_reappear_for_same_timestamp_or_backfilled_new_message_ids() {
        for date in [NOW-300,NOW-400] {
            let store = fixture(); let mut record = Record::empty("a"); record.snapshot = Some(snapshot(&store));
            apply_feedback(&mut record,"thread:order-a","ignore",NOW).unwrap();
            store.insert_message(&mail("backfill","a","order-a",date,"Order A","A newly synchronized requirement for the existing order."),&["inbox-a".into()]).unwrap();
            let selection = select_candidates(&store,"a",30,NOW,&record).unwrap();
            assert!(selection.ids.contains(&"backfill".into()));
            assert!(selection.ids.contains(&"request".into()));
        }
    }

    #[test]
    fn short_business_replies_are_allowed_only_as_complete_quotes_and_need_context_review() {
        let store = fixture(); let record = Record::empty("a");
        store.update_message_content("request","已开票","","",false,None).unwrap();
        let selection = select_candidates(&store,"a",30,NOW,&record).unwrap();
        let snapshot = build_snapshot(&store,"a",selection,result(&store,json!({"items":[proposal("request","已开票")]}),&["request"],true),NOW,&record).unwrap();
        assert_eq!(snapshot.items[0].proofs[0].quote,"已开票"); assert!(snapshot.items[0].needs_verification);
        store.update_message_content("request","已开票，请确认收到正式的付款资料。","","",false,None).unwrap();
        let selection = select_candidates(&store,"a",30,NOW,&record).unwrap();
        assert!(build_snapshot(&store,"a",selection,result(&store,json!({"items":[proposal("request","已开票")]}),&["request"],true),NOW,&record).is_err());
    }
}
