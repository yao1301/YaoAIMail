use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub fn open_default_mail_settings() -> Result<(), String> {
    #[cfg(windows)]
    {
        register_as_mail_client()?;
        opener::open("ms-settings:defaultapps").map_err(|e| format!("Failed to open settings: {e}"))
    }
    #[cfg(not(windows))]
    {
        Err("This feature is only available on Windows".to_string())
    }
}

#[cfg(windows)]
fn register_as_mail_client() -> Result<(), String> {
    use windows_registry::CURRENT_USER;

    let exe_path = tauri::utils::platform::current_exe()
        .map_err(|e| format!("Failed to get exe path: {e}"))?;
    let exe = exe_path.to_string_lossy();
    let open_cmd = format!("\"{exe}\" \"%1\"");

    // Register as a mail client
    let client_key = CURRENT_USER
        .create(r"SOFTWARE\Clients\Mail\YaoAIMail")
        .map_err(|e| e.to_string())?;
    client_key
        .set_string("", "YaoAIMail")
        .map_err(|e| e.to_string())?;

    let shell_key = CURRENT_USER
        .create(r"SOFTWARE\Clients\Mail\YaoAIMail\shell\open\command")
        .map_err(|e| e.to_string())?;
    shell_key
        .set_string("", format!("\"{exe}\""))
        .map_err(|e| e.to_string())?;

    // Register capabilities
    let caps_key = CURRENT_USER
        .create(r"SOFTWARE\Clients\Mail\YaoAIMail\Capabilities")
        .map_err(|e| e.to_string())?;
    caps_key
        .set_string("ApplicationName", "YaoAIMail")
        .map_err(|e| e.to_string())?;
    caps_key
        .set_string("ApplicationDescription", "YaoAIMail Email Client")
        .map_err(|e| e.to_string())?;

    let url_key = CURRENT_USER
        .create(r"SOFTWARE\Clients\Mail\YaoAIMail\Capabilities\UrlAssociations")
        .map_err(|e| e.to_string())?;
    url_key
        .set_string("mailto", "YaoAIMail.Url.mailto")
        .map_err(|e| e.to_string())?;

    // Register mailto protocol handler class
    let class_key = CURRENT_USER
        .create(r"SOFTWARE\Classes\YaoAIMail.Url.mailto")
        .map_err(|e| e.to_string())?;
    class_key
        .set_string("", "YaoAIMail Email URL")
        .map_err(|e| e.to_string())?;
    class_key
        .set_string("URL Protocol", "")
        .map_err(|e| e.to_string())?;

    let class_cmd_key = CURRENT_USER
        .create(r"SOFTWARE\Classes\YaoAIMail.Url.mailto\shell\open\command")
        .map_err(|e| e.to_string())?;
    class_cmd_key
        .set_string("", &open_cmd)
        .map_err(|e| e.to_string())?;

    // Register in RegisteredApplications
    let reg_apps_key = CURRENT_USER
        .create(r"SOFTWARE\RegisteredApplications")
        .map_err(|e| e.to_string())?;
    reg_apps_key
        .set_string("YaoAIMail", r"SOFTWARE\Clients\Mail\YaoAIMail\Capabilities")
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn sync_titlebar_theme(window: tauri::WebviewWindow, theme: String) -> Result<(), String> {
    use tauri::window::Color;

    let color = match theme.as_str() {
        "dark" => Color(0x1e, 0x1e, 0x1e, 0xff),
        _ => Color(0xf8, 0xf7, 0xf5, 0xff),
    };
    window
        .set_background_color(Some(color))
        .map_err(|e| format!("Failed to set background color: {e}"))
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    // Search providers and models often return `www.example.com` without a
    // scheme. Treat that as HTTPS, while still rejecting every non-web scheme
    // before handing the value to ShellExecute/open.
    let trimmed = url.trim();
    let normalized = if trimmed.starts_with("https://")
        || trimmed.starts_with("http://")
        || trimmed.starts_with("mailto:")
    {
        trimmed.to_string()
    } else if trimmed.starts_with("//") {
        format!("https:{trimmed}")
    } else if !trimmed.is_empty()
        && !trimmed.contains(char::is_whitespace)
        && trimmed.contains('.')
        && !trimmed.contains(':')
    {
        format!("https://{trimmed}")
    } else {
        return Err("Only https://, http://, and mailto: URLs are permitted".to_string());
    };
    opener::open(&normalized).map_err(|e| format!("Failed to open URL: {e}"))
}

#[tauri::command]
pub fn health_check(state: State<'_, AppState>) -> Result<String, String> {
    match state.store.list_accounts() {
        Ok(accounts) => Ok(format!(
            "YaoAIMail is healthy. {} account(s) configured.",
            accounts.len()
        )),
        Err(e) => Err(format!("Health check failed: {}", e)),
    }
}
