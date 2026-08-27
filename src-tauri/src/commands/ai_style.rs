use crate::state::AppState;
use pebble_core::{new_id, now_timestamp, FolderRole, PebbleError};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::State;

/// Key under which all style profiles are stored (encrypted user data KV).
const STYLE_PROFILES_KEY: &str = "ai_style_profiles";

/// A persisted writing-style profile learned from the user's sent emails.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleProfile {
    pub id: String,
    pub name: String,
    /// Short human-facing summary the user can edit.
    pub description: String,
    /// The reusable style guide (free text or structured JSON) used as the
    /// system persona when generating replies / composing emails.
    pub profile: String,
    pub is_active: bool,
    /// None means shared by all mailboxes; Some(ids) limits this style to
    /// one or more selected mailboxes. Old profiles deserialize as shared.
    #[serde(default)]
    pub account_ids: Option<Vec<String>>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One sample of the user's past writing, used to (re)learn a style.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleSample {
    pub subject: String,
    pub body: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleProfileInput {
    pub id: Option<String>,
    pub name: String,
    pub description: String,
    pub profile: String,
    pub is_active: Option<bool>,
    #[serde(default)]
    pub account_ids: Option<Vec<String>>,
}

fn normalize_account_ids(ids: Vec<String>) -> Vec<String> {
    let mut values = ids.into_iter().map(|value| value.trim().to_string()).filter(|value| !value.is_empty()).collect::<Vec<_>>();
    values.sort();
    values.dedup();
    values
}

fn load_profiles(state: &AppState) -> std::result::Result<Vec<StyleProfile>, PebbleError> {
    match state.store.get_secure_user_data(STYLE_PROFILES_KEY)? {
        Some(encrypted) => {
            let decrypted = state.crypto.decrypt(&encrypted)?;
            Ok(serde_json::from_slice(&decrypted).unwrap_or_default())
        }
        None => Ok(default_style_profiles()),
    }
}

fn default_style_profiles() -> Vec<StyleProfile> {
    let now = now_timestamp();
    [
        (
            "builtin-foreign-trade",
            "外贸商务风",
            "专业、清晰、友好，适合大多数客户沟通",
            "先给结论，再补充必要依据；句子简洁、段落短；语气专业而友好；明确价格、交期、付款、样品或下一步行动；避免空泛寒暄、夸张承诺和生硬的通用AI套话。",
            true,
        ),
        (
            "builtin-concise",
            "简洁直接风",
            "适合确认、催促、交期和付款跟进",
            "正文尽量短；第一段直接说明目的或结论；必要信息使用项目符号；请求要具体并带截止时间或下一步；礼貌但不绕弯；避免重复背景和过度热情。",
            false,
        ),
        (
            "builtin-warm",
            "亲和关系维护风",
            "适合老客户跟进和长期关系维护",
            "保持商务准确的同时更温暖；自然提及对方近况或合作进展；多使用感谢和积极措辞，但不谄媚；结尾给出轻量、明确的下一步；避免夸张赞美和冗长寒暄。",
            false,
        ),
    ]
    .into_iter()
    .map(|(id, name, description, profile, is_active)| StyleProfile {
        id: id.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        profile: profile.to_string(),
        is_active,
        account_ids: None,
        created_at: now,
        updated_at: now,
    })
    .collect()
}

fn clean_style_sample(body: &str) -> String {
    let mut lines = Vec::new();
    for raw in body.lines() {
        let line = raw.trim_end();
        let lower = line.trim().to_ascii_lowercase();
        if lower.starts_with("on ") && lower.ends_with(" wrote:")
            || lower.starts_with("from:")
            || lower.starts_with("发件人:")
            || lower.starts_with("发件人：")
        {
            break;
        }
        if lower == "--" || lower == "-- " {
            break;
        }
        if lower.contains("unsubscribe")
            || lower.contains("confidentiality notice")
            || lower.contains("tracking pixel")
        {
            continue;
        }
        lines.push(line.trim_start_matches('>').trim_start());
    }
    lines.join("\n").trim().to_string()
}

fn quoted_authored_sample(body: &str, own_email: &str) -> Option<String> {
    let lines = body.lines().collect::<Vec<_>>();
    let own = own_email.to_ascii_lowercase();
    for (index, line) in lines.iter().enumerate() {
        let lower = line.to_ascii_lowercase();
        let is_own_marker = lower.contains(&own)
            && (lower.contains("wrote")
                || lower.starts_with("from:")
                || lower.starts_with("发件人:")
                || lower.starts_with("发件人："));
        if !is_own_marker {
            continue;
        }

        let mut started = lower.contains("wrote");
        let mut extracted = Vec::new();
        for raw in lines.iter().skip(index + 1) {
            let trimmed = raw.trim().trim_start_matches('>').trim_start();
            let header = trimmed.to_ascii_lowercase();
            if !started
                && (trimmed.is_empty()
                    || header.starts_with("to:")
                    || header.starts_with("sent:")
                    || header.starts_with("date:")
                    || header.starts_with("subject:")
                    || header.starts_with("收件人:")
                    || header.starts_with("主题:")
                    || header.starts_with("发送时间:"))
            {
                if trimmed.is_empty() {
                    started = true;
                }
                continue;
            }
            if started
                && !extracted.is_empty()
                && ((header.starts_with("on ") && header.ends_with(" wrote:"))
                    || header.starts_with("from:")
                    || header.starts_with("发件人:"))
            {
                break;
            }
            if started {
                extracted.push(trimmed);
            }
        }
        let cleaned = clean_style_sample(&extracted.join("\n"));
        if cleaned.chars().count() >= 30 {
            return Some(cleaned);
        }
    }
    None
}

fn save_profiles(state: &AppState, profiles: &[StyleProfile]) -> std::result::Result<(), PebbleError> {
    let plaintext = serde_json::to_vec(profiles)
        .map_err(|e| PebbleError::Internal(format!("Failed to serialize style profiles: {e}")))?;
    let encrypted = state.crypto.encrypt(&plaintext)?;
    state.store.set_secure_user_data(STYLE_PROFILES_KEY, &encrypted)
}

/// List all writing-style profiles.
#[tauri::command]
pub async fn list_style_profiles(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<StyleProfile>, PebbleError> {
    load_profiles(&state)
}

/// Create or update a style profile. Upserted by id; if it becomes the only or
/// explicitly active profile, other profiles are deactivated.
#[tauri::command]
pub async fn save_style_profile(
    state: State<'_, AppState>,
    input: StyleProfileInput,
) -> std::result::Result<StyleProfile, PebbleError> {
    let mut profiles = load_profiles(&state)?;
    let now = now_timestamp();
    let id = input
        .id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(new_id);
    let becomes_active = input.is_active.unwrap_or(false) || profiles.is_empty();

    if becomes_active {
        for p in profiles.iter_mut() {
            p.is_active = false;
        }
    }

    let existing_account_ids = profiles.iter().find(|p| p.id == id).and_then(|p| p.account_ids.clone());
    // `None` means the caller did not change the legacy field; an explicit
    // empty array means this style is assigned to no account. This prevents a
    // cleared selector from silently becoming shared by every mailbox.
    let account_ids = match input.account_ids {
        Some(ids) => Some(normalize_account_ids(ids)),
        None => existing_account_ids,
    };
    let mut saved = StyleProfile {
        id: id.clone(),
        name: input.name.trim().to_string(),
        description: input.description.trim().to_string(),
        profile: input.profile,
        is_active: becomes_active,
        account_ids,
        created_at: now,
        updated_at: now,
    };

    match profiles.iter_mut().find(|p| p.id == id) {
        Some(existing) => {
            saved.created_at = existing.created_at;
            existing.name = saved.name.clone();
            existing.description = saved.description.clone();
            existing.profile = saved.profile.clone();
            existing.is_active = saved.is_active;
            existing.account_ids = saved.account_ids.clone();
            existing.updated_at = now;
        }
        None => profiles.push(saved.clone()),
    }

    save_profiles(&state, &profiles)?;
    Ok(saved)
}

/// Delete a style profile. If it was active and others remain, the first
/// remaining profile is promoted to active.
#[tauri::command]
pub async fn delete_style_profile(
    state: State<'_, AppState>,
    id: String,
) -> std::result::Result<Vec<StyleProfile>, PebbleError> {
    let mut profiles = load_profiles(&state)?;
    profiles.retain(|p| p.id != id);
    if !profiles.is_empty() && !profiles.iter().any(|p| p.is_active) {
        profiles[0].is_active = true;
    }
    save_profiles(&state, &profiles)?;
    Ok(profiles)
}

/// Collect recent samples of the user's SENT emails so the frontend can ask the
/// LLM to learn a writing-style profile from them.
#[tauri::command]
pub async fn get_sent_samples(
    state: State<'_, AppState>,
    limit: u32,
    account_id: Option<String>,
) -> std::result::Result<Vec<StyleSample>, PebbleError> {
    let mut samples: Vec<StyleSample> = Vec::new();
    let mut seen = HashSet::new();
    let accounts = state.store.list_accounts()?;
    let accounts: Vec<_> = match account_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        Some(target_id) => accounts.into_iter().filter(|account| account.id == target_id).collect(),
        None => accounts,
    };
    for acc in &accounts {
        if let Some(folder) = state.store.find_folder_by_role(&acc.id, FolderRole::Sent)? {
            let messages = state
                .store
                .list_full_messages_by_folder(&folder.id, limit, 0)?;
            for m in messages {
                let body = clean_style_sample(&m.body_text);
                if body.chars().count() >= 30 && seen.insert(body.clone()) {
                    samples.push(StyleSample {
                        subject: m.subject.clone(),
                        body,
                    });
                }
                if samples.len() >= limit as usize {
                    break;
                }
            }
        }
        if samples.len() >= limit as usize {
            break;
        }
    }

    // Some providers or imported archives do not expose a Sent folder. A
    // customer's reply often quotes the user's earlier message; recover only
    // quote blocks explicitly attributed to this account's own address.
    if samples.len() < limit as usize {
        for acc in &accounts {
            for folder in state.store.list_folders(&acc.id)? {
                if folder.role == Some(FolderRole::Sent) {
                    continue;
                }
                let scan_limit = limit.saturating_mul(5).clamp(20, 200);
                for message in state
                    .store
                    .list_full_messages_by_folder(&folder.id, scan_limit, 0)?
                {
                    if let Some(body) = quoted_authored_sample(&message.body_text, &acc.email) {
                        if seen.insert(body.clone()) {
                            samples.push(StyleSample {
                                subject: message.subject,
                                body,
                            });
                        }
                    }
                    if samples.len() >= limit as usize {
                        return Ok(samples);
                    }
                }
            }
        }
    }
    Ok(samples)
}
