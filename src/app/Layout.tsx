import { WorkspaceContent, preloadLazyViews } from './WorkspaceContent';
export { WorkspaceContent } from './WorkspaceContent';
import TitleBar from "../components/TitleBar";
import Sidebar from "../components/Sidebar";
import StatusBar from "../components/StatusBar";
import ComposeFAB from "../components/ComposeFAB";
import CommandPalette from "../features/command-palette/CommandPalette";
import ToastContainer from "../components/ToastContainer";
import ConfirmDialog from "../components/ConfirmDialog";
import { useConfirmStore } from "../stores/confirm.store";
import { useUIStore, applyThemeToDom, applyTypographyToDom, resolveTheme } from "../stores/ui.store";
import { useCommandStore } from "../stores/command.store";
import { useKeyboard } from "../hooks/useKeyboard";
import { useNetworkStatus } from "../hooks/useNetworkStatus";
import { buildCommands } from "../features/command-palette/commands";
import { useEffect } from "react";
import { scheduleLazyViewPreload } from "./lazyViewPreload";
import { useRealtimePreferenceSync } from "./useRealtimePreferenceSync";
import { useRealtimeSyncTriggers } from "./useRealtimeSyncTriggers";
import { useNotificationOpenNavigation } from "./useNotificationOpenNavigation";
import { useCloseToBackground } from "./useCloseToBackground";
import { useTrayI18n } from "./useTrayI18n";
import { useMailtoOpen } from "./useMailtoOpen";
import AppBackground from "./AppBackground";
import RightToolsPanel from "../components/RightToolsPanels";
import WorkspaceTabs from "../components/WorkspaceTabs";
import FloatingAiWritingPanel from "../components/FloatingAiWritingPanel";
import SelectionTranslateOverlay from "../features/translate/SelectionTranslateOverlay";

import { useTranslation } from "react-i18next";
import i18next from "i18next";
import { WifiOff } from "lucide-react";
import { setNotificationsEnabled as setBackendNotificationsEnabled, syncTitlebarTheme } from "@/lib/api";

export default function Layout() {
  const activeView = useUIStore((s) => s.activeView);
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen);
  const aiWritingFloating = useUIStore((s) => s.aiWritingFloating);
  const displayedView = activeView;
  const theme = useUIStore((s) => s.theme);
  const fontFamily = useUIStore((s) => s.fontFamily);
  const fontScale = useUIStore((s) => s.fontScale);
  const backgroundImage = useUIStore((s) => s.backgroundImage);
  const notificationsEnabled = useUIStore((s) => s.notificationsEnabled);
  const { t } = useTranslation();

  useKeyboard();

  useEffect(() => scheduleLazyViewPreload(preloadLazyViews), []);

  useEffect(() => {
    // Searches opened from a folder/shortcut also need a tab to return to.
    if (activeView === "search") useUIStore.getState().upsertNavTab({
      key: "feature:search", kind: "feature", view: "search", label: t("search.title", "搜索"),
    });
  }, [activeView]);

  useNetworkStatus();
  useRealtimePreferenceSync();
  useRealtimeSyncTriggers();
  useNotificationOpenNavigation();
  useCloseToBackground();
  useTrayI18n();
  useMailtoOpen();

  // Re-register commands when language changes
  useEffect(() => {
    useCommandStore.getState().registerCommands(buildCommands(t));
  }, [t]);

  // Keep the Rust notification gate aligned with the single frontend preference source.
  useEffect(() => {
    setBackendNotificationsEnabled(notificationsEnabled)
      .catch((err) => console.warn("Failed to sync notification preference to backend", err));
  }, [notificationsEnabled]);

  useEffect(() => {
    applyThemeToDom(theme);
    syncTitlebarTheme(resolveTheme(theme)).catch(() => {});
  }, [theme]);

  useEffect(() => {
    applyTypographyToDom(fontFamily, fontScale);
  }, [fontFamily, fontScale]);

  return (
    <div
      className={`app-shell flex flex-col h-screen overflow-hidden${backgroundImage ? " app-shell--with-background" : ""}`}
    >
      <AppBackground image={backgroundImage} />
      <TitleBar nativeCloseGuard />
      <div className="flex flex-1 min-h-0 app-shell-content">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-hidden" style={{ position: "relative", display: "flex", flexDirection: "column", maxHeight: "100%", minHeight: 0 }}>
          <OfflineBanner />
          <WorkspaceTabs />
          <div className="app-main-scroll" style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden", position: "relative" }}>
            <WorkspaceContent />

          </div>
        </main>
        {rightPanelOpen && displayedView !== "settings" && <RightToolsPanel />}
      </div>
      <ComposeFAB /><StatusBar /><CommandPalette /><ToastContainer /><GlobalConfirmDialog /><SelectionTranslateOverlay />
      {aiWritingFloating && <FloatingAiWritingPanel />}
    </div>
  );
}

function GlobalConfirmDialog() {
  const { isOpen, title, message, destructive, confirmLabel, cancelLabel, alternateLabel, busy, handleAlternate, handleConfirm, handleCancel } = useConfirmStore();
  if (!isOpen) return null;
  return (
    <ConfirmDialog
      title={title}
      message={message}
      destructive={destructive}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
      alternateLabel={alternateLabel}
      busy={busy}
      onAlternate={() => void handleAlternate()}
    />
  );
}

function OfflineBanner() {
  const networkStatus = useUIStore((s) => s.networkStatus);
  if (networkStatus === "online") return null;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "8px",
      padding: "6px 16px",
      backgroundColor: "rgba(239,68,68,0.1)",
      borderBottom: "1px solid rgba(239,68,68,0.2)",
      color: "#ef4444", fontSize: "12px",
    }}>
      <WifiOff size={14} />
      {i18next.t("status.offline", "Offline")} — {i18next.t("status.offlineHint", "Mail sync is paused until you're back online")}
    </div>
  );
}
