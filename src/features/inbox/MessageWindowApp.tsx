import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useQueryClient } from '@tanstack/react-query';
import TitleBar from '@/components/TitleBar';
import MessageDetail from '@/components/MessageDetail';
import ToastContainer from '@/components/ToastContainer';
import WorkspaceTabs from '@/components/WorkspaceTabs';
import SelectionTranslateOverlay from '@/features/translate/SelectionTranslateOverlay';
import ComposeView from '@/features/compose/ComposeView';
import { ComposeWindowConfirm } from '@/features/compose/ComposeWindowConfirm';
import { isComposeDirty, useComposeStore } from '@/stores/compose.store';
import { confirmComposeLeave } from '@/features/compose/draftPersistence';
import { useMailStore } from '@/stores/mail.store';
import { useUIStore, applyThemeToDom, applyTypographyToDom } from '@/stores/ui.store';
import { useMessageQuery } from '@/hooks/queries';
import { WorkspaceStateBoundary, hasTransferredWork } from '@/lib/workspaceState';

export function readWindowMessageId(search: string): string | null {
  try {
    const raw = new URLSearchParams(search).get('message');
    if (!raw || raw.length > 2048 || !/^[\w-]+$/.test(raw)) return null;
    const id = new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(raw.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0)));
    return id && id.length <= 1024 ? id : null;
  } catch { return null; }
}

/** Same mail renderer and compose workflow as main, without sidebar/overview,
 * sync worker startup or close-to-tray handlers. No extra model invocation. */
export default function MessageWindowApp() {
  const [ready,setReady] = useState(false);
  const id = readWindowMessageId(window.location.search);
  const openIds = useMailStore(s => s.openMessageIds);
  const activeView = useUIStore(s => s.activeView);
  const detailId = useUIStore(s => s.messageDetailId);
  const theme = useUIStore(s => s.theme);
  const family = useUIStore(s => s.fontFamily);
  const scale = useUIStore(s => s.fontScale);
  const tabs = useComposeStore(s => s.tabs);
  const activeCompose = useComposeStore(s => s.activeTabId);
  const queryClient = useQueryClient();
  const { data: message } = useMessageQuery(id);
  useEffect(() => {
    // Subwindows have no main startup splash animation.
    document.getElementById('splash')?.remove();
    document.getElementById('splash-style')?.remove();
    if (!id) return;
    useMailStore.getState().setSelectedMessage(id);
    useUIStore.setState({messageDetailId:id,activeView:'messageDetail',rightPanelOpen:false,navTabs:[]});
    setReady(true);
  }, [id]);
  useEffect(() => {
    if (message?.account_id) {
      const mail = useMailStore.getState();
      mail.setActiveAccountId(message.account_id);
      mail.setSelectedMessage(id);
    }
  }, [message?.account_id,id]);
  useEffect(() => {
    if (!ready) return;
    if (openIds.length === 0 && tabs.length === 0) { void getCurrentWindow().close(); return; }
    if (openIds.length === 0 && activeView !== 'compose' && tabs.length > 0) {
      useComposeStore.getState().activateComposeTab(tabs[0].id);
      useUIStore.getState().setActiveView('compose');
    } else if (detailId && !openIds.includes(detailId) && openIds.length > 0) {
      useUIStore.setState({messageDetailId:useMailStore.getState().selectedMessageId ?? openIds[0]});
    }
  }, [ready,openIds,tabs,activeView,detailId]);
  useEffect(() => {
    let disposed = false;
    let confirming = false;
    const native = getCurrentWindow();
    const subscription = native.onCloseRequested(async event => {
      if (!isComposeDirty() && !hasTransferredWork()) return;
      event.preventDefault();
      if (confirming) return;
      confirming = true;
      try {
        const discard = await confirmComposeLeave();
        if (discard && !disposed) {
          if (hasTransferredWork()) {
            await native.hide();
            const timer = window.setInterval(() => { if (!hasTransferredWork()) { window.clearInterval(timer); void native.destroy(); } }, 1000);
          } else await native.destroy();
        }
      } finally { confirming = false; }
    });
    void subscription.catch(() => {});
    return () => { disposed = true; void subscription.then(unlisten => unlisten()).catch(() => {}); };
  }, []);
  useEffect(() => { applyThemeToDom(theme); }, [theme]);
  useEffect(() => { applyTypographyToDom(family,scale); }, [family,scale]);
  useEffect(() => {
    const refresh = () => { void queryClient.invalidateQueries(); };
    window.addEventListener('focus',refresh);
    return () => window.removeEventListener('focus',refresh);
  }, [queryClient]);
  if (!id) return <><TitleBar nativeCloseGuard/><p role="alert">邮件窗口参数无效，请关闭后从邮件标签重新打开。</p></>;
  return <div style={{height:'100vh',display:'flex',flexDirection:'column',overflow:'hidden',background:'var(--color-bg)'}}>
    <TitleBar nativeCloseGuard/><WorkspaceTabs/>
    <main style={{flex:1,minHeight:0,position:'relative',overflow:'hidden'}}>
      {tabs.map(tab => <div key={tab.id} style={{height:'100%',display:activeView==='compose' && tab.id===activeCompose?'block':'none'}}><WorkspaceStateBoundary id={`compose:${tab.id}`}><ComposeView tabId={tab.id}/></WorkspaceStateBoundary></div>)}
      {activeView !== 'compose' && (!ready || openIds.length > 0) && <MessageDetail messageId={detailId ?? id} onBack={() => { void getCurrentWindow().close(); }}/>}
    </main>
    <ToastContainer/><ComposeWindowConfirm/><SelectionTranslateOverlay/>
  </div>;
}
