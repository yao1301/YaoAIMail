import { create } from "zustand";
import type { Message } from "@/lib/api";
import { useUIStore, type ActiveView } from "./ui.store";
import type { ComposeAttachment, ComposeDraftSnapshot } from "@/features/compose/compose-draft";
import type { MailReference } from "@/lib/mailReferenceDrag";

/** 是否处于独立写信窗口（?compose=1，遗留入口，不再主动创建）。 */
export function isComposeWindow(): boolean {
  return new URLSearchParams(window.location.search).get("compose") === "1";
}

export type ComposeMode = "new" | "reply" | "reply-all" | "forward";

export interface ComposePrefill {
  accountId?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  /** Pre-attached files (used by “reply all with attachments”). */
  attachments?: ComposeAttachment[];
  /** AI 草稿需使用保存的签名原文，避免编辑器自动追加另一份默认签名。 */
  aiGenerated?: boolean;
  signature?: string;
}

export interface ComposeContext {
  fromAccountId?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  bodyText?: string;
}

/** 一封独立的写信标签（主窗口标签栏中的一项）。 */
export interface ComposeTab {
  id: string;
  mode: ComposeMode;
  replyTo: Message | null;
  prefill: ComposePrefill | null;
  /** 挂载 key：每次打开递增，用于强制重挂载写信视图。 */
  key: number;
  dirty: boolean;
  draftSnapshot: ComposeDraftSnapshot | null;
  pendingAiBody: string | null;
  pendingAiSubject: string | null;
  pendingAiSignature: string | null;
  /** Explicit mail drops waiting for this tab's instruction box to mount/be idle. */
  pendingAiReferences?: MailReference[];
  activeDraftContext: ComposeContext | null;
}

interface ComposeState {
  /** 主窗口内的写信标签（按打开顺序）。 */
  tabs: ComposeTab[];
  tabsById: Record<string, ComposeTab>;
  activeTabId: string | null;
  /** ── 投影字段：等于激活标签的值（兼容独立窗口与既有消费方）── */
  composeMode: ComposeMode | null;
  composeReplyTo: Message | null;
  composePrefill: ComposePrefill | null;
  composeKey: number;
  composeDirty: boolean;
  activeDraftContext: ComposeContext | null;
  draftSnapshot: ComposeDraftSnapshot | null;
  pendingAiBody: string | null;
  pendingAiSubject: string | null;
  pendingAiSignature: string | null;
  /** 关闭确认对话框（针对 pendingCloseTabId 对应标签）。 */
  showComposeLeaveConfirm: boolean;
  pendingView: ActiveView | null;
  pendingCloseTabId: string | null;
  setComposeDirty: (dirty: boolean, tabId?: string) => void;
  setActiveDraftContext: (context: ComposeContext | null, tabId?: string) => void;
  setDraftSnapshot: (snapshot: ComposeDraftSnapshot | null, tabId?: string) => void;
  applyAiBody: (body: string, tabId?: string) => boolean;
  applyAiDraft: (draft: { body: string; subject?: string; signature?: string }, tabId?: string) => boolean;
  clearPendingAiBody: (tabId?: string) => void;
  openCompose: (mode: ComposeMode, replyTo?: Message | null, prefill?: ComposePrefill | null) => void;
  openDraft: (snapshot: ComposeDraftSnapshot) => void;
  /** 切换激活的写信标签并同步投影。 */
  activateComposeTab: (tabId: string) => void;
  queueAiReference: (tabId: string, reference: MailReference) => void;
  clearAiReferences: (tabId: string) => void;
  /** 关闭标签（默认激活标签）；有未保存修改时弹确认。 */
  closeCompose: (tabId?: string) => void;
  /** 强制关闭标签（右键批量操作），跳过未保存确认。 */
  forceCloseCompose: (tabId: string) => void;
  confirmCloseCompose: () => void;
  cancelCloseCompose: () => void;
  discardComposeAndSetActiveView: (view: ActiveView) => void;
}

let tabSeq = 0;
function nextTabId(): string {
  tabSeq += 1;
  return `compose-${Date.now()}-${tabSeq}`;
}
let keySeq = 0;
function nextKey(): number {
  keySeq += 1;
  return keySeq;
}

/** 从标签计算投影字段。 */
function projectTab(tab: ComposeTab | null) {
  return {
    composeMode: tab?.mode ?? null,
    composeReplyTo: tab?.replyTo ?? null,
    composePrefill: tab?.prefill ?? null,
    composeKey: tab?.key ?? 0,
    composeDirty: tab?.dirty ?? false,
    activeDraftContext: tab?.activeDraftContext ?? null,
    draftSnapshot: tab?.draftSnapshot ?? null,
    pendingAiBody: tab?.pendingAiBody ?? null,
    pendingAiSubject: tab?.pendingAiSubject ?? null,
    pendingAiSignature: tab?.pendingAiSignature ?? null,
  };
}

function getComposeResetState() {
  return {
    composeMode: null as ComposeMode | null,
    composeReplyTo: null as Message | null,
    composePrefill: null as ComposePrefill | null,
    composeDirty: false,
    activeDraftContext: null as ComposeContext | null,
    draftSnapshot: null as ComposeDraftSnapshot | null,
    pendingAiBody: null as string | null,
    pendingAiSubject: null as string | null,
    pendingAiSignature: null as string | null,
  };
}

/** 是否有任何未保存的写信草稿（主窗口任一标签 dirty，或独立窗口内嵌会话 dirty）。 */
export function isComposeDirty(): boolean {
  const compose = useComposeStore.getState();
  if (compose.tabs.some((tab) => tab.dirty)) return true;
  return compose.composeMode !== null && compose.composeDirty;
}

export const useComposeStore = create<ComposeState>((set) => ({
  tabs: [],
  tabsById: {},
  activeTabId: null,
  composeMode: null,
  composeReplyTo: null,
  composePrefill: null,
  composeKey: 0,
  composeDirty: false,
  activeDraftContext: null,
  draftSnapshot: null,
  pendingAiBody: null,
  pendingAiSubject: null,
  pendingAiSignature: null,
  showComposeLeaveConfirm: false,
  pendingView: null,
  pendingCloseTabId: null,
  queueAiReference: (tabId, reference) => set(state => {
    const tab = state.tabsById[tabId];
    if (!tab || !reference.id) return {};
    const pending = tab.pendingAiReferences ?? [];
    if (pending.some(item => item.id === reference.id)) return {};
    const updated = { ...tab, pendingAiReferences: [...pending, reference] };
    return { tabs: state.tabs.map(item => item.id === tabId ? updated : item), tabsById: { ...state.tabsById, [tabId]: updated } };
  }),
  clearAiReferences: tabId => set(state => {
    const tab = state.tabsById[tabId];
    if (!tab?.pendingAiReferences?.length) return {};
    const updated = { ...tab, pendingAiReferences: [] };
    return { tabs: state.tabs.map(item => item.id === tabId ? updated : item), tabsById: { ...state.tabsById, [tabId]: updated } };
  }),
  setComposeDirty: (dirty, tabId) => {
    set((state) => {
      const id = tabId ?? state.activeTabId;
      if (!id) return state.composeMode ? { composeDirty: dirty } : {};
      if (!state.tabsById[id]) return {};
      const updated = { ...state.tabsById[id], dirty };
      return {
        tabs: state.tabs.map((tab) => (tab.id === id ? updated : tab)),
        tabsById: { ...state.tabsById, [id]: updated },
        ...(state.activeTabId === id ? { composeDirty: dirty } : {}),
      };
    });
  },
  setActiveDraftContext: (context, tabId) => {
    set((state) => {
      const id = tabId ?? state.activeTabId;
      if (!id && isComposeWindow()) return { activeDraftContext: context };
      if (!id || !state.tabsById[id]) return {};
      const updated = { ...state.tabsById[id], activeDraftContext: context };
      return {
        tabs: state.tabs.map((tab) => (tab.id === id ? updated : tab)),
        tabsById: { ...state.tabsById, [id]: updated },
        ...(state.activeTabId === id ? { activeDraftContext: context } : {}),
      };
    });
  },
  setDraftSnapshot: (snapshot, tabId) => {
    set((state) => {
      const id = tabId ?? state.activeTabId;
      if (!id || !state.tabsById[id]) return {};
      const updated = { ...state.tabsById[id], draftSnapshot: snapshot };
      return {
        tabs: state.tabs.map((tab) => (tab.id === id ? updated : tab)),
        tabsById: { ...state.tabsById, [id]: updated },
        ...(state.activeTabId === id ? { draftSnapshot: snapshot } : {}),
      };
    });
  },
  applyAiBody: (body, tabId) => {
    let accepted = false;
    set((state) => {
      const id = tabId ?? state.activeTabId;
      if (!id && isComposeWindow() && state.composeMode) {
        accepted = true;
        return { pendingAiBody: body };
      }
      if (!id || !state.tabsById[id]) return {};
      accepted = true;
      const updated = { ...state.tabsById[id], pendingAiBody: body };
      return {
        tabs: state.tabs.map((tab) => (tab.id === id ? updated : tab)),
        tabsById: { ...state.tabsById, [id]: updated },
        ...(state.activeTabId === id ? { pendingAiBody: body } : {}),
      };
    });
    return accepted;
  },
  applyAiDraft: (draft, tabId) => {
    let accepted = false;
    set((state) => {
      const id = tabId ?? state.activeTabId;
      if (!id && isComposeWindow() && state.composeMode) {
        accepted = true;
        return { pendingAiBody: draft.body, pendingAiSubject: draft.subject ?? null, pendingAiSignature: draft.signature ?? null };
      }
      if (!id || !state.tabsById[id]) return {};
      accepted = true;
      const updated = { ...state.tabsById[id], pendingAiBody: draft.body, pendingAiSubject: draft.subject ?? null, pendingAiSignature: draft.signature ?? null };
      return {
        tabs: state.tabs.map((tab) => (tab.id === id ? updated : tab)),
        tabsById: { ...state.tabsById, [id]: updated },
        ...(state.activeTabId === id ? { pendingAiBody: draft.body, pendingAiSubject: draft.subject ?? null, pendingAiSignature: draft.signature ?? null } : {}),
      };
    });
    return accepted;
  },
  clearPendingAiBody: (tabId) => {
    set((state) => {
      const id = tabId ?? state.activeTabId;
      if (!id && isComposeWindow()) return { pendingAiBody: null, pendingAiSubject: null, pendingAiSignature: null };
      if (!id || !state.tabsById[id]) return {};
      const updated = { ...state.tabsById[id], pendingAiBody: null, pendingAiSubject: null, pendingAiSignature: null };
      return {
        tabs: state.tabs.map((tab) => (tab.id === id ? updated : tab)),
        tabsById: { ...state.tabsById, [id]: updated },
        ...(state.activeTabId === id ? { pendingAiBody: null, pendingAiSubject: null, pendingAiSignature: null } : {}),
      };
    });
  },
  openCompose: (mode, replyTo = null, prefill = null) => {
    // 独立写信窗口（遗留入口）不再新增标签，保持内嵌会话。
    if (isComposeWindow()) {
      openComposeEmbedded(set, mode, replyTo, prefill);
      return;
    }
    const id = nextTabId();
    const tab: ComposeTab = {
      id, mode, replyTo, prefill,
      key: nextKey(), dirty: false,
      draftSnapshot: null, pendingAiBody: null, pendingAiSubject: null, pendingAiSignature: null, activeDraftContext: null,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      tabsById: { ...state.tabsById, [id]: tab },
      activeTabId: id,
      showComposeLeaveConfirm: false,
      pendingView: null,
      pendingCloseTabId: null,
      ...projectTab(tab),
    }));
    const uiState = useUIStore.getState();
    useUIStore.setState({
      previousView: uiState.activeView === "compose" ? uiState.previousView : uiState.activeView,
      activeView: "compose",
    });
  },
  openDraft: (snapshot) => {
    if (isComposeWindow()) {
      // 独立窗口内打开草稿：直接写入内嵌会话。
      const uiState = useUIStore.getState();
      useUIStore.setState({
        previousView: uiState.activeView === "compose" ? uiState.previousView : uiState.activeView,
        activeView: "compose" as ActiveView,
      });
      set((state) => ({
        composeMode: "new",
        composeReplyTo: null,
        composePrefill: null,
        composeKey: state.composeKey + 1,
        composeDirty: false,
        activeDraftContext: null,
        draftSnapshot: snapshot,
        pendingAiBody: null,
        showComposeLeaveConfirm: false,
        pendingView: null,
        pendingCloseTabId: null,
      }));
      return;
    }
    const id = nextTabId();
    const tab: ComposeTab = {
      id, mode: "new", replyTo: null, prefill: null,
      key: nextKey(), dirty: false,
      draftSnapshot: snapshot, pendingAiBody: null, pendingAiSubject: null, pendingAiSignature: null, activeDraftContext: null,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      tabsById: { ...state.tabsById, [id]: tab },
      activeTabId: id,
      showComposeLeaveConfirm: false,
      pendingView: null,
      pendingCloseTabId: null,
      ...projectTab(tab),
    }));
    const uiState = useUIStore.getState();
    useUIStore.setState({
      previousView: uiState.activeView === "compose" ? uiState.previousView : uiState.activeView,
      activeView: "compose",
    });
  },
  activateComposeTab: (tabId) => {
    set((state) => {
      const tab = state.tabsById[tabId];
      if (!tab) return {};
      return {
        activeTabId: tabId,
        showComposeLeaveConfirm: false,
        pendingView: null,
        pendingCloseTabId: null,
        ...projectTab(tab),
      };
    });
  },
  closeCompose: (tabId) => {
    const state = useComposeStore.getState();
    const targetId = tabId ?? state.activeTabId;
    if (!targetId) {
      if (!state.composeMode) return;
      if (state.composeDirty) set({ showComposeLeaveConfirm: true, pendingCloseTabId: null, pendingView: null });
      else closeEmbeddedCompose(set);
      return;
    }
    const tab = state.tabsById[targetId];
    if (!tab) return;
    if (tab.dirty) {
      // 有未保存修改：先确保该标签处于激活状态，再弹确认框。
      if (state.activeTabId !== targetId) {
        useComposeStore.getState().activateComposeTab(targetId);
      }
      set({
        showComposeLeaveConfirm: true,
        pendingCloseTabId: targetId,
        pendingView: null,
      });
      return;
    }
    removeComposeTabNow(set, targetId);
  },
  forceCloseCompose: (tabId) => {
    removeComposeTabNow(set, tabId);
  },
  confirmCloseCompose: () => {
    const state = useComposeStore.getState();
    const targetId = state.pendingCloseTabId ?? state.activeTabId;
    if (!targetId) {
      set({ showComposeLeaveConfirm: false, pendingCloseTabId: null, pendingView: null });
      if (state.composeMode) closeEmbeddedCompose(set);
      return;
    }
    set({ showComposeLeaveConfirm: false, pendingCloseTabId: null, pendingView: null });
    removeComposeTabNow(set, targetId);
  },
  cancelCloseCompose: () => set({ showComposeLeaveConfirm: false, pendingView: null, pendingCloseTabId: null }),
  discardComposeAndSetActiveView: (view) => {
    const state = useComposeStore.getState();
    const targetId = state.activeTabId;
    // 先删标签（最后一个标签关闭时内部会回退 previousView），再覆盖为目标视图。
    if (targetId) removeComposeTabNow(set, targetId);
    useUIStore.setState({ activeView: view });
    set({
      showComposeLeaveConfirm: false,
      pendingView: null,
      pendingCloseTabId: null,
    });
  },
}));

function closeEmbeddedCompose(set: (partial: Partial<ComposeState>) => void) {
  const ui = useUIStore.getState();
  useUIStore.setState({ activeView: ui.previousView === 'compose' ? 'inbox' : ui.previousView });
  set({ ...getComposeResetState(), showComposeLeaveConfirm: false, pendingCloseTabId: null, pendingView: null });
}

/** 从标签列表中移除指定标签，并修正激活标签与视图（不弹确认，内部用）。 */
function removeComposeTabNow(
  set: (partial: Partial<ComposeState> | ((state: ComposeState) => Partial<ComposeState>)) => void,
  targetId: string,
) {
  const state = useComposeStore.getState();
  const tab = state.tabsById[targetId];
  if (!tab) return;
  const remaining = state.tabs.filter((item) => item.id !== targetId);
  const tabsById = { ...state.tabsById };
  delete tabsById[targetId];
  const wasActive = state.activeTabId === targetId;
  if (remaining.length === 0) {
    // 最后一个写信标签关闭：离开写信视图。
    const uiState = useUIStore.getState();
    const fallback = uiState.previousView === "compose" || uiState.previousView === "messageDetail" ? "inbox" : uiState.previousView;
    useUIStore.setState({ activeView: fallback });
    set({
      tabs: [],
      tabsById: {},
      activeTabId: null,
      showComposeLeaveConfirm: false,
      pendingView: null,
      pendingCloseTabId: null,
      ...getComposeResetState(),
    });
    return;
  }
  if (wasActive) {
    // 激活的是被关标签 → 激活最后一个剩余标签。
    const nextTab = remaining[remaining.length - 1];
    set({
      tabs: remaining,
      tabsById,
      activeTabId: nextTab.id,
      showComposeLeaveConfirm: false,
      pendingView: null,
      pendingCloseTabId: null,
      ...projectTab(nextTab),
    });
    return;
  }
  set({
    tabs: remaining,
    tabsById,
    showComposeLeaveConfirm: false,
    pendingView: null,
    pendingCloseTabId: null,
  });
}

/** 主窗口内嵌写信视图的旧语义（独立写信窗口使用，不新增标签）。 */
function openComposeEmbedded(
  set: (partial: Partial<ComposeState>) => void,
  mode: ComposeMode,
  replyTo: Message | null,
  prefill: ComposePrefill | null,
) {
  const uiState = useUIStore.getState();
  useUIStore.setState({
    previousView: uiState.activeView === "compose" ? uiState.previousView : uiState.activeView,
    activeView: "compose" as ActiveView,
  });
  set({
    composeMode: mode,
    composeReplyTo: replyTo,
    composePrefill: prefill,
    composeKey: useComposeStore.getState().composeKey + 1,
    composeDirty: false,
    activeDraftContext: null,
    draftSnapshot: null,
    pendingAiBody: null,
    showComposeLeaveConfirm: false,
    pendingView: null,
    pendingCloseTabId: null,
  });
}
