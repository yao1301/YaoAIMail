import TitleBar from "../components/TitleBar";
import Sidebar from "../components/Sidebar";
import StatusBar from "../components/StatusBar";
import ComposeFAB from "../components/ComposeFAB";
import InboxView from "../features/inbox/InboxView";
import CommandPalette from "../features/command-palette/CommandPalette";
import ToastContainer from "../components/ToastContainer";
import ConfirmDialog from "../components/ConfirmDialog";
import { useConfirmStore } from "../stores/confirm.store";
import { useComposeStore, type ComposeTab } from "../stores/compose.store";
import { useUIStore, applyThemeToDom, applyTypographyToDom, resolveTheme } from "../stores/ui.store";
import { useCommandStore } from "../stores/command.store";
import { useKeyboard } from "../hooks/useKeyboard";
import { useNetworkStatus } from "../hooks/useNetworkStatus";
import { buildCommands } from "../features/command-palette/commands";
import { useEffect, lazy, Suspense, Component, type ReactNode, type ErrorInfo } from "react";
import { createLazyViewPreloader, scheduleLazyViewPreload } from "./lazyViewPreload";
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
import MessageDetail from "../components/MessageDetail";
import SelectionTranslateOverlay from "../features/translate/SelectionTranslateOverlay";

const loadSettingsView = () => import("../features/settings/SettingsView");
const loadComposeView = () => import("../features/compose/ComposeView");
const loadAddressBookView = () => import("../features/contacts/AddressBookView");
const loadCompanyResearchView = () => import("../features/company-research/CompanyResearchView");
const loadLeadFinderView = () => import("../features/lead-finder/LeadFinderView");
const loadKanbanView = () => import("../features/home/HomeView");
const loadSearchView = () => import("../features/search/SearchView");
const loadStarredView = () => import("../features/starred/StarredView");
const loadAiWritingView = () => import("../features/settings/AiWritingTab");
const loadForeignToolsView = () => import("../features/settings/ForeignToolsTab");
const loadCustomerProfileView = () => import("../features/customer-profile/CustomerProfileView");
const preloadLazyViews = createLazyViewPreloader([
  loadSettingsView,
  loadComposeView,
  loadCompanyResearchView,
  loadLeadFinderView,
  loadKanbanView,
  loadSearchView,
  loadStarredView,
  loadAiWritingView,
  loadForeignToolsView,
  loadCustomerProfileView,
]);

const SettingsView = lazy(loadSettingsView);
const ComposeView = lazy(loadComposeView);
const AddressBookView = lazy(loadAddressBookView);
const CompanyResearchView = lazy(loadCompanyResearchView);
const LeadFinderView = lazy(loadLeadFinderView);
const KanbanView = lazy(loadKanbanView);
const SearchView = lazy(loadSearchView);
const StarredView = lazy(loadStarredView);
const AiWritingView = lazy(loadAiWritingView);
const ForeignToolsView = lazy(loadForeignToolsView);
const CustomerProfileView = lazy(loadCustomerProfileView);
import { useTranslation } from "react-i18next";
import i18next from "i18next";
import { WifiOff } from "lucide-react";
import { setNotificationsEnabled as setBackendNotificationsEnabled, syncTitlebarTheme } from "@/lib/api";

export default function Layout() {
  const activeView = useUIStore((s) => s.activeView);
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen);
  const aiWritingFloating = useUIStore((s) => s.aiWritingFloating);
  const displayedView = activeView;
  const composeTabs = useComposeStore((s) => s.tabs);
  const activeComposeTabId = useComposeStore((s) => s.activeTabId);
  const theme = useUIStore((s) => s.theme);
  const fontFamily = useUIStore((s) => s.fontFamily);
  const fontScale = useUIStore((s) => s.fontScale);
  const backgroundImage = useUIStore((s) => s.backgroundImage);
  const notificationsEnabled = useUIStore((s) => s.notificationsEnabled);
  const { t } = useTranslation();

  useKeyboard();

  useEffect(() => scheduleLazyViewPreload(preloadLazyViews), []);

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
    if (theme === "system") {
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      const listener = () => {
        applyThemeToDom("system");
        syncTitlebarTheme(resolveTheme("system")).catch(() => {});
      };
      mql.addEventListener("change", listener);
      return () => mql.removeEventListener("change", listener);
    }
  }, [theme]);

  useEffect(() => {
    applyTypographyToDom(fontFamily, fontScale);
  }, [fontFamily, fontScale]);

  return (
    <div
      className={`app-shell flex flex-col h-screen overflow-hidden${backgroundImage ? " app-shell--with-background" : ""}`}
    >
      <AppBackground image={backgroundImage} />
      <TitleBar />
      <div className="flex flex-1 min-h-0 app-shell-content">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-hidden" style={{ position: "relative", display: "flex", flexDirection: "column", maxHeight: "100%", minHeight: 0 }}>
          <OfflineBanner />
          <WorkspaceTabs />
          <div className="app-main-scroll" style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden", position: "relative" }}>
            {/* Keep every compose tab mounted while another workspace tab is
                active. Undo-send timers and editor state must continue in the
                background instead of being destroyed by view navigation. */}
            {composeTabs.length > 0 && (
              <div style={{ display: displayedView === "compose" ? "block" : "none", height: "100%" }}>
                <Suspense fallback={<ViewLoadingFallback />}>
                  <ComposeTabsView tabs={composeTabs} activeTabId={activeComposeTabId} />
                </Suspense>
              </div>
            )}
            <ViewErrorBoundary key={displayedView}>
              <Suspense fallback={<ViewLoadingFallback />}>
                {displayedView === "inbox" && <InboxView />}
                {displayedView === "addressBook" && <AddressBookView />}
                {displayedView === "companyResearch" && <CompanyResearchView />}
                {displayedView === "leadFinder" && <LeadFinderView />}
                {displayedView === "kanban" && <KanbanView />}
                {displayedView === "settings" && <SettingsView />}
                {displayedView === "search" && <SearchView />}
                {displayedView === "starred" && <StarredView />}
                {displayedView === "customerProfile" && <CustomerProfileView />}
                {displayedView === "aiWriting" && <StandaloneToolView><AiWritingView /></StandaloneToolView>}
                {displayedView === "foreignTools" && <StandaloneToolView><ForeignToolsView /></StandaloneToolView>}
                {displayedView === "messageDetail" && <MessageDetailPane />}
              </Suspense>
            </ViewErrorBoundary>
          </div>
        </main>
        {rightPanelOpen && displayedView !== "settings" && <RightToolsPanel />}
      </div>
      <ComposeFAB />
      <StatusBar />
      <CommandPalette />
      <ToastContainer />
      <GlobalConfirmDialog />
      <SelectionTranslateOverlay />
      {aiWritingFloating && <FloatingAiWritingPanel />}
    </div>
  );
}

/** 写信标签容器：所有写信标签同时挂载（编辑状态保留），仅显示激活标签。 */
function ComposeTabsView({ tabs, activeTabId }: { tabs: ComposeTab[]; activeTabId: string | null }) {
  return (
    <>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          style={{
            display: tab.id === activeTabId ? "block" : "none",
            height: "100%",
          }}
        >
          <ComposeView tabId={tab.id} />
        </div>
      ))}
    </>
  );
}

/** 全屏标签：双击/右键"打开"邮件后，标签内只显示邮件详情（无列表，顶部保留常用命令）。 */
function MessageDetailPane() {
  const messageDetailId = useUIStore((s) => s.messageDetailId);
  const setActiveView = useUIStore((s) => s.setActiveView);
  if (!messageDetailId) return null;
  return (
    <MessageDetail
      messageId={messageDetailId}
      onBack={() => setActiveView("inbox")}
    />
  );
}

function StandaloneToolView({ children }: { children: ReactNode }) {
  return (
    <div className="scroll-region" style={{ maxWidth: "980px", margin: "0 auto", padding: "28px 32px" }}>
      {children}
    </div>
  );
}

function ViewLoadingFallback() {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      height: "100%",
      color: "var(--color-text-secondary)",
      fontSize: "13px",
    }}>
      {i18next.t("common.loading", "Loading...")}
    </div>
  );
}

class ViewErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ViewError]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", height: "100%", gap: 12, padding: 24,
          color: "var(--color-text-secondary)",
        }}>
          <p style={{ fontSize: 14, margin: 0 }}>{i18next.t("errorBoundary.title", "Something went wrong")}</p>
          <p style={{ fontSize: 12, margin: 0, color: "var(--color-text-secondary)" }}>
            {i18next.t("errorBoundary.description", "Please try again or refresh the application.")}
          </p>
          {this.state.error && import.meta.env.DEV && (
            <pre style={{ fontSize: 11, color: "#ef4444", maxWidth: "90%", overflow: "auto", whiteSpace: "pre-wrap", textAlign: "left" }}>
              {this.state.error.message}
              {"\n"}
              {this.state.error.stack}
            </pre>
          )}
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              padding: "6px 16px", cursor: "pointer",
              backgroundColor: "var(--color-accent)", color: "#fff",
              border: "none", borderRadius: 6, fontSize: 13,
            }}
          >
            {i18next.t("errorBoundary.retry", "Retry")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function GlobalConfirmDialog() {
  const { isOpen, title, message, destructive, confirmLabel, cancelLabel, handleConfirm, handleCancel } = useConfirmStore();
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
