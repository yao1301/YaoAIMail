import { useEffect, useMemo, useRef, useState } from "react";
import { useAccountsQuery } from "@/hooks/queries";
import { startSync, stopSync, triggerSync } from "@/lib/api";
import { useMailStore } from "@/stores/mail.store";
import { useUIStore } from "@/stores/ui.store";
import { accountSyncPreferenceToPollInterval, getAccountSyncPreference } from "@/lib/accountSyncPreferences";

interface SyncAccount {
  id: string;
}

const EMPTY_ACCOUNTS: SyncAccount[] = [];

// 自动触发（window_focus / window_blur）节流：同一账号在窗口内只触发一次，
// 避免高频 focus/blur（如反复切换窗口）瞬间打出一批 IMAP 连接，触发服务器连接限制。
const AUTO_TRIGGER_THROTTLE_MS = 15_000;
const lastAutoTriggerAt = new Map<string, number>();

export function useRealtimeSyncTriggers() {
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const networkStatus = useUIStore((s) => s.networkStatus);
  const pollInterval = useUIStore((s) => s.pollInterval);
  const realtimeMode = useUIStore((s) => s.realtimeMode);
  const { data: accounts = EMPTY_ACCOUNTS } = useAccountsQuery();
  const [accountPreferenceVersion, setAccountPreferenceVersion] = useState(0);
  const previousNetworkStatus = useRef(networkStatus);
  const accountIds = useMemo(() => {
    const ids = accounts.map((account) => account.id).filter(Boolean);
    if (activeAccountId && !ids.includes(activeAccountId)) {
      ids.push(activeAccountId);
    }
    return ids;
  }, [accounts, activeAccountId]);

  useEffect(() => {
    const refresh = () => setAccountPreferenceVersion((version) => version + 1);
    window.addEventListener("yaomail-account-sync-preferences-changed", refresh);
    return () => window.removeEventListener("yaomail-account-sync-preferences-changed", refresh);
  }, []);

  const accountPreference = (accountId: string) => getAccountSyncPreference(accountId);
  const accountIsManual = (accountId: string) => accountPreference(accountId) === "manual" || (!accountPreference(accountId) && realtimeMode === "manual");
  const accountPollInterval = (accountId: string) => {
    const preference = accountPreference(accountId);
    return preference ? accountSyncPreferenceToPollInterval(preference) : pollInterval;
  };

  // Backend auto-resume starts workers before the web UI is mounted. Reapply
  // explicit per-account choices once here, and again after a user changes one.
  useEffect(() => {
    for (const accountId of accountIds) {
      const preference = getAccountSyncPreference(accountId);
      if (!preference) continue;
      void (async () => {
        try {
          await stopSync(accountId);
          if (preference !== "manual") {
            await startSync(accountId, accountSyncPreferenceToPollInterval(preference));
          }
        } catch {
          // The normal realtime status/error event reports connection failures.
        }
      })();
    }
  }, [accountIds, accountPreferenceVersion]);

  useEffect(() => {
    if (accountIds.length === 0) return;

    const triggerAccount = (accountId: string, reason: string, ensureRunning: boolean) => {
      // 非手动触发的自动同步做节流（window_focus/window_blur 等）
      if (reason !== "manual") {
        const now = Date.now();
        const last = lastAutoTriggerAt.get(accountId) ?? 0;
        if (now - last < AUTO_TRIGGER_THROTTLE_MS) return;
        lastAutoTriggerAt.set(accountId, now);
      }
      const trigger = () => {
        triggerSync(accountId, reason).catch(() => {});
      };

      if (ensureRunning && !accountIsManual(accountId)) {
        startSync(accountId, accountPollInterval(accountId))
          .catch(() => {})
          .finally(trigger);
        return;
      }

      trigger();
    };

    const onFocus = () => {
      for (const accountId of accountIds) {
        triggerAccount(accountId, "window_focus", true);
      }
    };
    const onBlur = () => {
      for (const accountId of accountIds) {
        triggerAccount(accountId, "window_blur", false);
      }
    };

    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      for (const accountId of accountIds) {
        lastAutoTriggerAt.delete(accountId);
        lastAutoTriggerAt.delete(`${accountId}:window_focus`);
        lastAutoTriggerAt.delete(`${accountId}:window_blur`);
      }
    };
  }, [accountIds, pollInterval, realtimeMode, accountPreferenceVersion]);

  useEffect(() => {
    const previous = previousNetworkStatus.current;
    previousNetworkStatus.current = networkStatus;

    if (accountIds.length === 0 || previous !== "offline" || networkStatus !== "online") return;
    for (const accountId of accountIds) {
      if (accountIsManual(accountId)) {
        triggerSync(accountId, "network_online").catch(() => {});
      } else {
        startSync(accountId, accountPollInterval(accountId))
          .catch(() => {})
          .finally(() => {
            triggerSync(accountId, "network_online").catch(() => {});
          });
      }
    }
  }, [accountIds, networkStatus, pollInterval, realtimeMode, accountPreferenceVersion]);
}
