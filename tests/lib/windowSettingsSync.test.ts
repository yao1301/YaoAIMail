import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { initializeProfileStorageNamespace, resetProfileStorageNamespaceForTests } from "@/lib/profileStorage";
import { queryClient } from "@/lib/query-client";
import { SETTINGS_CHANGE_KEYS } from "@/lib/settingsChangeSignal";
import { startWindowSettingsSync } from "@/lib/windowSettingsSync";
import { useUIStore } from "@/stores/ui.store";
import { useShortcutStore } from "@/stores/shortcut.store";

function savedElsewhere(key: string, value: string, profile = "settings-fixture", area = localStorage) {
  const scoped = `pebble:profile:${profile}:${key}`;
  const oldValue = area.getItem(scoped);
  area.setItem(scoped, value);
  window.dispatchEvent(new StorageEvent("storage", { storageArea: area, key: scoped, oldValue, newValue: value }));
}

let stop: () => void;
let originalUi = useUIStore.getState();
let originalShortcuts = useShortcutStore.getState();
let originalLanguage = i18n.language;

beforeEach(async () => {
  originalUi = useUIStore.getState();
  originalShortcuts = useShortcutStore.getState();
  originalLanguage = i18n.language;
  localStorage.clear();
  sessionStorage.clear();
  await initializeProfileStorageNamespace(async () => "settings-fixture");
  stop = startWindowSettingsSync();
});

afterEach(async () => {
  stop();
  localStorage.clear();
  sessionStorage.clear();
  resetProfileStorageNamespaceForTests();
  useUIStore.setState(originalUi);
  useShortcutStore.setState(originalShortcuts);
  await i18n.changeLanguage(originalLanguage);
  vi.restoreAllMocks();
});

describe("preferences changed in a detached settings window", () => {
  it("updates the main theme, typography, notifications, language and shortcuts without replacing the open view", () => {
    useUIStore.setState({ activeView: "inbox" });
    savedElsewhere("pebble-theme", "studio");
    savedElsewhere("pebble-font-family", "mono");
    savedElsewhere("pebble-font-scale", "1.2");
    savedElsewhere("pebble-notifications-enabled", "false");
    savedElsewhere("pebble-language", "zh");
    savedElsewhere("pebble-shortcuts", JSON.stringify({ search: "Ctrl+Shift+F" }));
    expect(useUIStore.getState()).toMatchObject({
      activeView: "inbox", theme: "studio", fontFamily: "mono", fontScale: 1.2,
      notificationsEnabled: false, language: "zh",
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("studio");
    expect(i18n.language).toBe("zh");
    expect(useShortcutStore.getState().bindings.search).toBe("Ctrl+Shift+F");
  });

  it("ignores other profiles and session state, and refreshes saved account and rule queries", () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    savedElsewhere("pebble-theme", "studio", "another-profile");
    savedElsewhere("pebble-theme", "studio", "settings-fixture", sessionStorage);
    expect(useUIStore.getState().theme).toBe("light");
    expect(invalidate).not.toHaveBeenCalled();
    savedElsewhere(SETTINGS_CHANGE_KEYS.accounts, "account-revision");
    savedElsewhere(SETTINGS_CHANGE_KEYS.rules, "rule-revision");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["accounts"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["folders"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["rules"] });
  });
});
