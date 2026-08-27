// 隔离实验：分别测不同"前置步骤"后，ImapProvider 的 fetch_messages_page 是否超时。
// 目的：定位到底是哪个前置步骤把连接弄脏，导致 FETCH 卡死。
// 用法：target\release\examples\zoho_iso.exe  （交互式输入邮箱/密码）
use pebble_mail::imap::{ConnectionSecurity, ImapConfig, ImapProvider};

fn read_line(prompt: &str) -> String {
    use std::io::Write;
    print!("{prompt}");
    std::io::stdout().flush().ok();
    let mut s = String::new();
    std::io::stdin().read_line(&mut s).ok();
    s.trim().to_string()
}

async fn fresh_provider(user: &str, pass: &str) -> ImapProvider {
    let cfg = ImapConfig {
        host: "imappro.zoho.com".to_string(),
        port: 993,
        username: user.to_string(),
        password: pass.to_string(),
        security: ConnectionSecurity::Tls,
        accept_invalid_certs: false,
        proxy: None,
    };
    ImapProvider::new(cfg)
}

async fn run_case(name: &str, user: &str, pass: &str, do_list: bool, do_status: bool) {
    let provider = fresh_provider(user, pass).await;
    match provider.connect().await {
        Ok(()) => {}
        Err(e) => {
            println!("[{}] connect FAILED: {e}", name);
            return;
        }
    }
    if do_list {
        match provider.list_folders("x").await {
            Ok(f) => println!("[{}] list_folders OK ({} folders)", name, f.len()),
            Err(e) => {
                println!("[{}] list_folders FAILED: {e}", name);
                return;
            }
        }
    }
    if do_status {
        match provider.get_mailbox_status("INBOX").await {
            Ok(s) => println!("[{}] get_mailbox_status OK (exists={})", name, s.exists),
            Err(e) => {
                println!("[{}] get_mailbox_status FAILED: {e}", name);
                return;
            }
        }
    }
    let exists = match provider.get_mailbox_status("INBOX").await {
        Ok(s) => s.exists,
        Err(_) => 1704,
    };
    let start = if exists > 5 { exists - 4 } else { 1 };
    print!("[{}] fetch_messages_page({start},{exists}) ... ", name);
    match tokio::time::timeout(
        std::time::Duration::from_secs(60),
        provider.fetch_messages_page("INBOX", start, exists),
    )
    .await
    {
        Ok(Ok(msgs)) => println!("OK 抓到 {} 封", msgs.len()),
        Ok(Err(e)) => println!("FAILED: {e}"),
        Err(_) => println!("TIMEOUT(60s)"),
    }
    let _ = provider.disconnect().await;
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .ok();

    let user = read_line("Zoho 邮箱地址: ");
    let pass = read_line("Zoho 密码（输入不显示）: ");

    println!("\n=== 用例 A: 只 connect 后直接抓（无 list / 无 status）===");
    run_case("A", &user, &pass, false, false).await;

    println!("\n=== 用例 B: connect + list_folders 后抓 ===");
    run_case("B", &user, &pass, true, false).await;

    println!("\n=== 用例 C: connect + get_mailbox_status 后抓 ===");
    run_case("C", &user, &pass, false, true).await;

    println!("\n=== 用例 D: connect + list + status 后抓（复现原 bug）===");
    run_case("D", &user, &pass, true, true).await;

    Ok(())
}
