import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { listen } from "@tauri-apps/api/event";
import { AlertCircle, AppWindow, Clock, Mail, RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useUIStore, type RealtimeStatus } from "../stores/ui.store";
import { useMailStore } from "@/stores/mail.store";
import { useToastStore } from "@/stores/toast.store";
import { listFolders, stopSync } from "@/lib/api";
import { useSyncMutation } from "@/hooks/mutations/useSyncMutation";
import {
  pendingMailOpsSummaryQueryKey,
  useAccountsQuery,
  useFoldersForAccountsQuery,
  usePendingMailOpsSummary,
} from "@/hooks/queries";
import { useFolderUnreadCountsForAccounts } from "@/hooks/queries/useFolderUnreadCounts";
import { allAccountsFolderId, unreadCountForFolder } from "@/lib/folderAggregation";
import {
  currentFolderCacheRevision,
  setFolderCacheIfCurrent,
} from "@/lib/folderCache";

interface MailErrorPayload {
  error_type: string;
  message: string;
  timestamp: number;
}

interface MailNewPayload {
  account_id?: string;
  message_id?: string;
  folder_ids?: string[];
  thread_id?: string | null;
  subject?: string;
  from?: string;
  received_at?: number;
}

interface SyncProgressPayload {
  account_id?: string;
  status?: "started" | "completed" | "error" | "progress";
  phase?: string;
  message?: string | null;
  total?: number | null;
  received?: number | null;
}

interface SyncCompletePayload {
  account_id?: string;
}

export default function StatusBar() {
  const { t } = useTranslation();
  const syncStatus = useUIStore((s) => s.syncStatus);
  const setSyncStatus = useUIStore((s) => s.setSyncStatus);
  const networkStatus = useUIStore((s) => s.networkStatus);
  const lastMailError = useUIStore((s) => s.lastMailError);
  const setLastMailError = useUIStore((s) => s.setLastMailError);
  const realtimeStatusByAccount = useUIStore((s) => s.realtimeStatusByAccount);
  const setRealtimeStatus = useUIStore((s) => s.setRealtimeStatus);
  const notificationsEnabled = useUIStore((s) => s.notificationsEnabled);
  const keepRunningInBackground = useUIStore((s) => s.keepRunningInBackground);
  const setKeepRunningInBackground = useUIStore((s) => s.setKeepRunningInBackground);
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const syncMutation = useSyncMutation();
  const queryClient = useQueryClient();
  const { data: pendingOpsSummary } = usePendingMailOpsSummary(activeAccountId);
  const { data: accounts = [] } = useAccountsQuery();
  const accountIds = accounts.map((a) => a.id);
  const { data: folders = [] } = useFoldersForAccountsQuery(accountIds);
  const { data: unreadCounts = {} } = useFolderUnreadCountsForAccounts(accountIds);
  const totalUnread = unreadCountForFolder(allAccountsFolderId("inbox"), folders, unreadCounts);
  const [newMailFlash, setNewMailFlash] = useState(0);
  const syncStatusRef = useRef(syncStatus);
  const [syncProgress, setSyncProgress] = useState<{ total: number; received: number } | null>(null);

  useEffect(() => {
    syncStatusRef.current = syncStatus;
  }, [syncStatus]);

  function updateSyncStatus(status: typeof syncStatus) {
    syncStatusRef.current = status;
    setSyncStatus(status);
  }

  // Listen for mail:error events from Rust backend
  useEffect(() => {
    const unlisten = listen<MailErrorPayload>("mail:error", (event) => {
      setLastMailError(event.payload.message);
      useToastStore.getState().addToast({
        message: t("status.mailErrorDetail", {
          defaultValue: "Mail sync failed: {{message}}",
          message: event.payload.message,
        }),
        type: "error",
        duration: 12_000,
      });
      // Auto-clear error after 10 seconds
      setTimeout(() => setLastMailError(null), 10_000);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [setLastMailError, t]);

  async function refreshFolderCache(accountId?: string | null) {
    const ids = accountId ? [accountId] : accountIds;
    await Promise.all(
      ids.map(async (id) => {
        try {
          const revision = currentFolderCacheRevision(id);
          // Write the freshly-read list directly into the exact per-account
          // cache used by the sidebar. This avoids leaving a multi-account
          // tree on an old parent_id after a server-side folder rename.
          const freshFolders = await listFolders(id);
          setFolderCacheIfCurrent(queryClient, id, freshFolders, revision);
        } catch {
          // The existing invalidation path remains the fallback when the
          // account is temporarily offline.
        }
      }),
    );
  }

  function refreshMailQueries(accountId?: string | null) {
    queryClient.invalidateQueries({ queryKey: ["folders"] });
    queryClient.invalidateQueries({ queryKey: ["messages"] });
    queryClient.invalidateQueries({ queryKey: ["threads"] });
    queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] });
    void refreshFolderCache(accountId);
  }

  function isActiveAccountEvent(accountId?: string | null) {
    return !accountId || !activeAccountId || accountId === activeAccountId;
  }

  // Listen for sync-complete: legacy worker-exit event used by one-shot syncs.
  useEffect(() => {
    const unlisten = listen<SyncCompletePayload>("mail:sync-complete", (event) => {
      if (!isActiveAccountEvent(event.payload?.account_id)) return;
      if (syncStatusRef.current !== "error") {
        updateSyncStatus("idle");
      }
      void refreshMailQueries(event.payload?.account_id);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [activeAccountId, setSyncStatus, queryClient]);

  // Listen for per-pass sync progress. Background workers are long-lived, so
  // UI "syncing" must track a concrete pass rather than worker lifetime.
  useEffect(() => {
    const unlisten = listen<SyncProgressPayload>("mail:sync-progress", (event) => {
      const { account_id, status, message, total, received } = event.payload;
      if (!isActiveAccountEvent(account_id)) return;
      if (status === "started") {
        setSyncProgress(null);
        updateSyncStatus("syncing");
      } else if (status === "progress") {
        updateSyncStatus("syncing");
        if (typeof total === "number" && typeof received === "number" && total > 0) {
          setSyncProgress({ total, received });
        }
      } else if (status === "completed") {
        setSyncProgress(null);
        updateSyncStatus("idle");
        void refreshMailQueries(account_id);
      } else if (status === "error") {
        setSyncProgress(null);
        updateSyncStatus("error");
        if (message) {
          setLastMailError(message);
        }
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [activeAccountId, setLastMailError, setSyncStatus, queryClient]);

  // Listen for new mail events: incremental data refresh + flash badge
  useEffect(() => {
    const unlisten = listen<MailNewPayload>("mail:new", (event) => {
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      if (event.payload.account_id) {
        queryClient.invalidateQueries({ queryKey: ["folders", event.payload.account_id] });
        queryClient.invalidateQueries({ queryKey: ["folder-unread-counts", event.payload.account_id] });
      }
      queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] });
      setNewMailFlash((n) => n + 1);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [queryClient]);

  // Listen for bulk flag changes (mark_all_read etc.) so the UI reflects the
  // new is_read state without waiting for the next sync cycle.
  useEffect(() => {
    const unlisten = listen<{ account_id?: string; folder_id?: string; kind?: string; count?: number }>(
      "mail:flags-changed",
      (event) => {
        queryClient.invalidateQueries({ queryKey: ["messages"] });
        queryClient.invalidateQueries({ queryKey: ["threads"] });
        if (event.payload.account_id) {
          queryClient.invalidateQueries({ queryKey: ["folder-unread-counts", event.payload.account_id] });
        }
        queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] });
      },
    );
    return () => { unlisten.then((fn) => fn()); };
  }, [queryClient]);

  useEffect(() => {
    const unlisten = listen("mail:pending-ops-changed", () => {
      queryClient.invalidateQueries({
        queryKey: pendingMailOpsSummaryQueryKey(activeAccountId),
      });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [activeAccountId, queryClient]);

  useEffect(() => {
    const unlisten = listen<RealtimeStatus>("mail:realtime-status", (event) => {
      setRealtimeStatus(event.payload.account_id, event.payload);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [setRealtimeStatus]);

  async function handleSync() {
    if (!activeAccountId) return;
    if (syncStatus === "syncing") {
      try { await stopSync(activeAccountId); } catch {}
      updateSyncStatus("idle");
    } else {
      updateSyncStatus("syncing");
      try {
        await syncMutation.mutateAsync(activeAccountId);
      } catch {
        updateSyncStatus("error");
      }
    }
  }

  const syncText = {
    idle: t("status.ready", "Ready"),
    syncing: t("status.syncing", "Syncing..."),
    error: t("status.syncError", "Sync error"),
  }[syncStatus];
  const realtimeStatus = activeAccountId ? realtimeStatusByAccount[activeAccountId] : undefined;
  const realtimeStatusText = getRealtimeStatusText(realtimeStatus, t);

  const pendingRemoteWrites = pendingOpsSummary?.total_active_count ?? 0;
  const failedRemoteWrites = pendingOpsSummary?.failed_count ?? 0;
  const retryingRemoteWrites = pendingOpsSummary?.in_progress_count ?? 0;
  const backgroundLabel = keepRunningInBackground
    ? t("status.exitOnClose", "Exit on close")
    : t("status.keepRunningInBackground", "Keep running in background on close");
  const pendingRemoteText = retryingRemoteWrites > 0
    ? t("status.remoteWritesRetrying", "{{count}} remote writes retrying", { count: retryingRemoteWrites })
    : failedRemoteWrites > 0
      ? t("status.remoteWritesPending", "{{count}} remote writes pending", { count: pendingRemoteWrites })
      : t("status.remoteWritesQueued", "{{count}} remote writes queued", { count: pendingRemoteWrites });

  return (
    <footer
      className="flex items-center px-3 h-6 text-xs border-t gap-3"
      style={{
        backgroundColor: "var(--color-statusbar-bg)",
        borderColor: "var(--color-border)",
        color: "var(--color-text-secondary)",
      }}
    >
      {networkStatus === "offline" ? (
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="flex items-center gap-1"
          style={{ color: "var(--color-error, #ef4444)" }}
        >
          <svg aria-hidden="true" focusable="false" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
            <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
            <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
            <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
            <line x1="12" y1="20" x2="12.01" y2="20" />
          </svg>
          {t("status.offline", "Offline")}
        </span>
      ) : (
        <>
          <span role="status" aria-live="polite" aria-atomic="true">{syncText}</span>
          {syncProgress && syncProgress.total > 0 && (
            <span role="status" aria-live="polite" aria-atomic="true" style={{ color: "var(--color-accent)" }}>
              历史同步 {Math.min(syncProgress.received, syncProgress.total).toLocaleString()} / {syncProgress.total.toLocaleString()}
            </span>
          )}
          {realtimeStatusText && (
            <span
              role="status"
              aria-live="polite"
              aria-atomic="true"
              aria-label={realtimeStatusText}
              className="truncate"
              title={realtimeStatus?.message ?? realtimeStatusText}
              style={{ maxWidth: "180px" }}
            >
              {realtimeStatusText}
            </span>
          )}
          <button
            onClick={handleSync}
            disabled={!activeAccountId}
            title={syncStatus === "syncing" ? t("status.stopSync") : t("status.syncNow")}
            aria-label={syncStatus === "syncing" ? t("status.stopSync") : t("status.syncNow")}
            style={{
              background: "none",
              border: "none",
              cursor: activeAccountId ? "pointer" : "default",
              padding: "2px",
              color: "var(--color-text-secondary)",
              display: "flex",
              alignItems: "center",
              opacity: activeAccountId ? 1 : 0.4,
            }}
          >
            <RefreshCw
              aria-hidden="true"
              size={13}
              style={{
                animation: syncStatus === "syncing" ? "spin 1s linear infinite" : "none",
              }}
            />
          </button>
          {pendingRemoteWrites > 0 && (
            <span
              role={failedRemoteWrites > 0 ? "alert" : "status"}
              aria-live={failedRemoteWrites > 0 ? "assertive" : "polite"}
              aria-atomic="true"
              className="flex items-center gap-1 truncate"
              title={pendingOpsSummary?.last_error ?? pendingRemoteText}
              style={{
                color: failedRemoteWrites > 0
                  ? "var(--color-warning, #d97706)"
                  : "var(--color-text-secondary)",
                maxWidth: "220px",
              }}
            >
              {failedRemoteWrites > 0 ? <AlertCircle aria-hidden="true" size={13} /> : <Clock aria-hidden="true" size={13} />}
              <span className="truncate">{pendingRemoteText}</span>
            </span>
          )}
        </>
      )}

      {lastMailError && (
        <span
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          className="truncate"
          style={{ color: "var(--color-error, #ef4444)" }}
        >
          {lastMailError}
        </span>
      )}

      <span className="ml-auto flex items-center gap-2">
        {/* Unread mail indicator */}
        <button
          type="button"
          onClick={() => useUIStore.getState().setActiveView("inbox")}
          aria-label={totalUnread > 0 ? `${totalUnread} 封未读邮件` : "没有未读邮件"}
          title={
            totalUnread > 0
              ? `${totalUnread} 封未读邮件，点击查看所有未读`
              : "没有未读邮件"
          }
          style={{
            position: "relative",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1px 5px 1px 4px",
            border: "1px solid color-mix(in srgb, var(--color-border) 80%, transparent)",
            borderRadius: 10,
            background: totalUnread > 0
              ? newMailFlash > 0
                ? "rgba(37,99,235,0.18)"
                : "color-mix(in srgb, var(--color-accent) 10%, transparent)"
              : "transparent",
            color: totalUnread > 0 ? "var(--color-accent)" : "var(--color-text-secondary)",
            cursor: "pointer",
            transition: "background-color 0.4s",
            fontSize: 11,
            fontWeight: 600,
            lineHeight: 1.4,
            minWidth: 32,
            height: 20,
          }}
        >
          <Mail aria-hidden="true" size={12} />
          <span style={{ marginLeft: 4 }}>
            {totalUnread > 0 ? totalUnread.toLocaleString() : "0"}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setKeepRunningInBackground(!keepRunningInBackground)}
          aria-label={backgroundLabel}
          aria-pressed={keepRunningInBackground}
          title={backgroundLabel}
          className="inline-flex items-center justify-center"
          style={{
            width: "20px",
            height: "20px",
            border: "1px solid transparent",
            borderRadius: "4px",
            background: keepRunningInBackground
              ? "color-mix(in srgb, var(--color-accent) 16%, transparent)"
              : "transparent",
            color: keepRunningInBackground
              ? "var(--color-accent)"
              : "var(--color-text-secondary)",
            cursor: "pointer",
            padding: 0,
          }}
        >
          <AppWindow aria-hidden="true" size={13} />
        </button>
        {notificationsEnabled && (
          <svg aria-hidden="true" focusable="false" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
        )}
      </span>
    </footer>
  );
}

function getRealtimeStatusText(
  status: RealtimeStatus | undefined,
  t: TFunction,
) {
  if (!status) return null;

  if (status.message) {
    return status.message;
  }

  switch (status.mode) {
    case "realtime":
      return t("status.realtimeConnected", "Realtime connected");
    case "polling":
      return t("status.realtimePolling", "Polling");
    case "manual":
      return t("status.realtimeManual", "Manual only");
    case "backoff":
      return t("status.realtimeBackoff", "Retrying");
    case "auth_required":
      return t("status.realtimeAuthRequired", "Reconnect required");
    case "offline":
      return t("status.offline", "Offline");
    case "error":
      return t("status.realtimeError", "Realtime error");
  }
}
