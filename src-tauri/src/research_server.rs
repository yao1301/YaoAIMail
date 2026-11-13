//! Optional headless host for the exact same research backend used by desktop IPC.
//! No Webview, mailbox synchronization, credentials endpoint or sending service.
use std::{net::SocketAddr,path::PathBuf};

pub fn run_from_environment()->Result<(),String>{
    let profile=std::env::var_os("PEBBLE_PROFILE_DIR").map(PathBuf::from).ok_or("独立研究服务需要显式设置PEBBLE_PROFILE_DIR，请使用专用研究资料目录")?;
    let addr:SocketAddr=std::env::var("PEBBLE_RESEARCH_API_ADDR").unwrap_or_else(|_|"127.0.0.1:7465".into()).parse().map_err(|_|"研究API监听地址无效")?;
    let token=std::env::var("PEBBLE_RESEARCH_API_TOKEN").map_err(|_|"独立研究服务必须设置认证Token")?;
    // Reject unsafe startup before touching any profile or initializing a key.
    if !addr.ip().is_loopback()||token.len()<32||token.len()>1024||!token.is_ascii()||token.chars().any(|c|c.is_control()||c.is_whitespace()) {
        return Err("研究API仅允许回环地址，Token至少32字节且不能含空白或控制字符".into());
    }
    if !profile.is_absolute()||!profile.is_dir()||!profile.join("db/pebble.db").is_file(){
        return Err("研究服务需要已初始化且已配置模型的专用绝对路径资料目录".into());
    }
    let runtime=tokio::runtime::Runtime::new().map_err(|_|"研究运行时初始化失败")?;
    runtime.block_on(async move{
        let lock=std::fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(profile.join("research-api.lock")).map_err(|_|"研究服务锁无法打开")?;
        lock.try_lock().map_err(|_|"此资料目录已有研究服务运行")?;
        let store=pebble_store::Store::open(&profile.join("db/pebble.db")).map_err(|_|"研究资料库无法打开")?;
        let crypto=pebble_crypto::CryptoService::init_for_profile(&profile).map_err(|_|"研究配置密钥无法读取")?;
        // Research does not need the private mail index. An in-memory index
        // satisfies the legacy adapter without indexing or reading any messages.
        let search=pebble_search::TantivySearch::open_in_memory().map_err(|_|"研究运行环境初始化失败")?;
        let(tx,_rx)=std::sync::mpsc::channel();
        let state=crate::state::AppState::new(store,search,crypto,tx,profile.join("attachments"));
        let engine=crate::commands::research_service::engine(&state).map_err(|_|"研究任务恢复失败，原记录保留")?;
        let result=pebble_research::api::serve(engine,addr,token).await;
        drop(lock);result
    })
}
