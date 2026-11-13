//! One-process window handoff. Sensitive state stays in an ephemeral mailbox;
//! only a random token is put in the URL, never a draft, prompt or API key.
use std::{collections::HashMap, sync::Mutex, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MAX_PAYLOAD: usize = 16 * 1024 * 1024;
struct Session { source: String, destination: String, payload: Option<String>, ready: bool, created: Instant }
#[derive(Default)]
pub struct WorkspaceWindows(Mutex<HashMap<String, Session>>);

#[tauri::command]
pub async fn open_workspace_window(app: AppHandle, window: WebviewWindow, token: String, payload: String, title: String) -> Result<(), String> {
    if token.len()!=36 || !token.bytes().all(|c|c.is_ascii_hexdigit()||c==b'-') { return Err("窗口交接标识无效".into()); }
    if payload.len()>MAX_PAYLOAD {return Err("当前页面资料过大，未移动原标签".into());}
    let parsed: serde_json::Value=serde_json::from_str(&payload).map_err(|_|"页面交接数据无效")?;
    if !matches!(parsed.get("view").and_then(|v|v.as_str()),Some("inbox"|"addressBook"|"companyResearch"|"leadFinder"|"kanban"|"settings"|"search"|"starred"|"compose"|"aiWriting"|"aiAssistant"|"foreignTools"|"customerProfile")) {return Err("不支持的页面类型".into());}
    let destination=format!("workspace-{token}");
    {
        let state=app.state::<WorkspaceWindows>(); let mut sessions=state.0.lock().map_err(|_|"窗口交接暂不可用")?;
        if sessions.contains_key(&token) {return Err("这个标签正在移动，请稍候".into());}
        sessions.insert(token.clone(),Session{source:window.label().into(),destination:destination.clone(),payload:Some(payload),ready:false,created:Instant::now()});
    }
    let profile=app.state::<crate::profile::ProfilePaths>();
    let built=WebviewWindowBuilder::new(&app,&destination,WebviewUrl::App(format!("index.html?workspaceWindow=1&transfer={token}").into()))
        .title(format!("{} - YaoAIMail",title.chars().filter(|c|!c.is_control()).take(100).collect::<String>()))
        .data_directory(profile.app_data_dir().join("webview"))
        .inner_size(1120.0,800.0).min_inner_size(700.0,520.0).center().focused(false).visible(false).decorations(false)
        .disable_drag_drop_handler()
        .additional_browser_args("--disable-autofill --disable-suggestions-ui --disable-features=Autofill,AutofillServerCommunication,PasswordManager")
        .build();
    let child=match built {Ok(child)=>child,Err(error)=>{app.state::<WorkspaceWindows>().0.lock().map_err(|_|"窗口交接暂不可用")?.remove(&token);return Err(format!("创建独立窗口失败：{error}"));}};
    // Frontend acknowledges only after restoring stores, mounting the page and
    // installing update listeners. Failure/timeout keeps the source tab alive.
    for _ in 0..300 {
        let ready=app.state::<WorkspaceWindows>().0.lock().map_err(|_|"窗口交接暂不可用")?.get(&token).is_some_and(|s|s.ready);
        if ready {return Ok(());}
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    app.state::<WorkspaceWindows>().0.lock().map_err(|_|"窗口交接暂不可用")?.remove(&token);
    let _=child.destroy();
    Err("独立窗口没有完成加载，原标签仍保留，请重试".into())
}

#[tauri::command]
pub fn read_workspace_window(app: AppHandle, window: WebviewWindow, token: String) -> Result<String,String> {
    let state=app.state::<WorkspaceWindows>();let sessions=state.0.lock().map_err(|_|"窗口交接暂不可用")?;
    let session=sessions.get(&token).filter(|s|s.destination==window.label() && s.created.elapsed()<Duration::from_secs(30)).ok_or("窗口交接已过期或无权读取")?;
    session.payload.clone().ok_or_else(||"窗口内容已经交接，请从主窗口重新打开".into())
}

#[tauri::command]
pub fn show_workspace_window(app: AppHandle, window: WebviewWindow, token: String) -> Result<(),String> {
    let state=app.state::<WorkspaceWindows>();let sessions=state.0.lock().map_err(|_|"窗口交接暂不可用")?;
    if !sessions.get(&token).is_some_and(|s|s.destination==window.label()) { return Err("窗口交接无效".into()); }
    window.show().map_err(|e|e.to_string())?;window.set_focus().map_err(|e|e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn ready_workspace_window(app: AppHandle, window: WebviewWindow, token: String) -> Result<(),String> {
    let state=app.state::<WorkspaceWindows>();let mut sessions=state.0.lock().map_err(|_|"窗口交接暂不可用")?;
    let session=sessions.get_mut(&token).filter(|s|s.destination==window.label()).ok_or("窗口交接无效")?;
    window.show().map_err(|e|e.to_string())?;window.set_focus().map_err(|e|e.to_string())?;
    session.ready=true;session.payload=None;
    Ok(())
}

#[tauri::command]
pub fn update_workspace_window(app: AppHandle, window: WebviewWindow, token: String, key: String, value: String) -> Result<(),String> {
    if key.len()>256 || value.len()>MAX_PAYLOAD {return Err("窗口状态更新过大".into());}
    let peer={
        let state=app.state::<WorkspaceWindows>();let sessions=state.0.lock().map_err(|_|"窗口交接暂不可用")?;
        let session=sessions.get(&token).filter(|s|s.ready).ok_or("独立窗口已关闭")?;
        if window.label()==session.source {session.destination.clone()}
        else if window.label()==session.destination {session.source.clone()}
        else {return Err("不能读取其他窗口的交接状态".into());}
    };
    app.emit_to(peer,"workspace:state",serde_json::json!({"token":token,"key":key,"value":value})).map_err(|e|e.to_string())
}

pub fn forget_window(app:&AppHandle,label:&str) {
    if let Some(state)=app.try_state::<WorkspaceWindows>() {
        let removed = if let Ok(mut sessions)=state.0.lock() {
            let removed: Vec<_> = sessions.iter().filter(|(_,s)|s.destination==label || s.source==label)
                .map(|(token,s)|(token.clone(), if s.destination==label {s.source.clone()} else {s.destination.clone()})).collect();
            for (token,_) in &removed { sessions.remove(token); }
            removed
        } else { Vec::new() };
        for (token,peer) in removed { let _=app.emit_to(peer,"workspace:closed",serde_json::json!({"token":token})); }
    }
}

#[tauri::command]
pub fn cancel_workspace_window(app: AppHandle, window: WebviewWindow, token: String) -> Result<(),String> {
    let destination = {
        let state=app.state::<WorkspaceWindows>();let mut sessions=state.0.lock().map_err(|_|"窗口交接暂不可用")?;
        if sessions.get(&token).is_some_and(|session| session.source!=window.label()) { return Err("不能取消其他窗口的交接".into()); }
        sessions.remove(&token).map(|session|session.destination)
    };
    if let Some(destination)=destination { if let Some(child)=app.get_webview_window(&destination) { let _=child.destroy(); } }
    Ok(())
}
