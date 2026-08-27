import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Inbox,
  Send,
  FileEdit,
  Trash2,
  Archive,
  AlertTriangle,
  Folder,
  Settings,
  Star,
  Sparkles,
  Wrench,
  ContactRound,
  Home,
  SquarePen,
  Building2,
  UserSearch,
  RefreshCw,
  MailCheck,
  FolderPlus,
  Pencil,
  Mail,
  Bookmark,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUIStore, type ActiveView } from "../stores/ui.store";
import { useComposeStore } from "../stores/compose.store";
import { useMailStore } from "../stores/mail.store";
import { useAccountsQuery, useFoldersForAccountsQuery } from "../hooks/queries";
import { useFolderUnreadCountsForAccounts } from "../hooks/queries/useFolderUnreadCounts";
import {
  allAccountsFolderId,
  sortFoldersForSidebar,
  unreadCountForFolder,
} from "../lib/folderAggregation";
import type { Account, Folder as FolderType } from "../lib/api";
import {
  createFolder,
  deleteFolder,
  emptyTrash,
  emptySpam,
  emptyDrafts,
  getBodyBackfillStats,
  listFolders,
  markFolderAllRead,
  moveFolder,
  renameFolder,
  triggerSync,
  updateAccount,
} from "../lib/api";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import { useToastStore } from "../stores/toast.store";
import { useConfirmStore } from "../stores/confirm.store";
import { queryClient } from "../lib/query-client";
import { useBackgroundTasksStore } from "../stores/backgroundTasks.store";
import { useAutoDevStore } from "../stores/autoDev.store";
import {
  beginFolderCacheRevision,
  setFolderCacheIfCurrent,
} from "../lib/folderCache";
import { withFolderDepth } from "../lib/folderHierarchy";

const EMPTY_ACCOUNTS: Account[] = [];
const EMPTY_FOLDERS: FolderType[] = [];

function folderMoveErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    for (const key of ["message", "error", "details", "reason"]) {
      if (typeof value[key] === "string" && value[key]) return value[key] as string;
    }
    try {
      return JSON.stringify(error);
    } catch {
      // fall through
    }
  }
  return "服务器没有接受这次移动，请刷新文件夹后重试";
}

function accountDisplayName(account: Account): string {
  const name = account.display_name?.trim();
  if (name) return name;
  const local = account.email.split("@")[0];
  return local || account.email;
}

const SPIN_STYLE_ID = "pebble-sidebar-spin-keyframes";

function ensureSpinKeyframes() {
  if (typeof document === "undefined") return;
  if (document.getElementById(SPIN_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = SPIN_STYLE_ID;
  style.textContent = "@keyframes pebble-sidebar-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }";
  document.head.appendChild(style);
}

const ROLE_ICONS: Record<string, React.ReactNode> = {
  inbox: <Inbox size={16} />,
  sent: <Send size={16} />,
  drafts: <FileEdit size={16} />,
  trash: <Trash2 size={16} />,
  archive: <Archive size={16} />,
  spam: <AlertTriangle size={16} />,
};

function folderIcon(role: FolderType["role"]): React.ReactNode {
  return (role && ROLE_ICONS[role]) || <Folder size={16} />;
}

/** 子文件夹显示短名（去掉服务器层级路径前缀，如 "Trash/111" → "111"）。 */
function folderShortName(folder: FolderType): string {
  const parts = folder.name.split("/");
  return parts[parts.length - 1] || folder.name;
}

function folderTreeSignature(folders: FolderType[]): string {
  return folders
    .map((folder) => `${folder.id}|${folder.parent_id ?? ""}|${folder.sort_order}|${folder.remote_id ?? ""}`)
    .sort()
    .join("\n");
}

function compareFolderOrder(a: FolderType, b: FolderType): number {
  const orderDifference = a.sort_order - b.sort_order;
  if (orderDifference !== 0) return orderDifference;
  // Use the same deterministic tie-breakers as the Rust move command. Fresh
  // IMAP folders can initially share a provider default (usually 100); the
  // drag calculation must still see exactly the order rendered on screen.
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

// Default folders shown when no account is configured
const DEFAULT_FOLDERS: { role: string; labelKey: string }[] = [
  { role: "inbox", labelKey: "sidebar.inbox" },
  { role: "sent", labelKey: "sidebar.sent" },
  { role: "archive", labelKey: "sidebar.archive" },
  { role: "drafts", labelKey: "sidebar.drafts" },
  { role: "trash", labelKey: "sidebar.trash" },
  { role: "spam", labelKey: "sidebar.spam" },
];

export default function Sidebar() {
  const autoDev = useAutoDevStore();
  const { t } = useTranslation();
  const activeView = useUIStore((s) => s.activeView);
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen);
  const rightPanelTools = useUIStore((s) => s.rightPanelTools);
  const openRightPanel = useUIStore((s) => s.openRightPanel);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const navigateToView = useUIStore((s) => s.navigateToView);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem("pebble-sidebar-width"));
    return Number.isFinite(stored) && stored >= 170 ? stored : 200;
  });
  const activeFolderId = useMailStore((s) => s.activeFolderId);
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const searchScope = useMailStore((s) => s.searchScope);
  const setActiveAccountId = useMailStore((s) => s.setActiveAccountId);
  const setActiveFolderId = useMailStore((s) => s.setActiveFolderId);
  const setSearchScope = useMailStore((s) => s.setSearchScope);
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; folder: FolderType } | null>(null);
  const [commonMenu, setCommonMenu] = useState<{
    x: number;
    y: number;
    kind: "all-unread" | "starred";
  } | null>(null);
  const [accountMenu, setAccountMenu] = useState<{ x: number; y: number; account: Account } | null>(null);
  const [renamingAccount, setRenamingAccount] = useState<Account | null>(null);
  const [folderDialog, setFolderDialog] = useState<{
    mode: "create" | "rename";
    folder?: FolderType;
    /** 创建时在其下新建子文件夹的父文件夹（账号右键新建时为 undefined = 顶层平级）。 */
    parent?: FolderType;
    /** 创建时预选的账号（账号右键新建时指定）。 */
    accountId?: string;
  } | null>(null);
  // 文件夹拖拽（改变顺序/层级）
  const [dragFolderId, setDragFolderId] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  /** 拖拽悬停在目标文件夹上的位置：before=目标上方（同级插前）after=下方（同级插后）inside=中间（变成子文件夹）。 */
  const [dragOverPosition, setDragOverPosition] = useState<"before" | "after" | "inside" | null>(null);
  // 正文/附件后台下载进度（每 30 秒轮询一次）
  const [bodyBackfillRemaining, setBodyBackfillRemaining] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const stats = await getBodyBackfillStats();
        if (cancelled) return;
        setBodyBackfillRemaining(stats.reduce((sum, item) => sum + item.remaining, 0));
      } catch { /* 轮询失败静默，下轮重试 */ }
    };
    void poll();
    const timer = setInterval(() => void poll(), 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  const backgroundTasks = useBackgroundTasksStore((state) => state.tasks);
  // Tasks are shown beside their owning feature entry; retained only for the hidden legacy block below.
  const runningTasks = Object.values(backgroundTasks).filter((task) => task.status === "running");
  const taskRunning = (...ids: string[]) => ids.some((id) => backgroundTasks[id]?.status === "running");

  const showUnread = useUIStore((s) => s.showFolderUnreadCount);
  const { data: accounts = EMPTY_ACCOUNTS } = useAccountsQuery();
  const allAccountsMode = accounts.length > 1 && !activeAccountId;
  const [syncingAll, setSyncingAll] = useState(false);

  // Track which accounts are expanded in the sidebar. Default: all expanded.
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(() => new Set());

  // 账号加载后默认全部展开（用户要求：所有账号直接列出、可折叠收起，无需切换器）
  useEffect(() => {
    if (accounts.length === 0) return;
    setExpandedAccounts((prev) => {
      if (prev.size > 0) return prev;
      return new Set(accounts.map((account) => account.id));
    });
  }, [accounts]);
  useEffect(() => {
    setExpandedAccounts((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const acc of accounts) {
        if (!next.has(acc.id)) {
          next.add(acc.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [accounts]);

  const folderAccountIds = useMemo(
    // 多账号时始终列出所有账号的文件夹（每个账号一组、可折叠），
    // activeAccountId 只用于高亮当前账号，不再"只看一个账号"。
    () => accounts.map((account) => account.id),
    [accounts],
  );
  const { data: queriedFolders = EMPTY_FOLDERS, isFetched: foldersFetched } = useFoldersForAccountsQuery(folderAccountIds);
  // React Query may still expose the previous render while an in-flight
  // folder query settles. Keep a short-lived authoritative projection for a
  // just-completed drag so the sidebar cannot show the old parent relation
  // after the server and SQLite already accepted the move.
  const [folderOverridesByAccount, setFolderOverridesByAccount] = useState<Record<string, FolderType[]>>({});
  const folders = useMemo(() => {
    if (Object.keys(folderOverridesByAccount).length === 0) return queriedFolders;
    return folderAccountIds
      .flatMap((accountId) => folderOverridesByAccount[accountId]
        ?? queriedFolders.filter((folder) => folder.account_id === accountId))
      .sort(compareFolderOrder);
  }, [folderAccountIds, folderOverridesByAccount, queriedFolders]);

  // Once the normal query catches up with the authoritative move result,
  // release the local projection. This prevents a completed drag from
  // permanently masking later server-side folder changes.
  useEffect(() => {
    setFolderOverridesByAccount((current) => {
      let changed = false;
      const next = { ...current };
      for (const [accountId, override] of Object.entries(current)) {
        const queried = queriedFolders.filter((folder) => folder.account_id === accountId);
        if (queried.length > 0 && folderTreeSignature(queried) === folderTreeSignature(override)) {
          delete next[accountId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [queriedFolders]);
  const { data: unreadCounts = {} } = useFolderUnreadCountsForAccounts(folderAccountIds);
  const ROLE_LABELS: Record<string, string> = {
    inbox: t("sidebar.inbox"),
    sent: t("sidebar.sent"),
    drafts: t("sidebar.drafts"),
    trash: t("sidebar.trash"),
    archive: t("sidebar.archive"),
    spam: t("sidebar.spam"),
  };
  const folderLabel = (folder: FolderType) =>
    (folder.role && ROLE_LABELS[folder.role]) || (folder.parent_id ? folderShortName(folder) : folder.name);

  function openFolderMenu(event: React.MouseEvent, folder: FolderType) {
    event.preventDefault();
    event.stopPropagation();
    setFolderMenu({ x: event.clientX, y: event.clientY, folder });
  }

  // ─── 文件夹拖拽：改变同级顺序 / 拖到别的文件夹下变子文件夹 / 拖回顶层 ───
  function handleFolderDragStart(event: React.DragEvent, folder: FolderType) {
    // 系统文件夹（收件箱等）不可拖动
    if (folder.role || folder.is_system) {
      event.preventDefault();
      return;
    }
    setDragFolderId(folder.id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", folder.id);
  }

  function clearFolderDragState() {
    setDragFolderId(null);
    setDragOverFolderId(null);
    setDragOverPosition(null);
  }

  function handleFolderDragEnd() {
    // drop 可能发生在无效区域、窗口外，或者被 WebView 取消。无论哪种情况
    // 都必须恢复透明度和目标框，不能让文件夹一直保持灰色。
    clearFolderDragState();
  }

  function handleFolderDragOver(event: React.DragEvent, folder: FolderType) {
    if (!dragFolderId || dragFolderId === folder.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverFolderId(folder.id);
    setDragOverPosition(folderDropPosition(event));
  }

  function folderDropPosition(event: React.DragEvent): "before" | "inside" | "after" {
    // Calculate from the actual event every time. Do not use the last React
    // dragover state: the final pointer movement can arrive immediately
    // before drop, before that state update has committed.
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
    return ratio < 1 / 3 ? "before" : ratio > 2 / 3 ? "after" : "inside";
  }

  function handleFolderDragLeave() {
    setDragOverFolderId(null);
    setDragOverPosition(null);
  }

  // 防止一次拖放重复触发多次 move_folder（会导致第二次因文件夹已移走而误报失败）
  const draggingLockRef = useRef(false);

  async function handleFolderDrop(event: React.DragEvent, target: FolderType) {
    event.preventDefault();
    event.stopPropagation();
    if (draggingLockRef.current) return; // 已在处理中，忽略重复触发
    draggingLockRef.current = true;
    try {
      const draggedId = dragFolderId;
      const eventFolderId = (event.currentTarget as HTMLElement).dataset.folderId;
      const actualTarget = eventFolderId
        ? folders.find((item) => item.id === eventFolderId)
        : target;
      if (!actualTarget) return;
      const position = folderDropPosition(event);
      clearFolderDragState();
      if (!draggedId || draggedId === actualTarget.id) return;
      const dragged = folders.find((item) => item.id === draggedId);
      if (!dragged || dragged.role || dragged.is_system) return;

      let newParent: string | null;
      let after: string | null;
      if (position === "inside") {
        // 拖到中间：变成 target 的子文件夹（插到其子列表末尾）
        newParent = actualTarget.id;
        const children = folders
          .filter((item) => item.parent_id === actualTarget.id)
          .sort(compareFolderOrder);
        after = children.length > 0 ? children[children.length - 1].id : null;
      } else {
        // 上/下边缘：与 target 同级，插到其前/后（after = target 的前一个兄弟 / target 本身）
        newParent = actualTarget.parent_id ?? null;
        const siblings = folders
          .filter((item) => (item.parent_id ?? null) === newParent && item.id !== draggedId)
          .sort(compareFolderOrder);
        const targetIndex = siblings.findIndex((item) => item.id === actualTarget.id);
        if (position === "before") {
          after = targetIndex > 0 ? siblings[targetIndex - 1].id : null;
        } else {
          after = actualTarget.id;
        }
      }

      const folderRevision = beginFolderCacheRevision(actualTarget.account_id);
      await queryClient.cancelQueries({ queryKey: ["folders", actualTarget.account_id] });
      const updatedFolders = await moveFolder(actualTarget.account_id, draggedId, newParent, after);
      setFolderOverridesByAccount((current) => ({
        ...current,
        [actualTarget.account_id]: updatedFolders,
      }));
      // move_folder 返回的是服务器操作完成后的权威树。立即更新当前账号缓存，
      // 避免异步 refetch 期间继续拿旧 parent_id 发起下一次拖动。
      setFolderCacheIfCurrent(queryClient, actualTarget.account_id, updatedFolders, folderRevision);
      // Read the authoritative local tree after the move has committed. A
      // fire-and-forget invalidation could leave the sidebar showing the old
      // parent links until the next manual mail sync.
      try {
        const refreshedFolders = await listFolders(actualTarget.account_id);
        setFolderOverridesByAccount((current) => ({
          ...current,
          [actualTarget.account_id]: refreshedFolders,
        }));
        setFolderCacheIfCurrent(queryClient, actualTarget.account_id, refreshedFolders, folderRevision);
      } catch {
        await queryClient.invalidateQueries({ queryKey: ["folders", actualTarget.account_id] });
      }
      useToastStore.getState().addToast({ message: "文件夹已移动。", type: "success" });
    } catch (error) {
      useToastStore.getState().addToast({ message: `移动失败：${folderMoveErrorMessage(error)}`, type: "error" });
    } finally {
      clearFolderDragState();
      draggingLockRef.current = false;
    }
  }

  /** 拖到列表底部空白 → 回到顶层（插到该账号顶层末尾）。 */
  async function handleFolderDropOnTopLevel(event: React.DragEvent, accountId: string) {
    event.preventDefault();
    if (draggingLockRef.current) return; // 已在处理中，忽略重复触发
    draggingLockRef.current = true;
    try {
      const draggedId = dragFolderId;
      clearFolderDragState();
      if (!draggedId) return;
      const dragged = folders.find((item) => item.id === draggedId);
      if (!dragged || dragged.role || dragged.is_system) return;
      if ((dragged.parent_id ?? null) === null) return; // 已在顶层，无需处理
      const topLevel = folders
        .filter((item) => item.account_id === accountId && item.parent_id === null && item.id !== draggedId)
        .sort(compareFolderOrder);
      const folderRevision = beginFolderCacheRevision(accountId);
      await queryClient.cancelQueries({ queryKey: ["folders", accountId] });
      const updatedFolders = await moveFolder(
        accountId,
        draggedId,
        null,
        topLevel.length > 0 ? topLevel[topLevel.length - 1].id : null,
      );
      setFolderOverridesByAccount((current) => ({ ...current, [accountId]: updatedFolders }));
      setFolderCacheIfCurrent(queryClient, accountId, updatedFolders, folderRevision);
      try {
        const refreshedFolders = await listFolders(accountId);
        setFolderOverridesByAccount((current) => ({ ...current, [accountId]: refreshedFolders }));
        setFolderCacheIfCurrent(queryClient, accountId, refreshedFolders, folderRevision);
      } catch {
        await queryClient.invalidateQueries({ queryKey: ["folders", accountId] });
      }
      useToastStore.getState().addToast({ message: "文件夹已移到顶层。", type: "success" });
    } catch (error) {
      useToastStore.getState().addToast({ message: `移动失败：${folderMoveErrorMessage(error)}`, type: "error" });
    } finally {
      clearFolderDragState();
      draggingLockRef.current = false;
    }
  }

  async function handleFolderSync(folder: FolderType) {
    try {
      await triggerSync(folder.account_id, "manual");
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] });
      // 关键：同步后必须刷新文件夹列表，否则服务器端层级变化（网页邮箱移动文件夹）
      // 本地永远看不到（list_folders 入口会做层级自愈）。
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      useToastStore.getState().addToast({ message: "已开始收取邮件。", type: "success" });
    } catch (error) {
      useToastStore.getState().addToast({ message: `收取邮件失败：${String(error)}`, type: "error" });
    }
  }

  async function handleSyncAllAccounts() {
    if (syncingAll || accounts.length === 0) return;
    ensureSpinKeyframes();
    setSyncingAll(true);
    try {
      const results = await Promise.allSettled(
        accounts.map((acc) => triggerSync(acc.id, "manual")),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] });
      // 同步后刷新文件夹列表（服务器层级变化本地才能看到）
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      if (failed === 0) {
        useToastStore.getState().addToast({
          message: accounts.length === 1 ? "已开始收取邮件。" : `已开始收取 ${accounts.length} 个账号的邮件。`,
          type: "success",
        });
      } else {
        useToastStore.getState().addToast({
          message: `${accounts.length - failed} 个账号已开始收取，${failed} 个失败。`,
          type: "error",
        });
      }
    } finally {
      // Visual feedback for at least 600ms so the spinner is visible
      setTimeout(() => setSyncingAll(false), 600);
    }
  }

  async function handleMarkAllRead(folder: FolderType) {
    try {
      const count = await markFolderAllRead(folder.account_id, folder.id);
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] });
      useToastStore.getState().addToast({
        message: count > 0 ? `已将 ${count} 封未读邮件标记为已读。` : "该文件夹没有未读邮件。",
        type: "success",
      });
    } catch (error) {
      useToastStore.getState().addToast({ message: `标记已读失败：${String(error)}`, type: "error" });
    }
  }

  async function handleMarkAllInboxesRead() {
    try {
      const targetAccounts = activeAccountId ? accounts.filter((a) => a.id === activeAccountId) : accounts;
      if (targetAccounts.length === 0) {
        useToastStore.getState().addToast({ message: "尚未配置邮箱账号。", type: "info" });
        return;
      }
      const results = await Promise.allSettled(
        targetAccounts.flatMap((acc) =>
          folders
            .filter((f) => f.account_id === acc.id && f.role === "inbox")
            .map((f) => markFolderAllRead(acc.id, f.id)),
        ),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] });
      useToastStore.getState().addToast({
        message: ok > 0 ? `已将 ${ok} 个收件箱的未读邮件标记为已读。` : "没有可标记的收件箱。",
        type: "success",
      });
    } catch (error) {
      useToastStore.getState().addToast({ message: `标记已读失败：${String(error)}`, type: "error" });
    }
  }

  const commonMenuItems: ContextMenuItem[] = commonMenu
    ? [
        { label: "收取邮件", icon: <RefreshCw size={14} />, onClick: () => void handleSyncAllAccounts() },
        { label: "未读全部标记为已读", icon: <MailCheck size={14} />, onClick: () => void handleMarkAllInboxesRead() },
      ]
    : [];

  const accountMenuItems: ContextMenuItem[] = accountMenu
    ? [
        {
          label: "重命名账号（备注）",
          icon: <Pencil size={14} />,
          onClick: () => setRenamingAccount(accountMenu.account),
        },
        {
          label: "收取该账号邮件",
          icon: <RefreshCw size={14} />,
          onClick: () => void handleSyncAccount(accountMenu.account),
        },
        {
          label: "该账号未读全部标记为已读",
          icon: <MailCheck size={14} />,
          onClick: () => void handleMarkAccountRead(accountMenu.account),
        },
        { separator: true },
        {
          label: "新建文件夹",
          icon: <FolderPlus size={14} />,
          onClick: () => setFolderDialog({ mode: "create", accountId: accountMenu.account.id }),
        },
        { separator: true },
        {
          label: "账户设置",
          icon: <Settings size={14} />,
          onClick: () => {
            // Pre-select the account so Settings → Accounts opens on it.
            useUIStore.getState().setFocusAccountId(accountMenu.account.id);
            safeSetActiveView("settings");
            setAccountMenu(null);
          },
        },
      ]
    : [];

  async function handleSyncAccount(account: Account) {
    try {
      await triggerSync(account.id, "manual");
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] });
      useToastStore.getState().addToast({ message: `已开始收取「${accountDisplayName(account)}」的邮件。`, type: "success" });
    } catch (error) {
      useToastStore.getState().addToast({ message: `收取失败：${String(error)}`, type: "error" });
    }
  }

  async function handleMarkAccountRead(account: Account) {
    try {
      const inboxes = folders.filter((f) => f.account_id === account.id && f.role === "inbox");
      const results = await Promise.allSettled(inboxes.map((f) => markFolderAllRead(account.id, f.id)));
      const ok = results.filter((r) => r.status === "fulfilled").length;
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] });
      useToastStore.getState().addToast({
        message: ok > 0 ? `已将「${accountDisplayName(account)}」的 ${ok} 个收件箱标记为已读。` : "该账号没有可标记的收件箱。",
        type: "success",
      });
    } catch (error) {
      useToastStore.getState().addToast({ message: `标记已读失败：${String(error)}`, type: "error" });
    }
  }

  async function handleDeleteFolder(folder: FolderType) {
    const ok = await useConfirmStore.getState().confirm({
      title: "删除文件夹",
      message: `确定删除文件夹「${folder.name}」吗？其中的邮件会一并移除。`,
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteFolder(folder.account_id, folder.id);
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      useToastStore.getState().addToast({ message: "文件夹已删除。", type: "success" });
    } catch (error) {
      useToastStore.getState().addToast({ message: `删除失败：${String(error)}`, type: "error" });
    }
  }

  async function handleEmptySystemFolder(folder: FolderType) {
    const isSpam = folder.role === "spam";
    const isDrafts = folder.role === "drafts";
    const ok = await useConfirmStore.getState().confirm({
      title: isSpam ? "清空垃圾邮件" : isDrafts ? "清空草稿箱" : "清空废纸篓",
      message: isSpam ? `确定永久删除「${folder.name}」中的所有邮件？` : isDrafts ? "确定删除草稿箱中的所有草稿？" : "确定永久删除废纸篓中的所有邮件？",
      confirmLabel: "清空",
      destructive: true,
    });
    if (!ok) return;
    try {
      const count = isSpam ? await emptySpam(folder.account_id) : isDrafts ? await emptyDrafts(folder.account_id) : await emptyTrash(folder.account_id);
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] });
      useToastStore.getState().addToast({ message: `${isSpam ? "垃圾邮件" : isDrafts ? "草稿箱" : "废纸篓"}已清空（${count} 封邮件已删除）`, type: "success" });
    } catch (error) {
      useToastStore.getState().addToast({ message: `清空失败：${String(error)}`, type: "error" });
    }
  }

  const customFolder = folderMenu?.folder
    // 自定义文件夹 = 无系统角色（含本地文件夹 __local_*：POP3 下新建的本地整理夹）
    ? !folderMenu.folder.role && !folderMenu.folder.is_system
    : false;

  const folderMenuItems: ContextMenuItem[] = folderMenu
    ? [
        { label: "收取邮件", icon: <RefreshCw size={14} />, onClick: () => void handleFolderSync(folderMenu.folder) },
        { label: "未读全部标记为已读", icon: <MailCheck size={14} />, onClick: () => void handleMarkAllRead(folderMenu.folder) },
        ...((folderMenu.folder.role === "trash" || folderMenu.folder.role === "spam" || folderMenu.folder.role === "drafts")
          ? [{ label: folderMenu.folder.role === "spam" ? "清空垃圾邮件" : folderMenu.folder.role === "drafts" ? "清空草稿箱" : "清空废纸篓", icon: <Trash2 size={14} />, danger: true, onClick: () => void handleEmptySystemFolder(folderMenu.folder) }]
          : []),
        { separator: true },
        { label: "新建文件夹", icon: <FolderPlus size={14} />, onClick: () => setFolderDialog({ mode: "create", parent: folderMenu.folder, accountId: folderMenu.folder.account_id }) },
        {
          label: "重命名",
          icon: <Pencil size={14} />,
          disabled: !customFolder,
          onClick: () => setFolderDialog({ mode: "rename", folder: folderMenu.folder }),
        },
        {
          label: "删除",
          icon: <Trash2 size={14} />,
          danger: true,
          disabled: !customFolder,
          onClick: () => void handleDeleteFolder(folderMenu.folder),
        },
      ]
    : [];

  // 多账号时始终按账号分组列出（用户要求：所有账号直接列出、各自可折叠；
  // "全部账号"只是"所有未读"等入口，不再作为侧边栏汇总视图）。
  const displayedFolders = useMemo(() => folders, [folders]);
  const hasRealFolders = displayedFolders.length > 0;

  // Keep system folders stable across all-account and single-account views.
  const dedupedFolders = useMemo(() => {
    return sortFoldersForSidebar(displayedFolders);
  }, [displayedFolders]);

  // Group raw folders by account_id for the multi-account sidebar.
  // 始终分组（不随 allAccountsMode 切换）：每个账号一组、各自可折叠。
  const foldersByAccount = useMemo(() => {
    const map = new Map<string, FolderType[]>();
    for (const folder of folders) {
      const list = map.get(folder.account_id) ?? [];
      list.push(folder);
      map.set(folder.account_id, list);
    }
    for (const list of map.values()) {
      // Apply the same role-aware ordering as sortFoldersForSidebar without
      // collapsing the per-account lists.
      const systemRoleOrder: Record<string, number> = {
        inbox: 0,
        sent: 1,
        archive: 2,
        drafts: 3,
        trash: 4,
        spam: 5,
      };
      list.sort((a, b) => {
        const ao = a.role ? (systemRoleOrder[a.role] ?? 99) : 99;
        const bo = b.role ? (systemRoleOrder[b.role] ?? 99) : 99;
        if (ao !== bo) return ao - bo;
        return compareFolderOrder(a, b);
      });
    }
    return map;
  }, [folders, allAccountsMode]);

  const showAccountGroups = !!foldersByAccount && accounts.length >= 1;

  // Auto-select the only account. With multiple accounts, null means the
  // combined "all accounts" mailbox.
  useEffect(() => {
    if (accounts.length === 1 && !activeAccountId) {
      setActiveAccountId(accounts[0].id);
    }
  }, [accounts, activeAccountId, setActiveAccountId]);

  // Auto-select inbox folder when folders load.
  // If the selected account has no folders, try the next account.
  useEffect(() => {
    if (displayedFolders.length > 0 && !activeFolderId) {
      const inbox = displayedFolders.find((f) => f.role === "inbox");
      setActiveFolderId((inbox ?? displayedFolders[0]).id);
    } else if (!allAccountsMode && foldersFetched && displayedFolders.length === 0 && activeAccountId && accounts.length > 1) {
      const idx = accounts.findIndex((a) => a.id === activeAccountId);
      const next = accounts[idx + 1] ?? accounts.find((a) => a.id !== activeAccountId);
      if (next) {
        setActiveAccountId(next.id);
      }
    }
  }, [displayedFolders, foldersFetched, activeFolderId, setActiveFolderId, accounts, activeAccountId, setActiveAccountId, allAccountsMode]);

  // 功能视图 → 标签名（Chrome 式标签栏显示用）
  const FEATURE_TAB_LABELS: Partial<Record<string, string>> = {
    addressBook: "地址本",
    companyResearch: "资信调研",
    leadFinder: "开发客户",
    kanban: "工作台",
    settings: "设置",
    search: "搜索",
    starred: "已加星标",
    customerProfile: "客户管理",
    aiWriting: "AI 写作",
    foreignTools: "外贸工具",
  };

  function safeSetActiveView(view: Parameters<typeof setActiveView>[0]) {
    navigateToView(view);
    // Chrome 式：切到某个功能时，在标签栏创建/激活对应功能标签
    const label = FEATURE_TAB_LABELS[view];
    if (label) {
      useUIStore.getState().upsertNavTab({ key: `feature:${view}`, kind: "feature", label, view: view as ActiveView });
    }
  }

  function handleFolderClick(folderId: string) {
    const folder = folders.find((item) => item.id === folderId);
    // 文件夹属于具体账号。先恢复账号，再恢复文件夹；setActiveAccountId
    // 会清空旧文件夹，所以顺序不能反过来。关闭所有标签后重新打开时，
    // 这一步可以避免用另一个账号的 folders 查询导致邮件列表为空。
    if (folder && folder.account_id !== activeAccountId) {
      setActiveAccountId(folder.account_id);
    }
    setActiveView("inbox");
    setActiveFolderId(folderId);
    if (folder) {
      setSearchScope({ kind: "folder", accountId: folder.account_id, folderId: folder.id });
    }
    // Chrome 式：文件夹标签（单一，切换文件夹时只改名字）
    const account = accounts.find((item) => item.id === folder?.account_id);
    const label = folder ? folderLabel(folder) : "收件箱";
    const accountSuffix = account ? ` · ${accountDisplayName(account)}` : "";
    useUIStore.getState().upsertNavTab({
      key: "folder",
      kind: "folder",
      label: `${label}${accountSuffix}`,
      view: "inbox",
      folderId,
      accountId: folder?.account_id ?? null,
    });
  }

  function handleAccountClick(accountId: string) {
    setActiveAccountId(accountId);
    setSearchScope({ kind: "account", accountId });
    setActiveView("inbox");
  }

  const buttonBase: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    borderRadius: "6px",
    padding: sidebarCollapsed ? "7px" : "6px 10px",
    width: "100%",
    border: "none",
    cursor: "pointer",
    fontSize: "13px",
    textAlign: "left",
    justifyContent: sidebarCollapsed ? "center" : "flex-start",
  };

  const beginResizeSidebar = useCallback((event: React.MouseEvent) => {
    if (sidebarCollapsed) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const onMove = (moveEvent: MouseEvent) => {
      setSidebarWidth(Math.min(360, Math.max(170, startWidth + moveEvent.clientX - startX)));
    };
    const onUp = (upEvent: MouseEvent) => {
      const next = Math.min(360, Math.max(170, startWidth + upEvent.clientX - startX));
      localStorage.setItem("pebble-sidebar-width", String(next));
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [sidebarCollapsed, sidebarWidth]);

  return (
    <aside
      aria-label={t("sidebar.navigation", "Sidebar")}
      style={{
        width: sidebarCollapsed ? "48px" : `${sidebarWidth}px`,
        flexShrink: 0,
        backgroundColor: "var(--color-sidebar-bg)",
        borderRight: "1px solid var(--color-border)",
        transition: "width 150ms ease",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        maxHeight: "100%",
        minHeight: 0,
        // 侧栏统一滚动：顶部入口、账号文件夹、底部设置必须属于同一个滚动上下文。
        // 这样 Windows 缩放后不会把“设置”挤到可视区域之外，也不会出现鼠标滚轮落在空白处却无效。
        overflowY: "auto",
        overflowX: "hidden",
        position: "relative",
      }}
    >
      {!sidebarCollapsed && (
        <div
          role="separator"
          aria-label="调整侧边栏宽度"
          onMouseDown={beginResizeSidebar}
          style={{ position: "absolute", right: "-3px", top: 0, bottom: 0, width: "6px", cursor: "col-resize", zIndex: 5 }}
        />
      )}
      {/* Primary actions */}
      <nav aria-label={t("sidebar.search", "Search")} style={{ padding: "8px 6px 0", display: "flex", flexDirection: "column", gap: "1px" }}>
        <SidebarButton
          icon={<SquarePen size={17} />}
          label="写新邮件"
          isActive={activeView === "compose"}
          collapsed={sidebarCollapsed}
          style={{ ...buttonBase, backgroundColor: "var(--color-accent)", color: "#fff", marginBottom: "5px", fontWeight: 600 }}
          onClick={() => useComposeStore.getState().openCompose("new")}
        />
        <SidebarButton
          icon={
            syncingAll ? (
              <RefreshCw size={16} style={{ animation: "pebble-sidebar-spin 1s linear infinite" }} />
            ) : (
              <RefreshCw size={16} />
            )
          }
          label={syncingAll ? "收取中…" : "收取邮件"}
          isActive={false}
          collapsed={sidebarCollapsed}
          disabled={syncingAll || accounts.length === 0}
          style={{
            ...buttonBase,
            backgroundColor: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
            color: "var(--color-accent)",
            marginBottom: "5px",
            fontWeight: 600,
          }}
          onClick={() => void handleSyncAllAccounts()}
        />
        <SidebarButton
          icon={<Home size={16} />}
          label="首页"
          isActive={activeView === "kanban"}
          collapsed={sidebarCollapsed}
          style={buttonBase}
          onClick={() => safeSetActiveView("kanban")}
        />
        <SidebarButton
          icon={taskRunning("addressBookTagging") ? <RefreshCw size={16} style={{ animation: "pebble-sidebar-spin 1s linear infinite" }} /> : <ContactRound size={16} />}
          label={taskRunning("addressBookTagging") ? "地址本识别中…" : "地址本"}
          isActive={activeView === "addressBook"}
          collapsed={sidebarCollapsed}
          style={buttonBase}
          onClick={() => safeSetActiveView("addressBook")}
        />
        <SidebarButton
          icon={taskRunning("companyResearch") ? <RefreshCw size={16} style={{ animation: "pebble-sidebar-spin 1s linear infinite" }} /> : <Building2 size={16} />}
          label={taskRunning("companyResearch") ? "资信调研中…" : "资信调研"}
          isActive={activeView === "companyResearch"}
          collapsed={sidebarCollapsed}
          style={buttonBase}
          onClick={() => safeSetActiveView("companyResearch")}
        />
        <SidebarButton
          icon={(taskRunning("leadFinder") || autoDev.running) ? <RefreshCw size={16} style={{ animation: autoDev.paused ? "none" : "pebble-sidebar-spin 1s linear infinite" }} /> : <UserSearch size={16} />}
          label={autoDev.running ? `自动开发 ${autoDev.done}/${autoDev.total}${autoDev.paused ? "（暂停）" : ""}` : taskRunning("leadFinder") ? "开发客户中…" : "开发客户"}
          isActive={activeView === "leadFinder"}
          collapsed={sidebarCollapsed}
          style={buttonBase}
          onClick={() => safeSetActiveView("leadFinder")}
        />
      </nav>

      {/* 常用文件夹分组：所有未读 + 星标邮件 */}
      {!sidebarCollapsed && (
        <div style={{
          padding: "10px 10px 4px 10px",
          fontSize: "11px",
          fontWeight: 600,
          color: "var(--color-text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
          display: "flex", alignItems: "center", gap: 4,
        }}>
          <Bookmark size={11} /> 常用文件夹
        </div>
      )}

      {/* 常用文件夹列表（始终显示，即使没有账号） */}
      <nav aria-label="常用文件夹" style={{ display: "flex", flexDirection: "column", gap: "1px", padding: "0 6px" }}>
        <SidebarButton
          icon={<Mail size={16} />}
          label="所有未读"
          badge={
            showUnread && hasRealFolders
              ? unreadCountForFolder(allAccountsFolderId("inbox"), folders, unreadCounts)
              : undefined
          }
          isActive={activeFolderId === allAccountsFolderId("inbox") && activeView === "inbox"}
          collapsed={sidebarCollapsed}
          style={{ ...buttonBase, fontWeight: 600 }}
          onClick={() => {
            if (!hasRealFolders) return;
            const allUnreadId = allAccountsFolderId("inbox");
            useMailStore.getState().setActiveFolderId(allUnreadId);
            safeSetActiveView("inbox");
            // 与常规文件夹标签一致：更新文件夹标签名称
            useUIStore.getState().upsertNavTab({
              key: "folder",
              kind: "folder",
              label: "所有未读",
              view: "inbox",
              folderId: allUnreadId,
              accountId: null,
            });
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setCommonMenu({ x: event.clientX, y: event.clientY, kind: "all-unread" });
          }}
        />
        <SidebarButton
          icon={<Star size={16} />}
          label={t("sidebar.starred", "Starred")}
          isActive={activeView === "starred"}
          collapsed={sidebarCollapsed}
          style={{ ...buttonBase, fontWeight: 600 }}
          onClick={() => safeSetActiveView("starred")}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setCommonMenu({ x: event.clientX, y: event.clientY, kind: "starred" });
          }}
        />
      </nav>

      {/* Section label */}
      {!sidebarCollapsed && (
        <div style={{
          padding: "12px 10px 4px 10px",
          fontSize: "11px",
          fontWeight: 600,
          color: "var(--color-text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}>
          {t("sidebar.mail", "Mail")}
        </div>
      )}

      {/* Folders section */}
      <nav
        className="scroll-region sidebar-folder-scroll"
        aria-label={t("sidebar.mailFolders", "Mail folders")}
        style={{
          flex: "none",
          overflow: "visible",
          padding: "0 6px",
          display: "flex",
          flexDirection: "column",
          gap: "1px",
        }}
      >
        {false && runningTasks.length > 0 && !sidebarCollapsed && (
          <div title={runningTasks.map((task) => task.label).join("；")} style={{ display: "flex", alignItems: "center", gap: 7, margin: "0 4px 5px", padding: "6px 8px", borderRadius: 6, background: "color-mix(in srgb, var(--color-accent) 10%, transparent)", color: "var(--color-accent)", fontSize: 11 }}>
            <RefreshCw size={13} style={{ animation: "pebble-sidebar-spin 1s linear infinite" }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{runningTasks.length === 1 ? runningTasks[0].label : `${runningTasks.length} 项后台任务处理中`}</span>
          </div>
        )}
        {bodyBackfillRemaining !== null && bodyBackfillRemaining > 0 && (
          <div
            title="邮件正文和附件正在后台自动下载到本地"
            style={{
              display: "flex", alignItems: "center", gap: 6,
              margin: "0 6px 6px", padding: "6px 8px",
              borderRadius: 6, fontSize: 11,
              color: "var(--color-accent)",
              background: "color-mix(in srgb, var(--color-accent) 8%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-accent) 25%, transparent)",
            }}
          >
            <RefreshCw size={12} style={{ animation: "pebble-sidebar-spin 1s linear infinite", flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}>正在下载邮件正文：剩余 {bodyBackfillRemaining} 封</span>
          </div>
        )}
        {showAccountGroups && foldersByAccount
          ? Array.from(foldersByAccount.entries()).map(([accountId, accountFolders]) => {
              const account = accounts.find((a) => a.id === accountId);
              const accountUnread = showUnread
                ? accountFolders.reduce(
                    // 垃圾邮件不计入账号未读数（用户要求不显示垃圾邮件数）
                    (sum, folder) => sum + (folder.role === "spam" ? 0 : (unreadCounts[folder.id] ?? 0)),
                    0,
                  )
                : 0;
              const isExpanded = expandedAccounts.has(accountId);
              const isAccountActive = activeAccountId === accountId;
              const labelText = account ? accountDisplayName(account) : accountId;
              return (
                <div key={accountId} style={{ marginBottom: 8, border: "1px solid color-mix(in srgb, var(--color-border) 80%, transparent)", borderRadius: 8, background: "color-mix(in srgb, var(--color-bg-secondary) 68%, transparent)", overflow: "hidden" }}>
                  {!sidebarCollapsed && (
                    <div
                      role="button"
                      aria-pressed={isAccountActive}
                      tabIndex={0}
                      onClick={() => handleAccountClick(accountId)}
                      onContextMenu={(event) => {
                        if (!account) return;
                        event.preventDefault();
                        event.stopPropagation();
                        setAccountMenu({ x: event.clientX, y: event.clientY, account });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleAccountClick(accountId);
                        }
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "6px 10px",
                        marginTop: 0,
                        borderBottom: isExpanded ? "1px solid var(--color-border)" : "none",
                        borderRadius: 6,
                        background: isAccountActive
                          ? "color-mix(in srgb, var(--color-accent) 22%, var(--color-bg-primary))"
                          : "transparent",
                        border: isAccountActive ? "1px solid var(--color-accent)" : "1px solid transparent",
                        borderLeft: isAccountActive ? "3px solid var(--color-accent)" : "3px solid transparent",
                        boxShadow: isAccountActive ? "0 0 0 1px color-mix(in srgb, var(--color-accent) 18%, transparent)" : "none",
                        cursor: "pointer",
                        userSelect: "none",
                        color: isAccountActive ? "var(--color-accent)" : "var(--color-text-primary)",
                        fontSize: 12,
                        fontWeight: isAccountActive ? 700 : 600,
                      }}
                    >
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={isExpanded ? "收起该账号文件夹" : "展开该账号文件夹"}
                        onClick={(event) => {
                          event.stopPropagation();
                          setExpandedAccounts((prev) => {
                            const next = new Set(prev);
                            if (next.has(accountId)) next.delete(accountId);
                            else next.add(accountId);
                            return next;
                          });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            e.stopPropagation();
                            setExpandedAccounts((prev) => {
                              const next = new Set(prev);
                              if (next.has(accountId)) next.delete(accountId);
                              else next.add(accountId);
                              return next;
                            });
                          }
                        }}
                        style={{ display: "flex", alignItems: "center", cursor: "pointer" }}
                      >
                        {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleAccountClick(accountId);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            event.stopPropagation();
                            handleAccountClick(accountId);
                          }
                        }}
                        style={{
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          cursor: "pointer",
                        }}
                        title={labelText}
                      >
                        {labelText}
                      </span>
                      {showUnread && accountUnread > 0 && (
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: "#fff",
                            background: "var(--color-accent)",
                            borderRadius: 9,
                            padding: "0 6px",
                            minWidth: 18,
                            textAlign: "center",
                          }}
                        >
                          {accountUnread}
                        </span>
                      )}
                    </div>
                  )}
                  {isExpanded &&
                    withFolderDepth(accountFolders).map(({ folder, depth }) => {
                      const isActive =
                        folder.id === activeFolderId
                        && activeView === "inbox"
                        // 点击账号名称代表整个账号范围；不要再把自动选中的收件箱
                        // 视觉上显示成同一个选中状态。
                        && searchScope?.kind !== "account";
                      const dropPosition = dragOverFolderId === folder.id ? dragOverPosition : null;
                      return (
                          <div
                            key={folder.id}
                            data-folder-id={folder.id}
                            style={{
                              marginLeft: 10 + depth * 14,
                              borderLeft: depth === 0 ? "2px solid color-mix(in srgb, var(--color-accent) 28%, var(--color-border))" : "none",
                              paddingLeft: depth === 0 ? 4 : 10,
                              opacity: dragFolderId === folder.id ? 0.45 : 1,
                              borderRadius: 6,
                              outline: dropPosition === "inside" ? "2px dashed var(--color-accent)" : "none",
                              outlineOffset: -1,
                              borderTop: dropPosition === "before" ? "2px solid var(--color-accent)" : "none",
                              borderBottom: dropPosition === "after" ? "2px solid var(--color-accent)" : "none",
                            }}
                            draggable={!folder.role && !folder.is_system}
                            onDragStart={(event) => handleFolderDragStart(event, folder)}
                            onDragEnd={handleFolderDragEnd}
                            onDragOver={(event) => handleFolderDragOver(event, folder)}
                            onDragLeave={handleFolderDragLeave}
                            onDrop={(event) => void handleFolderDrop(event, folder)}
                            title={!folder.role && !folder.is_system ? "拖动：拖到文件夹中间=放入其下，拖到上/下边缘=调整顺序" : undefined}
                          >
                          <SidebarButton
                          key={folder.id}
                          icon={folderIcon(folder.role)}
                          label={folderLabel(folder)}
                          badge={
                            showUnread && folder.role !== "spam"
                              ? unreadCountForFolder(folder.id, folders, unreadCounts)
                              : undefined
                          }
                          isActive={isActive}
                          collapsed={sidebarCollapsed}
                          style={buttonBase}
                          onClick={() => handleFolderClick(folder.id)}
                          onContextMenu={(event) => openFolderMenu(event, folder)}
                          />
                          </div>
                      );
                    })}
                  {/* 拖到这里 → 移回顶层 */}
                  {dragFolderId && (
                    <div
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(event) => void handleFolderDropOnTopLevel(event, accountId)}
                      style={{
                        margin: "4px 10px 0",
                        padding: "3px 0",
                        border: "1px dashed color-mix(in srgb, var(--color-accent) 45%, transparent)",
                        borderRadius: 6,
                        color: "var(--color-accent)",
                        fontSize: 11,
                        textAlign: "center",
                        background: "color-mix(in srgb, var(--color-accent) 6%, transparent)",
                      }}
                    >
                      拖到这里移到顶层
                    </div>
                  )}
                </div>
              );
            })
          : hasRealFolders
            ? withFolderDepth(dedupedFolders).flatMap(({ folder, depth }) => {
                const items: React.ReactNode[] = [];
                const isActive =
                  folder.id === activeFolderId
                  && activeView === "inbox"
                  && searchScope?.kind !== "account";
                const dropPosition = dragOverFolderId === folder.id ? dragOverPosition : null;
                items.push(
                  <div
                    key={folder.id}
                    data-folder-id={folder.id}
                    style={{
                      marginLeft: depth * 14,
                      opacity: dragFolderId === folder.id ? 0.45 : 1,
                      borderRadius: 6,
                      outline: dropPosition === "inside" ? "2px dashed var(--color-accent)" : "none",
                      outlineOffset: -1,
                      borderTop: dropPosition === "before" ? "2px solid var(--color-accent)" : "none",
                      borderBottom: dropPosition === "after" ? "2px solid var(--color-accent)" : "none",
                    }}
                    draggable={!folder.role && !folder.is_system}
                    onDragStart={(event) => handleFolderDragStart(event, folder)}
                    onDragEnd={handleFolderDragEnd}
                    onDragOver={(event) => handleFolderDragOver(event, folder)}
                    onDragLeave={handleFolderDragLeave}
                    onDrop={(event) => void handleFolderDrop(event, folder)}
                    title={!folder.role && !folder.is_system ? "拖动：拖到文件夹中间=放入其下，拖到上/下边缘=调整顺序" : undefined}
                  >
                    <SidebarButton
                      icon={folderIcon(folder.role)}
                      label={folderLabel(folder)}
                      badge={showUnread ? unreadCountForFolder(folder.id, folders, unreadCounts) : undefined}
                      isActive={isActive}
                      collapsed={sidebarCollapsed}
                      style={buttonBase}
                      onClick={() => handleFolderClick(folder.id)}
                      onContextMenu={(event) => openFolderMenu(event, folder)}
                    />
                  </div>
                );
                if (dragFolderId) {
                  items.push(
                    <div
                      key="drop-top-level"
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(event) => void handleFolderDropOnTopLevel(event, folder.account_id)}
                      style={{
                        margin: "4px 10px 0",
                        padding: "3px 0",
                        border: "1px dashed color-mix(in srgb, var(--color-accent) 45%, transparent)",
                        borderRadius: 6,
                        color: "var(--color-accent)",
                        fontSize: 11,
                        textAlign: "center",
                        background: "color-mix(in srgb, var(--color-accent) 6%, transparent)",
                      }}
                    >
                      拖到这里移到顶层
                    </div>,
                  );
                }
                return items;
              })
            : DEFAULT_FOLDERS.flatMap((df, index) => {
                const items: React.ReactNode[] = [];
                items.push(
                  <SidebarButton
                    key={df.role}
                    icon={ROLE_ICONS[df.role] || <Folder size={16} />}
                    label={t(df.labelKey)}
                    isActive={index === 0 && activeView === "inbox"}
                    collapsed={sidebarCollapsed}
                    style={buttonBase}
                    onClick={() => safeSetActiveView("inbox")}
                  />
                );
                return items;
              })}
      </nav>

      {/* Divider */}
      <div
        style={{
          height: "1px",
          backgroundColor: "var(--color-border)",
          margin: "0 6px",
        }}
      />

      {/* Frequently used AI and foreign-trade tools stay one click away. */}
      <nav
        aria-label={t("sidebar.tools", "Tools")}
        style={{
          padding: "6px 6px 8px",
          display: "flex",
          flexDirection: "column",
          gap: "1px",
        }}
      >
        <SidebarButton
          icon={<Sparkles size={16} />}
          label={t("sidebar.aiWriting", "AI 写作")}
          isActive={rightPanelOpen && rightPanelTools.includes("aiWriting")}
          collapsed={sidebarCollapsed}
          style={buttonBase}
          onClick={() => openRightPanel("aiWriting")}
        />
        <SidebarButton
          icon={<Wrench size={16} />}
          label={t("sidebar.foreignTools", "外贸工具")}
          isActive={rightPanelOpen && rightPanelTools.includes("foreignTools")}
          collapsed={sidebarCollapsed}
          style={buttonBase}
          onClick={() => openRightPanel("foreignTools")}
        />
        <SidebarButton
          icon={taskRunning("customerProfile", "customerProfileUpdate", "customerProfileListUpdate") ? <RefreshCw size={16} style={{ animation: "pebble-sidebar-spin 1s linear infinite" }} /> : <ContactRound size={16} />}
          label={taskRunning("customerProfile", "customerProfileUpdate", "customerProfileListUpdate") ? "客户画像处理中…" : "客户管理"}
          isActive={activeView === "customerProfile"}
          collapsed={sidebarCollapsed}
          style={buttonBase}
          onClick={() => safeSetActiveView("customerProfile")}
        />
        <SidebarButton
          icon={<Settings size={16} />}
          label={t("sidebar.settings", "Settings")}
          isActive={activeView === "settings"}
          collapsed={sidebarCollapsed}
          style={buttonBase}
          onClick={() => safeSetActiveView("settings")}
        />
      </nav>
      {folderMenu && (
        <ContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          items={folderMenuItems}
          onClose={() => setFolderMenu(null)}
        />
      )}
      {commonMenu && (
        <ContextMenu
          x={commonMenu.x}
          y={commonMenu.y}
          items={commonMenuItems}
          onClose={() => setCommonMenu(null)}
        />
      )}
      {accountMenu && (
        <ContextMenu
          x={accountMenu.x}
          y={accountMenu.y}
          items={accountMenuItems}
          onClose={() => setAccountMenu(null)}
        />
      )}
      {renamingAccount && (
        <AccountRenameDialog
          account={renamingAccount}
          onClose={() => setRenamingAccount(null)}
          onDone={() => {
            queryClient.invalidateQueries({ queryKey: ["accounts"] });
            setRenamingAccount(null);
          }}
        />
      )}
      {folderDialog && (
        <FolderNameDialog
          mode={folderDialog.mode}
          folder={folderDialog.folder}
          parent={folderDialog.parent}
          initialAccountId={folderDialog.accountId}
          accounts={accounts}
          onClose={() => setFolderDialog(null)}
          onDone={(folder) => {
            const accountId = folder.account_id;
            // 立即把新/重命名后的文件夹写入缓存（不等 refetch），侧边栏马上可见。
            queryClient.setQueryData<FolderType[]>(["folders", accountId], (old) => {
              const list = old ?? [];
              return list.some((item) => item.id === folder.id)
                ? list.map((item) => (item.id === folder.id ? folder : item))
                : [folder, ...list];
            });
            queryClient.invalidateQueries({ queryKey: ["folders"] });
            if (activeFolderId) {
              setActiveFolderId(activeFolderId);
            }
            void triggerSync(accountId, "manual").catch(() => {});
            setFolderDialog(null);
          }}
        />
      )}
    </aside>
  );
}

// Reusable sidebar button to avoid repetitive hover logic
function SidebarButton({
  icon, label, badge, isActive, collapsed, style, disabled, onClick, onContextMenu,
}: {
  icon: React.ReactNode;
  label: string;
  badge?: number;
  isActive: boolean;
  collapsed: boolean;
  style: React.CSSProperties;
  disabled?: boolean;
  onClick: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      aria-label={collapsed ? label : undefined}
      aria-current={isActive ? "page" : undefined}
      title={collapsed ? label : undefined}
      disabled={disabled}
      style={{
        ...style,
        backgroundColor: isActive
          ? "var(--color-sidebar-active)"
          : style.backgroundColor ?? "transparent",
        color: style.color ?? "var(--color-text-primary)",
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "default" : "pointer",
        transition: "background-color 0.15s ease, opacity 0.15s ease",
      }}
      onMouseEnter={(e) => {
        if (!isActive && !style.backgroundColor)
          e.currentTarget.style.backgroundColor = "var(--color-sidebar-hover)";
      }}
      onMouseLeave={(e) => {
        if (!isActive && !style.backgroundColor)
          e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      {icon}
      {!collapsed && (
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {label}
        </span>
      )}
      {!collapsed && badge != null && badge > 0 && (
        <span style={{
          fontSize: "11px",
          fontWeight: 600,
          color: "var(--color-accent)",
          minWidth: "18px",
          textAlign: "right",
        }}>
          {badge}
        </span>
      )}
    </button>
  );
}

function FolderNameDialog({
  mode,
  folder,
  parent,
  initialAccountId,
  accounts,
  onClose,
  onDone,
}: {
  mode: "create" | "rename";
  folder?: FolderType;
  /** 创建时在其下新建的父文件夹（undefined = 顶层平级）。 */
  parent?: FolderType;
  /** 创建时预选的账号（账号右键新建时传入）。 */
  initialAccountId?: string;
  accounts: Account[];
  onClose: () => void;
  /** 创建/重命名成功后的新文件夹（用于立即写入列表缓存）。 */
  onDone: (folder: FolderType) => void;
}) {
  const [name, setName] = useState(folder?.name ?? "");
  const [accountId, setAccountId] = useState(folder?.account_id ?? initialAccountId ?? accounts[0]?.id ?? "");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim() || !accountId) return;
    setBusy(true);
    try {
      let result: FolderType | undefined;
      if (mode === "create") {
        result = await createFolder(accountId, name.trim(), parent?.id);
        useToastStore.getState().addToast({
          message: parent ? `已在「${parent.name}」下创建文件夹。` : "文件夹已创建。",
          type: "success",
        });
      } else if (folder) {
        result = await renameFolder(accountId, folder.id, name.trim());
        useToastStore.getState().addToast({ message: "文件夹已重命名。", type: "success" });
      }
      if (result) onDone(result);
    } catch (error) {
      useToastStore.getState().addToast({ message: `${mode === "create" ? "创建" : "重命名"}失败：${String(error)}`, type: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 900,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 360,
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          borderRadius: 10,
          padding: 16,
          boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
        }}
      >
        <h3 style={{ margin: "0 0 12px", fontSize: 15 }}>
          {mode === "create" ? (parent ? `在「${parent.name}」下新建文件夹` : "新建文件夹") : "重命名文件夹"}
        </h3>
        {!folder && accounts.length > 1 && (
          <label style={{ display: "block", fontSize: 12, marginBottom: 10 }}>
            <span style={{ display: "block", marginBottom: 4, color: "var(--color-text-secondary)" }}>账号</span>
            <select
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              style={{ width: "100%", padding: "7px 9px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)" }}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>{accountDisplayName(account)}</option>
              ))}
            </select>
          </label>
        )}
        <label style={{ display: "block", fontSize: 12, marginBottom: 12 }}>
          <span style={{ display: "block", marginBottom: 4, color: "var(--color-text-secondary)" }}>文件夹名称</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
            style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)" }}
          />
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} disabled={busy}>取消</button>
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => void submit()}
            style={{ padding: "6px 14px", border: 0, borderRadius: 6, background: "var(--color-accent)", color: "#fff", cursor: busy ? "default" : "pointer" }}
          >
            {busy ? "处理中…" : "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AccountRenameDialog({
  account,
  onClose,
  onDone,
}: {
  account: Account;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(account.display_name ?? "");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await updateAccount(account.id, account.email, name.trim());
      useToastStore.getState().addToast({ message: "账号备注已更新。", type: "success" });
      onDone();
    } catch (error) {
      useToastStore.getState().addToast({ message: `重命名失败：${String(error)}`, type: "error" });
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.35)",
      }}
    >
      <div
        style={{
          width: "min(420px, 90vw)",
          background: "var(--color-bg-primary)",
          border: "1px solid var(--color-border)",
          borderRadius: 10,
          padding: 16,
          boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
        }}
      >
        <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>重命名账号（备注）</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--color-text-secondary)" }}>
          给「{account.email}」起一个方便记忆的名字，例如「老板的 Gmail」或「阿里询盘」。这只保存在本地，不影响邮箱本身。
        </p>
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
          placeholder="输入备注名称"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid var(--color-border)",
            background: "var(--color-bg-secondary)",
            color: "var(--color-text-primary)",
            marginBottom: 12,
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} disabled={busy}>取消</button>
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => void submit()}
            style={{ padding: "6px 14px", border: 0, borderRadius: 6, background: "var(--color-accent)", color: "#fff", cursor: busy ? "default" : "pointer" }}
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
