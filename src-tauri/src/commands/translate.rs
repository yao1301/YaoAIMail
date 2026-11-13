use super::network::get_global_proxy_raw;
use crate::state::AppState;
use pebble_core::{now_timestamp, PebbleError, TranslateConfig};
use pebble_translate::types::{TranslateProviderConfig, TranslateResult};
use pebble_translate::TranslateService;
use tauri::State;

/// Decode a hex string to bytes.
fn hex_decode(s: &str) -> std::result::Result<Vec<u8>, PebbleError> {
    if !s.len().is_multiple_of(2) {
        return Err(PebbleError::Internal(
            "Invalid hex string length".to_string(),
        ));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|e| PebbleError::Internal(format!("Invalid hex: {e}")))
}

/// Encode bytes to a hex string.
fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Decrypt the config field of a TranslateConfig using the app's crypto service.
/// If the stored value is legacy plaintext JSON, migrates it to encrypted form in-place.
pub(crate) fn decrypt_config(
    state: &AppState,
    stored: &str,
) -> std::result::Result<String, PebbleError> {
    if serde_json::from_str::<serde_json::Value>(stored).is_ok() {
        // Legacy plaintext config — migrate to encrypted form in-place.
        let encrypted = encrypt_config(state, stored)?;
        state.store.update_translate_config_blob(&encrypted)?;
        return Ok(stored.to_string());
    }
    let bytes = hex_decode(stored)?;
    let decrypted = state.crypto.decrypt(&bytes)?;
    String::from_utf8(decrypted)
        .map_err(|e| PebbleError::Internal(format!("Invalid UTF-8 in decrypted config: {e}")))
}

/// Encrypt a plaintext config string for storage.
pub(crate) fn encrypt_config(
    state: &AppState,
    plaintext: &str,
) -> std::result::Result<String, PebbleError> {
    let encrypted = state.crypto.encrypt(plaintext.as_bytes())?;
    Ok(hex_encode(&encrypted))
}

#[tauri::command]
pub async fn translate_text(
    state: State<'_, AppState>,
    text: String,
    from_lang: String,
    to_lang: String,
) -> std::result::Result<TranslateResult, PebbleError> {
    let config = state
        .store
        .get_translate_config()?
        .ok_or_else(|| PebbleError::Translate("No translate engine configured".to_string()))?;

    if !config.is_enabled {
        return Err(PebbleError::Translate(
            "Translation is disabled".to_string(),
        ));
    }

    // Decrypt config before parsing
    let decrypted = decrypt_config(&state, &config.config)?;
    let provider_config: TranslateProviderConfig = serde_json::from_str(&decrypted)
        .map_err(|e| PebbleError::Translate(format!("Invalid config: {e}")))?;

    validate_provider_config(&provider_config)?;

    let proxy = get_global_proxy_raw(&state.crypto, &state.store)?;

    TranslateService::translate_with_proxy(
        &provider_config,
        proxy.as_ref(),
        &text,
        &from_lang,
        &to_lang,
    )
    .await
}

#[tauri::command]
pub async fn get_translate_config(
    state: State<'_, AppState>,
) -> std::result::Result<Option<TranslateConfig>, PebbleError> {
    let config = state.store.get_translate_config()?;
    // Return config with decrypted config field so frontend can display/edit it
    match config {
        Some(mut tc) => {
            tc.config = decrypt_config(&state, &tc.config)?;
            Ok(Some(tc))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn save_translate_config(
    state: State<'_, AppState>,
    provider_type: String,
    config: String,
    is_enabled: bool,
) -> std::result::Result<(), PebbleError> {
    // Validate URL(s) in config before persisting
    let provider_config: TranslateProviderConfig = serde_json::from_str(&config)
        .map_err(|e| PebbleError::Translate(format!("Invalid config: {e}")))?;
    validate_provider_config(&provider_config)?;

    let now = now_timestamp();
    // Encrypt config before storing
    let encrypted = encrypt_config(&state, &config)?;
    let tc = TranslateConfig {
        id: "active".to_string(),
        provider_type,
        config: encrypted,
        is_enabled,
        created_at: now,
        updated_at: now,
    };
    state.store.save_translate_config(&tc)
}

/// Validate URL(s) in a TranslateProviderConfig.
fn validate_provider_config(
    provider_config: &TranslateProviderConfig,
) -> std::result::Result<(), PebbleError> {
    match provider_config {
        TranslateProviderConfig::DeepLX { endpoint } => validate_translate_url(endpoint),
        TranslateProviderConfig::GenericApi { endpoint, .. } => validate_translate_url(endpoint),
        TranslateProviderConfig::LLM { providers, .. } => {
            for p in providers {
                validate_translate_url(&p.base_url)?;
            }
            Ok(())
        }
        TranslateProviderConfig::DeepL { .. } => Ok(()), // uses official API, no custom URL
    }
}

/// Explicitly configured endpoints may use HTTP on trusted local/private IPs.
fn validate_translate_url(url: &str) -> std::result::Result<(), PebbleError> {
    pebble_translate::endpoint::validate_service_endpoint(url).map_err(PebbleError::Validation)
}

#[tauri::command]
pub async fn test_translate_connection(
    state: State<'_, AppState>,
    config: String,
) -> std::result::Result<String, PebbleError> {
    let provider_config: TranslateProviderConfig = serde_json::from_str(&config)
        .map_err(|e| PebbleError::Translate(format!("Invalid config: {e}")))?;

    // Validate endpoint URLs before making any requests
    validate_provider_config(&provider_config)?;

    let proxy = get_global_proxy_raw(&state.crypto, &state.store)?;
    TranslateService::test_connection(&provider_config, proxy.as_ref()).await?;
    Ok("连接成功".into())
}

#[tauri::command]
pub async fn list_llm_models(state: State<'_, AppState>, config: String) -> std::result::Result<Vec<String>, PebbleError> {
    let config: TranslateProviderConfig = serde_json::from_str(&config)
        .map_err(|_| PebbleError::Validation("模型配置无效，请检查接口地址".into()))?;
    let TranslateProviderConfig::LLM { providers, active_id } = &config else {
        return Err(PebbleError::Validation("请选择 AI 模型配置".into()));
    };
    let provider = providers.iter().find(|p| &p.id == active_id)
        .ok_or_else(|| PebbleError::Validation("未选择有效的模型配置".into()))?;
    validate_translate_url(&provider.base_url)?;
    let proxy = get_global_proxy_raw(&state.crypto, &state.store)?;
    let client = TranslateService::http_client_for_config(&config, proxy.as_ref())?;
    pebble_translate::models::list_models(&client, &provider.base_url, &provider.api_key, &provider.chat_path).await
}
