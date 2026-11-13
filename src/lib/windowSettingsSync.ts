import { subscribeProfileLocalStorage } from "./profileStorage";
import { queryClient } from "./query-client";
import { SETTINGS_CHANGE_KEYS } from "./settingsChangeSignal";
import { PROFILE_UI_PREFERENCE_KEYS, refreshProfileUiPreferences } from "@/stores/ui.store";
import { SHORTCUT_STORAGE_KEY, refreshProfileShortcuts } from "@/stores/shortcut.store";

const mailQueries = ["folders", "messages", "threads", "folder-unread-counts", "folder-counts", "starred-messages"];
const queriesByKey = new Map<string, string[]>([
  [SETTINGS_CHANGE_KEYS.accounts, ["accounts", "folders"]],
  [SETTINGS_CHANGE_KEYS.folders, mailQueries],
  [SETTINGS_CHANGE_KEYS.rules, ["rules"]],
  [SETTINGS_CHANGE_KEYS.restore, ["accounts", "rules", ...mailQueries]],
]);

export function startWindowSettingsSync() {
  const unsubscribe = subscribeProfileLocalStorage((key) => {
    if (key === null || PROFILE_UI_PREFERENCE_KEYS.has(key)) refreshProfileUiPreferences();
    if (key === null || key === SHORTCUT_STORAGE_KEY) refreshProfileShortcuts();
    const roots = queriesByKey.get(key ?? SETTINGS_CHANGE_KEYS.restore);
    for (const root of roots ?? []) {
      void queryClient.invalidateQueries({ queryKey: [root] });
    }
  });
  refreshProfileUiPreferences();
  return unsubscribe;
}
