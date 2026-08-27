//! Agent loop with OpenAI-compatible Tool/Function Calling.
//!
//! Gives the LLM the ability to *decide* to search the web, fetch a page or
//! query GLEIF, then continue reasoning with the results — instead of a
//! single-shot prompt. Used by 开发客户 / 客户管理画像 / 资信调研.
//!
//! Search uses the model's own web capability when the provider supports it
//! (the `web_search` tool is declared and forwarded to the provider), and
//! falls back to Brave/Tavily keys when configured. `fetch_url` needs no key
//! at all, so agents always have a working information path.

use crate::commands::ai::load_active_provider_config;
use crate::commands::company_intel::gleif_matches;
use crate::commands::external_services::get_external_service_api_keys;
use crate::commands::network::get_global_proxy_raw;
use crate::commands::web_research::{
    build_research_client, safe_fetch, EvidenceStatus, FetchPolicy,
};
use crate::state::AppState;
use pebble_core::{PebbleError, Result};
use pebble_translate::llm::{
    assistant_content, assistant_message, complete_chat, complete_chat_with_tools, function_tool,
    ChatTurn,
};
use pebble_translate::types::TranslateProviderConfig;
use pebble_translate::TranslateService;
use serde_json::{json, Value};

/// Final output of one agent run.
pub struct AgentResult {
    pub content: String,
    /// Source URLs surfaced during the run (for display / citations).
    pub sources: Vec<String>,
    /// How many tool calls were executed.
    pub tool_calls: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResultDto {
    pub content: String,
    pub sources: Vec<String>,
    pub tool_calls: usize,
}

/// Generic agent command usable from the frontend (customer profile
/// generation, lead enrichment, etc.).
#[tauri::command]
pub async fn agent_run(
    state: tauri::State<'_, AppState>,
    system: String,
    user: String,
) -> std::result::Result<AgentResultDto, PebbleError> {
    let result = run_agent(&state, &system, &user).await?;
    Ok(AgentResultDto {
        content: result.content,
        sources: result.sources,
        tool_calls: result.tool_calls,
    })
}

#[derive(Debug, Clone, Copy)]
pub struct AgentBudget {
    pub max_turns: u32,
    pub max_tool_calls: usize,
}

impl Default for AgentBudget {
    fn default() -> Self {
        Self { max_turns: 12, max_tool_calls: 8 }
    }
}

fn build_tools() -> Vec<Value> {
    vec![
        function_tool(
            "web_search",
            "搜索互联网，返回与关键词相关的网页列表（标题、链接、摘要）。用于查找公司信息、行业经销商、客户背景等。",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "搜索关键词，尽量用英文，可含行业/产品/国家" }
                },
                "required": ["query"]
            }),
        ),
        function_tool(
            "fetch_url",
            "抓取指定网址的网页正文并返回前若干字符。用于深入了解公司官网、产品页、关于我们等。",
            json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "要抓取的完整网址，必须以 http:// 或 https:// 开头" }
                },
                "required": ["url"]
            }),
        ),
        function_tool(
            "gleif_company",
            "通过 GLEIF 全球法人数据库查询公司注册信息（法人名称、国家、注册状态、LEI 编号）。查询失败可能表示该公司没有 LEI 编码。",
            json!({
                "type": "object",
                "properties": {
                    "company_name": { "type": "string", "description": "公司名称或域名关键词" }
                },
                "required": ["company_name"]
            }),
        ),
    ]
}

fn resolve_llm(
    state: &AppState,
) -> Result<(String, String, String, String, pebble_translate::types::LLMMode)> {
    let cfg = load_active_provider_config(state)?;
    match cfg {
        TranslateProviderConfig::LLM { providers, active_id } => {
            let provider = providers
                .iter()
                .find(|p| p.id == active_id)
                .or_else(|| providers.first())
                .ok_or_else(|| {
                    PebbleError::Translate("AI 模型未配置，请先在 设置 → AI 模型 中配置".to_string())
                })?;
            Ok((
                provider.base_url.clone(),
                provider.chat_path.clone(),
                provider.api_key.clone(),
                provider.model.clone(),
                provider.mode.clone(),
            ))
        }
        _ => Err(PebbleError::Translate(
            "当前 AI 引擎不支持联网智能体功能，请切换到 LLM 类型的 AI 模型".to_string(),
        )),
    }
}

/// Run an agent loop: LLM ↔ tools until it answers or hits MAX_AGENT_TURNS.
pub async fn run_agent(
    state: &AppState,
    system: &str,
    user: &str,
) -> Result<AgentResult> {
    run_agent_with_budget(state, system, user, AgentBudget::default()).await
}

pub async fn run_agent_with_budget(
    state: &AppState,
    system: &str,
    user: &str,
    budget: AgentBudget,
) -> Result<AgentResult> {
    let (base_url, chat_path, api_key, model, mode) = resolve_llm(state)?;
    let proxy = get_global_proxy_raw(&state.crypto, &state.store)?;
    let client = TranslateService::http_client_with_proxy(proxy.as_ref())?;
    // Tool-selected URLs are untrusted. Use a dedicated client that never
    // follows redirects before safe_fetch validates the next hop.
    let web_client = build_research_client(proxy.as_ref())?;

    let tools = build_tools();
    let mut messages = vec![
        json!({ "role": "system", "content": system }),
        json!({ "role": "user", "content": user }),
    ];

    let mut sources: Vec<String> = Vec::new();
    let mut tool_calls_used = 0usize;

    for _ in 0..budget.max_turns.max(1) {
        if tool_calls_used >= budget.max_tool_calls.max(1) {
            break;
        }
        let resp = match complete_chat_with_tools(
            &client,
            &base_url,
            &api_key,
            &model,
            &mode,
            &chat_path,
            &messages,
            &tools,
        )
        .await
        {
            Ok(r) => r,
            Err(e) => {
                // 模型可能不支持 tools（function calling）。降级为普通对话，
                // 至少保证任务能出结果（用模型自身知识，无联网）。
                tracing::warn!(
                    "Agent tools request failed ({}); retrying as plain chat",
                    e
                );
                let turns: Vec<ChatTurn<'_>> = messages
                    .iter()
                    .filter_map(|m| {
                        Some(ChatTurn {
                            role: m.get("role")?.as_str()?,
                            content: m.get("content")?.as_str()?,
                        })
                    })
                    .collect();
                let text = complete_chat(
                    &client, &base_url, &api_key, &model, &mode, &chat_path, &turns,
                )
                .await
                .map_err(|e2| PebbleError::Translate(format!("AI 请求失败: {e2}")))?;
                return Ok(AgentResult {
                    content: text,
                    sources,
                    tool_calls: tool_calls_used,
                });
            }
        };

        let msg = assistant_message(&resp);
        let content = assistant_content(&msg);
        let calls = msg
            .get("tool_calls")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();

        if calls.is_empty() {
            return Ok(AgentResult {
                content,
                sources,
                tool_calls: tool_calls_used,
            });
        }

        // Replay the assistant message verbatim (tool_calls included).
        messages.push(msg.clone());
        for call in &calls {
            let name = call
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let args = call
                .get("function")
                .and_then(|f| f.get("arguments"))
                .and_then(|a| a.as_str())
                .unwrap_or("{}")
                .to_string();
            let call_id = call
                .get("id")
                .and_then(|i| i.as_str())
                .unwrap_or("")
                .to_string();
            if tool_calls_used >= budget.max_tool_calls.max(1) {
                break;
            }
            tool_calls_used += 1;

            let result = execute_tool(state, &web_client, &name, &args).await;
            sources.extend(result.sources);
            messages.push(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": result.text,
            }));
        }
    }

    // Ran out of turns. Before falling back, force ONE final answer round so
    // a model stuck in a tool loop still produces a usable result (otherwise
    // the fallback would return an intermediate sentence instead of the
    // required final JSON).
    messages.push(json!({
        "role": "user",
        "content": "你已收集足够信息。请立即停止使用任何工具，直接输出最终结果（严格按之前要求的格式，不要解释、不要多余文字）。",
    }));
    // Do not replay the incomplete assistant tool-call message to the final
    // request. Several providers reject a transcript containing an assistant
    // tool call without a matching tool result, which used to produce the
    // generic fallback sentence instead of the requested JSON.
    let evidence = messages
        .iter()
        .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("tool"))
        .filter_map(|m| m.get("content").and_then(|c| c.as_str()))
        .collect::<Vec<_>>()
        .join("\n\n--- TOOL EVIDENCE ---\n\n");
    let final_user = format!(
        "{user}\n\n已收集到以下公开信息。现在停止搜索，严格只输出之前要求的 JSON 数组，不要解释：\n{}",
        evidence.chars().take(30_000).collect::<String>()
    );
    let turns = vec![
        ChatTurn { role: "system", content: system },
        ChatTurn { role: "user", content: &final_user },
    ];
    if let Ok(forced) = complete_chat(
        &client, &base_url, &api_key, &model, &mode, &chat_path, &turns,
    )
    .await
    {
        if !forced.trim().is_empty() {
            return Ok(AgentResult {
                content: forced,
                sources,
                tool_calls: tool_calls_used,
            });
        }
    }

    // Last resort: pick the last assistant message that actually carries
    // text content (messages that only contained tool_calls have null content).
    let last = messages
        .iter()
        .rev()
        .find(|m| {
            m.get("role").and_then(|r| r.as_str()) == Some("assistant")
                && m.get("content")
                    .and_then(|c| c.as_str())
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false)
        })
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("已达最大思考轮数，请简化任务后重试")
        .to_string();
    Ok(AgentResult {
        content: last,
        sources,
        tool_calls: tool_calls_used,
    })
}

struct ToolOutcome {
    text: String,
    sources: Vec<String>,
}

async fn execute_tool(
    state: &AppState,
    client: &reqwest::Client,
    name: &str,
    args_json: &str,
) -> ToolOutcome {
    let args: Value = serde_json::from_str(args_json).unwrap_or_else(|_| json!({}));
    match name {
        "web_search" => {
            let query = args
                .get("query")
                .and_then(|q| q.as_str())
                .unwrap_or("")
                .to_string();
            web_search_tool(state, client, &query).await
        }
        "fetch_url" => {
            let url = args
                .get("url")
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string();
            fetch_url_tool(client, &url).await
        }
        "gleif_company" => {
            let company = args
                .get("company_name")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            gleif_company_tool(client, &company).await
        }
        _ => ToolOutcome {
            text: format!("未知工具: {name}"),
            sources: Vec::new(),
        },
    }
}

async fn web_search_tool(state: &AppState, client: &reqwest::Client, query: &str) -> ToolOutcome {
    if query.trim().is_empty() {
        return ToolOutcome { text: "缺少搜索关键词".to_string(), sources: Vec::new() };
    }
    let tavily_keys = get_external_service_api_keys(state, "tavily").unwrap_or_default();
    let brave_keys = get_external_service_api_keys(state, "brave").unwrap_or_default();
    let mut lines: Vec<String> = Vec::new();
    let mut sources: Vec<String> = Vec::new();
    // Use one provider per tool call rather than charging two providers for
    // the same query. With no key, fall back to a public RSS search endpoint.
    let items = if !brave_keys.is_empty() {
        crate::commands::company_intel::brave_search_with_keys(client, &brave_keys, query).await
    } else if !tavily_keys.is_empty() {
        crate::commands::company_intel::tavily_search_with_keys(client, &tavily_keys, query).await
    } else {
        crate::commands::company_intel::keyless_web_search(client, query).await
    };
    for (i, item) in items.iter().enumerate() {
        lines.push(format!(
            "{}. {} — {}\n   {}\n   {}",
            i + 1,
            item.title,
            item.url,
            item.description,
            item.url
        ));
        sources.push(item.url.clone());
    }
    if lines.is_empty() {
        return ToolOutcome {
            text: "没有搜索到结果。请尝试换关键词，或改用 fetch_url 抓取已知官网。".to_string(),
            sources,
        };
    }
    ToolOutcome {
        text: lines.join("\n\n"),
        sources,
    }
}

async fn fetch_url_tool(client: &reqwest::Client, url: &str) -> ToolOutcome {
    let page = safe_fetch(client, url, "agent_fetch", FetchPolicy::default()).await;
    if page.evidence.status != EvidenceStatus::Ok {
        let reason = if page.evidence.error.is_empty() {
            "没有取得可用正文".to_string()
        } else {
            page.evidence.error.clone()
        };
        return ToolOutcome {
            text: format!("抓取失败（{reason}）：{}", page.final_url),
            sources: vec![page.final_url],
        };
    }
    let text = html_to_text(&page.text);
    let clipped: String = text.chars().take(6000).collect();
    if clipped.trim().is_empty() {
        return ToolOutcome { text: format!("页面内容为空（可能是 JS 渲染页面）：{}", page.final_url), sources: vec![page.final_url] };
    }
    ToolOutcome {
        text: format!("【{}】\n{clipped}", page.final_url),
        sources: vec![page.final_url],
    }
}

async fn gleif_company_tool(client: &reqwest::Client, company: &str) -> ToolOutcome {
    if company.trim().is_empty() {
        return ToolOutcome { text: "缺少公司名称".to_string(), sources: Vec::new() };
    }
    match gleif_matches(client, company).await {
        Ok(matches) => {
            if matches.is_empty() {
                return ToolOutcome {
                    text: format!("GLEIF 未找到 {company} 的法人记录（该公司可能没有 LEI 编码）。"),
                    sources: Vec::new(),
                };
            }
            let text = matches
                .iter()
                .take(5)
                .map(|m| {
                    format!(
                        "法人名称: {} | 国家: {} | 注册状态: {} | LEI: {}",
                        m.legal_name, m.country, m.registration_status, m.lei
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            ToolOutcome {
                text: format!("GLEIF 法人匹配：\n{text}"),
                sources: vec!["https://www.gleif.org/".to_string()],
            }
        }
        Err(e) => ToolOutcome {
            text: format!("GLEIF 查询失败：{e}"),
            sources: Vec::new(),
        },
    }
}

/// Very small HTML → readable text extractor (title + meta + paragraph text).
fn html_to_text(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    let mut in_script = false;
    let mut buf: Vec<char> = Vec::new();
    let chars: Vec<char> = html.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '<' {
            in_tag = true;
            let tag_start = i;
            let mut j = i;
            while j < chars.len() && chars[j] != '>' {
                j += 1;
            }
            let tag: String = chars[tag_start..j.min(chars.len())].iter().collect();
            let tag_lower = tag.to_ascii_lowercase();
            if tag_lower.starts_with("<script") || tag_lower.starts_with("<style") {
                in_script = true;
            } else if in_script && tag_lower.starts_with("</script") || in_script && tag_lower.starts_with("</style") {
                in_script = false;
            }
            if !in_script && (tag_lower.starts_with("<p") || tag_lower.starts_with("<h1")
                || tag_lower.starts_with("<h2") || tag_lower.starts_with("<h3")
                || tag_lower.starts_with("<li") || tag_lower.starts_with("<br")
                || tag_lower.starts_with("<div"))
            {
                out.push('\n');
            }
            i = j + 1;
            in_tag = false;
            continue;
        }
        if !in_script && !in_tag {
            if c == '&' {
                // try to decode a couple of common entities
                let rest: String = chars[i..(i + 6).min(chars.len())].iter().collect();
                match rest.as_str() {
                    s if s.starts_with("&nbsp;") => { out.push(' '); i += 6; continue; }
                    s if s.starts_with("&amp;") => { out.push('&'); i += 5; continue; }
                    s if s.starts_with("&lt;") => { out.push('<'); i += 4; continue; }
                    s if s.starts_with("&gt;") => { out.push('>'); i += 4; continue; }
                    _ => { out.push('&'); }
                }
            } else {
                out.push(c);
            }
        }
        i += 1;
    }
    // Collapse whitespace runs (keep single newlines).
    let mut result = String::new();
    let mut last_ws = false;
    let mut last_nl = false;
    for c in out.chars() {
        if c == '\n' {
            if !last_nl {
                result.push('\n');
            }
            last_nl = true;
            last_ws = true;
        } else if c.is_whitespace() {
            if !last_ws {
                result.push(' ');
            }
            last_ws = true;
            last_nl = false;
        } else {
            result.push(c);
            last_ws = false;
            last_nl = false;
        }
    }
    let _ = &mut buf;
    result.trim().to_string()
}
