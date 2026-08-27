use crate::commands::send_guard::{
    delete_stored_contact_role, load_roles, set_manual_contact_role, ContactRole,
};
use crate::state::AppState;
use pebble_core::{new_id, now_timestamp, PebbleError};
use serde::{Deserialize, Serialize};
use tauri::State;

const ADDRESS_BOOK_KEY: &str = "address_book_contacts_v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressBookContact {
    pub id: String,
    pub email: String,
    pub name: String,
    pub company: String,
    pub job_title: String,
    pub role: String,
    pub notes: String,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// 归属账号（从该账号的往来邮件导入时记录；手动添加为 null = 未归属）
    #[serde(default)]
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressBookContactInput {
    pub id: Option<String>,
    pub email: String,
    pub name: Option<String>,
    pub company: Option<String>,
    pub job_title: Option<String>,
    pub role: Option<String>,
    pub notes: Option<String>,
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub account_id: Option<String>,
}

fn load_contacts(state: &AppState) -> Result<Vec<AddressBookContact>, PebbleError> {
    let Some(encrypted) = state.store.get_secure_user_data(ADDRESS_BOOK_KEY)? else {
        return Ok(Vec::new());
    };
    let plaintext = state.crypto.decrypt(&encrypted)?;
    serde_json::from_slice(&plaintext)
        .map_err(|error| PebbleError::Internal(format!("Invalid address book data: {error}")))
}

fn save_contacts(state: &AppState, contacts: &[AddressBookContact]) -> Result<(), PebbleError> {
    if contacts.is_empty() {
        return state.store.delete_secure_user_data(ADDRESS_BOOK_KEY);
    }
    let plaintext = serde_json::to_vec(contacts)
        .map_err(|error| PebbleError::Internal(format!("Failed to serialize address book: {error}")))?;
    let encrypted = state.crypto.encrypt(&plaintext)?;
    state.store.set_secure_user_data(ADDRESS_BOOK_KEY, &encrypted)
}

fn parse_role(value: &str) -> ContactRole {
    match value {
        "customer" => ContactRole::Customer,
        "supplier" => ContactRole::Supplier,
        "service" => ContactRole::Service,
        "neutral" => ContactRole::Neutral,
        _ => ContactRole::Unknown,
    }
}

#[tauri::command]
pub async fn list_address_book_contacts(
    state: State<'_, AppState>,
) -> Result<Vec<AddressBookContact>, PebbleError> {
    let mut contacts = load_contacts(&state)?;
    let roles = load_roles(&state);
    for contact in &mut contacts {
        if let Some(entry) = roles
            .iter()
            .find(|entry| entry.email.eq_ignore_ascii_case(&contact.email))
        {
            contact.role = entry.role.as_str().to_string();
        }
    }
    contacts.sort_by(|left, right| {
        left.company
            .to_lowercase()
            .cmp(&right.company.to_lowercase())
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.email.to_lowercase().cmp(&right.email.to_lowercase()))
    });
    Ok(contacts)
}

#[tauri::command]
pub async fn save_address_book_contact(
    state: State<'_, AppState>,
    input: AddressBookContactInput,
) -> Result<AddressBookContact, PebbleError> {
    let email = input.email.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') {
        return Err(PebbleError::Validation("请输入有效邮箱地址".to_string()));
    }
    let role = input.role.unwrap_or_else(|| "unknown".to_string());
    let mut contacts = load_contacts(&state)?;
    let now = now_timestamp();
    let id = input
        .id
        .filter(|id| !id.trim().is_empty())
        .or_else(|| {
            contacts
                .iter()
                .find(|contact| contact.email.eq_ignore_ascii_case(&email))
                .map(|contact| contact.id.clone())
        })
        .unwrap_or_else(new_id);
    // 新建联系人必须关联具体账号（"全部账号"只是汇总，不是独立分类）。
    let account_id = input
        .account_id
        .filter(|value| !value.trim().is_empty());
    let existing_account_id = contacts
        .iter()
        .find(|contact| contact.id == id)
        .and_then(|contact| contact.account_id.clone());
    if account_id.is_none() && existing_account_id.is_none() {
        return Err(PebbleError::Validation(
            "请选择该联系人关联的账号（每个邮箱必须归属具体账号）。".to_string(),
        ));
    }
    let mut saved = AddressBookContact {
        id: id.clone(),
        email: email.clone(),
        name: input.name.unwrap_or_default().trim().to_string(),
        company: input.company.unwrap_or_default().trim().to_string(),
        job_title: input.job_title.unwrap_or_default().trim().to_string(),
        role: role.clone(),
        notes: input.notes.unwrap_or_default().trim().to_string(),
        tags: input
            .tags
            .unwrap_or_default()
            .into_iter()
            .map(|tag| tag.trim().to_string())
            .filter(|tag| !tag.is_empty())
            .collect(),
        created_at: now,
        updated_at: now,
        account_id: account_id.clone(),
    };
    if let Some(existing) = contacts.iter_mut().find(|contact| contact.id == id) {
        saved.created_at = existing.created_at;
        // 编辑联系人时不覆盖原有账号归属（除非显式传入新的）
        saved.account_id = saved.account_id.or_else(|| existing.account_id.clone());
        *existing = saved.clone();
    } else {
        contacts.push(saved.clone());
    }
    save_contacts(&state, &contacts)?;
    set_manual_contact_role(&state, &email, parse_role(&role))?;
    Ok(saved)
}

#[tauri::command]
pub async fn delete_address_book_contact(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), PebbleError> {
    let mut contacts = load_contacts(&state)?;
    let deleted_email = contacts
        .iter()
        .find(|contact| contact.id == id)
        .map(|contact| contact.email.clone());
    contacts.retain(|contact| contact.id != id);
    save_contacts(&state, &contacts)?;
    if let Some(email) = deleted_email {
        delete_stored_contact_role(&state, &email)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn import_mail_contacts_to_address_book(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<usize, PebbleError> {
    let known = state.store.list_known_contacts(&account_id, "", 5000)?;
    let mut contacts = load_contacts(&state)?;
    let roles = load_roles(&state);
    let mut added = 0usize;
    let now = now_timestamp();
    for known_contact in known {
        let email = known_contact.address.trim().to_lowercase();
        if email.is_empty()
            || contacts
                .iter()
                .any(|contact| contact.email.eq_ignore_ascii_case(&email))
        {
            continue;
        }
        let role = roles
            .iter()
            .find(|entry| entry.email.eq_ignore_ascii_case(&email))
            .map(|entry| entry.role.as_str().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        contacts.push(AddressBookContact {
            id: new_id(),
            email,
            name: known_contact.name.unwrap_or_default(),
            company: String::new(),
            job_title: String::new(),
            role,
            notes: String::new(),
            tags: Vec::new(),
            created_at: now,
            updated_at: now,
            account_id: Some(account_id.clone()),
        });
        added += 1;
    }
    save_contacts(&state, &contacts)?;
    Ok(added)
}
