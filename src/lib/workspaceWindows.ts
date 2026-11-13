import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useUIStore, type NavTab, type ActiveView } from '@/stores/ui.store';
import { useMailStore } from '@/stores/mail.store';
import { useComposeStore, type ComposeTab } from '@/stores/compose.store';
import { useBackgroundTasksStore } from '@/stores/backgroundTasks.store';
import { useLeadTaskProgress } from '@/features/lead-finder/leadTaskProgress';
import { queryClient } from '@/lib/query-client';
import { decodeWorkspaceValue, encodeWorkspaceValue } from './workspaceCodec';
import { getWorkspaceScope, WorkspaceStateScope, trackWorkspaceSource } from './workspaceState';
export { hasTransferredWork } from './workspaceState';
import { registerDetachedDraft } from './workspaceDraftDelivery';
import { deliverAiDraft, type AiDraftTarget } from '@/features/compose/deliverAiDraft';
import { receiveLeadState, wrapLeadState } from './workspaceLeadState';
import { useAutoDevStore } from '@/stores/autoDev.store';

export interface WorkspacePayload {
  view: ActiveView;
  id: string;
  tab?: NavTab;
  compose?: ComposeTab;
  state: Record<string, unknown>;
  ui: Record<string, unknown>;
  mail: Record<string, unknown>;
  tasks: typeof useBackgroundTasksStore.getState extends () => infer T ? T extends { tasks: infer U } ? U : never : never;
  progress: unknown;
  queries: [readonly unknown[], unknown][];
}
const pending = new Set<string>();
const detachable = new Set<ActiveView>(['inbox','addressBook','companyResearch','leadFinder','kanban','settings','search','starred','compose','aiWriting','aiAssistant','foreignTools','customerProfile']);
export function canDetachWorkspace(view: ActiveView) { return detachable.has(view); }
function dataOnly(state: object) { return Object.fromEntries(Object.entries(state).filter(([, value]) => typeof value !== 'function')); }
type Patch = { token: string; key: string; value: string };
const activeBridges = new Set<() => void>();
export function disposeWorkspaceBridges() { for (const dispose of [...activeBridges]) dispose(); }

export async function connectWorkspace(token: string, scope: WorkspaceStateScope, child: boolean, taskKeys?: string[]) {
  let enabled = child;
  let disposed = false;
  let sequence = Promise.resolve();
  const waiting = new Map<string, unknown>();
  const terminalDuringHandoff = new Map<string, WorkspacePayload['tasks'][string]>();
  const ownedTasks = new Set(child ? [] : Object.values(useBackgroundTasksStore.getState().tasks).filter(task => task.status === 'running' && (!taskKeys || taskKeys.includes(task.id))).map(task => task.id));
  const taskLifetimeKey = `workspace:jobs:tasks:${token}`;
  const send = (key: string, value: unknown) => {
    if (disposed) return Promise.reject(new Error('独立窗口已关闭'));
    if (child) return Promise.resolve(); // Source requests own completion; receiver edits are independent.
    if (!enabled) { waiting.set(key, value); return Promise.resolve(); }
    scope.outbound++;
    sequence = sequence.catch(() => {}).then(async () => {
      const encoded = await encodeWorkspaceValue(value);
      await invoke('update_workspace_window', { token, key, value: JSON.stringify(encoded) });
    }).finally(() => { scope.outbound--; });
    // Closing a peer ends mirroring, never generates an unhandled rejection.
    void sequence.catch(() => {});
    return sequence;
  };
  const unlisten = await listen<Patch>('workspace:state', event => {
    if (event.payload.token !== token) return;
    const { key, value } = event.payload;
    try {
      const decoded = decodeWorkspaceValue(JSON.parse(value));
      if (key === '@tasks') useBackgroundTasksStore.setState(state => ({ tasks: { ...state.tasks, ...decoded as WorkspacePayload['tasks'] } }));
      else if (key === '@progress') useLeadTaskProgress.setState(decoded as ReturnType<typeof useLeadTaskProgress.getState>);
      else if (key === '@ai' && child) {
        const { target, draft } = decoded as { target: AiDraftTarget; draft: { body: string; subject?: string; signature?: string } };
        deliverAiDraft(target, draft);
      } else {
        const patch = receiveLeadState(key, decoded, scope.snapshot());
        if (patch.apply) scope.write(key, patch.value);
        if (/:(aiBusy|aiGenerating|generating)$/.test(key) && decoded === false) useUIStore.getState().setAiBgTask(null);
      }
    } catch { /* Malformed or expired updates never replace the live editor. */ }
  });
  const observer = (key: string, value: unknown) => { void send(key, wrapLeadState(key, value, scope.snapshot())).catch(() => {}); };
  if (!child) scope.observers.add(observer);
  if (!child) scope.write(taskLifetimeKey, ownedTasks.size);
  const unsubTasks = useBackgroundTasksStore.subscribe((state, old) => {
    if (child || state.tasks === old.tasks) return;
    const changed = Object.fromEntries([...ownedTasks].filter(id => state.tasks[id] && state.tasks[id] !== old.tasks[id]).map(id => [id, state.tasks[id]]));
    if (Object.keys(changed).length) {
      void send('@tasks', changed).catch(() => {
        // Keep a completed result accessible in its owner if the peer closed.
        useBackgroundTasksStore.setState(state => ({ tasks: { ...changed, ...state.tasks } }));
      }).finally(() => {
        // Native requests still return through their original WebView store.
        // Retain that owner until its completion was handed to the receiver.
        if (enabled && !disposed) scope.write(taskLifetimeKey, ownedTasks.size);
      });
    }
    for (const [id, task] of Object.entries(changed)) if (task.status !== 'running') ownedTasks.delete(id);
    // The destination owns presentation and follow-on contact enrichment.
    // Clearing the source prevents two mounted copies from starting that step.
    for (const [id, task] of Object.entries(changed)) if (task.status !== 'running') {
      if (!enabled) terminalDuringHandoff.set(id, task);
      else if (useBackgroundTasksStore.getState().tasks[id] === task) useBackgroundTasksStore.getState().clear(id);
    }
  });
  const unsubProgress = useLeadTaskProgress.subscribe(state => { if (ownedTasks.size) void send('@progress', dataOnly(state)).catch(() => {}); });
  const peerClosed = new Set<() => void>();
  const unlistenClosed = await listen<{ token: string }>('workspace:closed', event => { if (event.payload.token === token) { dispose(); peerClosed.forEach(fn => fn()); } });
  let releaseSource = () => {};
  function dispose() { if (disposed) return; disposed = true; unlisten(); unlistenClosed(); unsubTasks(); unsubProgress(); scope.observers.delete(observer); activeBridges.delete(dispose); releaseSource(); }
  activeBridges.add(dispose);
  if (!child) releaseSource = trackWorkspaceSource(scope);
  return {
    send,
    onPeerClosed(callback: () => void) { peerClosed.add(callback); },
    async enable() {
      enabled = true; for (const [key, value] of waiting) send(key, value); waiting.clear(); await sequence;
      for (const [id, task] of terminalDuringHandoff) if (useBackgroundTasksStore.getState().tasks[id] === task) useBackgroundTasksStore.getState().clear(id);
      terminalDuringHandoff.clear();
      if (!child) scope.write(taskLifetimeKey, ownedTasks.size);
    },
    dispose,
  };
}

export async function detachWorkspaceTab(tab: NavTab | ComposeTab) {
  const compose = 'mode' in tab;
  const id = compose ? `compose:${tab.id}` : tab.key;
  const view = compose ? 'compose' : tab.view;
  if (!canDetachWorkspace(view) || pending.has(id)) return;
  pending.add(id);
  const scope = getWorkspaceScope(id);
  // A dormant/unvisited feature has no edits to transfer; its store context is
  // still carried so opening it in a new window uses the correct account.
  const stateScope = scope ?? new WorkspaceStateScope();
  stateScope.setTransferring(true);
  stateScope.element?.setAttribute('inert','');
  let resume: (() => void) | undefined;
  let bridge: Awaited<ReturnType<typeof connectWorkspace>> | undefined;
  let token: string | undefined;
  type Draft = { body: string; subject?: string; signature?: string };
  const bufferedDrafts: Draft[] = [];
  const target: AiDraftTarget | undefined = compose ? { tabId: tab.id, accountId: tab.activeDraftContext?.fromAccountId ?? tab.draftSnapshot?.accountId ?? tab.prefill?.accountId ?? tab.replyTo?.account_id, replyTo: tab.replyTo, prefill: tab.prefill ?? undefined } : undefined;
  let deliveryBridge: Awaited<ReturnType<typeof connectWorkspace>> | undefined;
  let transferReady = false;
  const unregister = compose ? registerDetachedDraft(tab.id, draft => {
    if (!transferReady || !deliveryBridge) { bufferedDrafts.push(draft); return; }
    void deliveryBridge.send('@ai', { target, draft }).catch(() => { unregister?.(); deliverAiDraft(target!, draft); });
  }) : undefined;
  try {
    if (compose && !scope?.prepare) throw new Error('草稿编辑器尚未准备好，请稍后再移动。');
    if (view === 'leadFinder' && useAutoDevStore.getState().running) throw new Error('自动开发正在执行邮件发送队列，请结束发送队列后再移动标签；当前任务未中断。');
    if (view === 'settings' && Object.entries(stateScope.snapshot()).some(([key, value]) => (/:(saving|testing|loading|folderLoading)$/.test(key) || /ModelDiscovery.*:busy$/.test(key)) && value === true)) throw new Error('设置正在读取、保存或测试，请完成后再移动标签。');
    resume = await scope?.prepare?.();
    const currentCompose = compose ? useComposeStore.getState().tabsById[tab.id] : undefined;
    if (compose && !currentCompose) throw new Error('原草稿已关闭，未打开重复窗口。');
    const payload: WorkspacePayload = {
      id, view, ...(compose ? { compose: currentCompose } : { tab }), state: stateScope.snapshot(),
      ui: dataOnly(useUIStore.getState()), mail: { ...dataOnly(useMailStore.getState()), ...(!compose && tab.kind === 'folder' ? { activeAccountId: tab.accountId, activeFolderId: tab.folderId } : {}) },
      tasks: Object.fromEntries(Object.entries(useBackgroundTasksStore.getState().tasks).filter(([key]) => ({ leadFinder: ['leadFinder'], companyResearch: ['companyResearch'], customerProfile: ['customerProfile','customerCompanyResearch'], addressBook: ['addressBookTagging'] } as Record<string, string[]>)[view]?.includes(key))), progress: dataOnly(useLeadTaskProgress.getState()),
      queries: queryClient.getQueriesData({ predicate: query => ['accounts', 'folders'].includes(String(query.queryKey[0])) }),
    };
    token = crypto.randomUUID();
    bridge = await connectWorkspace(token, stateScope, false, Object.keys(payload.tasks));
    deliveryBridge = bridge;
    const encoded = { view, content: await encodeWorkspaceValue(payload) };
    const closedBeforeReady = new Promise<never>((_, reject) => bridge?.onPeerClosed(() => reject(new Error('独立窗口已关闭'))));
    await Promise.race([
      invoke('open_workspace_window', { token, payload: JSON.stringify(encoded), title: compose ? (currentCompose?.draftSnapshot?.subject || currentCompose?.prefill?.subject || '写邮件') : tab.label }),
      closedBeforeReady,
    ]);
    await bridge.enable();
    for (const [key, task] of Object.entries(payload.tasks)) {
      if (task.status !== 'running' && useBackgroundTasksStore.getState().tasks[key] === task) useBackgroundTasksStore.getState().clear(key);
    }
    while (bufferedDrafts.length) {
      await bridge.send('@ai', { target, draft: bufferedDrafts[0] });
      bufferedDrafts.shift();
    }
    transferReady = true;
    stateScope.moved = true;
    if (compose) {
      const relay = bridge;
      relay.onPeerClosed(() => unregister?.());
      useComposeStore.getState().forceCloseCompose(tab.id);
    } else useUIStore.getState().removeNavTab(tab.key);
    const ui = useUIStore.getState();
    if (ui.activeView === view && (!compose || !useComposeStore.getState().activeTabId)) {
      useMailStore.getState().setSearchScope(null);
      ui.navigateToView('inbox');
    }
    // Keep the bridge alive for promises already running in the source WebView.
    bridge = undefined;
    resume = undefined;
  } catch (error) {
    unregister?.();
    for (const draft of bufferedDrafts) if (target) deliverAiDraft(target, draft);
    if (token) await invoke('cancel_workspace_window', { token }).catch(() => {});
    throw error;
  } finally {
    bridge?.dispose();
    resume?.();
    stateScope.element?.removeAttribute('inert');
    if (!stateScope.moved) stateScope.setTransferring(false);
    pending.delete(id);
  }
}
