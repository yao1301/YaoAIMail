import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WorkspaceContent } from './WorkspaceContent';
import AppBackground from './AppBackground';
import TitleBar from '@/components/TitleBar';
import WorkspaceTabs from '@/components/WorkspaceTabs';
import ToastContainer from '@/components/ToastContainer';
import SelectionTranslateOverlay from '@/features/translate/SelectionTranslateOverlay';
import CommandPalette from '@/features/command-palette/CommandPalette';
import { buildCommands } from '@/features/command-palette/commands';
import { useCommandStore } from '@/stores/command.store';
import { useTranslation } from 'react-i18next';
import { ComposeWindowConfirm } from '@/features/compose/ComposeWindowConfirm';
import { confirmComposeLeave } from '@/features/compose/draftPersistence';
import { useUIStore, applyThemeToDom, applyTypographyToDom, readProfileUiPreferences } from '@/stores/ui.store';
import { useComposeStore } from '@/stores/compose.store';
import { useMailStore } from '@/stores/mail.store';
import { useBackgroundTasksStore } from '@/stores/backgroundTasks.store';
import { useLeadTaskProgress } from '@/features/lead-finder/leadTaskProgress';
import { queryClient } from '@/lib/query-client';
import { decodeWorkspaceValue } from '@/lib/workspaceCodec';
import { WorkspaceStateScope, hasWorkspaceActivity } from '@/lib/workspaceState';
import { connectWorkspace, hasTransferredWork, type WorkspacePayload } from '@/lib/workspaceWindows';
import { useKeyboard } from '@/hooks/useKeyboard';

const RightToolsPanel = lazy(() => import('@/components/RightToolsPanels'));
const FloatingAiWritingPanel = lazy(() => import('@/components/FloatingAiWritingPanel'));

/** Shares native services without starting another polling/tray/mailto owner. */
export default function WorkspaceWindowApp() {
  const [transfer, setTransfer] = useState<{ id: string; scope: WorkspaceStateScope }>();
  const [failed, setFailed] = useState(false);
  const theme = useUIStore(s => s.theme);
  const fontFamily = useUIStore(s => s.fontFamily);
  const fontScale = useUIStore(s => s.fontScale);
  const backgroundImage = useUIStore(s => s.backgroundImage);
  const rightPanelOpen = useUIStore(s => s.rightPanelOpen);
  const aiWritingFloating = useUIStore(s => s.aiWritingFloating);
  const { t } = useTranslation();
  const token = new URLSearchParams(location.search).get('transfer') ?? '';
  const acknowledged = useRef(false);
  const revealed = useRef(false);
  useKeyboard();
  useEffect(() => { useCommandStore.getState().registerCommands(buildCommands(t)); }, [t]);
  useEffect(() => { applyThemeToDom(theme); applyTypographyToDom(fontFamily, fontScale); }, [theme, fontFamily, fontScale]);
  useEffect(() => {
    let cancelled = false;
    let bridge: Awaited<ReturnType<typeof connectWorkspace>> | undefined;
    void (async () => {
      const envelope = JSON.parse(await invoke<string>('read_workspace_window', { token }));
      const payload = decodeWorkspaceValue(envelope.content) as WorkspacePayload;
      if (cancelled) return;
      for (const [key, value] of payload.queries) if (value !== undefined) queryClient.setQueryData(key, value);
      useMailStore.setState({ ...payload.mail, openMessageIds: [] });
      useUIStore.setState({ ...payload.ui, ...readProfileUiPreferences(), activeView: payload.view, navTabs: payload.tab ? [payload.tab] : [], rightPanelOpen: false, aiWritingFloating: false });
      useBackgroundTasksStore.setState({ tasks: payload.tasks });
      useLeadTaskProgress.setState(payload.progress as ReturnType<typeof useLeadTaskProgress.getState>);
      const compose = payload.compose;
      useComposeStore.setState({ tabs: compose ? [compose] : [], tabsById: compose ? { [compose.id]: compose } : {}, activeTabId: null });
      if (compose) useComposeStore.getState().activateComposeTab(compose.id);
      const scope = new WorkspaceStateScope(payload.state);
      bridge = await connectWorkspace(token, scope, true);
      if (cancelled) { bridge.dispose(); return; }
      setTransfer({ id: payload.id, scope });
    })().catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; bridge?.dispose(); };
  }, [token]);
  useEffect(() => {
    let disposed = false, confirming = false;
    const native = getCurrentWindow();
    const subscription = native.onCloseRequested(async event => {
      event.preventDefault();
      if (confirming) return;
      confirming = true;
      try {
        // Before the page mounts, the original tab still owns the draft and tasks.
        if (!acknowledged.current) { await native.destroy(); return; }
        if (!await confirmComposeLeave() || disposed) return;
        // Completion callbacks still belong to this WebView. Hide it until
        // running requests settle so moving a tab never drops their results.
        const busy = () => Object.values(useBackgroundTasksStore.getState().tasks).some(task => task.status === 'running')
          || hasWorkspaceActivity() || hasTransferredWork()
          || Boolean(transfer && Object.entries(transfer.scope.snapshot()).some(([key, value]) => /:(busy|pending|generating|loading|testing|saving|.*Busy)$/.test(key) && value === true));
        if (busy()) {
          await native.hide();
          const timer = window.setInterval(() => { if (!busy()) { window.clearInterval(timer); void native.destroy(); } }, 1000);
        } else await native.destroy();
      } finally { confirming = false; }
    });
    void subscription.catch(() => {});
    return () => { disposed = true; void subscription.then(unlisten => unlisten()).catch(() => {}); };
  }, [transfer]);
  const acknowledge = useCallback(() => {
    if (acknowledged.current) return;
    acknowledged.current = true;
    void invoke('ready_workspace_window', { token }).catch(() => setFailed(true));
  }, [token]);
  useEffect(() => {
    if (!transfer || revealed.current) return;
    revealed.current = true;
    // Reveal the light shell immediately; source removal still waits for the
    // actual feature to mount, so a failed chunk load cannot lose its tab.
    void invoke('show_workspace_window', { token }).catch(() => setFailed(true));
  }, [transfer, token]);
  if (failed) return <div role="alert">窗口交接失败，原标签仍保留，请关闭此窗口后重试。</div>;
  if (!transfer) return null;
  return <div className="app-shell flex flex-col h-screen overflow-hidden">
    <AppBackground image={backgroundImage} />
    <TitleBar nativeCloseGuard /><WorkspaceTabs />
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <main style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}><WorkspaceContent transfer={transfer} onReady={acknowledge} /></main>
      {rightPanelOpen && <Suspense fallback={null}><RightToolsPanel /></Suspense>}
    </div>
    <ToastContainer /><ComposeWindowConfirm /><SelectionTranslateOverlay /><CommandPalette />
    {aiWritingFloating && <Suspense fallback={null}><FloatingAiWritingPanel /></Suspense>}
  </div>;
}
