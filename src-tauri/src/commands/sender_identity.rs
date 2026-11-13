//! Transport boundaries use the durable queued identity, never a mutable label.
use crate::state::AppState;
use pebble_core::{Account, EmailAddress, Message, PebbleError, ProviderType, Result};
use pebble_store::Store;

pub(crate) fn configured_sender(store: &Store, account: &Account) -> Result<EmailAddress> {
    let from = EmailAddress { address: account.email.clone(), name: Some(store.account_sender_name(&account.id)?) };
    pebble_mail::sender::sender_mailbox(&from)?;
    Ok(from)
}

pub(crate) fn validate_queued_sender(account: &Account, message: &Message) -> Result<()> {
    pebble_mail::sender::validate_queued_identity(&account.id, &account.email, &message.account_id,
        &EmailAddress { address: message.from_address.clone(), name: Some(message.from_name.clone()) })
}

/// Only sends require this check, not normal background mailbox polling.
pub(crate) async fn verify_oauth_sender(state: &AppState, account: &Account) -> Result<()> {
    let provider = match account.provider { ProviderType::Gmail => "gmail", ProviderType::Outlook => "outlook", _ => return Ok(()) };
    let auth = super::oauth::ensure_account_oauth_auth(state, &account.id, provider).await?;
    let network = pebble_oauth::OAuthNetworkConfig { proxy: auth.proxy };
    let (email, _, subject) = tokio::time::timeout(std::time::Duration::from_secs(20), super::oauth::fetch_userinfo(provider, &auth.tokens.access_token, &network))
        .await.map_err(|_| PebbleError::Validation("发送前验证授权邮箱超时，请稍后重试".into()))??;
    if email.trim().is_empty() || !email.trim().eq_ignore_ascii_case(account.email.trim()) {
        return Err(PebbleError::Validation("授权身份与发件账号不一致，请重新授权后再发送".into()));
    }
    state.store.bind_oauth_sender_identity(&account.id, &email, &subject)
}
