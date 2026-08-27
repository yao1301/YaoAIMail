use pebble_core::{PebbleError, Result};

use crate::deeplx::build_segments;
use crate::types::{LLMMode, ProviderKind, TranslateResult};

/// A single turn in a multi-turn chat. `role` is "system" | "user" | "assistant".
#[derive(Debug, Clone)]
pub struct ChatTurn<'a> {
    pub role: &'a str,
    pub content: &'a str,
}

#[allow(clippy::too_many_arguments)]
pub async fn complete(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    model: &str,
    mode: &LLMMode,
    chat_path: &str,
    system: &str,
    user: &str,
) -> Result<String> {
    let turns = [
        ChatTurn { role: "system", content: system },
        ChatTurn { role: "user", content: user },
    ];
    complete_chat(client, base_url, api_key, model, mode, chat_path, &turns).await
}

/// Responses API output commonly starts with a `reasoning` item and places
/// the assistant message later in the array. Reading only `/output/0` silently
/// turns a successful reasoning-model response into an empty string.
fn responses_output_text(json: &serde_json::Value) -> String {
    if let Some(text) = json.get("output_text").and_then(|value| value.as_str()) {
        return text.to_string();
    }
    let output = json.get("output")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("content").and_then(|value| value.as_array()))
        .flatten()
        .filter_map(|content| content.get("text").and_then(|value| value.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    if !output.is_empty() {
        return output;
    }
    // Some OpenAI-compatible gateways expose a Responses-style endpoint but
    // still return the Chat Completions envelope.
    json.pointer("/choices/0/message/content")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string()
}

/// A bounded completion for short structured tasks such as candidate-list
/// generation. Reasoning-first models can otherwise spend minutes on a simple
/// JSON enumeration. This intentionally does not change the normal writing,
/// translation, or research paths.
#[allow(clippy::too_many_arguments)]
pub async fn complete_fast(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    model: &str,
    kind: &ProviderKind,
    mode: &LLMMode,
    chat_path: &str,
    system: &str,
    user: &str,
    max_output_tokens: u32,
) -> Result<String> {
    let path = match mode {
        LLMMode::Completions => chat_path.to_string(),
        LLMMode::Responses => "/responses".to_string(),
    };
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let mut body = match mode {
        LLMMode::Completions => serde_json::json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user }
            ],
            "temperature": 0.3,
        }),
        LLMMode::Responses => serde_json::json!({
            "model": model,
            "input": format!("[System] {system}\n\n[User] {user}"),
            "max_output_tokens": max_output_tokens,
        }),
    };
    match mode {
        LLMMode::Completions if *kind == ProviderKind::OpenAI => {
            body["max_completion_tokens"] = serde_json::json!(max_output_tokens);
            body["reasoning_effort"] = serde_json::json!("minimal");
        }
        LLMMode::Completions => {
            body["max_tokens"] = serde_json::json!(max_output_tokens);
        }
        LLMMode::Responses if *kind == ProviderKind::OpenAI => {
            body["reasoning"] = serde_json::json!({ "effort": "minimal" });
        }
        LLMMode::Responses => {}
    }

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| PebbleError::Translate(format!("LLM request failed: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(PebbleError::Translate(format!("LLM error {status}: {body_text}")));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| PebbleError::Translate(format!("LLM parse failed: {e}")))?;
    let text = match mode {
        LLMMode::Completions => json
            .pointer("/choices/0/message/content")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
        LLMMode::Responses => responses_output_text(&json),
    };
    if text.is_empty() {
        let output_types = json.get("output")
            .and_then(|value| value.as_array())
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("type").and_then(|value| value.as_str()))
            .collect::<Vec<_>>()
            .join(",");
        tracing::warn!(
            status = json.get("status").and_then(|value| value.as_str()).unwrap_or("missing"),
            incomplete_reason = json.pointer("/incomplete_details/reason").and_then(|value| value.as_str()).unwrap_or("missing"),
            output_types,
            choices = json.get("choices").and_then(|value| value.as_array()).map_or(0, Vec::len),
            "bounded LLM completion returned no text"
        );
    }
    Ok(text)
}

/// Multi-turn chat completion. Supports arbitrary role sequences so the UI can
/// drive iterative refinement (the "多轮对话调整" requirement).
#[allow(clippy::too_many_arguments)]
pub async fn complete_chat(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    model: &str,
    mode: &LLMMode,
    chat_path: &str,
    turns: &[ChatTurn<'_>],
) -> Result<String> {
    let path = match mode {
        LLMMode::Completions => chat_path.to_string(),
        LLMMode::Responses => "/responses".to_string(),
    };
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);

    let body = match mode {
        LLMMode::Completions => {
            let messages: Vec<serde_json::Value> = turns
                .iter()
                .map(|t| {
                    serde_json::json!({ "role": t.role, "content": t.content })
                })
                .collect();
            serde_json::json!({
                "model": model,
                "messages": messages,
                "temperature": 0.7,
            })
        }
        LLMMode::Responses => {
            let combined = turns
                .iter()
                .map(|t| format!("[{}{}] {}", t.role.chars().next().unwrap().to_ascii_uppercase(), &t.role[1..], t.content))
                .collect::<Vec<_>>()
                .join("\n\n");
            serde_json::json!({
                "model": model,
                "input": combined,
            })
        }
    };

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| PebbleError::Translate(format!("LLM request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(PebbleError::Translate(format!(
            "LLM error {status}: {body_text}"
        )));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| PebbleError::Translate(format!("LLM parse failed: {e}")))?;

    let content = match mode {
        LLMMode::Completions => json
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string(),
        LLMMode::Responses => responses_output_text(&json),
    };

    Ok(content)
}

/// Chat completion that supports OpenAI-style function/tool calling.
///
/// `messages` is the full OpenAI message array (system/user/assistant with
/// tool_calls/tool), so callers can drive a multi-round agent loop. Returns
/// the full response JSON so the caller can inspect
/// `choices[0].message.tool_calls`. Only the Completions mode supports tools
/// (the Responses mode falls back to a plain completion).
#[allow(clippy::too_many_arguments)]
pub async fn complete_chat_with_tools(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    model: &str,
    mode: &LLMMode,
    chat_path: &str,
    messages: &[serde_json::Value],
    tools: &[serde_json::Value],
) -> Result<serde_json::Value> {
    if *mode == LLMMode::Responses {
        let turns: Vec<ChatTurn<'_>> = messages
            .iter()
            .filter_map(|m| {
                Some(ChatTurn {
                    role: m.get("role")?.as_str()?,
                    content: m.get("content")?.as_str()?,
                })
            })
            .collect();
        let text = complete_chat(client, base_url, api_key, model, mode, chat_path, &turns).await?;
        return Ok(serde_json::json!({
            "choices": [{ "message": { "role": "assistant", "content": text } }]
        }));
    }

    let path = match mode {
        LLMMode::Completions => chat_path.to_string(),
        LLMMode::Responses => "/responses".to_string(),
    };
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);

    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "temperature": 0.5,
    });
    if !tools.is_empty() {
        body["tools"] = serde_json::Value::Array(tools.to_vec());
    }

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| PebbleError::Translate(format!("LLM request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(PebbleError::Translate(format!(
            "LLM error {status}: {body_text}"
        )));
    }

    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| PebbleError::Translate(format!("LLM parse failed: {e}")))
}

/// Build an OpenAI-format function tool definition from a name, description
/// and JSON-schema parameters.
pub fn function_tool(
    name: &str,
    description: &str,
    parameters: serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters,
        }
    })
}

/// Extract the assistant message (content + tool_calls) from a completion response.
pub fn assistant_message(response: &serde_json::Value) -> serde_json::Value {
    response
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({ "role": "assistant", "content": "" }))
}

/// Extract the plain text content of an assistant message, if any.
pub fn assistant_content(message: &serde_json::Value) -> String {
    message
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string()
}

#[allow(clippy::too_many_arguments)]
pub async fn translate(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    model: &str,
    mode: &LLMMode,
    chat_path: &str,
    text: &str,
    from: &str,
    to: &str,
) -> Result<TranslateResult> {
    let system_prompt = format!(
        "You are a professional translator. Translate the following text from {from} to {to}. \
         Output ONLY the translation, nothing else. Preserve formatting and line breaks."
    );

    let translated = complete(
        client,
        base_url,
        api_key,
        model,
        mode,
        chat_path,
        &system_prompt,
        text,
    )
    .await?;

    Ok(TranslateResult {
        segments: build_segments(text, &translated),
        translated,
    })
}

#[cfg(test)]
mod tests {
    use super::responses_output_text;

    #[test]
    fn extracts_message_after_reasoning_item_from_responses_api() {
        let response = serde_json::json!({
            "output": [
                { "type": "reasoning", "content": [] },
                {
                    "type": "message",
                    "content": [{ "type": "output_text", "text": "[{\"name\":\"Acme Gifts\"}]" }]
                }
            ]
        });

        assert_eq!(responses_output_text(&response), "[{\"name\":\"Acme Gifts\"}]");
    }
}
