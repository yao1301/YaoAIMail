pub mod matcher;
pub mod types;

use matcher::evaluate_conditions;
use pebble_core::{Message, Rule};
use types::{RuleAction, RuleConditionSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleTrigger {
    Receive,
    Send,
}

impl RuleTrigger {
    fn persisted_name(self) -> &'static str {
        match self {
            Self::Receive => "on_receive",
            Self::Send => "on_send",
        }
    }
}

pub struct RuleEngine {
    /// 每条规则带 account_id（用于按账号过滤评估），空字符串 = 适用于所有账号。
    rules: Vec<(String, Vec<String>, RuleConditionSet, Vec<RuleAction>)>,
}

impl RuleEngine {
    pub fn new(rules: &[Rule]) -> Self {
        let mut parsed: Vec<(i32, String, Vec<String>, RuleConditionSet, Vec<RuleAction>)> = rules.iter()
            .filter(|r| r.is_enabled)
            .filter_map(|r| {
                let conditions: RuleConditionSet = match serde_json::from_str(&r.conditions) {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::warn!(rule_name = %r.name, error = %e, "skipping rule: invalid conditions JSON");
                        return None;
                    }
                };
                let actions: Vec<RuleAction> = match serde_json::from_str(&r.actions) {
                    Ok(a) => a,
                    Err(e) => {
                        tracing::warn!(rule_name = %r.name, error = %e, "skipping rule: invalid actions JSON");
                        return None;
                    }
                };
                let mut triggers: Vec<String> = serde_json::from_str(&r.trigger_when)
                    .unwrap_or_default();
                triggers.retain(|trigger| trigger == "on_receive" || trigger == "on_send");
                // V18 以前的规则没有触发时机；界面一直把空值显示为“收取邮件时”。
                if triggers.is_empty() {
                    triggers.push("on_receive".to_string());
                }
                Some((r.priority, r.account_id.clone(), triggers, conditions, actions))
            })
            .collect();
        parsed.sort_by_key(|(p, _, _, _, _)| *p);
        Self {
            rules: parsed
                .into_iter()
                .map(|(_, acc, triggers, c, a)| (acc, triggers, c, a))
                .collect(),
        }
    }

    pub fn rule_count(&self) -> usize {
        self.rules.len()
    }

    pub fn evaluate(&self, message: &Message) -> Vec<RuleAction> {
        self.evaluate_inner(message, None)
    }

    pub fn evaluate_for_trigger(
        &self,
        message: &Message,
        trigger: RuleTrigger,
    ) -> Vec<RuleAction> {
        self.evaluate_inner(message, Some(trigger))
    }

    fn evaluate_inner(
        &self,
        message: &Message,
        trigger: Option<RuleTrigger>,
    ) -> Vec<RuleAction> {
        let mut actions = Vec::new();
        for (rule_account_id, triggers, conditions, rule_actions) in &self.rules {
            // 规则限定到特定账号时，只在该账号的消息上评估。
            if !rule_account_id.is_empty() && *rule_account_id != message.account_id {
                continue;
            }
            if trigger.is_some_and(|trigger| {
                !triggers.iter().any(|value| value == trigger.persisted_name())
            }) {
                continue;
            }
            if evaluate_conditions(message, conditions) {
                actions.extend(rule_actions.iter().cloned());
            }
        }
        actions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_message(from: &str, subject: &str, body: &str) -> Message {
        Message {
            id: String::new(),
            account_id: String::new(),
            remote_id: String::new(),
            message_id_header: None,
            in_reply_to: None,
            references_header: None,
            thread_id: None,
            subject: subject.to_string(),
            snippet: String::new(),
            from_address: from.to_string(),
            from_name: String::new(),
            to_list: vec![],
            cc_list: vec![],
            bcc_list: vec![],
            body_text: body.to_string(),
            body_html_raw: String::new(),
            has_attachments: false,
            is_read: false,
            is_starred: false,
            is_draft: false,
            date: 0,
            remote_version: None,
            is_deleted: false,
            deleted_at: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn make_test_rule(
        name: &str,
        priority: i32,
        conditions_json: &str,
        actions_json: &str,
        enabled: bool,
    ) -> Rule {
        Rule {
            id: "rule-1".to_string(),
            name: name.to_string(),
            priority,
            conditions: conditions_json.to_string(),
            actions: actions_json.to_string(),
            is_enabled: enabled,
            account_id: String::new(),
            trigger_when: "[]".to_string(),
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn test_rule_engine_evaluate() {
        let conditions = r#"{"operator":"and","conditions":[{"field":"from","op":"contains","value":"newsletter"}]}"#;
        let actions = r#"[{"type":"AddLabel","value":"newsletters"},{"type":"MarkRead"}]"#;
        let rule = make_test_rule("Label newsletters", 1, conditions, actions, true);

        let engine = RuleEngine::new(&[rule]);
        let msg = make_test_message("newsletter@example.com", "Weekly Update", "Content");
        let result = engine.evaluate(&msg);

        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_disabled_rules_skipped() {
        let conditions = r#"{"operator":"and","conditions":[{"field":"from","op":"contains","value":"newsletter"}]}"#;
        let actions = r#"[{"type":"AddLabel","value":"newsletters"}]"#;
        let rule = make_test_rule("Disabled rule", 1, conditions, actions, false);

        let engine = RuleEngine::new(&[rule]);
        let msg = make_test_message("newsletter@example.com", "Weekly Update", "Content");
        let result = engine.evaluate(&msg);

        assert!(result.is_empty());
    }

    #[test]
    fn trigger_specific_evaluation_separates_receive_and_send_rules() {
        let conditions = r#"{"operator":"and","conditions":[{"field":"to","op":"contains","value":"buyer"}]}"#;
        let mut receive = make_test_rule(
            "Receive",
            1,
            conditions,
            r#"[{"type":"AddLabel","value":"received"}]"#,
            true,
        );
        receive.trigger_when = r#"["on_receive"]"#.to_string();
        let mut send = make_test_rule(
            "Send",
            2,
            conditions,
            r#"[{"type":"AddLabel","value":"sent"}]"#,
            true,
        );
        send.trigger_when = r#"["on_send"]"#.to_string();
        let mut message = make_test_message("sender@example.com", "Hello", "Body");
        message.to_list = vec![pebble_core::EmailAddress {
            name: None,
            address: "buyer@example.com".to_string(),
        }];
        let engine = RuleEngine::new(&[receive, send]);

        assert_eq!(engine.evaluate_for_trigger(&message, RuleTrigger::Receive).len(), 1);
        assert_eq!(engine.evaluate_for_trigger(&message, RuleTrigger::Send).len(), 1);
        assert_eq!(engine.evaluate(&message).len(), 2);
    }

    #[test]
    fn legacy_empty_trigger_defaults_to_receive() {
        let rule = make_test_rule(
            "Legacy",
            1,
            r#"{"operator":"and","conditions":[]}"#,
            r#"[{"type":"MarkRead"}]"#,
            true,
        );
        let engine = RuleEngine::new(&[rule]);
        let message = make_test_message("sender@example.com", "Hello", "Body");

        assert_eq!(engine.evaluate_for_trigger(&message, RuleTrigger::Receive).len(), 1);
        assert!(engine.evaluate_for_trigger(&message, RuleTrigger::Send).is_empty());
    }
}
