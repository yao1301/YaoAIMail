use crate::commands::network::get_global_proxy_raw;
use crate::commands::translate::decrypt_config;
use crate::state::AppState;
use pebble_core::PebbleError;
use pebble_translate::llm::ChatTurn;
use pebble_translate::types::TranslateProviderConfig;
use pebble_translate::TranslateService;
use serde::Deserialize;
use tauri::State;

/// One turn of a multi-turn chat, as sent from the frontend.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatTurnInput {
    pub role: String,
    pub content: String,
}

/// Load and decrypt the active LLM provider config from the translate store.
/// Reuses the same config the user sets up in Settings → AI 模型 (LLM), so the
/// AI features and translation share one provider list.
pub(crate) fn load_active_provider_config(
    state: &AppState,
) -> std::result::Result<TranslateProviderConfig, PebbleError> {
    let stored = state
        .store
        .get_translate_config()?
        .ok_or_else(|| {
            PebbleError::Translate(
                "尚未配置 AI 模型 (LLM) 引擎，请先在设置中配置".to_string(),
            )
        })?;
    if !stored.is_enabled {
        return Err(PebbleError::Translate(
            "AI 引擎已禁用，请在设置中启用".to_string(),
        ));
    }
    let decrypted = decrypt_config(state, &stored.config)?;
    serde_json::from_str(&decrypted)
        .map_err(|e| PebbleError::Translate(format!("配置解析失败: {e}")))
}

/// Single-shot AI completion. The frontend supplies the system + user prompt.
#[tauri::command]
pub async fn ai_prompt(
    state: State<'_, AppState>,
    system: String,
    user: String,
) -> std::result::Result<String, PebbleError> {
    let cfg = load_active_provider_config(&state)?;
    let proxy = get_global_proxy_raw(&state.crypto, &state.store)?;
    TranslateService::complete_with_proxy(&cfg, proxy.as_ref(), &system, &user)
        .await
}

/// Multi-turn AI chat. Enables iterative refinement of drafts and replies.
#[tauri::command]
pub async fn ai_chat(
    state: State<'_, AppState>,
    turns: Vec<ChatTurnInput>,
) -> std::result::Result<String, PebbleError> {
    if turns.is_empty() {
        return Err(PebbleError::Translate("对话内容为空".to_string()));
    }
    let cfg = load_active_provider_config(&state)?;
    let proxy = get_global_proxy_raw(&state.crypto, &state.store)?;
    let turns_ref: Vec<ChatTurn<'_>> = turns
        .iter()
        .map(|t| ChatTurn {
            role: t.role.as_str(),
            content: t.content.as_str(),
        })
        .collect();
    TranslateService::complete_chat_with_proxy(&cfg, proxy.as_ref(), &turns_ref)
        .await
}
