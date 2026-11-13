use crate::state::AppState;
use pebble_core::PebbleError;
use serde::{Deserialize, Serialize};
use tauri::State;
use reqwest::Client;

const EXTERNAL_SERVICE_KEYS: &str = "external_service_api_keys";
static KEY_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StoredExternalServiceKeys {
    tavily: Option<String>,
    brave: Option<String>,
    firecrawl: Option<String>,
    hunter: Option<String>,
    #[serde(default)]
    tavily_keys: Vec<String>,
    #[serde(default)]
    brave_keys: Vec<String>,
    #[serde(default)]
    firecrawl_keys: Vec<String>,
    #[serde(default)]
    hunter_keys: Vec<String>,
    #[serde(default)]
    deepseek_keys: Vec<String>,
    #[serde(default)]
    deepseek_search_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalServiceKeyStatus {
    pub tavily_configured: bool,
    pub brave_configured: bool,
    pub firecrawl_configured: bool,
    pub hunter_configured: bool,
    pub deepseek_configured: bool,
    pub deepseek_search_enabled: bool,
    pub tavily_key_count: usize,
    pub brave_key_count: usize,
    pub firecrawl_key_count: usize,
    pub hunter_key_count: usize,
    pub deepseek_key_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalServiceUsage {
    pub provider: String,
    pub supported: bool,
    pub valid: bool,
    pub used: Option<f64>,
    pub limit: Option<f64>,
    pub remaining: Option<f64>,
    pub unit: String,
    pub reset_at: Option<String>,
    pub message: String,
    pub checked_at: i64,
}

fn usage_from_values(
    provider: &str,
    used: Option<f64>,
    limit: Option<f64>,
    unit: &str,
    reset_at: Option<String>,
    message: impl Into<String>,
    supported: bool,
    valid: bool,
) -> ExternalServiceUsage {
    ExternalServiceUsage {
        provider: provider.to_string(),
        supported,
        valid,
        remaining: match (used, limit) { (Some(used), Some(limit)) => Some((limit - used).max(0.0)), _ => None },
        used,
        limit,
        unit: unit.to_string(),
        reset_at,
        message: message.into(),
        checked_at: chrono::Utc::now().timestamp(),
    }
}

fn json_number(value: &serde_json::Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| value.get(*key).and_then(|item| item.as_f64().or_else(|| item.as_i64().map(|n| n as f64))))
}

async fn check_provider(provider: &str, api_key: &str) -> Result<ExternalServiceUsage, PebbleError> {
    let provider = normalize_provider(provider)?;
    if provider == "deepseek" {
        return check_deepseek_key(api_key).await;
    }
    let client = Client::builder().timeout(std::time::Duration::from_secs(12)).build()
        .map_err(|error| PebbleError::Network(error.to_string()))?;
    let response = match provider {
        "tavily" => client.get("https://api.tavily.com/usage").bearer_auth(api_key).send().await,
        "firecrawl" => client.get("https://api.firecrawl.dev/v2/team/credit-usage").bearer_auth(api_key).send().await,
        "hunter" => client.get("https://api.hunter.io/v2/account").query(&[("api_key", api_key)]).send().await,
        // Brave exposes request authentication and search results publicly, but
        // does not document a stable balance endpoint. A one-result request is
        // used only when the user explicitly clicks Verify.
        "brave" => client.get("https://api.search.brave.com/res/v1/web/search")
            .query(&[("q", "YaoAIMail API key validation"), ("count", "1")])
            .header("X-Subscription-Token", api_key)
            .send().await,
        _ => unreachable!(),
    }.map_err(|error| PebbleError::Network(error.to_string()))?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        let detail = body.get("error").and_then(|value| value.as_str()).unwrap_or_else(|| body.get("message").and_then(|value| value.as_str()).unwrap_or("服务商拒绝了请求"));
        return Ok(usage_from_values(provider, None, None, "", None, format!("验证失败（HTTP {}）：{}", status.as_u16(), detail), true, false));
    }
    match provider {
        "tavily" => {
            let key = body.get("key").unwrap_or(&body);
            let used = json_number(key, &["usage"]);
            let limit = json_number(key, &["limit"]);
            Ok(usage_from_values(provider, used, limit, "credits", None, "API Key 有效，已读取 Tavily 使用额度", true, true))
        }
        "firecrawl" => {
            let data = body.get("data").unwrap_or(&body);
            let remaining = json_number(data, &["remainingCredits"]);
            let limit = json_number(data, &["planCredits"]);
            let used = match (remaining, limit) { (Some(remaining), Some(limit)) => Some((limit - remaining).max(0.0)), _ => None };
            Ok(usage_from_values(provider, used, limit, "credits", data.get("billingPeriodEnd").and_then(|value| value.as_str()).map(str::to_string), "API Key 有效，已读取 Firecrawl 剩余额度", true, true))
        }
        "hunter" => {
            let data = body.get("data").unwrap_or(&body);
            let used = json_number(data, &["requests_used", "used", "credits_used"]);
            let limit = json_number(data, &["requests_limit", "limit", "credits_limit"]);
            let remaining = json_number(data, &["requests_left", "remaining", "credits_remaining"]);
            let derived_used = match (used, limit, remaining) { (None, Some(limit), Some(remaining)) => Some((limit - remaining).max(0.0)), _ => used };
            Ok(usage_from_values(provider, derived_used, limit, "credits/requests", data.get("reset_date").and_then(|value| value.as_str()).map(str::to_string), if limit.is_some() || remaining.is_some() { "API Key 有效，已读取 Hunter 使用情况" } else { "API Key 有效，但当前账户接口未返回可读额度" }, true, true))
        }
        "brave" => Ok(usage_from_values(provider, None, None, "requests/credits", None, "API Key 有效；Brave 未提供稳定的余额查询接口，请在服务商控制台查看额度", false, true)),
        _ => unreachable!(),
    }
}

async fn check_deepseek_key(key: &str) -> Result<ExternalServiceUsage, PebbleError> {
    let response = Client::builder().redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(8)).build()
        .map_err(|_| PebbleError::Network("DeepSeek 连接初始化失败".into()))?
        .get("https://api.deepseek.com/user/balance").bearer_auth(key).send().await
        .map_err(|_| PebbleError::Network("无法连接 DeepSeek 官方接口".into()))?;
    let (valid, message) = match pebble_websearch::bounded_json(response).await {
        Ok(body) => match body.get("is_available").and_then(serde_json::Value::as_bool) {
            Some(true) => (true, "DeepSeek 官方 Key 有效"),
            Some(false) => (true, "DeepSeek 官方 Key 有效；余额不足时将使用原有搜索"),
            None => (false, "DeepSeek 返回了无法识别的账户信息"),
        },
        Err(pebble_websearch::Failure::Auth) => (false, "DeepSeek 拒绝了这个 Key，请使用 DeepSeek 官方平台签发的 Key"),
        Err(_) => (false, "暂时无法验证 DeepSeek Key，请稍后重试"),
    };
    Ok(usage_from_values("deepseek", None, None, "", None, message, false, valid))
}

#[tauri::command]
pub async fn validate_external_service_api_key(
    provider: String,
    api_key: String,
) -> Result<ExternalServiceUsage, PebbleError> {
    let key = api_key.trim();
    if key.is_empty() { return Err(PebbleError::Validation("API Key 不能为空".to_string())); }
    check_provider(&provider, key).await
}

#[tauri::command]
pub async fn get_external_service_usage(
    state: State<'_, AppState>,
    provider: String,
) -> Result<ExternalServiceUsage, PebbleError> {
    let provider_name = normalize_provider(&provider)?;
    if provider_name == "brave" {
        return Ok(usage_from_values(provider_name, None, None, "requests/credits", None, "Brave 未提供稳定的余额查询接口，请在服务商控制台查看额度", false, true));
    }
    let key = get_external_service_api_keys(&state, provider_name)?.into_iter().next();
    let Some(key) = key else {
        return Ok(usage_from_values(provider_name, None, None, "", None, "尚未配置 API Key", true, false));
    };
    check_provider(provider_name, &key).await
}

fn normalize_provider(provider: &str) -> Result<&'static str, PebbleError> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "tavily" => Ok("tavily"),
        "brave" => Ok("brave"),
        "firecrawl" => Ok("firecrawl"),
        "hunter" => Ok("hunter"),
        "deepseek" => Ok("deepseek"),
        _ => Err(PebbleError::Validation(
            "Unsupported external service provider".to_string(),
        )),
    }
}

fn load_keys(state: &AppState) -> Result<StoredExternalServiceKeys, PebbleError> {
    load_keys_from(&state.store, &state.crypto)
}

fn load_keys_from(store: &pebble_store::Store, crypto: &pebble_crypto::CryptoService) -> Result<StoredExternalServiceKeys, PebbleError> {
    let Some(encrypted) = store.get_secure_user_data(EXTERNAL_SERVICE_KEYS)? else {
        return Ok(StoredExternalServiceKeys::default());
    };
    let plaintext = crypto.decrypt(&encrypted)?;
    let mut keys: StoredExternalServiceKeys = serde_json::from_slice(&plaintext)
        .map_err(|error| PebbleError::Internal(format!("Invalid external service keys: {error}")))?;
    promote_legacy_key(&mut keys.tavily_keys, keys.tavily.take());
    promote_legacy_key(&mut keys.brave_keys, keys.brave.take());
    promote_legacy_key(&mut keys.firecrawl_keys, keys.firecrawl.take());
    promote_legacy_key(&mut keys.hunter_keys, keys.hunter.take());
    Ok(keys)
}

fn promote_legacy_key(keys: &mut Vec<String>, legacy: Option<String>) {
    if let Some(value) = legacy.filter(|value| !value.trim().is_empty()) {
        if !keys.iter().any(|item| item == &value) {
            keys.insert(0, value);
        }
    }
}

fn save_keys(state: &AppState, keys: &StoredExternalServiceKeys) -> Result<(), PebbleError> {
    let plaintext = serde_json::to_vec(keys)
        .map_err(|error| PebbleError::Internal(format!("Failed to serialize external service keys: {error}")))?;
    let encrypted = state.crypto.encrypt(&plaintext)?;
    state.store.set_secure_user_data(EXTERNAL_SERVICE_KEYS, &encrypted)
}

fn status(keys: &StoredExternalServiceKeys) -> ExternalServiceKeyStatus {
    ExternalServiceKeyStatus {
        tavily_configured: !keys.tavily_keys.is_empty(),
        brave_configured: !keys.brave_keys.is_empty(),
        firecrawl_configured: !keys.firecrawl_keys.is_empty(),
        hunter_configured: !keys.hunter_keys.is_empty(),
        deepseek_configured: !keys.deepseek_keys.is_empty(),
        deepseek_search_enabled: keys.deepseek_search_enabled && !keys.deepseek_keys.is_empty(),
        tavily_key_count: keys.tavily_keys.len(),
        brave_key_count: keys.brave_keys.len(),
        firecrawl_key_count: keys.firecrawl_keys.len(),
        hunter_key_count: keys.hunter_keys.len(),
        deepseek_key_count: keys.deepseek_keys.len(),
    }
}

#[tauri::command]
pub async fn get_external_service_key_status(
    state: State<'_, AppState>,
) -> Result<ExternalServiceKeyStatus, PebbleError> {
    Ok(status(&load_keys(&state)?))
}

/// Independent, explicit consent. Merely saving a Key never permits billing.
#[tauri::command]
pub async fn set_deepseek_search_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<ExternalServiceKeyStatus, PebbleError> {
    update_deepseek_consent(&state, enabled)
}

fn update_deepseek_consent(state: &AppState, enabled: bool) -> Result<ExternalServiceKeyStatus, PebbleError> {
    let _guard = KEY_WRITE_LOCK.lock().map_err(|_| PebbleError::Internal("外部服务设置暂时无法保存，请重试。".into()))?;
    let mut keys = load_keys(state)?;
    if enabled && keys.deepseek_keys.is_empty() {
        return Err(PebbleError::Validation("请先保存 DeepSeek 官方 API Key，再启用付费搜索。".into()));
    }
    keys.deepseek_search_enabled = enabled;
    save_keys(state, &keys)?;
    Ok(status(&keys))
}

pub(super) fn deepseek_key_is_enabled(store: &pebble_store::Store, crypto: &pebble_crypto::CryptoService, key: &str) -> bool {
    load_keys_from(store, crypto).map(|keys| keys.deepseek_search_enabled && keys.deepseek_keys.iter().any(|saved| saved == key)).unwrap_or(false)
}

#[tauri::command]
pub async fn save_external_service_api_key(
    state: State<'_, AppState>,
    provider: String,
    api_key: String,
) -> Result<ExternalServiceKeyStatus, PebbleError> {
    let _guard = KEY_WRITE_LOCK.lock().map_err(|_| PebbleError::Internal("外部服务设置暂时无法保存，请重试。".into()))?;
    let provider = normalize_provider(&provider)?;
    let mut keys = load_keys(&state)?;
    let api_key = api_key.trim().to_string();
    if !api_key.is_empty() {
        let target = match provider {
            "tavily" => &mut keys.tavily_keys,
            "brave" => &mut keys.brave_keys,
            "firecrawl" => &mut keys.firecrawl_keys,
            "hunter" => &mut keys.hunter_keys,
            "deepseek" => &mut keys.deepseek_keys,
            _ => unreachable!(),
        };
        if provider == "deepseek" {
            if target.first() != Some(&api_key) { keys.deepseek_search_enabled = false; }
            let target = &mut keys.deepseek_keys;
            *target = vec![api_key];
        } else if !target.iter().any(|item| item == &api_key) {
            target.push(api_key);
        }
    }
    match provider {
        "tavily" => keys.tavily = None,
        "brave" => keys.brave = None,
        "firecrawl" => keys.firecrawl = None,
        "hunter" => keys.hunter = None,
        "deepseek" => (),
        _ => unreachable!(),
    }
    if keys.tavily_keys.is_empty() && keys.brave_keys.is_empty() && keys.firecrawl_keys.is_empty() && keys.hunter_keys.is_empty() && keys.deepseek_keys.is_empty() {
        state.store.delete_secure_user_data(EXTERNAL_SERVICE_KEYS)?;
    } else {
        save_keys(&state, &keys)?;
    }
    Ok(status(&keys))
}

#[tauri::command]
pub async fn list_external_service_api_keys(
    state: State<'_, AppState>,
    provider: String,
) -> Result<Vec<super::external_service_keys::KeyEntry>, PebbleError> {
    let provider = normalize_provider(&provider)?;
    let keys = get_external_service_api_keys(&state, provider)?;
    super::external_service_keys::entries(&state.crypto, provider, &keys)
}

#[tauri::command]
pub async fn delete_external_service_api_key(
    state: State<'_, AppState>,
    provider: String,
    key_id: String,
) -> Result<ExternalServiceKeyStatus, PebbleError> {
    let _guard = KEY_WRITE_LOCK.lock().map_err(|_| PebbleError::Internal("外部服务设置暂时无法保存，请重试。".into()))?;
    let provider = normalize_provider(&provider)?;
    let mut keys = load_keys(&state)?;
    let target = match provider {
        "tavily" => &mut keys.tavily_keys,
        "brave" => &mut keys.brave_keys,
        "firecrawl" => &mut keys.firecrawl_keys,
        "hunter" => &mut keys.hunter_keys,
        "deepseek" => &mut keys.deepseek_keys,
        _ => unreachable!(),
    };
    super::external_service_keys::remove(&state.crypto, provider, target, &key_id)?;
    if provider == "deepseek" && keys.deepseek_keys.is_empty() { keys.deepseek_search_enabled = false; }
    if keys.tavily_keys.is_empty() && keys.brave_keys.is_empty() && keys.firecrawl_keys.is_empty() && keys.hunter_keys.is_empty() && keys.deepseek_keys.is_empty() {
        state.store.delete_secure_user_data(EXTERNAL_SERVICE_KEYS)?;
    } else {
        save_keys(&state, &keys)?;
    }
    Ok(status(&keys))
}

#[allow(dead_code)]
pub(crate) fn get_external_service_api_key(
    state: &AppState,
    provider: &str,
) -> Result<Option<String>, PebbleError> {
    let provider = normalize_provider(provider)?;
    let keys = load_keys(state)?;
    Ok(match provider {
        "tavily" => keys.tavily_keys.first().cloned(),
        "brave" => keys.brave_keys.first().cloned(),
        "firecrawl" => keys.firecrawl_keys.first().cloned(),
        "hunter" => keys.hunter_keys.first().cloned(),
        "deepseek" => keys.deepseek_keys.first().cloned(),
        _ => unreachable!(),
    })
}

/// Returns all configured keys in user order. Callers should try the next key
/// when a provider returns an authentication, quota, or rate-limit failure.
pub(crate) fn get_external_service_api_keys(
    state: &AppState,
    provider: &str,
) -> Result<Vec<String>, PebbleError> {
    let provider = normalize_provider(provider)?;
    let keys = load_keys(state)?;
    Ok(match provider {
        "tavily" => keys.tavily_keys,
        "brave" => keys.brave_keys,
        "firecrawl" => keys.firecrawl_keys,
        "hunter" => keys.hunter_keys,
        "deepseek" => keys.deepseek_keys,
        _ => unreachable!(),
    })
}

#[cfg(test)]
mod tests {
    use super::normalize_provider;

    #[test]
    fn only_supported_providers_are_accepted() {
        assert_eq!(normalize_provider("TAVILY").unwrap(), "tavily");
        assert_eq!(normalize_provider("brave").unwrap(), "brave");
        assert_eq!(normalize_provider("firecrawl").unwrap(), "firecrawl");
        assert_eq!(normalize_provider("hunter").unwrap(), "hunter");
        assert_eq!(normalize_provider("deepseek").unwrap(), "deepseek");
        assert!(normalize_provider("unknown").is_err());
    }
}
