// 诊断 example（之二）：用老妖软件**真实的 ImapProvider** 走完整收信路径：
//   connect() -> list_folders() -> get_mailbox_status("INBOX") -> fetch_messages_page(...)
// 全部调用 app 实际使用的函数，看真实 provider 在 Zoho 上到底能抓到几封。
// 若 fetch_messages_page 返回 0 封 -> bug 在 provider 层（app 必中招）；
// 若返回 >0 封 -> bug 在 SyncWorker/store 编排层。

use pebble_mail::imap::{ConnectionSecurity, ImapConfig, ImapProvider};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .ok();

    use std::io::Write;
    print!("Zoho 邮箱地址: ");
    std::io::stdout().flush().ok();
    let mut user = String::new();
    std::io::stdin().read_line(&mut user).ok();
    let user = user.trim().to_string();
    print!("Zoho 密码（输入不显示，仅本地用）: ");
    std::io::stdout().flush().ok();
    let mut pass = String::new();
    std::io::stdin().read_line(&mut pass).ok();
    let pass = pass.trim().to_string();

    let cfg = ImapConfig {
        host: "imappro.zoho.com".to_string(),
        port: 993,
        username: user,
        password: pass,
        security: ConnectionSecurity::Tls,
        accept_invalid_certs: false,
        proxy: None,
    };

    let provider = ImapProvider::new(cfg);

    println!("[1] connect() ...");
    match provider.connect().await {
        Ok(()) => println!("[1] connect OK"),
        Err(e) => {
            println!("[1] connect FAILED: {e}");
            return Ok(());
        }
    }

    println!("[2] list_folders() ...");
    match provider.list_folders("diag-account").await {
        Ok(folders) => {
            println!("[2] 发现 {} 个文件夹:", folders.len());
            for f in &folders {
                println!(
                    "    remote_id={:?} role={:?} name={:?}",
                    f.remote_id, f.role, f.name
                );
            }
        }
        Err(e) => println!("[2] list_folders FAILED: {e}"),
    }

    println!("[3] get_mailbox_status(\"INBOX\") ...");
    let exists = match provider.get_mailbox_status("INBOX").await {
        Ok(s) => {
            println!("[3] EXISTS = {}", s.exists);
            s.exists
        }
        Err(e) => {
            println!("[3] get_mailbox_status FAILED: {e}");
            0
        }
    };

    if exists > 0 {
        let start = if exists > 5 { exists - 4 } else { 1 };
        println!("[4] fetch_messages_page(\"INBOX\", {start}, {exists}) ...");
        match provider
            .fetch_messages_page("INBOX", start, exists)
            .await
        {
            Ok(msgs) => {
                println!("[4] fetch_messages_page 返回 {} 封", msgs.len());
                for (uid, raw) in &msgs {
                    let preview = if raw.len() > 80 {
                        String::from_utf8_lossy(&raw[..80])
                    } else {
                        String::from_utf8_lossy(raw)
                    };
                    println!("    UID={uid} 字节={} 预览={}", raw.len(), preview.replace('\n', " "));
                }
                if msgs.is_empty() {
                    println!("[4] >>> 关键：真实 provider 在 Zoho 上也返回 0 封 -> bug 在 provider 层");
                } else {
                    println!("[4] >>> 真实 provider 能抓到邮件 -> bug 在 SyncWorker/store 编排层");
                }
            }
            Err(e) => println!("[4] fetch_messages_page FAILED: {e}"),
        }

        // 同时走 fetch_messages_raw 的全量分支（since_uid=None）
        println!("[5] fetch_messages_raw(\"INBOX\", None, 5) [全量分支] ...");
        match provider.fetch_messages_raw("INBOX", None, 5).await {
            Ok(msgs) => {
                println!("[5] fetch_messages_raw 返回 {} 封", msgs.len());
                for (uid, raw) in &msgs {
                    println!("    UID={uid} 字节={}", raw.len());
                }
            }
            Err(e) => println!("[5] fetch_messages_raw FAILED: {e}"),
        }
    }

    let _ = provider.disconnect().await;
    Ok(())
}
