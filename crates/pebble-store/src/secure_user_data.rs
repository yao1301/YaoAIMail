use crate::Store;
use pebble_core::Result;
use rusqlite::{params, OptionalExtension};

impl Store {
    /// Save related encrypted settings together; None removes a key.
    pub fn set_secure_user_data_batch(&self, entries: &[(&str, Option<&[u8]>)]) -> Result<()> {
        self.with_write(|conn| {
            let tx = conn.unchecked_transaction()?;
            let now = pebble_core::now_timestamp();
            for (key, value) in entries {
                if let Some(value) = value {
                    tx.execute("INSERT INTO secure_user_data(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", params![key,value,now])?;
                } else {
                    tx.execute("DELETE FROM secure_user_data WHERE key=?1", [key])?;
                }
            }
            tx.commit()?;
            Ok(())
        })
    }

    pub fn get_secure_user_data(&self, key: &str) -> Result<Option<Vec<u8>>> {
        self.with_read(|conn| {
            conn.query_row(
                "SELECT value FROM secure_user_data WHERE key = ?1",
                params![key],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()
            .map_err(Into::into)
        })
    }

    pub fn set_secure_user_data(&self, key: &str, value: &[u8]) -> Result<()> {
        self.with_write(|conn| {
            conn.execute(
                "INSERT INTO secure_user_data (key, value, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET
                     value = excluded.value,
                     updated_at = excluded.updated_at",
                params![key, value, pebble_core::now_timestamp()],
            )?;
            Ok(())
        })
    }

    pub fn delete_secure_user_data(&self, key: &str) -> Result<()> {
        self.with_write(|conn| {
            conn.execute("DELETE FROM secure_user_data WHERE key = ?1", params![key])?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn related_secure_settings_are_atomic_on_failure_and_support_removal() {
        let store=Store::open_in_memory().unwrap();
        store.set_secure_user_data("one",b"original").unwrap();
        store.with_write(|conn| { conn.execute_batch("CREATE TRIGGER reject_fixture BEFORE INSERT ON secure_user_data WHEN NEW.key='reject' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;")?; Ok(()) }).unwrap();
        assert!(store.set_secure_user_data_batch(&[("one",Some(b"changed")),("reject",Some(b"bad"))]).is_err());
        assert_eq!(store.get_secure_user_data("one").unwrap().unwrap(),b"original");
        store.set_secure_user_data_batch(&[("one",None),("two",Some(b"new"))]).unwrap();
        assert!(store.get_secure_user_data("one").unwrap().is_none());
        assert_eq!(store.get_secure_user_data("two").unwrap().unwrap(),b"new");
    }

    #[test]
    fn secure_user_data_round_trips_blobs_by_key() {
        let store = Store::open_in_memory().unwrap();

        assert!(store.get_secure_user_data("templates").unwrap().is_none());
        store
            .set_secure_user_data("templates", b"encrypted payload")
            .unwrap();
        assert_eq!(
            store.get_secure_user_data("templates").unwrap().as_deref(),
            Some(&b"encrypted payload"[..]),
        );
        store.delete_secure_user_data("templates").unwrap();
        assert!(store.get_secure_user_data("templates").unwrap().is_none());
    }
}
