use pebble_core::{Result, Rule};
use rusqlite::params;

use crate::Store;

fn row_to_rule(row: &rusqlite::Row) -> rusqlite::Result<Rule> {
    let is_enabled: i32 = row.get(5)?;
    // V18 migration 启动时已加 account_id/trigger_when 列（迁移先于 list_rules 执行），
    // 直接 get 即可，不存在兼容老 schema 的场景。
    let account_id: String = row.get(8)?;
    let trigger_when: String = row.get(9)?;
    Ok(Rule {
        id: row.get(0)?,
        name: row.get(1)?,
        priority: row.get(2)?,
        conditions: row.get(3)?,
        actions: row.get(4)?,
        is_enabled: is_enabled != 0,
        account_id,
        trigger_when,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

impl Store {
    pub fn insert_rule(&self, rule: &Rule) -> Result<()> {
        self.with_write(|conn| {
            conn.execute(
                "INSERT INTO rules (id, name, priority, conditions, actions, is_enabled, created_at, updated_at, account_id, trigger_when)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    rule.id,
                    rule.name,
                    rule.priority,
                    rule.conditions,
                    rule.actions,
                    rule.is_enabled as i32,
                    rule.created_at,
                    rule.updated_at,
                    rule.account_id,
                    rule.trigger_when,
                ],
            )?;
            Ok(())
        })
    }

    /// 列出账号下的规则：返回 account_id 匹配的 + account_id 为空（适用于所有账号）的规则。
    pub fn list_rules(&self, account_id: &str) -> Result<Vec<Rule>> {
        self.with_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, priority, conditions, actions, is_enabled, created_at, updated_at, account_id, trigger_when
                     FROM rules
                     WHERE account_id = ?1 OR account_id = '' OR account_id IS NULL
                     ORDER BY priority ASC",
            )?;
            let rows = stmt.query_map(params![account_id], row_to_rule)?;
            let mut rules = Vec::new();
            for row in rows {
                rules.push(row?);
            }
            Ok(rules)
        })
    }

    pub fn update_rule(&self, rule: &Rule) -> Result<()> {
        self.with_write(|conn| {
            conn.execute(
                "UPDATE rules SET name = ?1, priority = ?2, conditions = ?3, actions = ?4,
                 is_enabled = ?5, updated_at = ?6, account_id = ?7, trigger_when = ?8
                 WHERE id = ?9",
                params![
                    rule.name,
                    rule.priority,
                    rule.conditions,
                    rule.actions,
                    rule.is_enabled as i32,
                    rule.updated_at,
                    rule.account_id,
                    rule.trigger_when,
                    rule.id,
                ],
            )?;
            Ok(())
        })
    }

    pub fn delete_rule(&self, id: &str) -> Result<()> {
        self.with_write(|conn| {
            conn.execute("DELETE FROM rules WHERE id = ?1", params![id])?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;

    #[test]
    fn test_rule_crud() {
        let store = Store::open_in_memory().unwrap();
        let now = pebble_core::now_timestamp();

        let rule = Rule {
            id: pebble_core::new_id(),
            name: "Auto-archive".to_string(),
            priority: 10,
            conditions: r#"{"from": "noreply@example.com"}"#.to_string(),
            actions: r#"["archive"]"#.to_string(),
            is_enabled: true,
            account_id: String::new(),
            trigger_when: "[]".to_string(),
            created_at: now,
            updated_at: now,
        };
        store.insert_rule(&rule).unwrap();

        let rules = store.list_rules("").unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].name, "Auto-archive");
        assert!(rules[0].is_enabled);

        // Insert a second rule with higher priority (lower number = higher priority)
        let rule2 = Rule {
            id: pebble_core::new_id(),
            name: "Urgent".to_string(),
            priority: 1,
            conditions: r#"{"subject": "URGENT"}"#.to_string(),
            actions: r#"["star"]"#.to_string(),
            is_enabled: true,
            account_id: String::new(),
            trigger_when: "[]".to_string(),
            created_at: now,
            updated_at: now,
        };
        store.insert_rule(&rule2).unwrap();

        let rules = store.list_rules("").unwrap();
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].name, "Urgent"); // priority 1 first
        assert_eq!(rules[1].name, "Auto-archive"); // priority 10 second

        // Update
        let mut updated = rule.clone();
        updated.name = "Auto-archive v2".to_string();
        updated.is_enabled = false;
        updated.updated_at = now + 1;
        store.update_rule(&updated).unwrap();

        let rules = store.list_rules("").unwrap();
        let found = rules.iter().find(|r| r.id == rule.id).unwrap();
        assert_eq!(found.name, "Auto-archive v2");
        assert!(!found.is_enabled);

        // Delete
        store.delete_rule(&rule.id).unwrap();
        let rules = store.list_rules("").unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].name, "Urgent");
    }
}
