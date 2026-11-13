//! Read-only model discovery. Never guesses IDs or makes a completion request.
use pebble_core::{PebbleError, Result};
use std::time::Duration;

fn models_url(base: &str, chat_path: &str) -> Result<reqwest::Url> {
    super::endpoint::validate_service_endpoint(base).map_err(PebbleError::Validation)?;
    let mut url = reqwest::Url::parse(base).map_err(|_| PebbleError::Validation("接口地址无效".into()))?;
    let path = url.path().trim_end_matches('/');
    let configured = format!("/{}", chat_path.trim_matches('/'));
    let root = ["/chat/completions", "/responses", configured.as_str()].into_iter()
        .filter(|suffix| suffix.len() > 1).find_map(|suffix| path.strip_suffix(suffix)).unwrap_or(path);
    let next = if root.ends_with("/models") { root.to_string() } else { format!("{root}/models") };
    url.set_path(&next);
    Ok(url)
}

fn parse_ids(value: &serde_json::Value) -> Result<Vec<String>> {
    let items = value.get("data").and_then(|v| v.as_array()).or_else(|| value.as_array())
        .ok_or_else(|| PebbleError::Translate("服务商未提供可识别的模型列表，请手动添加模型 ID".into()))?;
    let mut ids: Vec<String> = items.iter().filter_map(|item| item.get("id").and_then(|id| id.as_str()).or_else(|| item.as_str()))
        .map(str::trim).filter(|id| !id.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control)).map(str::to_owned).collect();
    ids.sort(); ids.dedup();
    if ids.is_empty() { return Err(PebbleError::Translate("未获取到模型 ID，原配置已保留，可手动添加".into())); }
    Ok(ids)
}

pub async fn list_models(client: &reqwest::Client, base: &str, key: &str, chat_path: &str) -> Result<Vec<String>> {
    let url = models_url(base, chat_path)?;
    tokio::time::timeout(Duration::from_secs(20), async {
        let mut request = client.get(url);
        if !key.trim().is_empty() { request = request.bearer_auth(key.trim()); }
        let mut response = request.send().await.map_err(|_| PebbleError::Network("获取模型列表失败，请检查接口及代理，或手动添加模型 ID".into()))?;
        if !response.status().is_success() {
            // Never echo a gateway error body or URL (either can contain keys).
            return Err(PebbleError::Translate(format!("无法获取模型列表（HTTP {}），请检查权限；不支持自动获取时可手动添加", response.status().as_u16())));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| PebbleError::Network("模型列表读取失败，请重试或手动添加".into()))? {
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 { return Err(PebbleError::Translate("模型列表过大，请手动添加需要的模型 ID".into())); }
            bytes.extend_from_slice(&chunk);
        }
        let value = serde_json::from_slice(&bytes).map_err(|_| PebbleError::Translate("服务商未返回有效的模型列表，请手动添加模型 ID".into()))?;
        parse_ids(&value)
    }).await.map_err(|_| PebbleError::Network("获取模型列表超时，原配置已保留，可手动添加".into()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoint_uses_same_prefix_and_handles_complete_urls() {
        for (base, expected) in [
            ("https://api.example.test/v1", "https://api.example.test/v1/models"),
            ("https://api.example.test/v1/chat/completions", "https://api.example.test/v1/models"),
            ("https://api.example.test/prefix/v2/responses/", "https://api.example.test/prefix/v2/models"),
            ("https://api.example.test/v1beta/openai", "https://api.example.test/v1beta/openai/models"),
            ("http://127.0.0.1:8080/v1", "http://127.0.0.1:8080/v1/models"),
        ] { assert_eq!(models_url(base,"/chat/completions").unwrap().as_str(),expected); }
        assert!(models_url("http://public.example.test/v1","").is_err());
    }
    #[test]
    fn normalizes_ids_without_fabricating_or_replacing_models() {
        assert_eq!(parse_ids(&serde_json::json!({"data":[{"id":" z "},{"id":"a"},{"id":"a"},{"id":""},{}]})).unwrap(),vec!["a","z"]);
        assert!(parse_ids(&serde_json::json!({"data":[]})).is_err());
        assert!(parse_ids(&serde_json::json!({"error":"secret must not appear"})).unwrap_err().to_string().find("secret").is_none());
    }
    #[tokio::test]
    async fn fetches_actual_list_with_bearer_without_calling_chat() {
        use std::{io::{Read,Write},net::TcpListener};
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();let addr=listener.local_addr().unwrap();
        let server=std::thread::spawn(move||{
            let (mut socket,_)=listener.accept().unwrap();socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut bytes=[0;8192];let n=socket.read(&mut bytes).unwrap();let request=String::from_utf8_lossy(&bytes[..n]);
            assert!(request.starts_with("GET /prefix/v1/models "));assert!(request.to_ascii_lowercase().contains("authorization: bearer fixture-key"));
            let body=r#"{"data":[{"id":"fixture-one"},{"id":"fixture-two"}]}"#;
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        });
        let client=crate::TranslateService::http_client_with_proxy(None).unwrap();
        let ids=list_models(&client,&format!("http://{addr}/prefix/v1/chat/completions"),"fixture-key","/chat/completions").await.unwrap();
        assert_eq!(ids,vec!["fixture-one","fixture-two"]);server.join().unwrap();
    }
}
