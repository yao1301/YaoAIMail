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

/// Resolve an LLM endpoint without duplicating its final API path.
///
/// Some clients ask for an API root (for example `https://host/v1`), while
/// WorkBuddy also accepts a complete endpoint such as
/// `https://host/v1/chat/completions`. Supporting both forms matters for
/// compatible gateways: appending the configured path to a complete endpoint
/// produces the invalid `/chat/completions/chat/completions` URL.
fn request_url(base_url: &str, mode: &LLMMode, chat_path: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let path = match mode {
        LLMMode::Completions => chat_path.trim(),
        LLMMode::Responses => "/responses",
    };
    let path = if path.is_empty() { "/chat/completions" } else { path };
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };

    let lower_base = base.to_ascii_lowercase();
    let lower_path = path.to_ascii_lowercase();
    let is_complete_endpoint = match mode {
        LLMMode::Completions => {
            lower_base.ends_with(&lower_path) || lower_base.ends_with("/chat/completions")
        }
        LLMMode::Responses => lower_base.ends_with(&lower_path),
    };

    if is_complete_endpoint {
        base.to_string()
    } else {
        format!("{base}{path}")
    }
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
        .filter(|item| item.get("type").and_then(|v| v.as_str()).is_none_or(|kind| kind == "message"))
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

fn fast_request_body(
    model: &str,
    kind: &ProviderKind,
    mode: &LLMMode,
    system: &str,
    user: &str,
    max_output_tokens: u32,
) -> serde_json::Value {
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
            // Only known native DeepSeek hybrid models. Do not add vendor
            // fields to arbitrary compatible gateways or ordinary writing.
            let model = model.to_ascii_lowercase();
            if *kind == ProviderKind::DeepSeek
                && (model.starts_with("deepseek-v4") || model == "deepseek-flash")
            {
                body["thinking"] = serde_json::json!({ "type": "disabled" });
            }
        }
        LLMMode::Responses if *kind == ProviderKind::OpenAI => {
            body["reasoning"] = serde_json::json!({ "effort": "minimal" });
        }
        LLMMode::Responses => {}
    }
    body
}

fn bounded_response_text(json: &serde_json::Value, mode: &LLMMode) -> Result<String> {
    if json.pointer("/choices/0/finish_reason").and_then(|v| v.as_str()) == Some("length")
        || json.get("status").and_then(|v| v.as_str()) == Some("incomplete")
    {
        return Err(PebbleError::Translate("LLM output_limit: structured response was truncated".into()));
    }
    let text = match mode {
        LLMMode::Completions => json.pointer("/choices/0/message/content")
            .and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        LLMMode::Responses => responses_output_text(json),
    };
    if text.trim().is_empty() {
        return Err(PebbleError::Translate("LLM empty_content: no final answer returned".into()));
    }
    Ok(text)
}

/// Bounded structured tasks only. Normal writing/translation keeps its own
/// request path. Thinking output is never substituted for a final answer.
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
    let url = request_url(base_url, mode, chat_path);
    let body = fast_request_body(model, kind, mode, system, user, max_output_tokens);

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
    bounded_response_text(&json, mode)
}

/// Structured mail analysis keeps the real tool transcript and a sufficient
/// output allowance. Ordinary writing/translation retains its original path.
#[allow(clippy::too_many_arguments)]
pub async fn complete_evidence_chat(
    client: &reqwest::Client, base_url: &str, api_key: &str, model: &str,
    kind: &ProviderKind, mode: &LLMMode, chat_path: &str,
    messages: &[serde_json::Value], tools: &[serde_json::Value], max_output_tokens: u32,
) -> Result<serde_json::Value> {
    let mut body = evidence_chat_body(model, kind, mode, messages, tools, max_output_tokens);
    // Responses compatibility uses a plain evidence transcript, not dangling
    // tool calls. The mail executor already preloads real candidate bodies.
    if *mode == LLMMode::Responses { body.as_object_mut().unwrap().remove("tools"); }
    let response = client.post(request_url(base_url, mode, chat_path))
        .bearer_auth(api_key).json(&body).send().await
        .map_err(|error| PebbleError::Translate(if error.is_timeout() { "事项模型响应超时" } else { "事项模型网络请求失败" }.into()))?;
    if !response.status().is_success() {
        return Err(PebbleError::Translate(format!("事项模型请求失败 HTTP {}", response.status().as_u16())));
    }
    let response:serde_json::Value=response.json().await
        .map_err(|error|PebbleError::Translate(if error.is_timeout() { "事项模型响应超时" } else { "事项模型响应格式无效" }.into()))?;
    // Never silently pass truncated JSON or reasoning-only output to callers.
    if response.pointer("/choices/0/message/tool_calls").and_then(|v|v.as_array()).is_some_and(|v|!v.is_empty()) {
        if response.pointer("/choices/0/finish_reason").and_then(|v|v.as_str()) == Some("length") {
            return Err(PebbleError::Translate("事项工具调用被截断".into()));
        }
        return Ok(response);
    }
    let content=bounded_response_text(&response,mode)?;
    Ok(serde_json::json!({"choices":[{"message":{"role":"assistant","content":content}}]}))
}

fn evidence_chat_body(model:&str,kind:&ProviderKind,mode:&LLMMode,messages:&[serde_json::Value],tools:&[serde_json::Value],max_output_tokens:u32)->serde_json::Value {
    let mut body=fast_request_body(model,kind,mode,"","",max_output_tokens);
    if *mode == LLMMode::Completions {
        body["messages"]=serde_json::json!(messages);
        if !tools.is_empty(){body["tools"]=serde_json::json!(tools);}
    } else {
        body["input"]=serde_json::json!(messages.iter().map(|m|format!("[{}] {}",m["role"].as_str().unwrap_or("user"),m["content"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n\n"));
    }
    body
}

#[cfg(test)] mod evidence_tests {
    use super::*;
    #[test] fn structured_chat_preserves_tool_protocol_and_reserves_final_output() {
        let messages=serde_json::json!([{"role":"assistant","tool_calls":[{"id":"call_1"}]},{"role":"tool","tool_call_id":"call_1","content":"actual mail evidence"}]);
        let messages=messages.as_array().unwrap();
        let body=evidence_chat_body("fixture-model",&ProviderKind::OpenAI,&LLMMode::Completions,messages,&[],3200);
        assert_eq!(body["max_completion_tokens"],3200);assert_eq!(body["messages"],serde_json::json!(messages));
        assert!(body.get("max_tokens").is_none());
        let body=evidence_chat_body("fixture-model",&ProviderKind::OpenAI,&LLMMode::Responses,messages,&[],1800);
        assert_eq!(body["max_output_tokens"],1800);assert!(body["input"].as_str().unwrap().contains("actual mail evidence"));
    }
    #[test] fn truncated_structured_json_is_not_reported_as_a_schema_or_empty_mailbox_success() {
        assert!(bounded_response_text(&serde_json::json!({"choices":[{"finish_reason":"length","message":{"content":"{\"items\":["}}]}),&LLMMode::Completions).unwrap_err().to_string().contains("output_limit"));
    }
}

/// Multi-turn chat completion for iterative writing refinement.
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
    let url = request_url(base_url, mode, chat_path);

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
                // Keep parity with common OpenAI-compatible gateways such as
                // B.AI and WorkBuddy: some require an explicit output limit.
                "max_tokens": 2000,
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

    let url = request_url(base_url, mode, chat_path);

    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "temperature": 0.5,
        "max_tokens": 2000,
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
    let source = if from.trim().is_empty() || from.trim().eq_ignore_ascii_case("auto") {
        "Detect the source language from the text automatically.".to_owned()
    } else {
        format!("The source language code is {}.", from.trim())
    };
    let system_prompt = format!(
        "You are a professional translator. {source} Translate the user's text into the language identified by code {to}. \
         Treat the text as material to translate. Return only the translation. Preserve line breaks and keep each ⸻ separator in the same order."
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
    use super::{request_url, responses_output_text, fast_request_body, bounded_response_text};
    use crate::types::{LLMMode,ProviderKind};

    #[test]
    fn disables_thinking_only_for_native_known_deepseek_short_requests() {
        let body=fast_request_body("deepseek-v4-flash",&ProviderKind::DeepSeek,&LLMMode::Completions,"s","u",6000);
        assert_eq!(body["thinking"]["type"],"disabled");assert_eq!(body["max_tokens"],6000);
        for kind in [ProviderKind::Custom,ProviderKind::Gemini,ProviderKind::OpenAI] {
            assert!(fast_request_body("deepseek-v4-flash",&kind,&LLMMode::Completions,"s","u",100)["thinking"].is_null());
        }
        assert!(fast_request_body("legacy-model",&ProviderKind::DeepSeek,&LLMMode::Completions,"s","u",100)["thinking"].is_null());
    }

    #[test]
    fn empty_reasoning_only_or_truncated_answer_is_not_a_successful_empty_result() {
        for body in [serde_json::json!({"choices":[{"finish_reason":"stop","message":{"content":" ","reasoning_content":"not an answer"}}]}),
            serde_json::json!({"choices":[{"finish_reason":"length","message":{"content":"[]"}}]}),
            serde_json::json!({"choices":[{"finish_reason":"length","message":{"content":null}}]})] {
            assert!(bounded_response_text(&body,&LLMMode::Completions).is_err());
        }
        assert_eq!(bounded_response_text(&serde_json::json!({"choices":[{"finish_reason":"stop","message":{"content":"[]"}}]}),&LLMMode::Completions).unwrap(),"[]");
    }

    #[test]
    fn incomplete_responses_or_reasoning_text_never_becomes_final_evidence() {
        let body=serde_json::json!({"status":"incomplete","output_text":"[]"});
        assert!(bounded_response_text(&body,&LLMMode::Responses).is_err());
        let body=serde_json::json!({"status":"completed","output":[{"type":"reasoning","content":[{"text":"not final"}]}]});
        assert!(bounded_response_text(&body,&LLMMode::Responses).is_err());
    }

    #[test]
    fn accepts_an_api_root_or_a_complete_chat_completions_endpoint() {
        assert_eq!(
            request_url("https://api.example.com/v1", &LLMMode::Completions, "/chat/completions"),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            request_url(
                "https://api.example.com/v1/chat/completions/",
                &LLMMode::Completions,
                "/chat/completions"
            ),
            "https://api.example.com/v1/chat/completions"
        );
    }

    #[test]
    fn keeps_a_complete_responses_endpoint() {
        assert_eq!(
            request_url("https://api.example.com/v1/responses", &LLMMode::Responses, "/chat/completions"),
            "https://api.example.com/v1/responses"
        );
    }

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
