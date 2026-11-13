//! Standalone DeepSeek tools; independent of the model configured for research.
use super::{bounded_json, Failure};
use reqwest::{Client, RequestBuilder, Url};
use serde_json::json;
use std::time::Duration;

const SEARCH: &str = "https://api.deepseek.com/v1/tools/search";
const FETCH: &str = "https://api.deepseek.com/v1/tools/fetch";

pub(super) fn search_request(client: &Client, key: &str, query: &str) -> Result<RequestBuilder, Failure> {
    let query = query.trim();
    // Skip overlong queries rather than silently losing qualifiers/exclusions.
    if query.is_empty() || query.chars().count() > 128 {
        return Err(Failure::Invalid);
    }
    Ok(client.post(SEARCH).bearer_auth(key).timeout(Duration::from_secs(5))
        .json(&json!({"query": query, "count": 20, "need_content": false})))
}

fn fetch_request(client: &Client, key: &str, url: &Url) -> Result<RequestBuilder, Failure> {
    // Do not forward tracking, signed links, fragments or credentials.
    // The caller also checks public DNS and the site's access policy.
    if !matches!(url.scheme(), "http" | "https") || !url.has_host()
        || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some() || url.as_str().len() > 8192
    {
        return Err(Failure::Invalid);
    }
    Ok(client.post(FETCH).bearer_auth(key).timeout(Duration::from_secs(4))
        .json(&json!({"url": url.as_str()})))
}

/// A missing/inaccessible page is local to that URL, not a provider outage.
pub async fn fetch(client: &Client, key: &str, url: &Url) -> Result<Option<(String, String)>, Failure> {
    let response = fetch_request(client, key, url)?.send().await.map_err(|_| Failure::Network)?;
    if matches!(response.status().as_u16(), 403 | 404) {
        return Ok(None);
    }
    parse_page(bounded_json(response).await?)
}

fn parse_page(value: serde_json::Value) -> Result<Option<(String, String)>, Failure> {
    let text = value.get("content").and_then(|v| v.as_str()).ok_or(Failure::Schema)?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    let title = value.get("title").and_then(|v| v.as_str()).unwrap_or_default();
    Ok(Some((title.chars().take(300).collect(), text.chars().take(60_000).collect())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standalone_search_sends_only_query_and_bearer_and_preserves_multilingual_operators() {
        let client = Client::new();
        let query = "grossiste éclairage site:example.com lang:fr,en -marketplace";
        let req = search_request(&client, "fixture-key", query).unwrap().build().unwrap();
        assert_eq!(req.url().as_str(), SEARCH);
        assert_eq!(req.method(), reqwest::Method::POST);
        assert_eq!(req.headers()["authorization"], "Bearer fixture-key");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(req.body().unwrap().as_bytes().unwrap()).unwrap(),
            json!({"query":query,"count":20,"need_content":false}));
        assert!(search_request(&client, "fixture-key", &"灯".repeat(128)).is_ok());
        assert!(search_request(&client, "fixture-key", &"灯".repeat(129)).is_err());
        let hits = crate::parse_results("deepseek", &json!({"results":[{"url":"https://example.com/","title":"Fixture","summary":"","snippet":"Useful snippet"}]})).unwrap();
        assert_eq!(hits[0].description, "Useful snippet");
        assert_eq!(hits[0].provider, "deepseek");
    }

    #[test]
    fn fetch_uses_fixed_endpoint_and_does_not_forward_signed_or_authenticated_urls() {
        let client = Client::new();
        let url = Url::parse("https://example.com/about").unwrap();
        let req = fetch_request(&client, "fixture-key", &url).unwrap().build().unwrap();
        assert_eq!(req.url().as_str(), FETCH);
        assert_eq!(req.method(), reqwest::Method::POST);
        assert_eq!(serde_json::from_slice::<serde_json::Value>(req.body().unwrap().as_bytes().unwrap()).unwrap(), json!({"url":url.as_str()}));
        for url in ["https://example.com/?token=fixture", "https://example.com/#private", "https://u:p@example.com/"] {
            assert!(fetch_request(&client, "fixture-key", &Url::parse(url).unwrap()).is_err());
        }
        assert!(parse_page(json!({"title":"Test","content":"  "})).unwrap().is_none());
        assert_eq!(parse_page(json!({"title":"Test","content":"# Evidence"})).unwrap().unwrap().1, "# Evidence");
        assert_eq!(parse_page(json!({"title":"Test"})), Err(Failure::Schema));
    }
}
