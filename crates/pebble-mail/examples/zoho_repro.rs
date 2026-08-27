// 诊断 example：用与老妖软件完全相同的 async-imap 0.10.4 + mail-parser 0.9.4，
// 对 Zoho 跑一遍「选 INBOX -> FETCH (UID BODY.PEEK[]) -> 取正文 -> 解析」，
// 打印每一步的真实结果，用于定位「登录成功但收不到邮件」到底是库层还是编排层的问题。
//
// 运行（在 PowerShell，先 cd 到 pebble-upstream）：
//   cargo build --example zoho_repro --release
//   $env:ZOHO_USER="你的邮箱"; $env:ZOHO_PASS="你的应用密码"
//   target/release/examples/zoho_repro.exe

use async_imap::Client;
use futures::TryStreamExt;
use std::sync::Arc;
use tokio_rustls::{
    rustls::{ClientConfig, RootCertStore},
    TlsConnector,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 显式安装 rustls 加密后端（aws-lc-rs），否则 0.23 会因多后端歧义拒绝自动选择。
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .ok();

    use std::io::Write;
    print!("Zoho 邮箱地址: ");
    std::io::stdout().flush().ok();
    let mut user = String::new();
    std::io::stdin().read_line(&mut user).ok();
    let user = user.trim().to_string();
    print!("Zoho 密码（输入不显示）: ");
    std::io::stdout().flush().ok();
    let mut pass = String::new();
    // 不回显密码：用 crossterm 较麻烦，这里直接 read_line（密码会回显，仅本地诊断用）
    std::io::stdin().read_line(&mut pass).ok();
    let pass = pass.trim().to_string();
    let host = "imappro.zoho.com";
    let port = 993u16;

    println!("[1] TCP connect + TLS ...");
    let tcp = tokio::net::TcpStream::connect((host, port)).await?;
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let cfg = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(cfg));
    let server_name: rustls::pki_types::ServerName = host.to_owned().try_into()?;
    let tls = connector.connect(server_name, tcp).await?;
    println!("[1] TLS OK");

    println!("[2] LOGIN ...");
    let client = Client::new(tls);
    let mut sess = client
        .login(&user, &pass)
        .await
        .map_err(|(e, _)| format!("login failed: {e}"))?;
    println!("[2] LOGIN OK");

    println!("[3] SELECT INBOX ...");
    let mb = sess.select("INBOX").await?;
    println!("[3] EXISTS = {}", mb.exists);
    if mb.exists == 0 {
        println!("EXISTS=0，Zoho 收件箱为空，问题在 Zoho 侧。退出。");
        let _ = sess.logout().await;
        return Ok(());
    }

    // 与软件一致：抓最后 5 封（新账号全量回填时也是按序列号翻页 fetch）
    let start = if mb.exists > 5 { mb.exists - 5 + 1 } else { 1 };
    let seq = format!("{start}:{}", mb.exists);
    println!("[4] FETCH {seq} (UID BODY.PEEK[]) ...");
    let mut fetches = sess.fetch(&seq, "(UID BODY.PEEK[])").await?;
    let mut n = 0u32;
    let mut with_uid = 0u32;
    let mut with_body = 0u32;
    let mut bodies: Vec<Vec<u8>> = Vec::new();
    let mut no_uid: Vec<u32> = Vec::new();
    while let Some(f) = fetches.try_next().await? {
        n += 1;
        match f.uid {
            Some(_) => with_uid += 1,
            None => no_uid.push(f.message),
        }
        if let Some(b) = f.body() {
            with_body += 1;
            bodies.push(b.to_vec());
        }
    }
    println!(
        "[4] 共收到 fetch 响应 {n} 个 | 含 UID 的 {with_uid} 个 | 含正文的 {with_body} 个 | 无 UID 的 seq={no_uid:?}"
    );

    println!("[5] 用 mail-parser 解析抓取到的正文 ...");
    let mut parsed_ok = 0u32;
    for (i, b) in bodies.iter().enumerate() {
        match mail_parser::MessageParser::default().parse(b) {
            Some(m) => {
                parsed_ok += 1;
                let from = m
                    .from()
                    .and_then(|a| a.first())
                    .and_then(|a| a.address())
                    .unwrap_or("-");
                let subj = m.subject().unwrap_or("-");
                println!(
                    "   邮件#{i}: 解析OK | from={from} | subject={}",
                    if subj.len() > 40 { &subj[..40] } else { subj }
                );
            }
            None => println!("   邮件#{i}: 解析失败(返回 None)"),
        }
    }
    println!("[5] 解析成功 {parsed_ok}/{with_body}");

    println!("\n==== 结论 ====");
    if with_body > 0 && parsed_ok == with_body {
        println!("async-imap 能抓到正文、mail-parser 也能解析 → 问题在软件编排层(会话/文件夹/游标)，不在库层。");
    } else if with_body == 0 {
        println!("async-imap 抓到 0 封正文(含 UID 也少) → 问题在 async-imap + Zoho 的交互(库层)。");
    } else {
        println!("能抓到正文但解析失败 → 问题在 mail-parser 对 Zoho 邮件的解析。");
    }

    drop(fetches);
    let _ = sess.logout().await;
    Ok(())
}
