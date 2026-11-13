import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUIStore } from "@/stores/ui.store";
import { startSync } from "@/lib/api";
import { useAccountsQuery } from "@/hooks/queries";
import { isComposeDirty } from '@/stores/compose.store';
import { confirmComposeLeave } from '@/features/compose/draftPersistence';
import { hasTransferredWork } from '@/lib/workspaceState';

export function useCloseToBackground() {
  const { data: accounts } = useAccountsQuery();
  const pollInterval = useUIStore((s) => s.pollInterval);
  const realtimeMode = useUIStore((s) => s.realtimeMode);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let confirming = false;
    let releaseTimer: number | undefined;
    const finishClose = async () => {
      if (useUIStore.getState().keepRunningInBackground || hasTransferredWork()) {
        await appWindow.hide();
        if (!useUIStore.getState().keepRunningInBackground && releaseTimer === undefined) {
          releaseTimer = window.setInterval(() => {
            if (!hasTransferredWork()) {
              window.clearInterval(releaseTimer);
              releaseTimer = undefined;
              if (!useUIStore.getState().keepRunningInBackground) void appWindow.destroy();
            }
          }, 1000);
        }
      } else await appWindow.destroy();
    };

    appWindow
      .onCloseRequested(async (event) => {
        if (isComposeDirty()) {
          event.preventDefault();
          if (confirming) return;
          confirming = true;
          try {
            if (await confirmComposeLeave() && !disposed) {
              await finishClose();
            }
          } finally { confirming = false; }
          return;
        }
        if (!useUIStore.getState().keepRunningInBackground && !hasTransferredWork()) {
          return;
        }

        event.preventDefault();
        void finishClose()
          .catch((err) => console.warn("Failed to hide window on close", err));
      })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((err) => console.warn("Failed to register close-to-background handler", err));

    return () => {
      disposed = true;
      if (releaseTimer !== undefined) window.clearInterval(releaseTimer);
      unlisten?.();
    };
  }, []);

  // Resume sync workers when window regains visibility after being hidden to tray
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let disposed = false;

    appWindow
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) return;
        if (realtimeMode === "manual") return;
        const ids = accounts?.map((a) => a.id) ?? [];
        for (const id of ids) {
          startSync(id, pollInterval).catch(() => {});
        }
      })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [accounts, pollInterval, realtimeMode]);
}
