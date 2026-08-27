use crate::state::AppState;
use pebble_core::{new_id, now_timestamp, PebbleError};
use serde::{Deserialize, Serialize};
use std::collections::{hash_map::DefaultHasher, HashSet};
use std::hash::{Hash, Hasher};
use tauri::State;

const KNOWLEDGE_BASE_KEY: &str = "ai_local_knowledge_base";
const MAX_ITEM_CHARS: usize = 2_000_000;
const MAX_SNIPPET_CHARS: usize = 6_000;
const CHUNK_TARGET_CHARS: usize = 900;
const CHUNK_OVERLAP_CHARS: usize = 120;
const VECTOR_DIMS: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeChunk {
    pub id: String,
    pub content: String,
    pub locator: String,
    pub section: String,
    pub ordinal: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeItem {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub account_id: Option<String>,
    /// None means shared by all mailboxes. Some(ids) limits the material to
    /// one or more selected mailboxes. account_id remains for old data.
    #[serde(default)]
    pub account_ids: Option<Vec<String>>,
    pub source_type: String,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub chunks: Vec<KnowledgeChunk>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveKnowledgeItemInput {
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub account_ids: Option<Vec<String>>,
    pub source_type: Option<String>,
    pub content: String,
}

fn normalized_account_ids(ids: Option<Vec<String>>, legacy_id: Option<&str>) -> Option<Vec<String>> {
    let mut values = ids
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if values.is_empty() {
        if let Some(value) = legacy_id.map(str::trim).filter(|value| !value.is_empty()) {
            values.push(value.to_string());
        }
    }
    values.sort();
    values.dedup();
    if values.is_empty() { None } else { Some(values) }
}

fn item_applies_to_account(item: &KnowledgeItem, account_id: &str) -> bool {
    normalized_account_ids(item.account_ids.clone(), item.account_id.as_deref())
        .is_none_or(|ids| ids.iter().any(|id| id == account_id))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSnippet {
    pub id: String,
    pub name: String,
    pub content: String,
    pub score: f32,
    pub chunk_id: String,
    pub source_type: String,
    pub locator: String,
    pub section: String,
}

fn load_items(state: &AppState) -> Result<Vec<KnowledgeItem>, PebbleError> {
    let Some(encrypted) = state.store.get_secure_user_data(KNOWLEDGE_BASE_KEY)? else { return Ok(Vec::new()); };
    let decrypted = state.crypto.decrypt(&encrypted)?;
    serde_json::from_slice(&decrypted).map_err(|error| PebbleError::Internal(format!("Invalid local knowledge base: {error}")))
}

fn save_items(state: &AppState, items: &[KnowledgeItem]) -> Result<(), PebbleError> {
    if items.is_empty() { return state.store.delete_secure_user_data(KNOWLEDGE_BASE_KEY); }
    let plaintext = serde_json::to_vec(items).map_err(|error| PebbleError::Internal(format!("Failed to serialize knowledge base: {error}")))?;
    state.store.set_secure_user_data(KNOWLEDGE_BASE_KEY, &state.crypto.encrypt(&plaintext)?)
}

fn query_tokens(query: &str) -> HashSet<String> {
    let lower = query.to_lowercase();
    let mut tokens = lower.split(|ch: char| !ch.is_alphanumeric()).filter(|token| token.chars().count() >= 2).map(str::to_string).collect::<HashSet<_>>();
    let cjk = lower.chars().filter(|ch| ('\u{3400}'..='\u{9fff}').contains(ch)).collect::<Vec<_>>();
    for pair in cjk.windows(2) { tokens.insert(pair.iter().collect()); }
    tokens
}

fn lexical_score(name: &str, content: &str, tokens: &HashSet<String>) -> f32 {
    let name = name.to_lowercase();
    let content = content.to_lowercase();
    tokens.iter().map(|token| {
        let title = if name.contains(token) { 5.0 } else { 0.0 };
        let occurrences = content.match_indices(token).take(8).count() as f32;
        title + occurrences / (1.0 + content.chars().count() as f32 / 700.0)
    }).sum()
}

fn hashed_vector(value: &str) -> [f32; VECTOR_DIMS] {
    let mut vector = [0.0; VECTOR_DIMS];
    let lower = value.to_lowercase();
    let mut features = lower.split(|ch: char| !ch.is_alphanumeric()).filter(|part| !part.is_empty()).map(str::to_string).collect::<Vec<_>>();
    let chars = lower.chars().filter(|ch| !ch.is_whitespace()).collect::<Vec<_>>();
    for window in chars.windows(3) { features.push(window.iter().collect()); }
    for feature in features {
        let mut hasher = DefaultHasher::new(); feature.hash(&mut hasher);
        vector[(hasher.finish() as usize) % VECTOR_DIMS] += 1.0;
    }
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 { for value in &mut vector { *value /= norm; } }
    vector
}

fn vector_similarity(left: &[f32; VECTOR_DIMS], right: &[f32; VECTOR_DIMS]) -> f32 {
    left.iter().zip(right.iter()).map(|(a, b)| a * b).sum()
}

fn chunk_content(content: &str) -> Vec<KnowledgeChunk> {
    fn push_chunk(chunks: &mut Vec<KnowledgeChunk>, buffer: &mut String, locator: &str, section: &str) {
        if buffer.trim().is_empty() { return; }
        let ordinal = chunks.len();
        chunks.push(KnowledgeChunk { id: format!("chunk-{ordinal}"), content: buffer.trim().to_string(), locator: locator.to_string(), section: section.to_string(), ordinal });
        let overlap = buffer.chars().rev().take(CHUNK_OVERLAP_CHARS).collect::<String>().chars().rev().collect::<String>();
        *buffer = overlap;
    }
    let mut chunks = Vec::new(); let mut locator = "正文".to_string(); let mut section = String::new(); let mut buffer = String::new();
    for raw in content.lines() {
        let line = raw.trim();
        if let Some(value) = line.strip_prefix("[[PAGE:").and_then(|v| v.strip_suffix("]]")) { push_chunk(&mut chunks, &mut buffer, &locator, &section); locator = format!("第 {value} 页"); continue; }
        if let Some(value) = line.strip_prefix("[[SHEET:").and_then(|v| v.strip_suffix("]]")) { push_chunk(&mut chunks, &mut buffer, &locator, &section); locator = format!("工作表：{value}"); continue; }
        if line.starts_with('#') { section = line.trim_start_matches('#').trim().to_string(); }
        if !buffer.is_empty() { buffer.push('\n'); } buffer.push_str(raw);
        if buffer.chars().count() >= CHUNK_TARGET_CHARS { push_chunk(&mut chunks, &mut buffer, &locator, &section); }
    }
    push_chunk(&mut chunks, &mut buffer, &locator, &section); chunks
}

fn truncate_chars(value: &str, max_chars: usize) -> String { value.chars().take(max_chars).collect() }

#[tauri::command]
pub async fn list_knowledge_items(state: State<'_, AppState>, account_id: Option<String>) -> Result<Vec<KnowledgeItem>, PebbleError> {
    let mut items = load_items(&state)?;
    if let Some(account_id) = account_id.as_deref() {
        items.retain(|item| item_applies_to_account(item, account_id));
    }
    for item in &mut items {
        item.account_ids = normalized_account_ids(item.account_ids.clone(), item.account_id.as_deref());
        if item.chunks.is_empty() { item.chunks = chunk_content(&item.content); }
    }
    Ok(items)
}

#[tauri::command]
pub async fn save_knowledge_item(state: State<'_, AppState>, input: SaveKnowledgeItemInput) -> Result<KnowledgeItem, PebbleError> {
    let name = input.name.trim(); let content = input.content.trim();
    if name.is_empty() { return Err(PebbleError::Validation("资料名称不能为空".to_string())); }
    if content.is_empty() { return Err(PebbleError::Validation("资料内容不能为空".to_string())); }
    if content.chars().count() > MAX_ITEM_CHARS { return Err(PebbleError::Validation("单份资料不能超过 200 万字符".to_string())); }
    let mut items = load_items(&state)?; let now = now_timestamp(); let id = input.id.filter(|id| !id.trim().is_empty()).unwrap_or_else(new_id);
    let account_scope_provided = input.account_ids.is_some() || input.account_id.is_some();
    let legacy_account_id = input.account_id.filter(|value| !value.trim().is_empty());
    let account_ids = normalized_account_ids(input.account_ids, legacy_account_id.as_deref());
    let mut saved = KnowledgeItem { id: id.clone(), name: name.to_string(), account_id: account_ids.as_ref().and_then(|ids| ids.first().cloned()), account_ids, source_type: input.source_type.unwrap_or_else(|| "note".to_string()), content: content.to_string(), created_at: now, updated_at: now, chunks: chunk_content(content) };
    if let Some(existing) = items.iter_mut().find(|item| item.id == id) {
        saved.created_at = existing.created_at;
        if !account_scope_provided { saved.account_ids = normalized_account_ids(existing.account_ids.clone(), existing.account_id.as_deref()); }
        saved.account_id = saved.account_ids.as_ref().and_then(|ids| ids.first().cloned());
        *existing = saved.clone();
    } else { items.push(saved.clone()); }
    save_items(&state, &items)?; Ok(saved)
}

#[tauri::command]
pub async fn delete_knowledge_item(state: State<'_, AppState>, id: String) -> Result<(), PebbleError> {
    let mut items = load_items(&state)?; items.retain(|item| item.id != id); save_items(&state, &items)
}

#[tauri::command]
pub async fn search_knowledge_base(state: State<'_, AppState>, query: String, account_id: Option<String>, limit: Option<usize>) -> Result<Vec<KnowledgeSnippet>, PebbleError> {
    let tokens = query_tokens(&query); let query_vector = hashed_vector(&query); let mut scored = Vec::new();
    for mut item in load_items(&state)? {
        if let Some(account_id) = account_id.as_deref() {
            if !item_applies_to_account(&item, account_id) { continue; }
        }
        if item.chunks.is_empty() { item.chunks = chunk_content(&item.content); }
        for chunk in &item.chunks {
            let score = lexical_score(&item.name, &chunk.content, &tokens) * 0.72 + vector_similarity(&query_vector, &hashed_vector(&chunk.content)) * 8.0;
            if tokens.is_empty() || score > 0.18 { scored.push((item.clone(), chunk.clone(), score)); }
        }
    }
    scored.sort_by(|(li, _, ls), (ri, _, rs)| rs.total_cmp(ls).then_with(|| ri.updated_at.cmp(&li.updated_at)));
    Ok(scored.into_iter().take(limit.unwrap_or(3).clamp(1, 10)).map(|(item, chunk, score)| KnowledgeSnippet { id: item.id, name: item.name, content: truncate_chars(&chunk.content, MAX_SNIPPET_CHARS), score, chunk_id: chunk.id, source_type: item.source_type, locator: chunk.locator, section: chunk.section }).collect())
}

#[cfg(test)]
mod tests {
    use super::{chunk_content, lexical_score, query_tokens};
    #[test] fn chinese_query_builds_bigrams() { assert!(query_tokens("付款方式是什么").contains("付款")); }
    #[test] fn title_matches_rank() { assert!(lexical_score("付款条款", "定金百分之三十", &query_tokens("付款方式")) >= 4.0); }
    #[test] fn preserves_locators() { let c = chunk_content("[[PAGE:2]]\nhello\n[[SHEET:报价]]\nprice"); assert!(c.iter().any(|x| x.locator == "第 2 页")); assert!(c.iter().any(|x| x.locator == "工作表：报价")); }
}
