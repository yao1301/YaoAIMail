use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// 在独立窗口中打开写信界面（支持同时开多个写信窗口）。
///
/// prefill 是序列化的 ComposePrefill JSON（to/cc/bcc/subject/body 等），
/// 通过 URL query `?compose=<base64>` 传给新窗口，新窗口前端解析后初始化写信表单。
/// 每个窗口使用唯一 label（compose-<timestamp>），互不覆盖。
#[tauri::command]
pub fn open_compose_window(
    app: AppHandle,
    prefill: Option<String>,
) -> Result<(), String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let label = format!("compose-{ts}");

    // prefill → base64（URL 安全编码），避免特殊字符破坏 query
    let query = match prefill.as_deref() {
        Some(json) if !json.trim().is_empty() => {
            base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, json.trim().as_bytes())
        }
        _ => String::new(),
    };
    let url = if query.is_empty() {
        WebviewUrl::App("index.html?compose=1".into())
    } else {
        WebviewUrl::App(format!("index.html?compose=1&prefill={query}").into())
    };

    WebviewWindowBuilder::new(&app, &label, url)
        .title("写邮件 - YaoAIMail")
        .inner_size(900.0, 720.0)
        .min_inner_size(700.0, 520.0)
        .center()
        .focused(true)
        .visible(true)
        .decorations(false)
        .additional_browser_args("--disable-autofill --disable-suggestions-ui --disable-features=Autofill,AutofillServerCommunication,PasswordManager")
        .build()
        .map_err(|e| format!("创建写信窗口失败: {e}"))?;

    // 校验 prefill 为合法 JSON（仅调试提示，不阻断）
    if let Some(json) = prefill {
        if serde_json::from_str::<Value>(&json).is_err() {
            tracing::warn!("open_compose_window received non-JSON prefill (len={})", json.len());
        }
    }

    Ok(())
}
