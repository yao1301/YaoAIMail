import { useCallback, useSyncExternalStore } from "react";
import { profileLocalStorage, subscribeProfileLocalStorage } from "./profileStorage";

export const SETTINGS_CHANGE_KEYS = {
  accounts: "pebble-settings-revision:accounts",
  folders: "pebble-settings-revision:folders",
  rules: "pebble-settings-revision:rules",
  trustedSenders: "pebble-settings-revision:trusted-senders",
  restore: "pebble-settings-revision:restore",
} as const;

type Change = keyof typeof SETTINGS_CHANGE_KEYS;
const changesByCommand = new Map<string, Change>([
  ["add_account", "accounts"],
  ["update_account", "accounts"],
  ["delete_account", "accounts"],
  ["complete_oauth_flow", "accounts"],
  ["update_imap_sync_folders", "folders"],
  ["create_rule", "rules"],
  ["update_rule", "rules"],
  ["delete_rule", "rules"],
  ["trust_sender", "trustedSenders"],
  ["remove_trusted_sender", "trustedSenders"],
  ["import_backup_file", "restore"],
  ["restore_from_webdav", "restore"],
]);

export function announceSavedSettings(command: string) {
  const change = changesByCommand.get(command);
  if (!change) return;
  try {
    // Only a revision marker travels. Other windows fetch their own data.
    profileLocalStorage.setItem(SETTINGS_CHANGE_KEYS[change], crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
  } catch {
    // A notification failure must not report an already-saved operation as failed.
  }
}

export function useSavedSettingsRevision(change: Change) {
  const key = SETTINGS_CHANGE_KEYS[change];
  const subscribe = useCallback((listener: () => void) =>
    subscribeProfileLocalStorage((changed) => {
      if (changed === null || changed === key || changed === SETTINGS_CHANGE_KEYS.restore) listener();
    }), [key]);
  const getSnapshot = useCallback(() => {
    const revision = profileLocalStorage.getItem(key) ?? "";
    const restore = profileLocalStorage.getItem(SETTINGS_CHANGE_KEYS.restore) ?? "";
    return `${revision}:${restore}`;
  }, [key]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
