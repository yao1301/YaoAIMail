//! Policy for explicitly user-configured service endpoints, NOT fetched web pages.
use std::net::IpAddr;

pub fn validate_service_endpoint(value: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(value).map_err(|_| "接口地址无效，请填写完整 HTTP/HTTPS 地址".to_string())?;
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("接口地址不能包含用户名、密码或片段".into());
    }
    match url.scheme() {
        "https" => Ok(()),
        "http" if is_local_host(url.host_str().unwrap_or_default()) => Ok(()),
        "http" => Err("公网接口必须使用 HTTPS；HTTP 仅允许本机和私有局域网地址".into()),
        _ => Err("接口仅支持 HTTP/HTTPS".into()),
    }
}

pub fn is_local_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") { return true; }
    match host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private(),
        Ok(IpAddr::V6(ip)) => ip.is_loopback() || (ip.segments()[0] & 0xfe00 == 0xfc00)
            || ip.to_ipv4_mapped().is_some_and(|ip| ip.is_loopback() || ip.is_private()),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_local_and_private_http_and_https() {
        for url in ["http://localhost:8080/v1", "http://127.2.3.4/v1", "http://192.168.50.25:18080/v1", "http://10.0.0.1", "http://172.16.0.1", "http://172.31.255.254", "http://[::1]:8080", "http://[fd12::1]:8080", "http://[::ffff:192.168.1.2]", "https://api.example.com/v1"] {
            assert!(validate_service_endpoint(url).is_ok(), "{url}");
        }
    }
    #[test]
    fn rejects_public_http_and_confusing_endpoints() {
        for url in ["http://8.8.8.8", "http://172.32.0.1", "http://localhost.example.com", "http://localhost@evil.example", "http://0.0.0.0", "http://169.254.169.254", "file:///etc/passwd", "https://", "https://user:secret@example.com", "http://[::]", "http://[fe80::1]", "https://example.com/#secret"] {
            assert!(validate_service_endpoint(url).is_err(), "{url}");
        }
    }

    #[tokio::test]
    async fn actual_llm_transport_accepts_http_and_blocks_public_http_redirect() {
        use std::io::{Read,Write};
        use std::net::TcpListener;
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();
        let address=listener.local_addr().unwrap();
        let server=std::thread::spawn(move||{
            for redirect in [false,true] {
                let (mut socket,_)=listener.accept().unwrap();socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
                let mut request=[0;8192];let n=socket.read(&mut request).unwrap();
                assert!(String::from_utf8_lossy(&request[..n]).starts_with("POST /v1/chat/completions "));
                if redirect {write!(socket,"HTTP/1.1 307 Temporary Redirect\r\nLocation: http://8.8.8.8/v1/chat/completions\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();}
                else {let body=r#"{"choices":[{"message":{"content":"fixture-ok"}}]}"#;write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();}
            }
        });
        let client=crate::TranslateService::http_client_with_proxy(None).unwrap();
        // Keep the base string alive for the asynchronous call.
        let base=format!("http://{address}/v1");
        let first=crate::llm::complete(&client,&base,"dummy-key","fixture-model",&crate::types::LLMMode::Completions,"/chat/completions","fixture","hello").await.unwrap();
        assert_eq!(first,"fixture-ok");
        assert!(crate::llm::complete(&client,&base,"dummy-key","fixture-model",&crate::types::LLMMode::Completions,"/chat/completions","fixture","hello").await.is_err());
        server.join().unwrap();
    }
}
