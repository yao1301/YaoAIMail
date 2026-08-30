import { create } from "zustand";
import i18n from "@/lib/i18n";
import { getInitialLanguage, LANGUAGE_STORAGE_KEY, type Language } from "@/lib/language";
import { profileLocalStorage, profileSessionStorage } from "@/lib/profileStorage";
import { readStartHiddenToTrayPreference, START_HIDDEN_TO_TRAY_KEY } from "@/lib/startupVisibility";
import { useMailStore } from "./mail.store";
import type { AdvancedSearchQuery } from "@/lib/api";

export type ActiveView = "inbox" | "addressBook" | "companyResearch" | "leadFinder" | "kanban" | "settings" | "search" | "starred" | "snoozed" | "compose" | "aiWriting" | "aiAssistant" | "foreignTools" | "customerProfile" | "messageDetail";

// Snooze was an experimental virtual mailbox, not a real server folder.  It
// is intentionally disabled now: old callers or stale in-memory tabs must not
// be able to bring the removed view back into the navigation UI.
const REMOVED_VIEWS = new Set<ActiveView>(["snoozed"]);

function normalizeActiveView(view: ActiveView): ActiveView {
  return REMOVED_VIEWS.has(view) ? "inbox" : view;
}

/** Chrome 式标签：文件夹标签（单一、动态改名）+ 功能标签（邮件标签沿用 openMessageIds） */
export interface NavTab {
  key: string;
  kind: "folder" | "feature";
  label: string;
  view: ActiveView;
  folderId?: string | null;
  accountId?: string | null;
}
export type RightPanelTool = "aiWriting" | "aiAssistant" | "foreignTools";
export type SettingsTab = "accounts" | "general" | "proxy" | "appearance" | "privacy" | "rules" | "remoteWrites" | "translation" | "aiWriting" | "workRole" | "knowledgeBase" | "aiAssistant" | "customerMemory" | "foreignTools" | "externalServices" | "sendGuard" | "shortcuts" | "cloudSync" | "about";
export type Theme = "light" | "dark" | "warm" | "ocean" | "forest" | "highContrast" | "system";
export type AppFontFamily = "system" | "yahei" | "songti" | "rounded" | "mono";
export type { Language } from "@/lib/language";
export type NetworkStatus = "online" | "offline";
export type RealtimeMode = "realtime" | "polling" | "manual" | "backoff" | "offline" | "auth_required" | "error";
export type RealtimePreference = "realtime" | "balanced" | "battery" | "manual";
export type BackgroundImageFit = "cover" | "contain" | "repeat";

export interface BackgroundImageSettings {
  path: string;
  filename: string;
  fit: BackgroundImageFit;
  opacity: number;
  updatedAt: number;
}

export interface RealtimeStatus {
  account_id: string;
  mode: RealtimeMode;
  provider: string;
  last_success_at?: number | null;
  next_retry_at?: number | null;
  message?: string | null;
}

const REALTIME_PREFERENCE_KEY = "pebble-realtime-mode";
const REALTIME_PREFERENCES = new Set<RealtimePreference>(["realtime", "balanced", "battery", "manual"]);
const NOTIFICATIONS_KEY = "pebble-notifications-enabled";
const KEEP_RUNNING_BACKGROUND_KEY = "pebble-keep-running-background";
export const BACKGROUND_IMAGE_STORAGE_KEY = "pebble-background-image-settings";
const BACKGROUND_IMAGE_FITS = new Set<BackgroundImageFit>(["cover", "contain", "repeat"]);
const DEFAULT_BACKGROUND_IMAGE_FIT: BackgroundImageFit = "cover";
const DEFAULT_BACKGROUND_IMAGE_OPACITY = 0.35;
const MIN_BACKGROUND_IMAGE_OPACITY = 0.05;
const MAX_BACKGROUND_IMAGE_OPACITY = 1;

function readRealtimePreference(): RealtimePreference {
  const stored = profileLocalStorage.getItem(REALTIME_PREFERENCE_KEY);
  return REALTIME_PREFERENCES.has(stored as RealtimePreference)
    ? (stored as RealtimePreference)
    : "realtime";
}

function clampBackgroundImageOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BACKGROUND_IMAGE_OPACITY;
  return Math.min(MAX_BACKGROUND_IMAGE_OPACITY, Math.max(MIN_BACKGROUND_IMAGE_OPACITY, value));
}

function readBackgroundImageSettings(): BackgroundImageSettings | null {
  const stored = profileLocalStorage.getItem(BACKGROUND_IMAGE_STORAGE_KEY);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as Partial<BackgroundImageSettings>;
    if (!parsed || typeof parsed.path !== "string" || typeof parsed.filename !== "string") {
      return null;
    }
    const fit = BACKGROUND_IMAGE_FITS.has(parsed.fit as BackgroundImageFit)
      ? parsed.fit as BackgroundImageFit
      : DEFAULT_BACKGROUND_IMAGE_FIT;
    return {
      path: parsed.path,
      filename: parsed.filename,
      fit,
      opacity: clampBackgroundImageOpacity(Number(parsed.opacity ?? DEFAULT_BACKGROUND_IMAGE_OPACITY)),
      updatedAt: Number.isFinite(Number(parsed.updatedAt)) ? Number(parsed.updatedAt) : Date.now(),
    };
  } catch {
    return null;
  }
}

function persistBackgroundImageSettings(settings: BackgroundImageSettings | null) {
  if (!settings) {
    profileLocalStorage.removeItem(BACKGROUND_IMAGE_STORAGE_KEY);
    return;
  }
  profileLocalStorage.setItem(BACKGROUND_IMAGE_STORAGE_KEY, JSON.stringify(settings));
}

export function readNotificationsEnabledPreference(): boolean {
  const stored = profileLocalStorage.getItem(NOTIFICATIONS_KEY);
  return stored === null ? true : stored === "true";
}

export function readKeepRunningInBackgroundPreference(): boolean {
  const stored = profileLocalStorage.getItem(KEEP_RUNNING_BACKGROUND_KEY);
  return stored === null ? true : stored === "true";
}

export function realtimePreferenceToPollInterval(mode: RealtimePreference): number {
  switch (mode) {
    case "realtime":
      return 3;
    case "balanced":
      return 15;
    case "battery":
      return 60;
    case "manual":
      return 0;
  }
}

const initialRealtimeMode = readRealtimePreference();
const initialNotificationsEnabled = readNotificationsEnabledPreference();
const initialKeepRunningInBackground = readKeepRunningInBackgroundPreference();
const initialStartHiddenToTray = readStartHiddenToTrayPreference();
const initialLanguage = getInitialLanguage();
const initialBackgroundImage = readBackgroundImageSettings();

/** Resolve "system" theme to an actual "dark" | "light" value. */
export function resolveTheme(theme: Theme): "dark" | "light" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme === "dark" || theme === "highContrast" ? "dark" : "light";
}

/** Apply the resolved theme to the DOM immediately (no React effect needed). */
export function applyThemeToDom(theme: Theme) {
  document.documentElement.setAttribute(
    "data-theme",
    theme === "system" ? resolveTheme(theme) : theme,
  );
}

export function applyTypographyToDom(fontFamily: AppFontFamily, fontScale: number) {
  const families: Record<AppFontFamily, string> = {
    system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    yahei: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    songti: '"SimSun", "Songti SC", serif',
    rounded: '"Microsoft JhengHei UI", "PingFang SC", "Segoe UI", sans-serif',
    mono: '"Cascadia Mono", Consolas, monospace',
  };
  document.documentElement.style.setProperty("--app-font-family", families[fontFamily]);
  document.documentElement.style.setProperty("--app-font-scale", String(fontScale));
}

interface UIState {
  sidebarCollapsed: boolean;
  activeView: ActiveView;
  rightPanelOpen: boolean;
  rightPanelTool: RightPanelTool;
  /** 已打开的右侧工具面板；最多同时显示 AI 写作和外贸工具两个面板。 */
  rightPanelTools: RightPanelTool[];
  aiWritingFloating: boolean;
  aiWritingFloatPosition: { x: number; y: number };
  setAiWritingFloating: (floating: boolean) => void;
  setAiWritingFloatPosition: (position: { x: number; y: number }) => void;
  openRightPanel: (tool: RightPanelTool) => void;
  closeRightPanel: (tool?: RightPanelTool) => void;
  theme: Theme;
  fontFamily: AppFontFamily;
  fontScale: number;
  setFontFamily: (fontFamily: AppFontFamily) => void;
  setFontScale: (fontScale: number) => void;
  backgroundImage: BackgroundImageSettings | null;
  language: Language;
  syncStatus: "idle" | "syncing" | "error";
  networkStatus: NetworkStatus;
  lastMailError: string | null;
  realtimeStatusByAccount: Record<string, RealtimeStatus>;
  realtimeMode: RealtimePreference;
  notificationsEnabled: boolean;
  setNotificationsEnabled: (enabled: boolean) => void;
  keepRunningInBackground: boolean;
  setKeepRunningInBackground: (enabled: boolean) => void;
  startHiddenToTray: boolean;
  setStartHiddenToTray: (enabled: boolean) => void;
  previousView: ActiveView;
  toggleSidebar: () => void;
  /** 统一切换主内容视图；标签栏和侧边栏都必须走这条路径。 */
  navigateToView: (view: ActiveView) => void;
  setActiveView: (view: ActiveView) => void;
  /** 从地址本跳转到客户画像时预填的邮箱（消费后清空） */
  customerProfileEmail: string | null;
  setCustomerProfileEmail: (email: string | null) => void;
  openMessageInInbox: (messageId: string) => void;
  setTheme: (theme: Theme) => void;
  setBackgroundImage: (image: { path: string; filename: string }) => void;
  setBackgroundImageFit: (fit: BackgroundImageFit) => void;
  setBackgroundImageOpacity: (opacity: number) => void;
  clearBackgroundImage: () => void;
  setLanguage: (lang: Language) => void;
  setSyncStatus: (status: "idle" | "syncing" | "error") => void;
  setNetworkStatus: (status: NetworkStatus) => void;
  setLastMailError: (error: string | null) => void;
  setRealtimeStatus: (accountId: string, status: RealtimeStatus) => void;
  setRealtimeMode: (mode: RealtimePreference) => void;
  pollInterval: number;
  setPollInterval: (secs: number) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  /** 从侧边栏账号右键跳转到「设置→账户」时预选中的账号 id */
  focusAccountId: string | null;
  setFocusAccountId: (id: string | null) => void;
  /** AI 写作指令框互斥：哪个入口获得了焦点，另一个就禁用。
   *  "compose" = 写信/回复页草稿栏下方；"panel" = 右侧工作区或悬浮窗。 */
  aiInputFocusOwner: "compose" | "panel" | null;
  setAiInputFocusOwner: (owner: "compose" | "panel" | null) => void;
  /** 全屏标签阅读：双击/右键打开时，该邮件的标签只显示邮件详情（无列表） */
  messageDetailId: string | null;
  setMessageDetailId: (messageId: string | null) => void;
  /** Chrome 式导航标签：文件夹标签 + 功能标签 */
  navTabs: NavTab[];
  upsertNavTab: (tab: NavTab) => void;
  removeNavTab: (key: string) => void;
  setNavTabs: (tabs: NavTab[]) => void;
  /** AI 后台生成完成但写信页已关闭时暂存的结果，回写信页时自动应用 */
  pendingAiDraft: string | null;
  setPendingAiDraft: (draft: string | null) => void;
  /** 内联筛选下拉注入的搜索条件：SearchView 挂载时消费后清空。 */
  pendingSearchFilters: AdvancedSearchQuery | null;
  setPendingSearchFilters: (filters: AdvancedSearchQuery | null) => void;
  /** AI 写作后台生成任务（全局，不随组件卸载丢失）：
   *  running 时标签页/右侧面板显示进行中；done 后 result 供各处提醒/应用。 */
  aiBgTask: { running: boolean; source: "compose" | "panel"; result: string | null } | null;
  setAiBgTask: (task: { running: boolean; source: "compose" | "panel"; result: string | null } | null) => void;
  /** 写信页与右侧/悬浮 AI 写作共用的同一条对话历史（不含 system）。
   *  两边读写同一份，避免各自独立导致上下文脱节。 */
  aiWritingTurns: { role: "user" | "assistant"; content: string }[];
  setAiWritingTurns: (turns: { role: "user" | "assistant"; content: string }[]) => void;
  /** 首页 AI 工作台识别为写作意图后，传给 AI 写作输入框的一次性指令。 */
  pendingAiWritingInstruction: string | null;
  setPendingAiWritingInstruction: (instruction: string | null) => void;
  pendingRuleDraftText: string | null;
  setPendingRuleDraftText: (text: string | null) => void;
  /** 开发客户输入保留（切页回来不丢） */
  leadFinderDraft: { product: string; market: string; buyerType: string; query: string } | null;
  setLeadFinderDraft: (d: { product: string; market: string; buyerType: string; query: string } | null) => void;
  /** 资信调研输入保留 */
  companyResearchDraft: { company: string; website: string; country: string } | null;
  setCompanyResearchDraft: (d: { company: string; website: string; country: string } | null) => void;
  /** 客户管理搜索/筛选保留 */
  customerProfileSearch: string;
  customerProfileFilter: string;
  setCustomerProfileSearch: (q: string) => void;
  setCustomerProfileFilter: (f: string) => void;
  showFolderUnreadCount: boolean;
  setShowFolderUnreadCount: (show: boolean) => void;
  /** 从右键菜单“发送到 AI 写作”进来的待处理内容（AiWritingTab 会消费） */
  aiContextQueue: Array<{ messageId: string; title: string }>;
  aiContextAttachmentQueue: Array<{ attachmentId: string; title: string }>;
  enqueueAiContext: (messageId: string, title: string) => void;
  enqueueAiContextAttachment: (attachmentId: string, title: string) => void;
  clearAiContextQueue: () => void;
  /** 从邮件/附件右键菜单发送到 AI 开发客户的待处理内容 */
  leadContextQueue: Array<{ messageId: string; title: string }>;
  leadContextAttachmentQueue: Array<{ attachmentId: string; title: string }>;
  enqueueLeadContext: (messageId: string, title: string) => void;
  enqueueLeadContextAttachment: (attachmentId: string, title: string) => void;
  clearLeadContextQueue: () => void;
  /** 从邮件/附件右键菜单发送到首页 AI 工作台。 */
  homeContextQueue: Array<{ messageId: string; title: string }>;
  homeContextAttachmentQueue: Array<{ attachmentId: string; title: string }>;
  enqueueHomeContext: (messageId: string, title: string) => void;
  enqueueHomeContextAttachment: (attachmentId: string, title: string) => void;
  clearHomeContextQueue: () => void;
  /** 资料中心右键发送到指定 AI 输入区；目标页面消费后清空。 */
  knowledgeContextQueue: Array<{ itemId: string; title: string; target: "writing" | "compose" | "leadFinder" | "companyResearch" | "home" }>;
  enqueueKnowledgeContext: (itemId: string, title: string, target: "writing" | "compose" | "leadFinder" | "companyResearch" | "home") => void;
  clearKnowledgeContextQueue: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarCollapsed: false,
  activeView: "kanban",
  rightPanelOpen: false,
  rightPanelTool: "aiWriting",
  rightPanelTools: [],
  aiWritingFloating: profileLocalStorage.getItem("yao-ai-writing-floating") === "true",
  aiWritingFloatPosition: (() => {
    try {
      const value = JSON.parse(profileLocalStorage.getItem("yao-ai-writing-position") || "null");
      return value && Number.isFinite(value.x) && Number.isFinite(value.y)
        ? { x: value.x, y: value.y }
        : { x: Math.max(24, window.innerWidth - 520), y: 90 };
    } catch {
      return { x: Math.max(24, window.innerWidth - 520), y: 90 };
    }
  })(),
  setAiWritingFloating: (floating) => {
    profileLocalStorage.setItem("yao-ai-writing-floating", String(floating));
    set({ aiWritingFloating: floating });
  },
  setAiWritingFloatPosition: (position) => {
    profileLocalStorage.setItem("yao-ai-writing-position", JSON.stringify(position));
    set({ aiWritingFloatPosition: position });
  },
  openRightPanel: (tool) => set((state) => ({
    rightPanelOpen: true,
    rightPanelTool: tool,
    rightPanelTools: state.rightPanelTools.includes(tool)
      ? state.rightPanelTools
      : [...state.rightPanelTools, tool].slice(-2),
  })),
  closeRightPanel: (tool) => set((state) => {
    const closing = tool ?? state.rightPanelTool;
    const rightPanelTools = state.rightPanelTools.filter((item) => item !== closing);
    return {
      rightPanelOpen: rightPanelTools.length > 0,
      rightPanelTools,
      rightPanelTool: rightPanelTools[rightPanelTools.length - 1] ?? "aiWriting",
    };
  }),
  theme: (profileLocalStorage.getItem("pebble-theme") as Theme) || "light",
  fontFamily: (profileLocalStorage.getItem("pebble-font-family") as AppFontFamily) || "system",
  fontScale: Number(profileLocalStorage.getItem("pebble-font-scale") || "1"),
  setFontFamily: (fontFamily) => {
    profileLocalStorage.setItem("pebble-font-family", fontFamily);
    applyTypographyToDom(fontFamily, useUIStore.getState().fontScale);
    set({ fontFamily });
  },
  setFontScale: (fontScale) => {
    const safeScale = Math.min(1.35, Math.max(0.9, fontScale));
    profileLocalStorage.setItem("pebble-font-scale", String(safeScale));
    applyTypographyToDom(useUIStore.getState().fontFamily, safeScale);
    set({ fontScale: safeScale });
  },
  backgroundImage: initialBackgroundImage,
  language: initialLanguage,
  syncStatus: "idle",
  networkStatus: "online",
  lastMailError: null,
  realtimeStatusByAccount: {},
  realtimeMode: initialRealtimeMode,
  notificationsEnabled: initialNotificationsEnabled,
  setNotificationsEnabled: (enabled) => {
    profileLocalStorage.setItem(NOTIFICATIONS_KEY, String(enabled));
    set({ notificationsEnabled: enabled });
  },
  keepRunningInBackground: initialKeepRunningInBackground,
  setKeepRunningInBackground: (enabled) => {
    profileLocalStorage.setItem(KEEP_RUNNING_BACKGROUND_KEY, String(enabled));
    set({ keepRunningInBackground: enabled });
  },
  startHiddenToTray: initialStartHiddenToTray,
  setStartHiddenToTray: (enabled) => {
    profileLocalStorage.setItem(START_HIDDEN_TO_TRAY_KEY, String(enabled));
    set({ startHiddenToTray: enabled });
  },
  previousView: "inbox",
  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  navigateToView: (view) => set({ activeView: normalizeActiveView(view) }),
  aiContextQueue: [],
  aiContextAttachmentQueue: [],
  enqueueAiContext: (messageId, title) =>
    set((state) => ({ aiContextQueue: [...state.aiContextQueue, { messageId, title }] })),
  enqueueAiContextAttachment: (attachmentId, title) =>
    set((state) => ({ aiContextAttachmentQueue: [...state.aiContextAttachmentQueue, { attachmentId, title }] })),
  clearAiContextQueue: () => set({ aiContextQueue: [], aiContextAttachmentQueue: [] }),
  leadContextQueue: [],
  leadContextAttachmentQueue: [],
  enqueueLeadContext: (messageId, title) =>
    set((state) => ({ leadContextQueue: [...state.leadContextQueue, { messageId, title }] })),
  enqueueLeadContextAttachment: (attachmentId, title) =>
    set((state) => ({ leadContextAttachmentQueue: [...state.leadContextAttachmentQueue, { attachmentId, title }] })),
  clearLeadContextQueue: () => set({ leadContextQueue: [], leadContextAttachmentQueue: [] }),
  homeContextQueue: [],
  homeContextAttachmentQueue: [],
  enqueueHomeContext: (messageId, title) =>
    set((state) => ({ homeContextQueue: [...state.homeContextQueue, { messageId, title }] })),
  enqueueHomeContextAttachment: (attachmentId, title) =>
    set((state) => ({ homeContextAttachmentQueue: [...state.homeContextAttachmentQueue, { attachmentId, title }] })),
  clearHomeContextQueue: () => set({ homeContextQueue: [], homeContextAttachmentQueue: [] }),
  knowledgeContextQueue: [],
  enqueueKnowledgeContext: (itemId, title, target) =>
    set((state) => ({ knowledgeContextQueue: [...state.knowledgeContextQueue, { itemId, title, target }] })),
  clearKnowledgeContextQueue: () => set({ knowledgeContextQueue: [] }),
  pendingAiWritingInstruction: null,
  setPendingAiWritingInstruction: (instruction) => set({ pendingAiWritingInstruction: instruction }),
  setActiveView: (view) => {
    // 保留旧 API，内部统一走同一个导航动作，避免标签标题和主内容分叉。
    useUIStore.getState().navigateToView(view);
  },
  customerProfileEmail: null,
  setCustomerProfileEmail: (email) => set({ customerProfileEmail: email }),
  openMessageInInbox: (messageId) => {
    useMailStore.getState().setSelectedMessage(messageId);
    useMailStore.setState({
      selectedThreadId: null,
      threadView: false,
      selectedMessageIds: new Set(),
      batchMode: false,
    });
    set({ activeView: "inbox" });
  },
  setTheme: (theme) => {
    profileLocalStorage.setItem("pebble-theme", theme);
    applyThemeToDom(theme);
    set({ theme });
  },
  setBackgroundImage: (image) => {
    const current = useUIStore.getState().backgroundImage;
    const next: BackgroundImageSettings = {
      path: image.path,
      filename: image.filename,
      fit: current?.fit ?? DEFAULT_BACKGROUND_IMAGE_FIT,
      opacity: current?.opacity ?? DEFAULT_BACKGROUND_IMAGE_OPACITY,
      updatedAt: Date.now(),
    };
    persistBackgroundImageSettings(next);
    set({ backgroundImage: next });
  },
  setBackgroundImageFit: (fit) => {
    if (!BACKGROUND_IMAGE_FITS.has(fit)) return;
    const current = useUIStore.getState().backgroundImage;
    if (!current) return;
    const next = { ...current, fit, updatedAt: Date.now() };
    persistBackgroundImageSettings(next);
    set({ backgroundImage: next });
  },
  setBackgroundImageOpacity: (opacity) => {
    const current = useUIStore.getState().backgroundImage;
    if (!current) return;
    const next = {
      ...current,
      opacity: clampBackgroundImageOpacity(opacity),
      updatedAt: Date.now(),
    };
    persistBackgroundImageSettings(next);
    set({ backgroundImage: next });
  },
  clearBackgroundImage: () => {
    persistBackgroundImageSettings(null);
    set({ backgroundImage: null });
  },
  setLanguage: (lang) => {
    i18n.changeLanguage(lang);
    profileLocalStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
    set({ language: lang });
  },
  setSyncStatus: (status) => set({ syncStatus: status }),
  setNetworkStatus: (status) => set({ networkStatus: status }),
  setLastMailError: (error) => set({ lastMailError: error }),
  setRealtimeStatus: (accountId, status) =>
    set((state) => ({
      realtimeStatusByAccount: {
        ...state.realtimeStatusByAccount,
        [accountId]: status,
      },
    })),
  setRealtimeMode: (mode) => {
    const pollInterval = realtimePreferenceToPollInterval(mode);
    profileLocalStorage.setItem(REALTIME_PREFERENCE_KEY, mode);
    profileLocalStorage.setItem("pebble-poll-interval", String(pollInterval));
    set({
      realtimeMode: mode,
      pollInterval,
    });
  },
  pollInterval: realtimePreferenceToPollInterval(initialRealtimeMode),
  setPollInterval: (secs) => {
    profileLocalStorage.setItem("pebble-poll-interval", String(secs));
    set({ pollInterval: secs });
  },
  searchQuery: "",
  setSearchQuery: (q) => set({ searchQuery: q }),
  settingsTab: (profileSessionStorage.getItem("pebble-settings-tab") as SettingsTab) || "accounts",
  setSettingsTab: (tab) => {
    profileSessionStorage.setItem("pebble-settings-tab", tab);
    set({ settingsTab: tab });
  },
  focusAccountId: null,
  setFocusAccountId: (id) => set({ focusAccountId: id }),
  aiInputFocusOwner: null,
  setAiInputFocusOwner: (owner) => set({ aiInputFocusOwner: owner }),
  messageDetailId: null,
  setMessageDetailId: (messageId) => set({ messageDetailId: messageId }),
  navTabs: [],
  upsertNavTab: (tab) =>
    set((state) => {
      if (REMOVED_VIEWS.has(tab.view)) {
        return { navTabs: state.navTabs.filter((item) => item.key !== tab.key) };
      }
      const exists = state.navTabs.some((item) => item.key === tab.key);
      return { navTabs: exists ? state.navTabs.map((item) => (item.key === tab.key ? tab : item)) : [...state.navTabs, tab] };
    }),
  removeNavTab: (key) => set((state) => ({ navTabs: state.navTabs.filter((item) => item.key !== key) })),
  setNavTabs: (tabs) => set({ navTabs: tabs.filter((tab) => !REMOVED_VIEWS.has(tab.view)) }),
  pendingAiDraft: null,
  setPendingAiDraft: (draft) => set({ pendingAiDraft: draft }),
  pendingSearchFilters: null,
  setPendingSearchFilters: (filters) => set({ pendingSearchFilters: filters }),
  aiBgTask: null,
  setAiBgTask: (task) => set({ aiBgTask: task }),
  aiWritingTurns: [],
  setAiWritingTurns: (turns) => set({ aiWritingTurns: turns }),
  pendingRuleDraftText: null,
  setPendingRuleDraftText: (text) => set({ pendingRuleDraftText: text }),
  leadFinderDraft: null,
  setLeadFinderDraft: (d) => set({ leadFinderDraft: d }),
  companyResearchDraft: null,
  setCompanyResearchDraft: (d) => set({ companyResearchDraft: d }),
  customerProfileSearch: "",
  customerProfileFilter: "",
  setCustomerProfileSearch: (q) => set({ customerProfileSearch: q }),
  setCustomerProfileFilter: (f) => set({ customerProfileFilter: f }),
  // Unread badges are a core mailbox signal. Keep an explicit user opt-out,
  // but do not interpret a missing profile preference as "hide everything".
  showFolderUnreadCount: profileLocalStorage.getItem("pebble-show-unread-count") !== "false",
  setShowFolderUnreadCount: (show) => {
    profileLocalStorage.setItem("pebble-show-unread-count", String(show));
    set({ showFolderUnreadCount: show });
  },
}));
