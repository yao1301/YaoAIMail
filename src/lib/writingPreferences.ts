import { profileLocalStorage } from "@/lib/profileStorage";

export interface WritingPreferences {
  language: string;
  styleProfileId: string;
  includeKnowledge: boolean;
  signatureId: string;
}

const STORAGE_KEY = "yaoaimail-writing-preferences-v1";

const defaults: WritingPreferences = {
  language: "auto",
  styleProfileId: "",
  includeKnowledge: false,
  signatureId: "",
};

function readAll(): Record<string, WritingPreferences> {
  try {
    const raw = profileLocalStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<WritingPreferences>>;
    return Object.fromEntries(Object.entries(parsed).map(([accountId, value]) => [
      accountId,
      { ...defaults, ...value, includeKnowledge: Boolean(value.includeKnowledge) },
    ]));
  } catch {
    return {};
  }
}

export function getWritingPreferences(accountId: string | null | undefined): WritingPreferences {
  if (!accountId) return { ...defaults };
  return { ...defaults, ...readAll()[accountId] };
}

export function saveWritingPreferences(accountId: string | null | undefined, patch: Partial<WritingPreferences>): WritingPreferences {
  if (!accountId) return { ...defaults, ...patch };
  const all = readAll();
  const next = { ...defaults, ...all[accountId], ...patch };
  all[accountId] = next;
  try {
    profileLocalStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Local preference storage is best effort; AI generation still works.
  }
  return next;
}

