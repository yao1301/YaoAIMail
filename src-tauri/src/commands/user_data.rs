use crate::state::AppState;
use pebble_core::{new_id, now_timestamp, PebbleError};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

const EMAIL_TEMPLATES_KEY: &str = "email_templates";
const EMAIL_SIGNATURES_KEY: &str = "email_signatures";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmailTemplate {
    pub id: String,
    pub name: String,
    pub subject: String,
    pub body: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmailSignature {
    pub id: String,
    pub name: String,
    pub content: String,
    /// Computed on read; not authoritative in storage.
    #[serde(default)]
    pub is_default: bool,
}

/// Per-account signatures (a mailbox can hold multiple named signatures).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountSignatures {
    pub signatures: Vec<EmailSignature>,
    pub default_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveEmailTemplateRequest {
    pub name: String,
    pub subject: String,
    pub body: String,
}

fn decrypt_json<T: DeserializeOwned>(
    state: &AppState,
    key: &str,
) -> Result<Option<T>, PebbleError> {
    let Some(encrypted) = state.store.get_secure_user_data(key)? else {
        return Ok(None);
    };
    let decrypted = state.crypto.decrypt(&encrypted)?;
    serde_json::from_slice(&decrypted)
        .map(Some)
        .map_err(|e| PebbleError::Internal(format!("Invalid secure user data for {key}: {e}")))
}

fn encrypt_json<T: Serialize>(state: &AppState, key: &str, value: &T) -> Result<(), PebbleError> {
    let plaintext = serde_json::to_vec(value)
        .map_err(|e| PebbleError::Internal(format!("Failed to serialize secure user data: {e}")))?;
    let encrypted = state.crypto.encrypt(&plaintext)?;
    state.store.set_secure_user_data(key, &encrypted)
}

fn normalize_template_input(input: SaveEmailTemplateRequest) -> SaveEmailTemplateRequest {
    SaveEmailTemplateRequest {
        name: input.name.trim().to_string(),
        subject: input.subject,
        body: input.body,
    }
}

#[tauri::command]
pub async fn list_email_templates(
    state: State<'_, AppState>,
) -> Result<Vec<EmailTemplate>, PebbleError> {
    Ok(decrypt_json(&state, EMAIL_TEMPLATES_KEY)?.unwrap_or_default())
}

#[tauri::command]
pub async fn save_email_template(
    state: State<'_, AppState>,
    template: SaveEmailTemplateRequest,
) -> Result<EmailTemplate, PebbleError> {
    let template = normalize_template_input(template);
    if template.name.is_empty() {
        return Err(PebbleError::Validation(
            "Template name cannot be empty".to_string(),
        ));
    }

    let mut templates: Vec<EmailTemplate> =
        decrypt_json(&state, EMAIL_TEMPLATES_KEY)?.unwrap_or_default();
    let saved = EmailTemplate {
        id: new_id(),
        name: template.name,
        subject: template.subject,
        body: template.body,
        created_at: now_timestamp(),
    };
    templates.push(saved.clone());
    encrypt_json(&state, EMAIL_TEMPLATES_KEY, &templates)?;
    Ok(saved)
}

#[tauri::command]
pub async fn delete_email_template(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), PebbleError> {
    let mut templates: Vec<EmailTemplate> =
        decrypt_json(&state, EMAIL_TEMPLATES_KEY)?.unwrap_or_default();
    templates.retain(|template| template.id != id);
    encrypt_json(&state, EMAIL_TEMPLATES_KEY, &templates)
}

/// Load per-account signatures. Migrates the legacy flat map
/// (`account_id -> content`) to the multi-signature format automatically.
fn load_email_signatures(
    state: &AppState,
) -> Result<HashMap<String, AccountSignatures>, PebbleError> {
    let Some(encrypted) = state.store.get_secure_user_data(EMAIL_SIGNATURES_KEY)? else {
        return Ok(HashMap::new());
    };
    let decrypted = state.crypto.decrypt(&encrypted)?;
    // New format first.
    if let Ok(map) = serde_json::from_slice::<HashMap<String, AccountSignatures>>(&decrypted) {
        return Ok(map);
    }
    // Legacy format: { account_id: content } -> migrate to a single default signature.
    if let Ok(legacy) = serde_json::from_slice::<HashMap<String, String>>(&decrypted) {
        let mut map: HashMap<String, AccountSignatures> = HashMap::new();
        for (account_id, content) in legacy {
            if content.trim().is_empty() {
                continue;
            }
            let signature = EmailSignature {
                id: new_id(),
                name: "默认签名".to_string(),
                content,
                is_default: false,
            };
            map.insert(
                account_id,
                AccountSignatures {
                    signatures: vec![signature.clone()],
                    default_id: Some(signature.id),
                },
            );
        }
        return Ok(map);
    }
    Ok(HashMap::new())
}

fn save_email_signatures(
    state: &AppState,
    map: &HashMap<String, AccountSignatures>,
) -> Result<(), PebbleError> {
    if map.is_empty() {
        state.store.delete_secure_user_data(EMAIL_SIGNATURES_KEY)
    } else {
        encrypt_json(state, EMAIL_SIGNATURES_KEY, map)
    }
}

fn default_signature_content(
    map: &HashMap<String, AccountSignatures>,
    account_id: &str,
) -> String {
    let Some(account) = map.get(account_id) else {
        return String::new();
    };
    let Some(default_id) = &account.default_id else {
        return String::new();
    };
    account
        .signatures
        .iter()
        .find(|signature| &signature.id == default_id)
        .map(|signature| signature.content.clone())
        .unwrap_or_default()
}

fn decorated_signatures(
    account: &AccountSignatures,
) -> Vec<EmailSignature> {
    let mut list = account.signatures.clone();
    for signature in list.iter_mut() {
        signature.is_default =
            account.default_id.as_deref() == Some(signature.id.as_str());
    }
    list
}

#[tauri::command]
pub async fn get_email_signature(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<String, PebbleError> {
    let map = load_email_signatures(&state)?;
    Ok(default_signature_content(&map, &account_id))
}

#[tauri::command]
pub async fn set_email_signature(
    state: State<'_, AppState>,
    account_id: String,
    signature: String,
) -> Result<(), PebbleError> {
    let mut map = load_email_signatures(&state)?;
    if signature.trim().is_empty() {
        map.remove(&account_id);
    } else {
        let item = EmailSignature {
            id: new_id(),
            name: "默认签名".to_string(),
            content: signature,
            is_default: false,
        };
        map.insert(
            account_id,
            AccountSignatures {
                signatures: vec![item.clone()],
                default_id: Some(item.id),
            },
        );
    }
    save_email_signatures(&state, &map)
}

#[tauri::command]
pub async fn list_email_signatures(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<Vec<EmailSignature>, PebbleError> {
    let map = load_email_signatures(&state)?;
    Ok(map
        .get(&account_id)
        .map(decorated_signatures)
        .unwrap_or_default())
}

#[tauri::command]
pub async fn save_email_signature(
    state: State<'_, AppState>,
    account_id: String,
    signature_id: Option<String>,
    name: String,
    content: String,
) -> Result<Vec<EmailSignature>, PebbleError> {
    if name.trim().is_empty() {
        return Err(PebbleError::Validation(
            "Signature name cannot be empty".to_string(),
        ));
    }
    let mut map = load_email_signatures(&state)?;
    let account = map.entry(account_id).or_insert(AccountSignatures {
        signatures: Vec::new(),
        default_id: None,
    });
    match signature_id {
        Some(id) => {
            let signature = account
                .signatures
                .iter_mut()
                .find(|signature| signature.id == id)
                .ok_or_else(|| PebbleError::Validation("Signature not found".to_string()))?;
            signature.name = name.trim().to_string();
            signature.content = content;
        }
        None => {
            let signature = EmailSignature {
                id: new_id(),
                name: name.trim().to_string(),
                content,
                is_default: false,
            };
            if account.default_id.is_none() {
                account.default_id = Some(signature.id.clone());
            }
            account.signatures.push(signature);
        }
    }
    let result = decorated_signatures(account);
    save_email_signatures(&state, &map)?;
    Ok(result)
}

#[tauri::command]
pub async fn delete_email_signature(
    state: State<'_, AppState>,
    account_id: String,
    signature_id: String,
) -> Result<Vec<EmailSignature>, PebbleError> {
    let mut map = load_email_signatures(&state)?;
    let Some(account) = map.get_mut(&account_id) else {
        return Ok(Vec::new());
    };
    account.signatures.retain(|signature| signature.id != signature_id);
    if account.default_id.as_deref() == Some(signature_id.as_str()) {
        account.default_id = account.signatures.first().map(|signature| signature.id.clone());
    }
    let result = decorated_signatures(account);
    save_email_signatures(&state, &map)?;
    Ok(result)
}

#[tauri::command]
pub async fn set_default_email_signature(
    state: State<'_, AppState>,
    account_id: String,
    signature_id: String,
) -> Result<Vec<EmailSignature>, PebbleError> {
    let mut map = load_email_signatures(&state)?;
    let account = map
        .get_mut(&account_id)
        .ok_or_else(|| PebbleError::Validation("No signatures".to_string()))?;
    if !account.signatures.iter().any(|signature| signature.id == signature_id) {
        return Err(PebbleError::Validation("Signature not found".to_string()));
    }
    account.default_id = Some(signature_id);
    let result = decorated_signatures(account);
    save_email_signatures(&state, &map)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{normalize_template_input, SaveEmailTemplateRequest};

    #[test]
    fn template_names_are_trimmed_before_storage() {
        let normalized = normalize_template_input(SaveEmailTemplateRequest {
            name: "  Intro  ".to_string(),
            subject: "Subject".to_string(),
            body: "Body".to_string(),
        });

        assert_eq!(normalized.name, "Intro");
        assert_eq!(normalized.subject, "Subject");
        assert_eq!(normalized.body, "Body");
    }
}
