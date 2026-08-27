import { create } from "zustand";

export type SearchScope =
  | { kind: "account"; accountId: string }
  | { kind: "folder"; accountId: string; folderId: string }
  | null;

/** 搜索范围（内联筛选下拉可随时切换；auto = 跟随侧边栏当前选择）。 */
export type SearchRange = "auto" | "folder" | "account" | "all";

interface MailState {
  // ─── UI State ──────────────────────────────────────────────────────────────
  activeAccountId: string | null;
  activeFolderId: string | null;
  /** Scope selected from the sidebar for the next mailbox search. */
  searchScope: SearchScope;
  /** 搜索范围：下拉切换后覆盖侧边栏选择；auto 跟随当前选择。 */
  searchRange: SearchRange;
  selectedMessageId: string | null;
  openMessageIds: string[];
  selectedThreadId: string | null;
  threadView: boolean;
  // ─── Batch Selection ───────────────────────────────────────────────────────
  selectedMessageIds: Set<string>;
  batchMode: boolean;

  setActiveAccountId: (accountId: string | null) => void;
  setActiveFolderId: (folderId: string | null) => void;
  setSearchScope: (scope: SearchScope) => void;
  setSearchRange: (range: SearchRange) => void;
  setSelectedMessage: (messageId: string | null) => void;
  /** 单击邮件：只选中显示，不新开标签页（双击才开标签） */
  selectMessage: (messageId: string) => void;
  closeMessageTab: (messageId: string) => void;
  /** 关闭某个标签右侧的所有标签（保留该标签及其左侧） */
  closeTabsToRight: (messageId: string) => void;
  /** 关闭某个标签左侧的所有标签（保留该标签及其右侧） */
  closeTabsToLeft: (messageId: string) => void;
  /** 关闭除指定标签外的所有标签 */
  closeOtherTabs: (messageId: string) => void;
  /** 关闭所有标签 */
  closeAllTabs: () => void;
  setSelectedThreadId: (threadId: string | null) => void;
  toggleThreadView: () => void;
  toggleBatchMode: () => void;
  toggleMessageSelection: (messageId: string) => void;
  selectAllMessages: (messageIds: string[]) => void;
  clearSelection: () => void;
}

export const useMailStore = create<MailState>((set, get) => ({
  activeAccountId: null,
  activeFolderId: null,
  searchScope: null,
  searchRange: "auto",
  selectedMessageId: null,
  openMessageIds: [],
  selectedThreadId: null,
  threadView: false,
  selectedMessageIds: new Set<string>(),
  batchMode: false,

  setActiveAccountId: (accountId) => {
    set({
      activeAccountId: accountId,
      activeFolderId: null,
      selectedMessageId: null,
      selectedThreadId: null,
      selectedMessageIds: new Set(),
      batchMode: false,
    });
  },

  setActiveFolderId: (folderId) => {
    set({
      activeFolderId: folderId,
      selectedMessageId: null,
      selectedThreadId: null,
      selectedMessageIds: new Set(),
      batchMode: false,
    });
  },

  setSearchScope: (scope) => set({ searchScope: scope }),
  setSearchRange: (range) => set({ searchRange: range }),

  setSelectedMessage: (messageId) => {
    set((state) => ({
      selectedMessageId: messageId,
      openMessageIds: messageId && !state.openMessageIds.includes(messageId)
        ? [...state.openMessageIds, messageId]
        : state.openMessageIds,
    }));
  },

  /** 单击邮件：只选中并在当前视图显示，不新开标签页（双击才开标签）。 */
  selectMessage: (messageId) => {
    set({
      selectedMessageId: messageId,
      selectedThreadId: null,
    });
  },

  closeMessageTab: (messageId) => {
    set((state) => {
      const index = state.openMessageIds.indexOf(messageId);
      const openMessageIds = state.openMessageIds.filter((id) => id !== messageId);
      if (state.selectedMessageId !== messageId) return { openMessageIds };
      const next = openMessageIds[Math.min(index, openMessageIds.length - 1)] ?? null;
      return { openMessageIds, selectedMessageId: next };
    });
  },

  closeTabsToRight: (messageId) => {
    set((state) => {
      const index = state.openMessageIds.indexOf(messageId);
      if (index < 0) return {};
      const keep = state.openMessageIds.slice(0, index + 1);
      const closed = state.openMessageIds.slice(index + 1);
      const selectedMessageId = closed.includes(state.selectedMessageId ?? "") ? messageId : state.selectedMessageId;
      return { openMessageIds: keep, selectedMessageId };
    });
  },

  closeTabsToLeft: (messageId) => {
    set((state) => {
      const index = state.openMessageIds.indexOf(messageId);
      if (index < 0) return {};
      const keep = state.openMessageIds.slice(index);
      const closed = state.openMessageIds.slice(0, index);
      const selectedMessageId = closed.includes(state.selectedMessageId ?? "") ? messageId : state.selectedMessageId;
      return { openMessageIds: keep, selectedMessageId };
    });
  },

  closeOtherTabs: (messageId) => {
    set((state) => ({
      openMessageIds: [messageId],
      selectedMessageId: state.selectedMessageId === messageId ? messageId : messageId,
    }));
  },

  closeAllTabs: () => {
    set({
      openMessageIds: [],
      selectedMessageId: null,
    });
  },

  setSelectedThreadId: (threadId) => {
    set({ selectedThreadId: threadId });
  },

  toggleThreadView: () => {
    set({
      threadView: !get().threadView,
      selectedThreadId: null,
      selectedMessageId: null,
      selectedMessageIds: new Set(),
      batchMode: false,
    });
  },

  toggleBatchMode: () => {
    const current = get().batchMode;
    set({
      batchMode: !current,
      selectedMessageIds: new Set(),
    });
  },

  toggleMessageSelection: (messageId) => {
    const ids = new Set(get().selectedMessageIds);
    if (ids.has(messageId)) ids.delete(messageId);
    else ids.add(messageId);
    set({ selectedMessageIds: ids });
  },

  selectAllMessages: (messageIds) => {
    set({ selectedMessageIds: new Set(messageIds) });
  },

  clearSelection: () => {
    set({ selectedMessageIds: new Set() });
  },
}));
