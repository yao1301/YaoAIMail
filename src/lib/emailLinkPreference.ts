import { useSyncExternalStore } from "react";
import { profileLocalStorage, subscribeProfileLocalStorage } from "./profileStorage";

const STORAGE_KEY = "pebble-email-link-opening";

export type EmailLinkMode = "ask" | "browser" | "inApp";

export function readEmailLinkMode(): EmailLinkMode {
  const saved = profileLocalStorage.getItem(STORAGE_KEY);
  return saved === "browser" || saved === "inApp" ? saved : "ask";
}

export function saveEmailLinkMode(mode: EmailLinkMode) {
  profileLocalStorage.setItem(STORAGE_KEY, mode);
}

function subscribe(listener: () => void) {
  return subscribeProfileLocalStorage((key) => {
    if (key === null || key === STORAGE_KEY) listener();
  }, true);
}

export function useEmailLinkMode() {
  return useSyncExternalStore(subscribe, readEmailLinkMode);
}
