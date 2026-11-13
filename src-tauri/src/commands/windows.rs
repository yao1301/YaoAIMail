use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

pub(crate) const LINK_PREVIEW_PREFIX: &str = "link-preview-";
static NEXT_LINK_PREVIEW: AtomicU64 = AtomicU64::new(1);

fn can_preview_link(url: &Url, dev_url: Option<&Url>) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && dev_url.is_none_or(|dev| dev.origin() != url.origin())
        && url.domain().is_some_and(|domain| {
            let domain = domain.trim_end_matches('.');
            domain.contains('.')
                && !domain.ends_with(".localhost")
                && !domain.ends_with(".local")
        })
}

/// External pages have no app capabilities and use an isolated browser profile.
#[tauri::command]
pub async fn open_mail_link_window(app: AppHandle, url: String) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|_| "链接地址无效")?;
    let dev_url = app.config().build.dev_url.clone();
    if !can_preview_link(&url, dev_url.as_ref()) {
        return Err("此链接需要使用默认浏览器打开".into());
    }
    let title = format!("{} - YaoAIMail", url.host_str().unwrap_or_default());
    let label = format!("{LINK_PREVIEW_PREFIX}{}", NEXT_LINK_PREVIEW.fetch_add(1, Ordering::Relaxed));
    let profile = app.state::<crate::profile::ProfilePaths>();
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
        .title(title)
        .data_directory(profile.app_data_dir().join("link-preview-webview"))
        .incognito(true)
        .devtools(false)
        .disable_drag_drop_handler()
        .inner_size(1060.0, 760.0)
        .min_inner_size(520.0, 360.0)
        .center()
        .decorations(true)
        .resizable(true)
        .minimizable(true)
        .maximizable(true)
        .closable(true)
        .on_navigation(move |url| can_preview_link(url, dev_url.as_ref()))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .build()
        .map_err(|_| "无法打开软件内网页窗口，请使用默认浏览器".to_string())?;
    Ok(())
}

/// A second WebView in THIS process: same Store/Crypto/profile, never another
/// executable or a new database. Only an opaque id travels in the URL.
#[tauri::command]
pub async fn open_mail_window(app: AppHandle, state: tauri::State<'_, crate::state::AppState>, message_id: String) -> Result<(), String> {
    let header = state.store.get_message_evidence_header(&message_id).map_err(|_| "读取邮件失败")?
        .ok_or("邮件已不存在，未关闭原标签")?;
    let label = format!("mail-{}", base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, message_id.as_bytes()));
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    let profile = app.state::<crate::profile::ProfilePaths>();
    let id = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, message_id.as_bytes());
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(format!("index.html?mailWindow=1&message={id}").into()))
        .title(if header.subject.is_empty() { "邮件 - YaoAIMail".into() } else { format!("{} - YaoAIMail", header.subject.chars().take(120).collect::<String>()) })
        .data_directory(profile.app_data_dir().join("webview"))
        .inner_size(1000.0, 760.0).min_inner_size(700.0, 520.0)
        .center().focused(true).visible(true).decorations(false)
        .disable_drag_drop_handler()
        .additional_browser_args("--disable-autofill --disable-suggestions-ui --disable-features=Autofill,AutofillServerCommunication,PasswordManager")
        .build().map_err(|e| format!("创建邮件窗口失败: {e}"))?;
    Ok(())
}

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

    let profile = app.state::<crate::profile::ProfilePaths>();
    WebviewWindowBuilder::new(&app, &label, url)
        .title("写邮件 - YaoAIMail")
        .data_directory(profile.app_data_dir().join("webview"))
        .disable_drag_drop_handler()
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
