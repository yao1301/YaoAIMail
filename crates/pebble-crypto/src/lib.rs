pub mod aes;
pub mod keystore;
pub mod passphrase;

use pebble_core::{PebbleError, Result};
use std::path::Path;
use zeroize::Zeroizing;

const PORTABLE_KEY_FILENAME: &str = "portable-key";
const PORTABLE_KEY_HEADER: &str = "PEBBLE-PORTABLE-KEY-V1";

/// Service that manages encryption/decryption using a DEK from the OS keystore.
pub struct CryptoService {
    dek: Zeroizing<[u8; 32]>,
}

impl CryptoService {
    /// Initialize by loading (or creating) the DEK from the OS credential store.
    pub fn init() -> Result<Self> {
        let dek = keystore::KeyStore::get_or_create_dek()?;
        Ok(Self { dek })
    }

    /// Initialize using a key stored beside a portable profile when present.
    ///
    /// Public/release installations do not contain this file and therefore
    /// continue to use the OS credential store. A portable key is only
    /// created when explicitly requested through PEBBLE_CREATE_PORTABLE_KEY=1.
    pub fn init_for_profile(profile_dir: &Path) -> Result<Self> {
        let portable_key_path = profile_dir.join(PORTABLE_KEY_FILENAME);
        if portable_key_path.is_file() {
            return Ok(Self {
                dek: Zeroizing::new(read_portable_key(&portable_key_path)?),
            });
        }

        let dek = keystore::KeyStore::get_or_create_dek()?;
        if std::env::var("PEBBLE_CREATE_PORTABLE_KEY").as_deref() == Ok("1") {
            write_portable_key(&portable_key_path, &dek)?;
        }

        Ok(Self { dek })
    }

    /// Encrypt plaintext bytes.
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>> {
        aes::encrypt(&self.dek, plaintext)
    }

    /// Decrypt ciphertext bytes.
    pub fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>> {
        aes::decrypt(&self.dek, ciphertext)
    }
}

fn read_portable_key(path: &Path) -> Result<[u8; 32]> {
    let contents = std::fs::read_to_string(path).map_err(|e| {
        PebbleError::Auth(format!("Failed to read portable encryption key: {e}"))
    })?;
    let mut lines = contents.lines();
    if lines.next() != Some(PORTABLE_KEY_HEADER) {
        return Err(PebbleError::Auth(
            "Unsupported portable encryption key format".to_string(),
        ));
    }
    let encoded = lines.next().unwrap_or_default().trim();
    if lines.next().is_some() || encoded.len() != 64 {
        return Err(PebbleError::Auth(
            "Invalid portable encryption key".to_string(),
        ));
    }
    decode_hex_key(encoded)
}

fn write_portable_key(path: &Path, key: &[u8; 32]) -> Result<()> {
    let temporary_path = path.with_extension(format!("tmp-{}", std::process::id()));
    let contents = format!("{PORTABLE_KEY_HEADER}\n{}\n", encode_hex_key(key));
    std::fs::write(&temporary_path, contents).map_err(|e| {
        PebbleError::Auth(format!("Failed to write portable encryption key: {e}"))
    })?;
    if let Err(error) = std::fs::rename(&temporary_path, path) {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(PebbleError::Auth(format!(
            "Failed to finalize portable encryption key: {error}"
        )));
    }
    Ok(())
}

fn encode_hex_key(key: &[u8; 32]) -> String {
    let mut encoded = String::with_capacity(64);
    for byte in key {
        use std::fmt::Write;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn decode_hex_key(encoded: &str) -> Result<[u8; 32]> {
    let bytes = encoded.as_bytes();
    let mut key = [0u8; 32];
    for (index, slot) in key.iter_mut().enumerate() {
        let high = hex_value(bytes[index * 2]).ok_or_else(|| {
            PebbleError::Auth("Invalid portable encryption key".to_string())
        })?;
        let low = hex_value(bytes[index * 2 + 1]).ok_or_else(|| {
            PebbleError::Auth("Invalid portable encryption key".to_string())
        })?;
        *slot = (high << 4) | low;
    }
    Ok(key)
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passphrase_encrypted_blob_round_trips() {
        let plaintext = br#"{"accounts":[{"id":"a1","password":"secret"}]}"#;

        let encrypted =
            passphrase::encrypt_with_passphrase(plaintext, "correct horse battery staple").unwrap();
        let decrypted =
            passphrase::decrypt_with_passphrase(&encrypted, "correct horse battery staple")
                .unwrap();

        assert_eq!(decrypted, plaintext);
        assert_ne!(encrypted.ciphertext_hex, String::from_utf8_lossy(plaintext));
    }

    #[test]
    fn passphrase_encrypted_blob_rejects_wrong_passphrase() {
        let encrypted = passphrase::encrypt_with_passphrase(b"secret", "right passphrase").unwrap();

        let err = passphrase::decrypt_with_passphrase(&encrypted, "wrong passphrase")
            .unwrap_err()
            .to_string();

        assert!(err.contains("Decryption failed"));
    }

    #[test]
    fn passphrase_encrypted_blob_rejects_empty_passphrase() {
        let err = passphrase::encrypt_with_passphrase(b"secret", "")
            .unwrap_err()
            .to_string();

        assert!(err.contains("passphrase is required"));
    }

    #[test]
    fn passphrase_encrypted_blob_rejects_unsupported_iterations_before_decrypting() {
        let mut encrypted =
            passphrase::encrypt_with_passphrase(b"secret", "right passphrase").unwrap();
        encrypted.iterations = 1;

        let err = passphrase::decrypt_with_passphrase(&encrypted, "right passphrase")
            .unwrap_err()
            .to_string();

        assert!(err.contains("Unsupported backup secret KDF iterations"));
    }

    #[test]
    fn portable_key_encoding_round_trips() {
        let key = [0x00, 0x01, 0x0a, 0xff, 0x42, 0x7f, 0x80, 0xfe, 0x11, 0x22, 0x33,
            0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x12,
            0x23, 0x34, 0x45, 0x56, 0x67, 0x78, 0x89, 0x9a, 0xab];
        let encoded = encode_hex_key(&key);
        assert_eq!(decode_hex_key(&encoded).unwrap(), key);
    }

    #[test]
    fn portable_key_parser_rejects_wrong_header() {
        let path = std::env::temp_dir().join(format!(
            "pebble-portable-key-test-{}",
            std::process::id()
        ));
        std::fs::write(&path, "wrong-header\n00\n").unwrap();
        let error = read_portable_key(&path).unwrap_err().to_string();
        let _ = std::fs::remove_file(&path);
        assert!(error.contains("Unsupported portable encryption key format"));
    }

    #[test]
    #[ignore] // Requires OS credential store access
    fn test_crypto_service_init() {
        let service = CryptoService::init();
        assert!(service.is_ok());
    }

    #[test]
    #[ignore] // Requires OS credential store access
    fn test_crypto_service_round_trip() {
        let service = CryptoService::init().unwrap();
        let plaintext = b"test credentials json";
        let encrypted = service.encrypt(plaintext).unwrap();
        let decrypted = service.decrypt(&encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }
}
