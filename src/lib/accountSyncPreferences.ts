import { profileLocalStorage } from "./profileStorage";

export type AccountSyncPreference = "realtime" | "balanced" | "battery" | "manual";

const STORAGE_KEY = "yaomail-account-sync-preferences";
const VALID: AccountSyncPreference[] = ["realtime", "balanced", "battery", "manual"];

function readAll(): Record<string, AccountSyncPreference> {
  try {
    const raw = profileLocalStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => VALID.includes(value as AccountSyncPreference)),
    ) as Record<string, AccountSyncPreference>;
  } catch {
    return {};
  }
}

export function getAccountSyncPreference(accountId: string): AccountSyncPreference | null {
  return readAll()[accountId] ?? null;
}

export function setAccountSyncPreference(accountId: string, preference: AccountSyncPreference): void {
  const next = { ...readAll(), [accountId]: preference };
  profileLocalStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent("yaomail-account-sync-preferences-changed"));
}

export function accountSyncPreferenceToPollInterval(preference: AccountSyncPreference): number {
  switch (preference) {
    case "realtime": return 3;
    case "balanced": return 15;
    case "battery": return 60;
    case "manual": return 0;
  }
}
