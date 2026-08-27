use crate::state::AppState;
use pebble_core::{new_id, now_timestamp, PebbleError, Rule};
use pebble_rules::types::RuleAction;
use pebble_rules::{RuleEngine, RuleTrigger};
use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

/// 后台执行的分批大小：每批取 100 封评估+应用动作，批间让出数据库写连接
/// （避免与正文下载 backfill 抢唯一的 SQLite 写连接导致界面卡顿）。
const APPLY_RULES_BATCH: u32 = 100;
/// 批间让出时长（毫秒）。
const APPLY_RULES_YIELD_MS: u64 = 30;

#[tauri::command]
pub async fn create_rule(
    state: State<'_, AppState>,
    rule: Rule,
) -> std::result::Result<Rule, PebbleError> {
    let now = now_timestamp();
    let rule = Rule {
        id: new_id(),
        is_enabled: rule.is_enabled,
        created_at: now,
        updated_at: now,
        ..rule
    };
    state.store.insert_rule(&rule)?;
    Ok(rule)
}

#[tauri::command]
pub async fn list_rules(
    state: State<'_, AppState>,
    account_id: String,
) -> std::result::Result<Vec<Rule>, PebbleError> {
    state.store.list_rules(&account_id)
}

#[tauri::command]
pub async fn update_rule(
    state: State<'_, AppState>,
    rule: Rule,
) -> std::result::Result<(), PebbleError> {
    state.store.update_rule(&rule)
}

#[tauri::command]
pub async fn delete_rule(
    state: State<'_, AppState>,
    rule_id: String,
) -> std::result::Result<(), PebbleError> {
    state.store.delete_rule(&rule_id)
}

/// 手动执行规则：对指定账号/文件夹下的每封邮件评估规则并应用动作，
/// 用于"规则设定好之后点执行按钮套用现有邮件"。返回报告。
#[derive(Debug, Clone, Serialize)]
pub struct ApplyRulesReport {
    pub processed: u32,
    pub matched: u32,
    pub actions_applied: u32,
    pub errors: Vec<ApplyRulesError>,
    pub matched_messages: Vec<MatchedMessage>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApplyRulesError {
    pub message_id: String,
    pub subject: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MatchedMessage {
    pub message_id: String,
    pub subject: String,
    pub from_address: String,
    pub rule_names: Vec<String>,
}

#[tauri::command]
pub async fn apply_rules_to_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    account_id: String,
    folder_id: String,
    // 指定要执行的规则 ID 列表；None 或空数组表示该账号下所有启用的规则。
    rule_ids: Option<Vec<String>>,
) -> std::result::Result<(), PebbleError> {
    let store = state.store.clone();
    // 立即返回，实际执行放到后台分批任务，避免长时间占用前端调用（弹窗"一直执行中"）。
    // 进度与完成通过事件 rules:apply-progress / rules:apply-done 推送给前端。
    let app_emit = app.clone();
    std::thread::spawn(move || {
        let result = (|| -> std::result::Result<ApplyRulesReport, PebbleError> {
            // 从 folder_id 反查真实所属账号，再加载该账号规则——避免前端选错账号导致
            // 整个 RSG 规则被 account_id 过滤掉、processed=0 误导用户。如果前端传了
            // account_id 但和 folder 所属账号不一致，给出明确警告而非静默 0。
            let folder = store.get_folder(&folder_id)?;
            let resolved_account_id = folder
                .as_ref()
                .map(|f| f.account_id.clone())
                .unwrap_or_else(|| account_id.clone());
            if !account_id.is_empty()
                && folder.is_some()
                && !folder.as_ref().unwrap().account_id.is_empty()
                && account_id != resolved_account_id
            {
                tracing::warn!(
                    "apply_rules_to_folder: frontend account_id={account_id} but folder belongs to {resolved_account_id}; using folder account"
                );
            }
            tracing::info!(
                "apply_rules_to_folder: account_id={resolved_account_id} (frontend={account_id}) folder_id={folder_id} rule_ids_filter={:?}",
                rule_ids
            );
            let mut all_rules = store.list_rules(&resolved_account_id)?;
            tracing::info!("apply_rules_to_folder: loaded {} rules for account", all_rules.len());
            if let Some(ids) = rule_ids.filter(|ids| !ids.is_empty()) {
                all_rules.retain(|rule| ids.contains(&rule.id));
            }
            tracing::info!("apply_rules_to_folder: after rule_ids filter rules={}", all_rules.len());
            if all_rules.is_empty() {
                return Ok(ApplyRulesReport {
                    processed: 0,
                    matched: 0,
                    actions_applied: 0,
                    errors: Vec::new(),
                    matched_messages: Vec::new(),
                });
            }
            let engine = RuleEngine::new(&all_rules);
            let mut processed: u32 = 0;
            let mut matched: u32 = 0;
            let mut actions_applied: u32 = 0;
            let mut errors: Vec<ApplyRulesError> = Vec::new();
            let mut matched_messages: Vec<MatchedMessage> = Vec::new();

            // Snapshot IDs before applying actions. Moving/archiving a message
            // changes the live folder, so OFFSET pagination would skip rows.
            let all_ids = store.list_message_ids_by_folder(&folder_id)?;
            for ids in all_ids.chunks(APPLY_RULES_BATCH as usize) {
                let ids: Vec<String> = ids.to_vec();
                let messages = store.get_messages_batch(&ids)?;
                let mut pending_actions: Vec<(pebble_core::Message, RuleAction)> = Vec::new();
                for message in &messages {
                    processed += 1;
                    let actions = engine.evaluate(message);
                    if actions.is_empty() {
                        continue;
                    }
                    matched += 1;
                    matched_messages.push(MatchedMessage {
                        message_id: message.id.clone(),
                        subject: message.subject.clone(),
                        from_address: message.from_address.clone(),
                        rule_names: Vec::new(),
                    });
                    for action in &actions {
                        pending_actions.push((message.clone(), action.clone()));
                    }
                }
                // Evaluate in memory, then collapse the writes by operation
                // and target. This turns thousands of one-row transactions
                // into a handful of batch transactions for large folders.
                let (batch_applied, batch_errors) =
                    apply_actions_batch(&store, &folder_id, &pending_actions);
                actions_applied += batch_applied;
                errors.extend(batch_errors);
                // 每批后推送一次进度，让界面有反馈；批间短暂让出写连接。
                let _ = app_emit.emit(
                    "rules:apply-progress",
                    serde_json::json!({
                        "processed": processed,
                        "matched": matched,
                        "actions_applied": actions_applied,
                        "phase": "running",
                    }),
                );
                std::thread::sleep(std::time::Duration::from_millis(APPLY_RULES_YIELD_MS));
            }

            Ok(ApplyRulesReport {
                processed,
                matched,
                actions_applied,
                errors,
                matched_messages,
            })
        })();

        match result {
            Ok(report) => {
                tracing::info!(
                    "apply_rules_to_folder: done processed={} matched={} applied={} errors={}",
                    report.processed, report.matched, report.actions_applied, report.errors.len()
                );
                let _ = app_emit.emit(
                    "rules:apply-done",
                    serde_json::json!({
                        "phase": "done",
                        "report": report,
                    }),
                );
            }
            Err(error) => {
                tracing::error!("apply_rules_to_folder failed: {error}");
                let _ = app_emit.emit(
                    "rules:apply-done",
                    serde_json::json!({
                        "phase": "error",
                        "error": error.to_string(),
                    }),
                );
            }
        }
    });
    Ok(())
}

pub(crate) fn apply_actions_batch(
    store: &pebble_store::Store,
    source_folder_id: &str,
    actions: &[(pebble_core::Message, RuleAction)],
) -> (u32, Vec<ApplyRulesError>) {
    let mut applied = 0u32;
    let mut errors = Vec::new();
    let mut mark_read = Vec::new();
    let mut labels: HashMap<String, Vec<String>> = HashMap::new();
    let mut moves: HashMap<String, Vec<String>> = HashMap::new();
    let mut remote_moves: HashMap<String, Vec<pebble_core::Message>> = HashMap::new();
    let mut move_meta: HashMap<String, (String, String)> = HashMap::new();
    let mut move_counts: HashMap<String, usize> = HashMap::new();
    let mut final_moves: HashMap<String, (pebble_core::Message, RuleAction)> = HashMap::new();
    for (message, action) in actions {
        if matches!(action, RuleAction::Archive | RuleAction::MoveToFolder(_)) {
            *move_counts.entry(message.id.clone()).or_default() += 1;
            // If several matching rules move the same message, only the final
            // destination is externally observable. Persist one outbox record
            // from the original source to that final target.
            final_moves.insert(message.id.clone(), (message.clone(), action.clone()));
        }
    }

    for (message, action) in actions {
        match action {
            RuleAction::MarkRead => mark_read.push(message.id.clone()),
            RuleAction::AddLabel(label) => labels.entry(label.clone()).or_default().push(message.id.clone()),
            RuleAction::Archive => match store.find_folder_by_role(&message.account_id, pebble_core::FolderRole::Archive) {
                Ok(Some(folder)) => {
                    if move_counts.get(&message.id).copied().unwrap_or(0) > 1 {
                        continue;
                    }
                    let target_id = folder.id.clone();
                    move_meta.entry(target_id.clone()).or_insert_with(|| (message.id.clone(), message.subject.clone()));
                    moves.entry(target_id.clone()).or_default().push(message.id.clone());
                    remote_moves.entry(target_id).or_default().push(message.clone());
                }
                Ok(None) => errors.push(ApplyRulesError { message_id: message.id.clone(), subject: message.subject.clone(), error: "账号没有 Archive 文件夹".to_string() }),
                Err(error) => errors.push(ApplyRulesError { message_id: message.id.clone(), subject: message.subject.clone(), error: error.to_string() }),
            },
            RuleAction::MoveToFolder(folder_ref) => {
                if move_counts.get(&message.id).copied().unwrap_or(0) > 1 {
                    continue;
                }
                let target = store.get_folder(folder_ref).ok().flatten().or_else(|| store.find_folder_by_name(&message.account_id, folder_ref).ok().flatten());
                match target {
                    Some(folder) => {
                        let target_id = folder.id.clone();
                        move_meta.entry(target_id.clone()).or_insert_with(|| (message.id.clone(), message.subject.clone()));
                        moves.entry(target_id.clone()).or_default().push(message.id.clone());
                        remote_moves.entry(target_id).or_default().push(message.clone());
                    }
                    None => errors.push(ApplyRulesError { message_id: message.id.clone(), subject: message.subject.clone(), error: format!("目标文件夹 '{}' 不存在", folder_ref) }),
                }
            }
            RuleAction::SetKanbanColumn(_) => applied += 1,
        }
    }

    if let Ok(count) = store.update_message_flags_batch(&mark_read, Some(true), None) {
        applied += count;
    } else {
        applied += mark_read.len() as u32;
    }
    for (label, ids) in labels {
        match store.add_label_to_messages_batch(&ids, &label) {
            Ok(count) => applied += count,
            Err(error) => errors.push(ApplyRulesError { message_id: ids.first().cloned().unwrap_or_default(), subject: String::new(), error: error.to_string() }),
        }
    }
    let source_folder = store.get_folder(source_folder_id).ok().flatten();
    for (folder_id, _ids) in moves {
        let messages = remote_moves.remove(&folder_id).unwrap_or_default();
        let target_folder = store.get_folder(&folder_id).ok().flatten();
        let result = match (source_folder.as_ref(), target_folder.as_ref()) {
            (Some(source), Some(target)) => store
                .move_rule_messages_to_folder_with_outbox(&messages, source, target),
            _ => Err(PebbleError::Validation(
                "规则来源文件夹或目标文件夹不存在".to_string(),
            )),
        };
        match result {
            Ok(count) => {
                applied += count;
            }
            Err(error) => {
                let (message_id, subject) = move_meta
                    .get(&folder_id)
                    .cloned()
                    .or_else(|| {
                        messages
                            .first()
                            .map(|message| (message.id.clone(), message.subject.clone()))
                    })
                    .unwrap_or_default();
                errors.push(ApplyRulesError { message_id, subject, error: error.to_string() });
            }
        }
    }
    for (message, action) in final_moves
        .into_values()
        .filter(|(message, _)| move_counts.get(&message.id).copied().unwrap_or(0) > 1)
    {
        let target = match action {
            RuleAction::Archive => store
                .find_folder_by_role(&message.account_id, pebble_core::FolderRole::Archive)
                .ok()
                .flatten(),
            RuleAction::MoveToFolder(folder_ref) => store
                .get_folder(&folder_ref)
                .ok()
                .flatten()
                .or_else(|| {
                    store
                        .find_folder_by_name(&message.account_id, &folder_ref)
                        .ok()
                        .flatten()
                }),
            _ => None,
        };
        let result = match (source_folder.as_ref(), target.as_ref()) {
            (Some(source), Some(target)) => store
                .move_rule_messages_to_folder_with_outbox(
                    std::slice::from_ref(&message),
                    source,
                    target,
                ),
            _ => Err(PebbleError::Validation(
                "规则来源文件夹或最终目标文件夹不存在".to_string(),
            )),
        };
        match result {
            Ok(count) => applied += count,
            Err(error) => errors.push(ApplyRulesError {
                message_id: message.id,
                subject: message.subject,
                error: error.to_string(),
            }),
        }
    }
    (applied, errors)
}

pub(crate) fn apply_rules_to_message_for_trigger(
    store: &pebble_store::Store,
    message: &pebble_core::Message,
    trigger: RuleTrigger,
) -> std::result::Result<u32, PebbleError> {
    let rules = store.list_rules(&message.account_id)?;
    if rules.is_empty() {
        return Ok(0);
    }
    let actions = RuleEngine::new(&rules).evaluate_for_trigger(message, trigger);
    if actions.is_empty() {
        return Ok(0);
    }
    let source_folder_id = store
        .get_message_folder_ids(&message.id)?
        .into_iter()
        .next()
        .ok_or_else(|| PebbleError::Validation("邮件没有来源文件夹，无法执行规则".to_string()))?;
    let pending_actions = actions
        .into_iter()
        .map(|action| (message.clone(), action))
        .collect::<Vec<_>>();
    let (applied, errors) = apply_actions_batch(store, &source_folder_id, &pending_actions);
    if let Some(error) = errors.first() {
        return Err(PebbleError::Internal(format!(
            "发送邮件规则执行失败：{}",
            error.error
        )));
    }
    Ok(applied)
}

#[cfg(test)]
mod trigger_tests {
    use super::*;
    use pebble_core::{
        new_id, now_timestamp, Account, EmailAddress, Folder, FolderRole, FolderType, Message,
        ProviderType, Rule,
    };
    use pebble_store::Store;

    #[test]
    fn on_send_rule_moves_local_sent_copy_without_waiting_for_sync() {
        let store = Store::open_in_memory().unwrap();
        let now = now_timestamp();
        let account = Account {
            id: new_id(),
            email: "sender@example.com".to_string(),
            display_name: "Sender".to_string(),
            color: None,
            provider: ProviderType::Imap,
            created_at: now,
            updated_at: now,
        };
        store.insert_account(&account).unwrap();
        let sent = Folder {
            id: new_id(),
            account_id: account.id.clone(),
            remote_id: "Sent".to_string(),
            name: "Sent".to_string(),
            folder_type: FolderType::Folder,
            role: Some(FolderRole::Sent),
            parent_id: None,
            color: None,
            is_system: true,
            sort_order: 2,
        };
        let target = Folder {
            id: new_id(),
            account_id: account.id.clone(),
            remote_id: "Customers/Watch".to_string(),
            name: "Customer Watch".to_string(),
            folder_type: FolderType::Folder,
            role: None,
            parent_id: None,
            color: None,
            is_system: false,
            sort_order: 10,
        };
        store.insert_folder(&sent).unwrap();
        store.insert_folder(&target).unwrap();
        let message = Message {
            id: new_id(),
            account_id: account.id.clone(),
            remote_id: "local-sent-test".to_string(),
            message_id_header: Some("<sent-test@example.com>".to_string()),
            in_reply_to: None,
            references_header: None,
            thread_id: None,
            subject: "Follow-up".to_string(),
            snippet: "Hello".to_string(),
            from_address: account.email.clone(),
            from_name: account.display_name.clone(),
            to_list: vec![EmailAddress {
                name: None,
                address: "buyer@watch.example".to_string(),
            }],
            cc_list: vec![],
            bcc_list: vec![],
            body_text: "Hello".to_string(),
            body_html_raw: String::new(),
            has_attachments: false,
            is_read: true,
            is_starred: false,
            is_draft: false,
            date: now,
            remote_version: None,
            is_deleted: false,
            deleted_at: None,
            created_at: now,
            updated_at: now,
        };
        store
            .insert_message(&message, std::slice::from_ref(&sent.id))
            .unwrap();
        store
            .insert_rule(&Rule {
                id: new_id(),
                name: "Sent customer filing".to_string(),
                priority: 1,
                conditions: r#"{"operator":"and","conditions":[{"field":"to","op":"contains","value":"watch.example"}]}"#.to_string(),
                actions: format!(r#"[{{"type":"MoveToFolder","value":"{}"}}]"#, target.id),
                is_enabled: true,
                account_id: account.id.clone(),
                trigger_when: r#"["on_send"]"#.to_string(),
                created_at: now,
                updated_at: now,
            })
            .unwrap();

        let applied = apply_rules_to_message_for_trigger(&store, &message, RuleTrigger::Send)
            .unwrap();

        assert_eq!(applied, 1);
        assert_eq!(
            store.get_message_folder_ids(&message.id).unwrap(),
            vec![target.id]
        );
        let pending = store.list_pending_mail_ops(&account.id).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].op_type, "move_to_folder");
    }
}
