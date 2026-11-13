use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TranslateProviderConfig {
    #[serde(rename = "deeplx")]
    DeepLX { endpoint: String },
    #[serde(rename = "deepl")]
    DeepL { api_key: String, use_free_api: bool },
    #[serde(rename = "generic_api")]
    GenericApi {
        endpoint: String,
        api_key: Option<String>,
        source_lang_param: String,
        target_lang_param: String,
        text_param: String,
        result_path: String,
    },
    #[serde(rename = "llm")]
    LLM {
        providers: Vec<LlmProvider>,
        active_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LLMMode {
    Completions,
    Responses,
}

/// Built-in LLM provider families plus a fully custom option.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    OpenAI,
    DeepSeek,
    Gemini,
    Custom,
}

/// A single configured LLM provider. `base_url` is the API base (e.g.
/// `https://api.openai.com/v1`); `chat_path` is the route appended for chat
/// completions (e.g. `/chat/completions`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmProvider {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub chat_path: String,
    pub api_key: String,
    pub model: String,
    pub mode: LLMMode,
    /// Missing in older profiles, which always inherited the shared proxy.
    /// Newly created profiles explicitly store false until the user opts in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_proxy: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslateResult {
    pub translated: String,
    pub segments: Vec<BilingualSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BilingualSegment {
    pub source: String,
    pub target: String,
}
