import { useRef, useMemo, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, Archive, Trash2, MailOpen, MailCheck, Star, X } from "lucide-react";
import { ArrowDown, ArrowUp, Paperclip } from "lucide-react";
import type { MessageSummary } from "@/lib/api";
import { getMessageLabelsBatch, batchArchive, batchMarkRead, batchStar, deleteMessage } from "@/lib/api";
import { useAccountsQuery, useFoldersForAccountsQuery } from "@/hooks/queries";
import { useMailStore } from "@/stores/mail.store";
import { useToastStore } from "@/stores/toast.store";
import { useConfirmStore } from "@/stores/confirm.store";
import { roleForSelection } from "@/lib/folderAggregation";
import { assignAccountColors, getAccountColor, getAccountLabel } from "@/lib/accountColors";
import MessageItem from "./MessageItem";
import { MessageListSkeleton } from "./Skeleton";

interface Props {
  messages: MessageSummary[];
  selectedMessageId: string | null;
  /** 单击：选中并显示（不新开标签页） */
  onSelectMessage: (id: string) => void;
  /** 双击：为该邮件单独打开一个标签页 */
  onOpenMessageTab?: (id: string) => void;
  /** 右键"打开"（同双击效果） */
  onOpenFullscreen?: (id: string) => void;
  loading: boolean;
  onToggleStar?: (messageId: string, newStarred: boolean) => void;
  onLoadMore?: () => void;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
}

export default function MessageList({
  messages,
  selectedMessageId,
  onSelectMessage,
  onOpenMessageTab,
  onOpenFullscreen,
  loading,
  onToggleStar,
  onLoadMore,
  hasNextPage = false,
  isFetchingNextPage = false,
}: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const parentRef = useRef<HTMLDivElement>(null);
  const batchMode = useMailStore((s) => s.batchMode);
  const selectedMessageIds = useMailStore((s) => s.selectedMessageIds);
  const toggleBatchMode = useMailStore((s) => s.toggleBatchMode);
  const clearSelection = useMailStore((s) => s.clearSelection);
  const lastClickIndex = useRef(-1);
  // WebView2/Tauri 下 React onClick 的 ctrlKey/shiftKey 不可靠（实测始终 false），改用
  // window keydown 实时跟踪修饰键状态。
  const modKeys = useRef({ ctrl: false, shift: false, meta: false });
  const [batchLoading, setBatchLoading] = useState(false);
  // 删除请求可能要等待远端邮件服务完成；先隐藏列表行，避免用户看到明显卡顿。
  const [optimisticallyDeletedIds, setOptimisticallyDeletedIds] = useState<Set<string>>(new Set());
  const confirm = useConfirmStore((s) => s.confirm);
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const activeFolderId = useMailStore((s) => s.activeFolderId);
  const { data: accounts = [] } = useAccountsQuery();
  const accountsById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );
  const accountColorsById = useMemo(() => assignAccountColors(accounts), [accounts]);
  // 关闭左侧账号色条（多账号时不再显示蓝色竖条，避免视觉杂乱）
  const showAccountColorMarkers = false;
  const folderAccountIds = useMemo(
    () => activeAccountId ? [activeAccountId] : accounts.map((account) => account.id),
    [accounts, activeAccountId],
  );
  const { data: folders = [] } = useFoldersForAccountsQuery(folderAccountIds);
  // Offer spam action only when NOT already viewing the spam folder
  const activeFolderRole = roleForSelection(activeFolderId, folders);
  const spamFolder = activeAccountId ? folders.find((f) => f.account_id === activeAccountId && f.role === "spam") : undefined;
  const spamFolderId = activeFolderRole !== "spam" ? spamFolder?.id : undefined;
  const visibleMessages = useMemo(
    () => messages.filter((message) => !optimisticallyDeletedIds.has(message.id)),
    [messages, optimisticallyDeletedIds],
  );
  const messageIds = useMemo(() => visibleMessages.map((m) => m.id), [visibleMessages]);
  const messageIdsKey = useMemo(() => messageIds.join(","), [messageIds]);
  const { data: labelsByMessage = {} } = useQuery({
    queryKey: ["message-labels", messageIdsKey],
    queryFn: () => getMessageLabelsBatch(messageIds),
    staleTime: 60_000,
    enabled: messageIds.length > 0,
  });

  type SortKey = "date" | "subject" | "starred" | "attachments";
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("pebble-mail-sort") ?? "");
      if (
        stored
        && ["date", "subject", "starred", "attachments"].includes(stored.key)
        && (stored.dir === "asc" || stored.dir === "desc")
      ) {
        return stored as { key: SortKey; dir: "asc" | "desc" };
      }
    } catch {
      // ignore corrupted value
    }
    return { key: "date", dir: "desc" };
  });

  const sortedMessages = useMemo(() => {
    const copy = [...visibleMessages];
    const factor = sort.dir === "asc" ? 1 : -1;
    copy.sort((left, right) => {
      switch (sort.key) {
        case "subject":
          return (left.subject || "").localeCompare(right.subject || "", "zh") * factor;
        case "starred":
          return (Number(left.is_starred) - Number(right.is_starred)) * factor;
        case "attachments":
          return (Number(left.has_attachments) - Number(right.has_attachments)) * factor;
        case "date":
        default:
          return (left.date - right.date) * factor;
      }
    });
    return copy;
  }, [visibleMessages, sort]);

  useEffect(() => {
    // 重新查询后，已经从服务端消失的 ID 从本地临时集合中清理掉。
    setOptimisticallyDeletedIds((current) => {
      const next = new Set([...current].filter((id) => messages.some((message) => message.id === id)));
      return next.size === current.size ? current : next;
    });
  }, [messages]);

  function toggleSort(key: SortKey) {
    setSort((previous) => {
      const dir: "asc" | "desc" = key === "date" ? "desc" : "asc";
      const next: { key: SortKey; dir: "asc" | "desc" } = previous.key === key
        ? { key, dir: previous.dir === "asc" ? "desc" : "asc" }
        : { key, dir };
      localStorage.setItem("pebble-mail-sort", JSON.stringify(next));
      return next;
    });
  }

  const virtualizer = useVirtualizer({
    count: sortedMessages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 76,
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 5,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastVisibleIndex = virtualItems.length > 0
    ? virtualItems[virtualItems.length - 1].index
    : -1;

  // 文件夹切换回来时不要等用户点击邮件才触发第二次布局。
  // WebView2 在首次挂载/缩放后可能先给虚拟列表一个 0 高度，ResizeObserver
  // 监听到真实尺寸后立即重新测量，保证滚动条和自动分页从第一帧就可用。
  useEffect(() => {
    const element = parentRef.current;
    if (!element) return;
    const measure = () => virtualizer.measure();
    const frame = requestAnimationFrame(measure);
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(measure)
      : null;
    observer?.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [virtualizer, sortedMessages.length]);

  useEffect(() => {
    if (
      onLoadMore
      && hasNextPage
      && !isFetchingNextPage
      && lastVisibleIndex >= Math.max(0, visibleMessages.length - 5)
    ) {
      onLoadMore();
    }
  }, [
    hasNextPage,
    isFetchingNextPage,
    lastVisibleIndex,
    visibleMessages.length,
    onLoadMore,
  ]);

  function handleListScroll(event: React.UIEvent<HTMLDivElement>) {
    if (!onLoadMore || !hasNextPage || isFetchingNextPage) return;
    const element = event.currentTarget;
    // WebView2 can occasionally miss the virtualizer's final range update.
    // The physical scroll position is an independent fallback.
    if (element.scrollHeight - element.scrollTop - element.clientHeight <= 5 * 76) {
      onLoadMore();
    }
  }

  // Scroll selected message into view on keyboard navigation
  useEffect(() => {
    if (!selectedMessageId) return;
    const idx = sortedMessages.findIndex((m) => m.id === selectedMessageId);
    if (idx >= 0) {
      virtualizer.scrollToIndex(idx, { align: "auto" });
    }
  }, [selectedMessageId, sortedMessages, virtualizer]);

  // 所有 hooks 必须在 early return 之前；将早期 return 移到所有 hooks 之后。

  function invalidateMessageViews() {
    queryClient.invalidateQueries({ queryKey: ["messages"] });
    queryClient.invalidateQueries({ queryKey: ["threads"] });
    queryClient.invalidateQueries({ queryKey: ["starred-messages"] });
  }

  function batchActionChangesUnreadCounts(action: "archive" | "delete" | "markRead" | "markUnread" | "star" | "unstar") {
    return action !== "star" && action !== "unstar";
  }

  async function handleBatchAction(action: "archive" | "delete" | "markRead" | "markUnread" | "star" | "unstar") {
    const ids = [...selectedMessageIds];
    if (ids.length === 0) return;
    if (action === "delete") {
      const count = ids.length;
      const ok = await confirm({
        title: t("batch.deleteTitle", { count, defaultValue: `Delete ${count} messages?` }),
        message: t("batch.deleteConfirm", {
          count,
          defaultValue: `This will move ${count} message(s) to Trash. This action can be undone by restoring from Trash.`,
        }),
        confirmLabel: t("batch.deleteButton", { defaultValue: "Delete" }),
        destructive: true,
      });
      if (!ok) return;
    }
    setBatchLoading(true);
    if (action === "delete") {
      setOptimisticallyDeletedIds((current) => new Set([...current, ...ids]));
    }
    try {
      let count = 0;
      if (action === "archive") count = await batchArchive(ids);
      else if (action === "delete") {
        // 删除走单条 deleteMessage（与右键删除同一命令，已验证可用）：
        // 逐条执行，即使服务器不稳也能本地删除成功。
        let ok = 0;
        const failedIds: string[] = [];
        for (const id of ids) {
          try {
            await deleteMessage(id);
            ok += 1;
          } catch {
            failedIds.push(id);
            // 单条失败不阻塞其余
          }
        }
        if (failedIds.length > 0) {
          setOptimisticallyDeletedIds((current) => {
            const next = new Set(current);
            failedIds.forEach((id) => next.delete(id));
            return next;
          });
        }
        count = ok;
      }
      else if (action === "markRead") count = await batchMarkRead(ids, true);
      else if (action === "markUnread") count = await batchMarkRead(ids, false);
      else if (action === "star") count = await batchStar(ids, true);
      else count = await batchStar(ids, false);
      invalidateMessageViews();
      if (batchActionChangesUnreadCounts(action)) {
        queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] });
      }
      addToast({ message: t("batch.success", { count }), type: "success" });
      clearSelection();
    } catch {
      addToast({ message: t("batch.failed"), type: "error" });
    } finally {
      setBatchLoading(false);
    }
  }

  /** 行点击：支持 Ctrl/Cmd 增量多选、Shift 区间多选（普通模式也生效）。 */
  function handleRowClick(event: React.SyntheticEvent | undefined, index: number, messageId: string) {
    const e = event as React.MouseEvent | undefined;
    // 优先用 event（含 nativeEvent）的 ctrlKey/shiftKey，缺失时用 window keydown 跟踪的状态
    const native = event?.nativeEvent as MouseEvent | undefined;
    const ctrlPressed = (e?.ctrlKey || e?.metaKey || native?.ctrlKey || native?.metaKey)
      || modKeys.current.ctrl || modKeys.current.meta;
    const shiftPressed = (e?.shiftKey || native?.shiftKey) || modKeys.current.shift;
    const store = useMailStore.getState();
    if (ctrlPressed) {
      // Ctrl/Cmd + 点击：逐个勾选/取消
      const next = new Set(store.selectedMessageIds);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      useMailStore.setState({ selectedMessageIds: next, batchMode: next.size > 0 });
      lastClickIndex.current = index;
      return;
    }
    if (shiftPressed) {
      // Shift 区间多选：锚点 = 上一次普通点击的 index（lastClickIndex）。
      // 此前错误地以"已选中的第一封"为锚点（selIds 为空时退回当前 index，
      // 导致只选到 1 封）。规范语义：先点起始封（普通点击），再 Shift 点结束封。
      const anchor = lastClickIndex.current >= 0 ? lastClickIndex.current : index;
      const from = Math.min(anchor, index);
      const to = Math.max(anchor, index);
      const next = new Set(sortedMessages.slice(from, to + 1).map((m) => m.id));
      useMailStore.setState({ selectedMessageIds: next, batchMode: true });
      lastClickIndex.current = index;
      return;
    }
    // 无修饰键的普通点击：退出批量模式，单选当前邮件。
    // （此前 batchMode 粘滞——Shift 区间选完后，普通点击仍会继续勾选，
    //   表现为"松开 Shift 还能随便批量选"。常规邮件客户端语义是普通点击=单选。）
    if (batchMode) {
      useMailStore.setState({ selectedMessageIds: new Set(), batchMode: false });
      lastClickIndex.current = index;
      onSelectMessage(messageId);
      return;
    }
    lastClickIndex.current = index;
    onSelectMessage(messageId);
  }

  // 实时跟踪修饰键（Tauri WebView2 下 React onClick 的 ctrlKey/shiftKey 不可靠，
  // 用 window keydown/keyup 持续记录，key/code 双兜底）
  useEffect(() => {
    const isShiftKey = (e: KeyboardEvent) => e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight";
    const isCtrlKey = (e: KeyboardEvent) => e.key === "Control" || e.code === "ControlLeft" || e.code === "ControlRight";
    const isMetaKey = (e: KeyboardEvent) => e.key === "Meta" || e.code === "MetaLeft" || e.code === "MetaRight";

    const onKey = (event: KeyboardEvent) => {
      // 注意：keyup 时 event.key 仍是 "Shift"/"Control"，必须按事件类型区分——
      // 按下=记录 true，松开=记录 false；不能只靠 key 判断（否则松开后永远卡 true）。
      if (event.type === "keyup") {
        if (isShiftKey(event)) modKeys.current.shift = false;
        if (isCtrlKey(event)) modKeys.current.ctrl = false;
        if (isMetaKey(event)) modKeys.current.meta = false;
        // 组合键松开的顺序可能不规则，用 event.shiftKey/ctrlKey/metaKey 兜底清零
        modKeys.current.shift = modKeys.current.shift && event.shiftKey;
        modKeys.current.ctrl = modKeys.current.ctrl && event.ctrlKey;
        modKeys.current.meta = modKeys.current.meta && event.metaKey;
        return;
      }
      // keydown
      modKeys.current.shift = event.shiftKey || isShiftKey(event);
      modKeys.current.ctrl = event.ctrlKey || isCtrlKey(event);
      modKeys.current.meta = event.metaKey || isMetaKey(event);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", () => {
      modKeys.current.ctrl = false;
      modKeys.current.meta = false;
      modKeys.current.shift = false;
    });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, []);

  // Delete 键删除：焦点不在输入框时，删除批量选中的邮件；否则删除当前选中邮件。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Delete") return;
      const target = event.target as HTMLElement | null;
      if (target && target.closest("input, textarea, select, [contenteditable='true']")) return;
      const store = useMailStore.getState();
      const ids = store.selectedMessageIds.size > 0
        ? [...store.selectedMessageIds]
        : store.selectedMessageId
          ? [store.selectedMessageId]
          : [];
      if (ids.length === 0) return;
      event.preventDefault();
      useMailStore.setState({
        selectedMessageIds: new Set(ids),
        batchMode: true,
      });
      setBatchLoading(true);
      setOptimisticallyDeletedIds((current) => new Set([...current, ...ids]));
      void (async () => {
        let ok = 0;
        const failedIds: string[] = [];
        for (const id of ids) {
          try {
            await deleteMessage(id);
            ok += 1;
          } catch {
            failedIds.push(id);
            // 单条失败不阻塞其余
          }
        }
        if (failedIds.length > 0) {
          setOptimisticallyDeletedIds((current) => {
            const next = new Set(current);
            failedIds.forEach((id) => next.delete(id));
            return next;
          });
        }
        invalidateMessageViews();
        useMailStore.setState({ selectedMessageIds: new Set(), batchMode: false, selectedMessageId: null });
        if (batchActionChangesUnreadCounts("delete")) {
          queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] });
        }
        addToast({ message: t("batch.success", { count: ok }), type: ok > 0 ? "success" : "error" });
        setBatchLoading(false);
      })();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addToast, invalidateMessageViews, queryClient, t]);

  // 早期 return 必须放在所有 hooks 之后（React 规则：hooks 数量在每次渲染必须一致）
  if (loading) {
    return <MessageListSkeleton />;
  }
  if (visibleMessages.length === 0) {
    return (
      <div
        className="fade-in"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "var(--color-text-secondary)",
          fontSize: "14px",
          gap: "8px",
        }}
      >
        <Inbox size={32} strokeWidth={1.2} />
        {t("common.noMessages")}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, minWidth: 0 }}>
      {/* Batch toolbar */}
      {batchMode && (
        <div style={{
          display: "flex", alignItems: "center", gap: "6px",
          padding: "6px 10px", borderBottom: "1px solid var(--color-border)",
          backgroundColor: "var(--color-bg)", flexShrink: 0,
        }}>
          <span style={{ fontSize: 12, color: "var(--color-text-secondary)", padding: "0 4px" }}>
            {selectedMessageIds.size > 0 ? `已选 ${selectedMessageIds.size} 封` : "可用 Ctrl/Shift 点击多选"}
          </span>
          {selectedMessageIds.size > 0 && (
            <>
              <BatchBtn icon={Archive} label={t("messageActions.archive")} onClick={() => handleBatchAction("archive")} disabled={batchLoading} />
              <BatchBtn icon={Trash2} label={t("common.delete")} onClick={() => handleBatchAction("delete")} disabled={batchLoading} />
              <BatchBtn icon={MailOpen} label={t("batch.markRead")} onClick={() => handleBatchAction("markRead")} disabled={batchLoading} />
              <BatchBtn icon={MailCheck} label={t("batch.markUnread")} onClick={() => handleBatchAction("markUnread")} disabled={batchLoading} />
              <BatchBtn icon={Star} label={t("batch.star", "Star")} onClick={() => handleBatchAction("star")} disabled={batchLoading} />
              <BatchBtn icon={Star} label={t("batch.unstar", "Unstar")} onClick={() => handleBatchAction("unstar")} disabled={batchLoading} />
            </>
          )}
          <BatchBtn icon={X} label={t("common.close")} onClick={toggleBatchMode} disabled={false} />
        </div>
      )}
      {visibleMessages.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "2px",
            padding: "3px 8px",
            borderBottom: "1px solid var(--color-border)",
            backgroundColor: "var(--color-bg-secondary)",
            flexShrink: 0,
            fontSize: 11,
          }}
        >
          <SortButton
            label="附件"
            icon={<Paperclip size={11} />}
            active={sort.key === "attachments"}
            dir={sort.key === "attachments" ? sort.dir : null}
            onClick={() => toggleSort("attachments")}
          />
          <SortButton
            label="星标"
            icon={<Star size={11} />}
            active={sort.key === "starred"}
            dir={sort.key === "starred" ? sort.dir : null}
            onClick={() => toggleSort("starred")}
          />
          <SortButton
            label="主题"
            active={sort.key === "subject"}
            dir={sort.key === "subject" ? sort.dir : null}
            onClick={() => toggleSort("subject")}
          />
          <div style={{ flex: 1 }} />
          <SortButton
            label="日期"
            active={sort.key === "date"}
            dir={sort.key === "date" ? sort.dir : null}
            onClick={() => toggleSort("date")}
          />
        </div>
      )}
      <div
        ref={parentRef}
        className="scroll-region message-list-scroll"
        role="listbox"
        aria-label={t("inbox.messageList", "Messages")}
        onScroll={handleListScroll}
        style={{ flex: "1 1 0", minHeight: 0, minWidth: 0, overflow: "auto" }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: "relative",
          }}
        >
          {virtualItems.map((virtualItem) => {
            const message = sortedMessages[virtualItem.index];
            const account = accountsById.get(message.account_id);
            return (
              <div
                key={virtualItem.key}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <MessageItem
                  message={message}
                  labels={labelsByMessage[message.id] ?? []}
                  isSelected={message.id === selectedMessageId}
                  onClick={(event) => handleRowClick(event, virtualItem.index, message.id)}
                  onDoubleClick={() => { if (!batchMode) onOpenMessageTab?.(message.id); }}
                  onOpenFullscreen={() => { if (!batchMode) onOpenFullscreen?.(message.id); }}
                  onToggleStar={onToggleStar}
                  batchMode={batchMode}
                  batchSelected={selectedMessageIds.has(message.id)}
                  spamFolderId={spamFolderId}
                  folderRole={activeFolderRole}
                  activeFolderId={activeFolderId}
                  accountColor={
                    showAccountColorMarkers
                      ? accountColorsById.get(message.account_id) ?? getAccountColor(account, message.account_id)
                      : undefined
                  }
                  accountLabel={showAccountColorMarkers ? getAccountLabel(account, message.account_id) : undefined}
                />
              </div>
            );
          })}
        </div>
        {onLoadMore && hasNextPage && (
          <div style={{ padding: "10px", textAlign: "center" }}>
            <button
              type="button"
              onClick={onLoadMore}
              disabled={isFetchingNextPage}
              aria-label="加载更多邮件"
              style={{
                border: "1px solid var(--color-border)",
                borderRadius: 6,
                background: "var(--color-bg)",
                color: "var(--color-text-secondary)",
                padding: "6px 14px",
                cursor: isFetchingNextPage ? "default" : "pointer",
                fontSize: 12,
              }}
            >
              {isFetchingNextPage ? t("common.loading", "Loading...") : "加载更多邮件"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function BatchBtn({ icon: Icon, label, onClick, disabled }: {
  icon: React.ElementType; label: string; onClick: () => void; disabled: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      style={{
        display: "flex", alignItems: "center", padding: "4px",
        border: "none", background: "transparent", borderRadius: "4px",
        cursor: disabled ? "default" : "pointer",
        color: "var(--color-text-secondary)", opacity: disabled ? 0.5 : 1,
      }}
    >
      <Icon size={14} />
    </button>
  );
}

function SortButton({
  label,
  icon,
  active,
  dir,
  onClick,
}: {
  label: string;
  icon?: React.ReactNode;
  active: boolean;
  dir: "asc" | "desc" | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`按${label}排序`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 3,
        padding: "2px 7px",
        border: "1px solid",
        borderColor: active ? "var(--color-accent)" : "transparent",
        borderRadius: 4,
        background: active ? "color-mix(in srgb, var(--color-accent) 10%, transparent)" : "transparent",
        color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
        cursor: "pointer",
        fontSize: 11,
      }}
    >
      {icon}
      {label}
      {active && dir && (dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </button>
  );
}
