use crate::commands::send_guard::{
    delete_stored_contact_role, load_roles, save_roles, set_manual_contact_role, ContactRole,
    RoleSource,
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

fn role_tag(role: &str) -> Option<&'static str> {
    match role {
        "customer" => Some("客户"),
        "supplier" => Some("供应商"),
        "service" => Some("服务商"),
        "neutral" => Some("内部联系人"),
        "unknown" => Some("未分类"),
        _ => None,
    }
}

/// Contact type is a first-class field. Fixed type labels must never also live
/// in the free-form tag list, otherwise a manual role correction can leave a
/// contradictory old tag behind (for example role=supplier + tag=客户).
fn normalize_custom_tags(tags: Vec<String>) -> Vec<String> {
    let fixed = ["客户", "供应商", "服务商", "内部联系人", "未分类"];
    let mut normalized = Vec::new();
    for tag in tags {
        let tag = tag.trim();
        if tag.is_empty() || fixed.contains(&tag) || normalized.iter().any(|known| known == tag) {
            continue;
        }
        normalized.push(tag.to_string());
    }
    normalized
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
    let mut roles = load_roles(&state);
    let mut contacts_changed = false;
    let mut roles_changed = false;

    // Older builds appended a fixed role tag and then used the manual-save
    // path, accidentally making automatic guesses permanent. A matching fixed
    // tag identifies those records; restore them to stale inferred results so
    // the next one-click recognition can reassess the correspondence.
    for contact in &contacts {
        let Some(expected_tag) = role_tag(&contact.role) else { continue };
        if !contact.tags.iter().any(|tag| tag.trim() == expected_tag) {
            continue;
        }
        if let Some(entry) = roles.iter_mut().find(|entry| {
            entry.email.eq_ignore_ascii_case(&contact.email)
                && entry.source == RoleSource::Manual
                && entry.role.as_str() == contact.role
        }) {
            entry.source = RoleSource::Inferred;
            entry.confidence = 0.0;
            entry.inferred_at = 0;
            entry.reasons = vec!["旧版自动识别结果，等待按往来邮件重新核验".to_string()];
            roles_changed = true;
        }
    }

    for contact in &mut contacts {
        let old_tags = std::mem::take(&mut contact.tags);
        let normalized = normalize_custom_tags(old_tags.clone());
        if normalized != old_tags {
            contacts_changed = true;
        }
        contact.tags = normalized;
    }
    if contacts_changed {
        save_contacts(&state, &contacts)?;
    }
    if roles_changed {
        save_roles(&state, &roles)?;
    }
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
    let existing_contact = contacts.iter().find(|contact| contact.id == id).cloned();
    let stored_roles = load_roles(&state);
    let stored_role = stored_roles.iter().find(|entry| {
        entry.email.eq_ignore_ascii_case(&email)
            || existing_contact
                .as_ref()
                .is_some_and(|contact| entry.email.eq_ignore_ascii_case(&contact.email))
    });
    let classification_changed = match existing_contact.as_ref() {
        None => true,
        Some(existing) => {
            !existing.email.eq_ignore_ascii_case(&email)
                || stored_role.is_none()
                || stored_role.is_some_and(|entry| entry.role.as_str() != role)
        }
    };
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
        tags: normalize_custom_tags(input.tags.unwrap_or_default()),
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
    // Editing a name, note, account or custom tag must not silently turn the
    // current AI result into a permanent manual override. Only a new contact or
    // a real classification change is an explicit manual judgment.
    if classification_changed {
        set_manual_contact_role(&state, &email, parse_role(&role))?;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_role_labels_are_removed_from_custom_tags() {
        assert_eq!(
            normalize_custom_tags(vec![
                "客户".into(),
                " 重点跟进 ".into(),
                "供应商".into(),
                "重点跟进".into(),
            ]),
            vec!["重点跟进"]
        );
    }
}
