use crate::commands::network::get_global_proxy_raw;
use crate::commands::translate::decrypt_config;
use crate::state::AppState;
use pebble_core::{new_id, now_timestamp, PebbleError};
use pebble_translate::types::TranslateProviderConfig;
use pebble_translate::TranslateService;
use serde::{Deserialize, Serialize};
use tauri::State;

/// Key under which all customer memories are stored (encrypted user data KV).
pub const CUSTOMER_MEMORIES_KEY: &str = "ai_customer_memories";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomerProfileContact {
    pub email: String,
    pub name: String,
    pub job_title: String,
}

/// One follow-up log entry on the customer timeline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FollowUpEntry {
    pub id: String,
    /// Unix seconds when the follow-up happened.
    pub date: i64,
    /// Channel: 邮件 / 电话 / 微信 / 展会 / 样品 / 其他.
    pub channel: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FollowUpSequenceStep {
    pub id: String,
    pub day_offset: i64,
    pub title: String,
    pub instruction: String,
    pub status: String,
    pub due_at: i64,
}

/// A persisted memory profile for one customer / contact, learned from the
/// email history with them. This is what turns the client from "a mail app"
/// into "a foreign-trade business brain" that remembers who each customer is.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerMemory {
    pub id: String,
    /// The contact's email address (used as the dedup key).
    pub email: String,
    /// Contact person name (if known).
    pub name: String,
    /// Company / organization.
    pub company: String,
    /// One-line overview shown in the list.
    pub summary: String,
    /// Detailed, structured context used as AI grounding when drafting.
    pub profile: String,
    /// How many messages were used to build this memory.
    pub message_count: usize,
    /// All known people belonging to this company. Added with a default so
    /// existing per-email records remain readable.
    #[serde(default)]
    pub contacts: Vec<CustomerProfileContact>,
    /// Manual tag for where this customer came from (e.g. 展会/社媒/谷歌开发).
    #[serde(default)]
    pub source: String,
    /// Manual tag for the current development stage (e.g. 开发中/已成交).
    #[serde(default)]
    pub status: String,
    /// Follow-up stage (mutually exclusive): 待开发/已联系/已报价/已寄样/谈判中/已成交/流失.
    #[serde(default)]
    pub stage: String,
    /// Free-form characteristic tags (multi-select): 价格敏感/质量优先/交期紧急/需要认证/定制需求/要过样品...
    #[serde(default)]
    pub tags: Vec<String>,
    /// Customer tier: A(重点) / B(常规) / C(培育).
    #[serde(default)]
    pub tier: String,
    /// Unix seconds of the next scheduled follow-up (0 = none).
    #[serde(default)]
    pub next_follow_up: i64,
    /// Follow-up timeline entries.
    #[serde(default)]
    pub follow_ups: Vec<FollowUpEntry>,
    /// 接触过该客户的账号（生成记忆时从往来邮件记录；空 = 旧数据/未知）
    #[serde(default)]
    pub account_ids: Vec<String>,
    #[serde(default)]
    pub follow_up_sequence: Vec<FollowUpSequenceStep>,
    #[serde(default)]
    pub follow_up_sequence_paused: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerMemoryInput {
    pub id: Option<String>,
    pub email: String,
    pub name: Option<String>,
    pub company: Option<String>,
    pub summary: Option<String>,
    pub profile: Option<String>,
    pub source: Option<String>,
    pub status: Option<String>,
    pub stage: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    pub tier: Option<String>,
    pub next_follow_up: Option<i64>,
    #[serde(default)]
    pub follow_ups: Option<Vec<FollowUpEntry>>,
    #[serde(default)]
    pub account_ids: Option<Vec<String>>,
    #[serde(default)]
    pub follow_up_sequence: Option<Vec<FollowUpSequenceStep>>,
    pub follow_up_sequence_paused: Option<bool>,
}

fn load_memories(state: &AppState) -> std::result::Result<Vec<CustomerMemory>, PebbleError> {
    let loaded: Vec<CustomerMemory> = match state.store.get_secure_user_data(CUSTOMER_MEMORIES_KEY)? {
        Some(encrypted) => {
            let decrypted = state.crypto.decrypt(&encrypted)?;
            serde_json::from_slice(&decrypted).unwrap_or_default()
        }
        None => Vec::new(),
    };
    Ok(group_company_profiles(loaded))
}

fn group_company_profiles(memories: Vec<CustomerMemory>) -> Vec<CustomerMemory> {
    let mut grouped: Vec<CustomerMemory> = Vec::new();
    for mut memory in memories {
        if !memory.email.trim().is_empty()
            && !memory.contacts.iter().any(|contact| contact.email.eq_ignore_ascii_case(&memory.email))
        {
            memory.contacts.push(CustomerProfileContact {
                email: memory.email.clone(),
                name: memory.name.clone(),
                job_title: String::new(),
            });
        }
        let company_key = memory.company.trim().to_lowercase();
        let existing = if company_key.is_empty() {
            grouped.iter_mut().find(|item| item.email.eq_ignore_ascii_case(&memory.email))
        } else {
            grouped.iter_mut().find(|item| item.company.trim().eq_ignore_ascii_case(&memory.company))
        };
        if let Some(existing) = existing {
            for contact in memory.contacts {
                if !existing.contacts.iter().any(|item| item.email.eq_ignore_ascii_case(&contact.email)) {
                    existing.contacts.push(contact);
                }
            }
            existing.message_count += memory.message_count;
            if memory.updated_at > existing.updated_at {
                existing.email = memory.email;
                existing.name = memory.name;
                existing.summary = memory.summary;
                existing.profile = memory.profile;
                existing.source = memory.source;
                existing.status = memory.status;
                existing.stage = memory.stage;
                existing.tags = memory.tags;
                existing.tier = memory.tier;
                existing.next_follow_up = memory.next_follow_up;
                existing.follow_ups = memory.follow_ups;
                existing.follow_up_sequence = memory.follow_up_sequence;
                existing.follow_up_sequence_paused = memory.follow_up_sequence_paused;
                existing.updated_at = memory.updated_at;
            }
        } else {
            grouped.push(memory);
        }
    }
    grouped
}

fn save_memories(state: &AppState, memories: &[CustomerMemory]) -> std::result::Result<(), PebbleError> {
    let plaintext = serde_json::to_vec(memories)
        .map_err(|e| PebbleError::Internal(format!("Failed to serialize customer memories: {e}")))?;
    let encrypted = state.crypto.encrypt(&plaintext)?;
    state.store.set_secure_user_data(CUSTOMER_MEMORIES_KEY, &encrypted)
}

/// List all customer memories.
#[tauri::command]
pub async fn list_customer_memories(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<CustomerMemory>, PebbleError> {
    load_memories(&state)
}

/// Create or update a customer memory. Upserted by id (or by email when no id).
#[tauri::command]
pub async fn save_customer_memory(
    state: State<'_, AppState>,
    input: CustomerMemoryInput,
) -> std::result::Result<CustomerMemory, PebbleError> {
    let mut memories = load_memories(&state)?;
    let now = now_timestamp();
    let email = input.email.trim().to_string();
    if email.is_empty() {
        return Err(PebbleError::Internal("客户邮箱不能为空".to_string()));
    }

    let id = input
        .id
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| memories.iter().find(|m| m.email == email).map(|m| m.id.clone()))
        .unwrap_or_else(new_id);

    let saved = CustomerMemory {
        id: id.clone(),
        email: email.clone(),
        name: input.name.clone().unwrap_or_default(),
        company: input.company.clone().unwrap_or_default(),
        summary: input.summary.clone().unwrap_or_default(),
        profile: input.profile.clone().unwrap_or_default(),
        message_count: 0,
        contacts: vec![CustomerProfileContact {
            email: email.clone(),
            name: input.name.clone().unwrap_or_default(),
            job_title: String::new(),
        }],
        source: input.source.clone().unwrap_or_default(),
        status: input.status.clone().unwrap_or_default(),
        stage: input.stage.clone().unwrap_or_default(),
        tags: input.tags.clone().unwrap_or_default(),
        tier: input.tier.clone().unwrap_or_default(),
        next_follow_up: input.next_follow_up.unwrap_or(0),
        follow_ups: input.follow_ups.clone().unwrap_or_default(),
        account_ids: input.account_ids.clone().unwrap_or_default(),
        follow_up_sequence: input.follow_up_sequence.clone().unwrap_or_default(),
        follow_up_sequence_paused: input.follow_up_sequence_paused.unwrap_or(false),
        updated_at: now,
    };

    match memories.iter_mut().find(|m| m.id == id) {
        Some(existing) => {
            existing.name = saved.name.clone();
            existing.company = saved.company.clone();
            existing.summary = saved.summary.clone();
            existing.profile = saved.profile.clone();
            existing.source = saved.source.clone();
            existing.status = saved.status.clone();
            existing.stage = saved.stage.clone();
            existing.tags = saved.tags.clone();
            existing.tier = saved.tier.clone();
            existing.next_follow_up = saved.next_follow_up;
            existing.follow_ups = saved.follow_ups.clone();
            existing.account_ids = saved.account_ids.clone();
            existing.follow_up_sequence = saved.follow_up_sequence.clone();
            existing.follow_up_sequence_paused = saved.follow_up_sequence_paused;
            if !existing.contacts.iter().any(|contact| contact.email.eq_ignore_ascii_case(&email)) {
                existing.contacts.push(saved.contacts[0].clone());
            }
            existing.updated_at = now;
        }
        None => memories.push(saved.clone()),
    }

    save_memories(&state, &memories)?;
    Ok(saved)
}

/// Delete a customer memory by id.
#[tauri::command]
pub async fn delete_customer_memory(
    state: State<'_, AppState>,
    id: String,
) -> std::result::Result<Vec<CustomerMemory>, PebbleError> {
    let mut memories = load_memories(&state)?;
    memories.retain(|m| m.id != id);
    save_memories(&state, &memories)?;
    Ok(memories)
}

/// Loose shape we ask the LLM to return. Everything optional so a partial or
/// slightly-off response still degrades gracefully.
#[derive(Debug, Deserialize, Default)]
struct LlmMemory {
    name: Option<String>,
    company: Option<String>,
    role: Option<String>,
    country: Option<String>,
    products: Option<Vec<String>>,
    key_facts: Option<Vec<String>>,
    relationship: Option<String>,
    last_topics: Option<String>,
    tags: Option<Vec<String>>,
}

/// Build (or refresh) a customer memory from the email history with `email`.
/// Gathers recent messages involving the contact, asks the configured LLM to
/// summarize who they are and what was discussed, then upserts the memory.
#[tauri::command]
pub async fn build_customer_memory(
    state: State<'_, AppState>,
    email: String,
    limit: u32,
    existing_profile: Option<String>,
) -> std::result::Result<CustomerMemory, PebbleError> {
    let email = email.trim().to_string();
    if email.is_empty() {
        return Err(PebbleError::Internal("客户邮箱不能为空".to_string()));
    }
    let email_lc = email.to_lowercase();

    // 1) Find messages involving this contact via the full-text index.
    let search = state.search.clone();
    let q = email.clone();
    let hits = tokio::task::spawn_blocking(move || search.search(&q, (limit as usize) * 3 + 10))
        .await
        .map_err(|e| PebbleError::Internal(format!("Search task join error: {e}")))??;

    let ids: Vec<String> = hits.iter().map(|h| h.message_id.clone()).collect();
    let messages = state.store.get_messages_batch(&ids)?;

    // 2) Keep only messages where the contact is sender or recipient.
    //    尽量覆盖全部往来邮件（corpus 上限放宽，不再只分析几封）。
    let mut corpus = String::new();
    let mut kept = 0usize;
    let mut account_ids: Vec<String> = Vec::new();
    for m in messages {
        let involves = m.from_address.to_lowercase() == email_lc
            || m.to_list
                .iter()
                .any(|a| a.address.to_lowercase() == email_lc);
        if !involves {
            continue;
        }
        if !account_ids.contains(&m.account_id) {
            account_ids.push(m.account_id.clone());
        }
        let body = m.body_text.trim();
        if body.len() < 20 {
            continue;
        }
        corpus.push_str(&format!("主题: {}\n{}\n\n", m.subject, body));
        kept += 1;
        if corpus.len() >= 30_000 {
            break;
        }
    }

    if corpus.trim().is_empty() {
        return Err(PebbleError::Internal(format!(
            "没有找到与 {email} 的往来邮件，无法生成记忆"
        )));
    }

    // 3) Ask the LLM to summarize the customer.
    //    传入了原有画像时 → 增量更新：保留原有有效信息，按最新邮件补充/修正。
    let cfg = load_active_provider_config(&state)?;
    let proxy = get_global_proxy_raw(&state.crypto, &state.store)?;
    let system = "You are a foreign-trade CRM assistant. Based on the email history \
below, build a structured customer profile. Return STRICT JSON (no markdown, no commentary) \
with these fields: name (contact person), company, role (their job title if inferable), \
country (if inferable), products (array of product categories discussed), keyFacts (array \
of concrete facts: what they asked, negotiated, complained about, ordered), relationship \
(short string: e.g. 'new lead', 'negotiating', 'regular buyer', 'after-sales'), lastTopics \
(what was most recently discussed), tags (array of short labels). Write values in the same \
language as the emails (usually Chinese), keep product/company names verbatim.";
    let existing_section = existing_profile
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .map(|p| format!("\n\n【原有客户画像，请保留其中仍然有效的全部信息，在此基础上根据新的邮件往来补充、修正，输出完整更新后的画像，不要丢失原有重要内容】\n{}", p.trim()))
        .unwrap_or_default();
    let user = format!(
        "客户邮箱: {email}\n\n邮件往来历史:\n{corpus}{existing_section}\n\n请输出 JSON 客户档案。"
    );

    let raw = TranslateService::complete_with_proxy(&cfg, proxy.as_ref(), &system, &user).await?;
    let parsed = parse_memory_json(&raw);

    let name = parsed.name.clone().unwrap_or_default();
    let company = parsed.company.clone().unwrap_or_default();
    let summary = build_summary(&parsed, &email);
    let mut profile = build_profile_text(&parsed);

    // 增量更新兜底：AI 未能完整保留原有画像时，绝不丢失原有信息——
    // 保留原有 profile 全文，并把新生成的内容作为"最新补充"追加在后面。
    if let Some(existing) = existing_profile.as_deref().filter(|p| !p.trim().is_empty()) {
        let existing = existing.trim();
        let merged = if profile.trim().len() >= existing.len() / 2 {
            // 新画像比较完整（≥原有一半长度）→ 直接用新画像（已按 prompt 保留原信息）
            profile
        } else {
            // 新画像明显变短 → 保留原有全文 + 追加最新补充
            format!(
                "{}\n\n---\n\n【最新邮件补充】\n{}",
                existing,
                profile.trim()
            )
        };
        profile = merged;
    }

    // 4) Upsert by company where possible, preserving each person's role.
    let mut memories = load_memories(&state)?;
    let id = memories
        .iter()
        .find(|m| {
            (!company.trim().is_empty() && m.company.trim().eq_ignore_ascii_case(&company))
                || m.email.eq_ignore_ascii_case(&email)
                || m.contacts.iter().any(|contact| contact.email.eq_ignore_ascii_case(&email))
        })
        .map(|m| m.id.clone())
        .unwrap_or_else(new_id);

    let contact = CustomerProfileContact {
        email: email.clone(),
        name: name.clone(),
        job_title: parsed.role.clone().unwrap_or_default(),
    };
    let mut saved = CustomerMemory {
        id: id.clone(),
        email: email.clone(),
        name,
        company,
        summary,
        profile,
        message_count: kept,
        contacts: vec![contact.clone()],
        source: String::new(),
        status: String::new(),
        stage: String::new(),
        tags: Vec::new(),
        tier: String::new(),
        next_follow_up: 0,
        follow_ups: Vec::new(),
        account_ids,
        follow_up_sequence: Vec::new(),
        follow_up_sequence_paused: false,
        updated_at: now_timestamp(),
    };

    match memories.iter_mut().find(|m| m.id == id) {
        Some(existing) => {
            saved.contacts = existing.contacts.clone();
            if let Some(existing_contact) = saved.contacts.iter_mut().find(|item| item.email.eq_ignore_ascii_case(&email)) {
                *existing_contact = contact;
            } else {
                saved.contacts.push(contact);
            }
            saved.message_count += existing.message_count;
            saved.source = existing.source.clone();
            saved.status = existing.status.clone();
            saved.stage = existing.stage.clone();
            saved.tags = existing.tags.clone();
            saved.tier = existing.tier.clone();
            saved.next_follow_up = existing.next_follow_up;
            saved.follow_ups = existing.follow_ups.clone();
            saved.follow_up_sequence = existing.follow_up_sequence.clone();
            saved.follow_up_sequence_paused = existing.follow_up_sequence_paused;
            *existing = saved.clone();
        }
        None => memories.push(saved.clone()),
    }
    save_memories(&state, &memories)?;
    Ok(saved)
}

fn load_active_provider_config(
    state: &AppState,
) -> std::result::Result<TranslateProviderConfig, PebbleError> {
    let stored = state
        .store
        .get_translate_config()?
        .ok_or_else(|| {
            PebbleError::Translate("尚未配置 AI 模型 (LLM) 引擎，请先在设置中配置".to_string())
        })?;
    if !stored.is_enabled {
        return Err(PebbleError::Translate("AI 引擎已禁用，请在设置中启用".to_string()));
    }
    let decrypted = decrypt_config(state, &stored.config)?;
    serde_json::from_str(&decrypted).map_err(|e| PebbleError::Translate(format!("配置解析失败: {e}")))
}

/// Extract the first JSON object from an LLM reply (tolerant of ```json fences).
fn parse_memory_json(raw: &str) -> LlmMemory {
    let text = raw.trim();
    let start = text.find('{').unwrap_or(0);
    let end = text.rfind('}').map(|i| i + 1).unwrap_or(text.len());
    let json = &text[start..end];
    serde_json::from_str::<LlmMemory>(json).unwrap_or_default()
}

fn build_summary(m: &LlmMemory, email: &str) -> String {
    let who = match (&m.name, &m.company) {
        (Some(n), Some(c)) if !n.is_empty() && !c.is_empty() => format!("{n}（{c}）"),
        (Some(n), _) if !n.is_empty() => n.clone(),
        (_, Some(c)) if !c.is_empty() => c.clone(),
        _ => email.to_string(),
    };
    let rel = m.relationship.clone().unwrap_or_else(|| "未知阶段".to_string());
    let topics = m.last_topics.clone().unwrap_or_default();
    if topics.is_empty() {
        format!("{who} — {rel}")
    } else {
        format!("{who} — {rel}；近期：{topics}")
    }
}

fn build_profile_text(m: &LlmMemory) -> String {
    let mut out = String::new();
    if let Some(c) = &m.company {
        if !c.is_empty() {
            out.push_str(&format!("公司：{c}\n"));
        }
    }
    if let Some(r) = &m.role {
        if !r.is_empty() {
            out.push_str(&format!("职位：{r}\n"));
        }
    }
    if let Some(co) = &m.country {
        if !co.is_empty() {
            out.push_str(&format!("国家/地区：{co}\n"));
        }
    }
    if let Some(p) = &m.products {
        if !p.is_empty() {
            out.push_str(&format!("涉及产品：{}\n", p.join("、")));
        }
    }
    if let Some(k) = &m.key_facts {
        if !k.is_empty() {
            out.push_str("关键事实：\n");
            for f in k {
                out.push_str(&format!("  - {f}\n"));
            }
        }
    }
    if let Some(rel) = &m.relationship {
        if !rel.is_empty() {
            out.push_str(&format!("关系阶段：{rel}\n"));
        }
    }
    if let Some(t) = &m.last_topics {
        if !t.is_empty() {
            out.push_str(&format!("近期话题：{t}\n"));
        }
    }
    if let Some(tags) = &m.tags {
        if !tags.is_empty() {
            out.push_str(&format!("标签：{}\n", tags.join("、")));
        }
    }
    if out.trim().is_empty() {
        out.push_str("（模型未返回结构化信息，请手动补充客户背景。）");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory(id: &str, email: &str, name: &str, company: &str, updated_at: i64) -> CustomerMemory {
        CustomerMemory {
            id: id.to_string(),
            email: email.to_string(),
            name: name.to_string(),
            company: company.to_string(),
            summary: name.to_string(),
            profile: format!("profile-{name}"),
            message_count: 2,
            contacts: Vec::new(),
            source: String::new(),
            status: String::new(),
            stage: String::new(),
            tags: Vec::new(),
            tier: String::new(),
            next_follow_up: 0,
            follow_ups: Vec::new(),
            account_ids: Vec::new(),
            follow_up_sequence: Vec::new(),
            follow_up_sequence_paused: false,
            updated_at,
        }
    }

    #[test]
    fn groups_contacts_from_the_same_company_case_insensitively() {
        let grouped = group_company_profiles(vec![
            memory("1", "buyer@example.com", "Alice", "Example Ltd", 1),
            memory("2", "manager@example.com", "Bob", "example ltd", 2),
        ]);

        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0].contacts.len(), 2);
        assert_eq!(grouped[0].message_count, 4);
        assert_eq!(grouped[0].email, "manager@example.com");
    }

    #[test]
    fn keeps_different_companies_separate() {
        let grouped = group_company_profiles(vec![
            memory("1", "a@example.com", "A", "Example Ltd", 1),
            memory("2", "b@other.com", "B", "Other Inc", 2),
        ]);

        assert_eq!(grouped.len(), 2);
    }
}
