//! Only masked labels and provider-bound, authenticated deletion tokens cross IPC.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use pebble_core::PebbleError;
use pebble_crypto::CryptoService;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyEntry {
    pub id: String,
    pub masked_key: String,
}

#[derive(Serialize, Deserialize)]
struct KeyToken {
    purpose: String,
    provider: String,
    key: String,
}

const PURPOSE: &str = "external-service-single-key-delete-v1";

pub fn entries(crypto: &CryptoService, provider: &str, keys: &[String]) -> Result<Vec<KeyEntry>, PebbleError> {
    keys.iter().map(|key| {
        let token = serde_json::to_vec(&KeyToken { purpose: PURPOSE.into(), provider: provider.into(), key: key.clone() })
            .map_err(|_| PebbleError::Internal("无法读取 API 配置，请重试。".into()))?;
        // Never reveal an entire short key, or expose the clear key as a row ID.
        let masked_key = if key.chars().count() > 8 {
            format!("••••••••{}", key.chars().skip(key.chars().count() - 4).collect::<String>())
        } else { "••••••••".into() };
        Ok(KeyEntry { id: URL_SAFE_NO_PAD.encode(crypto.encrypt(&token)?), masked_key })
    }).collect()
}

pub fn remove(crypto: &CryptoService, provider: &str, keys: &mut Vec<String>, id: &str) -> Result<(), PebbleError> {
    let invalid = || PebbleError::Validation("此 API 配置已变更，请重新展开列表后再删除。".into());
    if id.is_empty() || id.len() > 16_384 { return Err(invalid()); }
    let encrypted = URL_SAFE_NO_PAD.decode(id).map_err(|_| invalid())?;
    let plaintext = crypto.decrypt(&encrypted).map_err(|_| invalid())?;
    let token: KeyToken = serde_json::from_slice(&plaintext).map_err(|_| invalid())?;
    if token.purpose != PURPOSE || token.provider != provider { return Err(invalid()); }
    let index = keys.iter().position(|key| key == &token.key).ok_or_else(invalid)?;
    keys.remove(index);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (CryptoService, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!("pebble-key-list-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("portable-key"), format!("PEBBLE-PORTABLE-KEY-V1\n{}\n", "01".repeat(32))).unwrap();
        (CryptoService::init_for_profile(&path).unwrap(), path)
    }

    #[test]
    fn tokens_delete_exactly_one_key_even_with_equal_masked_suffixes() {
        let (crypto, path) = fixture();
        let mut keys = vec!["anonymous-first-1234".into(), "anonymous-second-1234".into(), "tiny".into()];
        let rows = entries(&crypto, "tavily", &keys).unwrap();
        assert_eq!(rows[0].masked_key, rows[1].masked_key);
        assert_ne!(rows[0].id, rows[1].id);
        assert_eq!(rows[2].masked_key, "••••••••");
        let json = serde_json::to_string(&rows).unwrap();
        assert!(!json.contains("anonymous-first"));
        assert!(!json.contains("tiny"));
        let original = keys.clone();
        assert!(remove(&crypto, "brave", &mut keys, &rows[1].id).is_err());
        assert!(remove(&crypto, "tavily", &mut keys, "").is_err());
        assert!(remove(&crypto, "tavily", &mut keys, "forged-token").is_err());
        assert_eq!(keys, original);
        remove(&crypto, "tavily", &mut keys, &rows[1].id).unwrap();
        assert_eq!(keys, vec![original[0].clone(), original[2].clone()]);
        assert!(remove(&crypto, "tavily", &mut keys, &rows[1].id).is_err());
        // Tokens remain valid after deletion/reordering of a different row.
        remove(&crypto, "tavily", &mut keys, &rows[0].id).unwrap();
        assert_eq!(keys, vec!["tiny"]);
        std::fs::remove_file(path.join("portable-key")).unwrap();
        std::fs::remove_dir(path).unwrap();
    }
}
