import { WorkspaceStateBoundary, WorkspaceStateScope } from '@/lib/workspaceState';
import { useComposeStore } from '@/stores/compose.store';
import { useUIStore } from '@/stores/ui.store';
import { useEffect, lazy, Suspense, Component, type ReactNode, type ErrorInfo } from 'react';
import { createLazyViewPreloader } from './lazyViewPreload';
import i18next from 'i18next';
const InboxView=lazy(()=>import('../features/inbox/InboxView'));
const MessageDetail=lazy(()=>import('../components/MessageDetail'));
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
export const preloadLazyViews = createLazyViewPreloader([
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
const AiAssistantView = lazy(() => import("../features/settings/AIAssistantTab"));

export function WorkspaceContent({ transfer, onReady }: { transfer?: { id: string; scope: WorkspaceStateScope }; onReady?: () => void }) {
  const displayedView = useUIStore(s => s.activeView);
  const navTabs = useUIStore(s => s.navTabs);
  const composeTabs = useComposeStore(s => s.tabs);
  const activeComposeTabId = useComposeStore(s => s.activeTabId);
  const searchTabOpen = displayedView === 'search' || navTabs.some(tab => tab.view === 'search');
  const scopeId = navTabs.find(tab => tab.view === displayedView)?.key ?? 'feature:' + displayedView;
  return <>
    {composeTabs.length > 0 && <div style={{ display: displayedView === 'compose' ? 'block' : 'none', height: '100%' }}>
      <Suspense fallback={<ViewLoadingFallback />}>
        {composeTabs.map(tab => <div key={tab.id} style={{ display: tab.id === activeComposeTabId ? 'block' : 'none', height: '100%' }}>
          <WorkspaceStateBoundary id={'compose:' + tab.id} scope={transfer?.id === 'compose:' + tab.id ? transfer.scope : undefined}>
            <ComposeView tabId={tab.id} />{displayedView === 'compose' && tab.id === activeComposeTabId && <WorkspaceReady onReady={onReady} />}
          </WorkspaceStateBoundary>
        </div>)}
      </Suspense>
    </div>}
    {searchTabOpen && <div style={{ display: displayedView === 'search' ? 'block' : 'none', height: '100%' }}>
      <WorkspaceStateBoundary id="feature:search" scope={transfer?.id === 'feature:search' ? transfer.scope : undefined}>
        <ViewErrorBoundary><Suspense fallback={<ViewLoadingFallback />}>
          <SearchView isActive={displayedView === 'search'} />{displayedView === 'search' && <WorkspaceReady onReady={onReady} />}
        </Suspense></ViewErrorBoundary>
      </WorkspaceStateBoundary>
    </div>}
    {displayedView !== 'compose' && displayedView !== 'search' && <WorkspaceStateBoundary key={scopeId} id={scopeId} scope={transfer?.id === scopeId ? transfer.scope : undefined}>
      <ViewErrorBoundary><Suspense fallback={<ViewLoadingFallback />}>
        {displayedView === 'inbox' && <InboxView />}
        {displayedView === 'addressBook' && <AddressBookView />}
        {displayedView === 'companyResearch' && <CompanyResearchView />}
        {displayedView === 'leadFinder' && <LeadFinderView />}
        {displayedView === 'kanban' && <KanbanView />}
        {displayedView === 'settings' && <SettingsView />}
        {displayedView === 'starred' && <StarredView />}
        {displayedView === 'customerProfile' && <CustomerProfileView />}
        {displayedView === 'aiWriting' && <StandaloneToolView><AiWritingView /></StandaloneToolView>}
        {displayedView === 'foreignTools' && <StandaloneToolView><ForeignToolsView /></StandaloneToolView>}
        {displayedView === 'aiAssistant' && <StandaloneToolView><AiAssistantView /></StandaloneToolView>}
        {displayedView === 'messageDetail' && <MessageDetailPane />}
        <WorkspaceReady onReady={onReady} />
      </Suspense></ViewErrorBoundary>
    </WorkspaceStateBoundary>}
  </>;
}
function WorkspaceReady({ onReady }: { onReady?: () => void }) {
  useEffect(() => { onReady?.(); }, [onReady]);
  return null;
}
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

