pub mod deepl;
pub mod deeplx;
pub mod generic;
pub mod llm;
pub mod types;

use pebble_core::{HttpProxyConfig, PebbleError, Result};
use types::{TranslateProviderConfig, TranslateResult};
use llm::ChatTurn;

pub struct TranslateService;

impl TranslateService {
    pub fn http_client_with_proxy(proxy: Option<&HttpProxyConfig>) -> Result<reqwest::Client> {
        let mut builder = reqwest::ClientBuilder::new();
        if let Some(proxy) = proxy {
            let uri = proxy.socks5h_uri().map_err(PebbleError::Network)?;
            let reqwest_proxy = reqwest::Proxy::all(&uri)
                .map_err(|e| PebbleError::Network(format!("Invalid proxy: {e}")))?;
            builder = builder.proxy(reqwest_proxy);
        }
        builder
            .build()
            .map_err(|e| PebbleError::Network(format!("Failed to build HTTP client: {e}")))
    }

    pub async fn translate(
        config: &TranslateProviderConfig,
        text: &str,
        from: &str,
        to: &str,
    ) -> Result<TranslateResult> {
        Self::translate_with_proxy(config, None, text, from, to).await
    }

    pub async fn translate_with_proxy(
        config: &TranslateProviderConfig,
        proxy: Option<&HttpProxyConfig>,
        text: &str,
        from: &str,
        to: &str,
    ) -> Result<TranslateResult> {
        let client = Self::http_client_with_proxy(proxy)?;

        match config {
            TranslateProviderConfig::DeepLX { endpoint } => {
                deeplx::translate(&client, endpoint, text, from, to).await
            }
            TranslateProviderConfig::DeepL {
                api_key,
                use_free_api,
            } => deepl::translate(&client, api_key, *use_free_api, text, from, to).await,
            TranslateProviderConfig::GenericApi {
                endpoint,
                api_key,
                source_lang_param,
                target_lang_param,
                text_param,
                result_path,
            } => {
                generic::translate(
                    &client,
                    endpoint,
                    api_key.as_deref(),
                    source_lang_param,
                    target_lang_param,
                    text_param,
                    result_path,
                    text,
                    from,
                    to,
                )
                .await
            }
            TranslateProviderConfig::LLM { providers, active_id } => {
                let active = providers
                    .iter()
                    .find(|p| &p.id == active_id)
                    .ok_or_else(|| {
                        PebbleError::Translate("No active LLM provider selected".to_string())
                    })?;
                llm::translate(
                    &client,
                    &active.base_url,
                    &active.api_key,
                    &active.model,
                    &active.mode,
                    &active.chat_path,
                    text,
                    from,
                    to,
                )
                .await
            }
        }
    }

    /// Run a general LLM completion against the configured active provider.
    /// Used by the外贸AI features (style learning, reply generation, summarization, agent).
    pub async fn complete(
        config: &TranslateProviderConfig,
        system: &str,
        user: &str,
    ) -> Result<String> {
        Self::complete_with_proxy(config, None, system, user).await
    }

    /// Like [`complete`], but routes through the global SOCKS5 proxy when set.
    pub async fn complete_with_proxy(
        config: &TranslateProviderConfig,
        proxy: Option<&HttpProxyConfig>,
        system: &str,
        user: &str,
    ) -> Result<String> {
        let client = Self::http_client_with_proxy(proxy)?;

        match config {
            TranslateProviderConfig::LLM { providers, active_id } => {
                let active = providers
                    .iter()
                    .find(|p| &p.id == active_id)
                    .ok_or_else(|| {
                        PebbleError::Translate(
                            "No active LLM provider selected. Configure an AI 模型 (LLM) provider first."
                                .to_string(),
                        )
                    })?;
                llm::complete(
                    &client,
                    &active.base_url,
                    &active.api_key,
                    &active.model,
                    &active.mode,
                    &active.chat_path,
                    system,
                    user,
                )
                .await
            }
            _ => Err(PebbleError::Translate(
                "AI features require an LLM provider. Please configure the AI 模型 (LLM) engine in settings."
                    .to_string(),
            )),
        }
    }

    /// Short structured completion with a bounded output and low reasoning
    /// effort where supported. Kept separate so normal AI writing behavior is
    /// unchanged.
    pub async fn complete_fast_with_proxy(
        config: &TranslateProviderConfig,
        proxy: Option<&HttpProxyConfig>,
        system: &str,
        user: &str,
        max_output_tokens: u32,
    ) -> Result<String> {
        let client = Self::http_client_with_proxy(proxy)?;
        match config {
            TranslateProviderConfig::LLM { providers, active_id } => {
                let active = providers
                    .iter()
                    .find(|provider| &provider.id == active_id)
                    .ok_or_else(|| PebbleError::Translate("No active LLM provider selected".to_string()))?;
                llm::complete_fast(
                    &client,
                    &active.base_url,
                    &active.api_key,
                    &active.model,
                    &active.kind,
                    &active.mode,
                    &active.chat_path,
                    system,
                    user,
                    max_output_tokens,
                ).await
            }
            _ => Err(PebbleError::Translate(
                "AI features require an LLM provider".to_string(),
            )),
        }
    }

    /// Multi-turn chat completion (see [`llm::complete_chat`]) against the active provider.
    pub async fn complete_chat(
        config: &TranslateProviderConfig,
        turns: &[ChatTurn<'_>],
    ) -> Result<String> {
        Self::complete_chat_with_proxy(config, None, turns).await
    }

    /// Like [`complete_chat`], but routes through the global SOCKS5 proxy when set.
    pub async fn complete_chat_with_proxy(
        config: &TranslateProviderConfig,
        proxy: Option<&HttpProxyConfig>,
        turns: &[ChatTurn<'_>],
    ) -> Result<String> {
        let client = Self::http_client_with_proxy(proxy)?;

        match config {
            TranslateProviderConfig::LLM { providers, active_id } => {
                let active = providers
                    .iter()
                    .find(|p| &p.id == active_id)
                    .ok_or_else(|| {
                        PebbleError::Translate(
                            "No active LLM provider selected. Configure an AI 模型 (LLM) provider first."
                                .to_string(),
                        )
                    })?;
                llm::complete_chat(
                    &client,
                    &active.base_url,
                    &active.api_key,
                    &active.model,
                    &active.mode,
                    &active.chat_path,
                    turns,
                )
                .await
            }
            _ => Err(PebbleError::Translate(
                "AI features require an LLM provider. Please configure the AI 模型 (LLM) engine in settings."
                    .to_string(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pebble_core::HttpProxyConfig;

    #[test]
    fn translate_service_accepts_socks5_proxy_config() {
        let proxy = HttpProxyConfig {
            host: "127.0.0.1".to_string(),
            port: 7890,
        };

        let client = TranslateService::http_client_with_proxy(Some(&proxy));

        assert!(client.is_ok());
    }

    #[test]
    fn translate_service_rejects_invalid_proxy_config() {
        let proxy = HttpProxyConfig {
            host: " ".to_string(),
            port: 7890,
        };

        let err = TranslateService::http_client_with_proxy(Some(&proxy)).unwrap_err();

        assert!(err.to_string().contains("Proxy host"));
    }

    #[tokio::test]
    async fn translate_service_validates_proxy_before_translation_request() {
        let config = TranslateProviderConfig::DeepLX {
            endpoint: "http://localhost:1188/translate".to_string(),
        };
        let proxy = HttpProxyConfig {
            host: " ".to_string(),
            port: 7890,
        };

        let err =
            TranslateService::translate_with_proxy(&config, Some(&proxy), "Hello", "en", "zh")
                .await
                .unwrap_err();

        assert!(err.to_string().contains("Proxy host"));
    }
}
