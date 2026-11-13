use super::*;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

fn config(base: &str, use_proxy: bool) -> TranslateProviderConfig {
    serde_json::from_value(serde_json::json!({
        "type":"llm", "active_id":"fixture", "providers":[{
            "id":"fixture", "name":"Fixture", "kind":"custom", "base_url":base,
            "chat_path":"/chat/completions", "api_key":"dummy-key", "model":"fixture-model",
            "mode":"completions", "use_proxy":use_proxy
        }]
    })).unwrap()
}

fn respond(stream: &mut TcpStream, content: &str) {
    let mut request = Vec::new();
    loop {
        let mut buf = [0; 4096];
        let n = stream.read(&mut buf).unwrap();
        assert!(n > 0, "request ended before body");
        request.extend_from_slice(&buf[..n]);
        if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&request[..end]);
            assert!(headers.starts_with("POST /v1/chat/completions "));
            let length: usize = headers.lines().filter_map(|line| line.split_once(':'))
                .find(|(name,_)| name.eq_ignore_ascii_case("content-length"))
                .unwrap().1.trim().parse().unwrap();
            if request.len() >= end + 4 + length { break; }
        }
        assert!(request.len() < 100_000);
    }
    let body = serde_json::json!({"choices":[{"message":{"content":content}}]}).to_string();
    write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
}

fn server(proxy: bool, requests: usize, content: &'static str) -> (u16, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let worker = std::thread::spawn(move || {
        for _ in 0..requests {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket,_)) => break socket,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(std::time::Instant::now() < deadline, "expected request did not arrive");
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                    Err(e) => panic!("accept failed: {e}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            if proxy {
                let mut header = [0;2]; socket.read_exact(&mut header).unwrap(); assert_eq!(header[0],5);
                let mut methods = vec![0;header[1] as usize]; socket.read_exact(&mut methods).unwrap();
                assert!(methods.contains(&0)); socket.write_all(&[5,0]).unwrap();
                let mut request=[0;4]; socket.read_exact(&mut request).unwrap(); assert_eq!(&request[..3], &[5,1,0]);
                match request[3] {
                    1 => { let mut host=[0;4]; socket.read_exact(&mut host).unwrap(); assert_eq!(host,[127,0,0,1]); }
                    3 => { let mut len=[0]; socket.read_exact(&mut len).unwrap(); let mut host=vec![0;len[0] as usize]; socket.read_exact(&mut host).unwrap(); assert_eq!(host,b"127.0.0.1"); }
                    _ => panic!("unexpected SOCKS address"),
                }
                let mut port=[0;2]; socket.read_exact(&mut port).unwrap(); assert_eq!(u16::from_be_bytes(port),9);
                socket.write_all(&[5,0,0,1,127,0,0,1,0,0]).unwrap();
            }
            respond(&mut socket,content);
        }
    });
    (port,worker)
}

async fn exercise_all(config: &TranslateProviderConfig, proxy: &HttpProxyConfig) {
    assert!(!TranslateService::translate_with_proxy(config,Some(proxy),"Hello","en","zh").await.unwrap().translated.is_empty());
    assert_eq!(TranslateService::complete_with_proxy(config,Some(proxy),"fixture","hello").await.unwrap(),"fixture-ok");
    assert_eq!(TranslateService::complete_fast_with_proxy(config,Some(proxy),"fixture","hello",50).await.unwrap(),"fixture-ok");
    assert_eq!(TranslateService::complete_chat_with_proxy(config,Some(proxy),&[ChatTurn {role:"user",content:"hello"}]).await.unwrap(),"fixture-ok");
    TranslateService::test_connection(config,Some(proxy)).await.unwrap();
}

#[tokio::test]
async fn unchecked_model_uses_direct_for_every_service_path_even_with_invalid_shared_proxy() {
    let (port,worker) = server(false,5,"fixture-ok");
    let cfg=config(&format!("http://127.0.0.1:{port}/v1"),false);
    exercise_all(&cfg,&HttpProxyConfig{host:" ".into(),port:0}).await;
    worker.join().unwrap();
}

#[tokio::test]
async fn checked_model_uses_real_socks_handshake_for_every_service_path_including_test() {
    let (port,worker) = server(true,5,"fixture-ok");
    // Port 9 has no model server. Only the SOCKS fixture returns the response.
    exercise_all(&config("http://127.0.0.1:9/v1",true),&HttpProxyConfig{host:"127.0.0.1".into(),port}).await;
    worker.join().unwrap();
}

#[test]
fn checked_without_address_and_invalid_active_id_fail_closed() {
    let mut cfg=config("http://127.0.0.1:9/v1",true);
    assert!(TranslateService::proxy_for_config(&cfg,None).unwrap_err().to_string().contains("设置 → 代理"));
    if let TranslateProviderConfig::LLM{active_id,..}=&mut cfg { *active_id="missing".into(); }
    assert!(TranslateService::proxy_for_config(&cfg,None).is_err());
}

#[test]
fn legacy_profiles_keep_previous_proxy_behavior_but_explicit_false_round_trips() {
    let mut value=serde_json::to_value(config("https://api.example.test/v1",false)).unwrap();
    value["providers"][0].as_object_mut().unwrap().remove("use_proxy");
    let cfg:TranslateProviderConfig=serde_json::from_value(value).unwrap();
    let proxy=HttpProxyConfig{host:"127.0.0.1".into(),port:11001};
    assert!(TranslateService::proxy_for_config(&cfg,Some(&proxy)).unwrap().is_some());
    assert!(TranslateService::proxy_for_config(&cfg,None).unwrap().is_none());
    let saved=serde_json::to_string(&config("https://api.example.test/v1",false)).unwrap();
    let loaded:TranslateProviderConfig=serde_json::from_str(&saved).unwrap();
    assert!(TranslateService::proxy_for_config(&loaded,Some(&proxy)).unwrap().is_none());
}

#[tokio::test]
async fn connection_test_rejects_empty_success_responses() {
    let (port,worker)=server(false,1,"");
    let error=TranslateService::test_connection(&config(&format!("http://127.0.0.1:{port}/v1"),false),None).await.unwrap_err();
    assert!(error.to_string().contains("未返回有效内容"));
    worker.join().unwrap();
}
