use crate::state::AppState;
use pebble_core::PebbleError;
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::image::Image;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_notification::NotificationExt;
use tracing::warn;

const TRAY_DEFAULT_TOOLTIP: &str = "YaoAIMail";
const TRAY_ATTENTION_TOOLTIP: &str = "YaoAIMail - 新邮件";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NotificationStatus {
    pub enabled: bool,
    pub attention_active: bool,
    pub platform: String,
    pub app_id: Option<String>,
}

pub fn notification_status_payload(
    enabled: bool,
    attention_active: bool,
    platform: &str,
    app_id: Option<String>,
) -> NotificationStatus {
    NotificationStatus {
        enabled,
        attention_active,
        platform: platform.to_string(),
        app_id,
    }
}

fn notification_platform() -> &'static str {
    #[cfg(windows)]
    {
        "windows"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(all(not(windows), not(target_os = "macos"), target_os = "linux"))]
    {
        "linux"
    }
    #[cfg(all(not(windows), not(target_os = "macos"), not(target_os = "linux")))]
    {
        "desktop"
    }
}

#[cfg(windows)]
fn is_tauri_target_build_dir(curr_dir: &str) -> bool {
    use std::path::MAIN_SEPARATOR as SEP;

    curr_dir.ends_with(format!("{SEP}target{SEP}debug").as_str())
        || curr_dir.ends_with(format!("{SEP}target{SEP}release").as_str())
}

#[cfg(windows)]
pub fn windows_notification_app_id<R: Runtime>(app: &AppHandle<R>) -> String {
    let is_dev_build_dir = tauri::utils::platform::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|parent| parent.display().to_string()))
        .is_some_and(|curr_dir| is_tauri_target_build_dir(&curr_dir));

    if is_dev_build_dir {
        tauri_winrt_notification::Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    }
}

fn notification_app_id<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    #[cfg(windows)]
    {
        Some(windows_notification_app_id(app))
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        None
    }
}

#[cfg(windows)]
fn register_windows_app_user_model_id<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use windows_registry::{CURRENT_USER, HSTRING};

    let app_id = windows_notification_app_id(app);
    if app_id == tauri_winrt_notification::Toast::POWERSHELL_APP_ID {
        return Ok(());
    }

    let key = CURRENT_USER
        .create(format!(r"SOFTWARE\Classes\AppUserModelId\{app_id}"))
        .map_err(|e| e.to_string())?;
    key.set_string("DisplayName", &app.package_info().name)
        .map_err(|e| e.to_string())?;
    key.set_string("IconBackgroundColor", "0")
        .map_err(|e| e.to_string())?;

    if let Ok(exe) = tauri::utils::platform::current_exe() {
        let icon_uri = HSTRING::from(exe.to_string_lossy().as_ref());
        key.set_hstring("IconUri", &icon_uri)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(windows)]
pub fn ensure_notification_environment<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    register_windows_app_user_model_id(app)
}

#[cfg(not(windows))]
pub fn ensure_notification_environment<R: Runtime>(_app: &AppHandle<R>) -> Result<(), String> {
    Ok(())
}

pub fn show_desktop_notification<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
) -> Result<(), String> {
    ensure_notification_environment(app)?;

    #[cfg(windows)]
    {
        let version = windows_version::OsVersion::current();
        if version.major == 6 && version.minor == 1 {
            return app
                .notification()
                .builder()
                .title(title)
                .body(body)
                .show()
                .map_err(|e| e.to_string());
        }
        tauri_winrt_notification::Toast::new(&windows_notification_app_id(app))
            .title(title)
            .text1(body)
            .duration(tauri_winrt_notification::Duration::Short)
            .show()
            .map_err(|e| format!("{e:?}"))
    }

    #[cfg(not(windows))]
    {
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| e.to_string())
    }
}

/// Draw a small white envelope inside a red circle at the top-right of the
/// tray icon, like a "new mail" badge on top of the logo.
fn draw_envelope_badge(
    rgba: &mut [u8],
    width: usize,
    height: usize,
    center_x: f32,
    center_y: f32,
    radius: f32,
) {
    let min_dim = width.min(height) as f32;
    // Scale everything relative to the badge radius so it stays crisp at 16px.
    let env_w = radius * 1.55;
    let env_h = radius * 1.15;
    let env_left = center_x - env_w / 2.0;
    let env_top = center_y - env_h / 2.0;
    let env_right = center_x + env_w / 2.0;
    let env_bottom = center_y + env_h / 2.0;
    let corner = env_w * 0.18;
    let stroke = (min_dim * 0.045).clamp(0.8, 1.8);

    for y in 0..height {
        for x in 0..width {
            let fx = x as f32 + 0.5;
            let fy = y as f32 + 0.5;
            let offset = (y * width + x) * 4;
            let dx = fx - center_x;
            let dy = fy - center_y;
            let distance = (dx * dx + dy * dy).sqrt();

            // 1) red circle background
            if distance <= radius {
                rgba[offset] = 229;
                rgba[offset + 1] = 57;
                rgba[offset + 2] = 53;
                rgba[offset + 3] = 255;
            }
            // 2) white envelope body (rounded rect)
            let in_rect = fx >= env_left && fx <= env_right && fy >= env_top && fy <= env_bottom;
            let rounded = in_rect
                && (fx < env_left + corner
                    || fx > env_right - corner
                    || fy < env_top + corner
                    || fy > env_bottom - corner);
            let in_corner_region = rounded;
            let in_rounded_rect = if in_corner_region {
                // approximate corner check
                let cx = if fx < env_left + corner { env_left + corner } else if fx > env_right - corner { env_right - corner } else { fx };
                let cy = if fy < env_top + corner { env_top + corner } else if fy > env_bottom - corner { env_bottom - corner } else { fy };
                ((fx - cx).powi(2) + (fy - cy).powi(2)) <= corner * corner
            } else {
                in_rect
            };
            if in_rounded_rect && distance <= radius {
                rgba[offset] = 255;
                rgba[offset + 1] = 255;
                rgba[offset + 2] = 255;
                rgba[offset + 3] = 255;
            }
            // 3) envelope flap (V shape): white envelope with red V line
            if distance <= radius && fx >= env_left && fx <= env_right && fy >= env_top && fy <= env_bottom {
                // The V line: at each column, the flap line y = env_top + (x - left)/(right-left)*env_h*0.6
                let t = (fx - env_left) / (env_right - env_left).max(1.0);
                let line_y = env_top + (0.9 - 0.6 * t) * env_h * 1.0;
                if (fy - line_y).abs() <= stroke {
                    rgba[offset] = 229;
                    rgba[offset + 1] = 57;
                    rgba[offset + 2] = 53;
                    rgba[offset + 3] = 255;
                }
            }
        }
    }
}

pub fn tray_attention_icon(base: &Image<'_>) -> Image<'static> {
    let width = base.width() as usize;
    let height = base.height() as usize;
    let mut rgba = base.rgba().to_vec();
    // 放大角标：占图标约 1/3，红圈更醒目（托盘图标小，原 0.20 太小看不清）
    let radius = ((width.min(height) as f32) * 0.32).clamp(6.0, 14.0);
    let center_x = width as f32 - radius - 2.0;
    let center_y = radius + 2.0;

    draw_envelope_badge(&mut rgba, width, height, center_x, center_y, radius);
    Image::new_owned(rgba, base.width(), base.height())
}

fn should_mark_attention<R: Runtime>(app: &AppHandle<R>) -> bool {
    // 新邮件到达即亮托盘徽章（不依赖窗口是否在前台/聚焦）
    let _ = app;
    true
}

pub fn mark_attention_indicator<R: Runtime>(app: &AppHandle<R>) {
    if should_mark_attention(app) {
        set_attention_indicator(app, true);
    }
}

pub fn clear_attention_indicator<R: Runtime>(app: &AppHandle<R>) {
    set_attention_indicator(app, false);
}

fn set_attention_indicator<R: Runtime>(app: &AppHandle<R>, active: bool) {
    if let Some(state) = app.try_state::<AppState>() {
        let previous = state
            .notification_attention_active
            .swap(active, Ordering::SeqCst);
        if previous == active {
            return;
        }
    }

    if let Some(tray) = app.tray_by_id("main") {
        if let Some(default_icon) = app.default_window_icon() {
            let icon = if active {
                tray_attention_icon(default_icon)
            } else {
                default_icon.clone().to_owned()
            };
            if let Err(e) = tray.set_icon(Some(icon)) {
                warn!("Failed to update tray notification icon: {e}");
            }
        }

        let tooltip = if active {
            TRAY_ATTENTION_TOOLTIP
        } else {
            TRAY_DEFAULT_TOOLTIP
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

#[tauri::command]
pub async fn set_notifications_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> std::result::Result<(), PebbleError> {
    state.notifications_enabled.store(enabled, Ordering::SeqCst);
    if !enabled {
        clear_attention_indicator(&app);
    }
    Ok(())
}

#[tauri::command]
pub async fn get_notification_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> std::result::Result<NotificationStatus, PebbleError> {
    Ok(notification_status_payload(
        state.notifications_enabled.load(Ordering::SeqCst),
        state.notification_attention_active.load(Ordering::SeqCst),
        notification_platform(),
        notification_app_id(&app),
    ))
}

#[tauri::command]
pub async fn show_test_notification(
    app: AppHandle,
    state: State<'_, AppState>,
) -> std::result::Result<(), PebbleError> {
    if !state.notifications_enabled.load(Ordering::SeqCst) {
        return Err(PebbleError::Validation(
            "Desktop notifications are disabled".to_string(),
        ));
    }

    show_desktop_notification(
        &app,
        "Pebble - Test Notification",
        "Desktop notifications are working.",
    )
    .map_err(PebbleError::Internal)
}

#[tauri::command]
pub async fn clear_notification_attention(app: AppHandle) -> std::result::Result<(), PebbleError> {
    clear_attention_indicator(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::image::Image;

    #[test]
    fn notification_status_payload_reports_gate_attention_and_app_id() {
        let status = notification_status_payload(
            true,
            false,
            "windows",
            Some("com.qingj01.pebble".to_string()),
        );

        assert!(status.enabled);
        assert!(!status.attention_active);
        assert_eq!(status.platform, "windows");
        assert_eq!(status.app_id.as_deref(), Some("com.qingj01.pebble"));
    }

    #[test]
    fn tray_attention_icon_preserves_base_size_and_marks_top_right() {
        let base = Image::new_owned(vec![24; 32 * 32 * 4], 32, 32);
        let icon = tray_attention_icon(&base);

        assert_eq!(icon.width(), 32);
        assert_eq!(icon.height(), 32);

        let top_right_dot = ((5 * 32 + 26) * 4) as usize;
        assert!(icon.rgba()[top_right_dot] > 220);
        assert!(icon.rgba()[top_right_dot + 1] < 80);
        assert!(icon.rgba()[top_right_dot + 2] < 80);
        assert_eq!(icon.rgba()[top_right_dot + 3], 255);

        let bottom_left = ((30 * 32 + 1) * 4) as usize;
        assert_eq!(
            &icon.rgba()[bottom_left..bottom_left + 4],
            &[24, 24, 24, 24]
        );
    }
}
