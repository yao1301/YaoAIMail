import { useMailStore } from "@/stores/mail.store";
import { useComposeStore } from "@/stores/compose.store";
import { useAccountsQuery, useMessagesQuery, useThreadsQuery, useFoldersForAccountsQuery, useMessageQuery, patchMessagesCache } from "@/hooks/queries";
import { useUIStore } from "@/stores/ui.store";
import { useToastStore } from "@/stores/toast.store";
import MessageList from "@/components/MessageList";
import MessageDetail from "@/components/MessageDetail";
import ThreadView from "./ThreadView";
import ThreadItem from "@/components/ThreadItem";
import SearchBar from "@/components/SearchBar";
import SearchFilterDropdown from "@/components/SearchFilterDropdown";
import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { listen } from "@tauri-apps/api/event";
import { List, MessageSquare, Mail, Trash2, Inbox, CheckSquare, RefreshCw, PanelLeft, PanelTop, Reply, ReplyAll, Forward, Star, Archive, Sparkles, Search } from "lucide-react";
import { MessageListSkeleton } from "@/components/Skeleton";
import { emptyTrash, triggerSync, aiPrompt, getMessage, deleteMessage, listAttachments } from "@/lib/api";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { folderIdsForSelection, roleForSelection, isAllAccountsFolderId } from "@/lib/folderAggregation";
import type { ThreadSummary } from "@/lib/api";

const EMPTY_THREADS: ThreadSummary[] = [];

export default function InboxView() {
  const { t } = useTranslation();
  const setActiveView = useUIStore((s) => s.setActiveView);
  const activeFolderId = useMailStore((s) => s.activeFolderId);
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const searchScope = useMailStore((s) => s.searchScope);
  const selectedMessageId = useMailStore((s) => s.selectedMessageId);
  const setSelectedMessage = useMailStore((s) => s.setSelectedMessage);
  const threadView = useMailStore((s) => s.threadView);
  const toggleThreadView = useMailStore((s) => s.toggleThreadView);
  const selectedThreadId = useMailStore((s) => s.selectedThreadId);
  const setSelectedThreadId = useMailStore((s) => s.setSelectedThreadId);
  const { data: accounts = [] } = useAccountsQuery();
  const folderAccountIds = useMemo(
    () => activeAccountId ? [activeAccountId] : accounts.map((account) => account.id),
    [accounts, activeAccountId],
  );
  const { data: folders = [] } = useFoldersForAccountsQuery(folderAccountIds);
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const openCompose = useComposeStore((s) => s.openCompose);
  const { data: selectedMessage } = useMessageQuery(selectedMessageId);
  const hasSelection = !!(threadView ? selectedThreadId : selectedMessageId);
  const [aiReplying, setAiReplying] = useState(false);
  // We can read `is_starred` only from MessageSummary (list entry); useMessageQuery
  // returns a Message that doesn't expose it, so the toolbar calls handleToggleStar
  // and trusts the optimistic UI update to reflect the new state.
  const [showTrashConfirm, setShowTrashConfirm] = useState(false);
  const [listWidth, setListWidth] = useState(() => {
    const stored = Number(localStorage.getItem("pebble-inbox-list-width"));
    return Number.isFinite(stored) && stored >= 240 ? stored : 340;
  });
  const [listHeight, setListHeight] = useState(() => {
    const stored = Number(localStorage.getItem("pebble-inbox-list-height"));
    return Number.isFinite(stored) && stored >= 160 ? stored : 320;
  });
  const [stackedLayout, setStackedLayout] = useState(
    () => localStorage.getItem("pebble-inbox-stacked-layout") === "1",
  );
  const [syncing, setSyncing] = useState(false);
  // 账户空态搜索框的关键词（受控，供内联筛选下拉读取）。
  const [accountSearchQuery, setAccountSearchQuery] = useState("");

  const beginResizeList = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = listWidth;
    const onMove = (moveEvent: MouseEvent) => {
      const next = Math.min(620, Math.max(240, startWidth + moveEvent.clientX - startX));
      setListWidth(next);
    };
    const onUp = (upEvent: MouseEvent) => {
      const next = Math.min(620, Math.max(240, startWidth + upEvent.clientX - startX));
      localStorage.setItem("pebble-inbox-list-width", String(next));
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [listWidth]);

  const beginResizeHeight = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = listHeight;
    const onMove = (moveEvent: MouseEvent) => {
      const next = Math.min(720, Math.max(160, startHeight + moveEvent.clientY - startY));
      setListHeight(next);
    };
    const onUp = (upEvent: MouseEvent) => {
      const next = Math.min(720, Math.max(160, startHeight + upEvent.clientY - startY));
      localStorage.setItem("pebble-inbox-list-height", String(next));
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [listHeight]);

  function toggleStackedLayout() {
    const next = !stackedLayout;
    setStackedLayout(next);
    localStorage.setItem("pebble-inbox-stacked-layout", next ? "1" : "0");
  }

  async function handleReceiveMail() {
    const targetAccountIds = activeAccountId
      ? [activeAccountId]
      : accounts.map((account) => account.id);
    if (targetAccountIds.length === 0) return;
    setSyncing(true);
    try {
      const results = await Promise.all(targetAccountIds.map(async (accountId) => {
        const waiter = waitForSyncCompletion(accountId);
        try {
          await triggerSync(accountId, "manual");
        } catch (error) {
          return { ok: false, message: extractErrorMessage(error) };
        }
        return waiter;
      }));
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] });
      const failures = results.filter((result) => !result.ok);
      if (failures.length === results.length) {
        addToast({ message: `收取邮件失败：${failures[0]?.message ?? "未知错误"}`, type: "error", duration: 12_000 });
      } else if (failures.length > 0) {
        addToast({
          message: `部分账号收取完成，但有 ${failures.length} 个账号失败：${failures[0]?.message ?? ""}`,
          type: "error",
          duration: 12_000,
        });
      } else {
        addToast({ message: "邮件已收取完成，列表已刷新。", type: "success" });
      }
    } finally {
      setSyncing(false);
    }
  }

  function waitForSyncCompletion(accountId: string, timeoutMs = 120_000): Promise<{ ok: boolean; message?: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: { ok: boolean; message?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unlistenPromises.forEach((promise) => {
          promise.then((fn) => fn()).catch(() => {});
        });
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ ok: false, message: "收取超时，请查看底部状态栏提示或稍后重试。" }),
        timeoutMs,
      );
      const unlistenPromises: Promise<() => void>[] = [];
      unlistenPromises.push(
        listen<{ account_id?: string }>("mail:sync-complete", (event) => {
          if (event.payload?.account_id === accountId) finish({ ok: true });
        }),
      );
      unlistenPromises.push(
        listen<{ account_id?: string; status?: string; message?: string | null }>("mail:sync-progress", (event) => {
          if (event.payload?.account_id !== accountId) return;
          if (event.payload.status === "completed") finish({ ok: true });
          if (event.payload.status === "error") {
            finish({ ok: false, message: event.payload.message ?? "收取失败" });
          }
        }),
      );
      unlistenPromises.push(
        listen<{ account_id?: string; message: string }>("mail:error", (event) => {
          if (event.payload.account_id === accountId) {
            finish({ ok: false, message: event.payload.message });
          }
        }),
      );
      unlistenPromises.push(
        listen<{ account_id?: string }>("mail:new", (event) => {
          if (event.payload?.account_id === accountId) finish({ ok: true });
        }),
      );
    });
  }

  const activeFolderRole = roleForSelection(activeFolderId, folders);
  const isTrashFolder = activeFolderRole === "trash";
  const selectedFolderIds = folderIdsForSelection(activeFolderId, folders);
  const queryFolderId = selectedFolderIds[0] ?? null;
  const queryFolderIds = selectedFolderIds.length > 1 ? selectedFolderIds : undefined;

  const {
    data: messages,
    isLoading: loadingMessages,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useMessagesQuery(
    threadView ? null : queryFolderId,
    threadView ? undefined : queryFolderIds,
    // "所有未读"视图：查全部账户未读
    !threadView && isAllAccountsFolderId(activeFolderId) && activeFolderRole === "inbox",
  );
  const { data: threads = EMPTY_THREADS, isLoading: loadingThreads } = useThreadsQuery(
    threadView ? queryFolderId : null,
    50,
    0,
    threadView ? queryFolderIds : undefined,
  );
  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  /** AI 一键回复：基于当前选中邮件生成回复草稿并打开写信页。 */
  const handleAiReply = useCallback(async () => {
    if (aiReplying || !selectedMessage) return;
    setAiReplying(true);
    try {
      // 用完整邮件（含正文）打开回复，否则写信页的原文引用区没有内容
      const full = await getMessage(selectedMessage.id);
      if (!full) throw new Error("无法读取邮件全文");
      const sender = full.from_name || full.from_address || "";
      const subject = full.subject || "(无主题)";
      const bodyText = full.body_text?.trim()
        ? full.body_text.slice(0, 4000)
        : "(无正文内容)";
      const system =
        "你是外贸业务员的 AI 邮件助手。请阅读下面的原始邮件，写一封专业、得体的回复草稿。" +
        "要求：直接输出邮件正文（不含主题行），语气自然、符合商务邮件习惯；" +
        "如果原文是询盘或报价咨询，回复中给出对方需要的要点；不要编造不存在的价格/交期/承诺。";
      const user =
        `【原始邮件】\n发件人：${sender}\n主题：${subject}\n\n${bodyText}\n\n` +
        `请生成回复草稿（直接输出正文，不需要主题行）。`;
      const draft = await aiPrompt(system, user);
      openCompose("reply", full as never, { body: draft.trim() });
      addToast({ message: "AI 已生成回复草稿，请检查后发送。", type: "success" });
    } catch (error) {
      addToast({ message: `AI 回复生成失败：${String(error)}`, type: "error" });
    } finally {
      setAiReplying(false);
    }
  }, [aiReplying, selectedMessage, openCompose, addToast]);
  const handleToggleStar = useCallback((messageId: string, newStarred: boolean) => {
    patchMessagesCache(queryClient, (page) =>
      page.map((m) => (m.id === messageId ? { ...m, is_starred: newStarred } : m)),
    );
  }, [queryClient]);

  const openMessageOrDraft = useCallback(async (messageId: string, fullscreen = false) => {
    const summary = messages.find((item) => item.id === messageId);
    if (!summary?.is_draft) {
      if (fullscreen) {
        useMailStore.getState().setSelectedMessage(messageId);
        useUIStore.getState().setMessageDetailId(messageId);
        useUIStore.getState().setActiveView("messageDetail");
      } else {
        useMailStore.getState().selectMessage(messageId);
      }
      return;
    }

    try {
      const [draft, draftAttachments] = await Promise.all([
        getMessage(messageId),
        listAttachments(messageId),
      ]);
      if (!draft) throw new Error("草稿不存在或尚未同步完成");
      const richTextHtml = draft.body_html_raw?.trim()
        ? draft.body_html_raw
        : draft.body_text
          .split(/\r?\n/)
          .map((line) => line
            ? `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`
            : "<p><br></p>")
          .join("");
      useComposeStore.getState().openDraft({
        sourceDraftId: draft.id,
        accountId: draft.account_id,
        to: draft.to_list.map((address) => address.address).filter(Boolean),
        cc: draft.cc_list.map((address) => address.address).filter(Boolean),
        bcc: draft.bcc_list.map((address) => address.address).filter(Boolean),
        subject: draft.subject,
        rawSource: draft.body_text,
        richTextHtml,
        editorMode: "rich",
        attachments: draftAttachments
          .filter((attachment) => !attachment.is_inline && !!attachment.local_path)
          .map((attachment) => ({
            name: attachment.filename,
            path: attachment.local_path as string,
            size: attachment.size,
          })),
        savedAt: Date.now(),
      });
    } catch (error) {
      addToast({ message: `打开草稿失败：${extractErrorMessage(error)}`, type: "error" });
    }
  }, [addToast, messages]);

  const detailOpen = threadView ? selectedThreadId !== null : selectedMessageId !== null;

  // No accounts or no folder selected — show welcome / setup prompt
  // Clicking an account name selects the account scope: 右侧给出账户级搜索框，
  // 回车后带 searchScope（{kind:"account"}）进入搜索页，搜索整个账号的邮件。
  if (searchScope?.kind === "account" && searchScope.accountId === activeAccountId) {
    const account = accounts.find((item) => item.id === activeAccountId);
    const accountName = account?.display_name || account?.email || "当前账号";
    return (
      <div className="fade-in" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: "16px", color: "var(--color-text-secondary)", padding: "24px" }}>
        <Inbox size={42} strokeWidth={1.2} />
        <strong style={{ color: "var(--color-text-primary)", fontSize: 16 }}>{accountName}</strong>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const value = accountSearchQuery.trim();
            if (!value) return;
            useUIStore.getState().setSearchQuery(value);
            useUIStore.getState().setPendingSearchFilters({});
            useUIStore.getState().setActiveView("search");
          }}
          className="search-toolbar"
          style={{ width: "min(480px, 100%)" }}
        >
          <div className="search-input-shell">
            <Search size={15} aria-hidden="true" />
            <input
              type="text"
              name="account-search"
              value={accountSearchQuery}
              onChange={(event) => setAccountSearchQuery(event.target.value)}
              placeholder={`搜索 ${accountName} 的全部邮件…`}
              aria-label="搜索整个账号的邮件"
              autoFocus
              className="search-input"
            />
          </div>
          <SearchFilterDropdown
            query={accountSearchQuery}
            onSearch={({ query, filters }) => {
              useUIStore.getState().setSearchQuery(query);
              useUIStore.getState().setPendingSearchFilters(filters);
              useUIStore.getState().setActiveView("search");
            }}
          />
          <button type="submit" className="search-toolbar-button search-toolbar-button--primary">
            <Search size={14} aria-hidden="true" />
            {t("search.searchButton", "Search")}
          </button>
        </form>
        <span style={{ fontSize: 12, maxWidth: 460, textAlign: "center", lineHeight: 1.6 }}>
          可搜索该账号全部文件夹的邮件（主题、发件人、正文）；也可以点击左侧文件夹浏览邮件
        </span>
      </div>
    );
  }

  if (accounts.length === 0 || !activeFolderId) {
    return (
      <div className="fade-in" style={{
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        height: "100%", gap: "16px", color: "var(--color-text-secondary)",
      }}>
        <Mail size={48} strokeWidth={1.2} />
        <p style={{ fontSize: "16px", fontWeight: 500, color: "var(--color-text-primary)", margin: 0 }}>
          {t("inbox.welcome", "Welcome to YaoAIMail")}
        </p>
        <p style={{ fontSize: "13px", margin: 0 }}>
          {t("inbox.addAccountHint", "Add an email account to get started")}
        </p>
        <button
          onClick={() => setActiveView("settings")}
          style={{
            marginTop: "8px", padding: "8px 20px", borderRadius: "6px",
            border: "none", backgroundColor: "var(--color-accent)", color: "#fff",
            fontSize: "13px", fontWeight: 600, cursor: "pointer",
          }}
        >
          {t("settings.addAccount", "Add Account")}
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div className="inbox-toolbar-row">
        {/* Action buttons (left): disabled when no selection */}
        <button
          type="button"
          disabled={!hasSelection || !selectedMessage || aiReplying}
          onClick={() => void handleAiReply()}
          aria-label="AI 回复"
          title={aiReplying ? "AI 正在生成回复…" : "AI 回复：基于当前邮件生成回复草稿"}
          className="inbox-toolbar-button"
          style={{
            opacity: !hasSelection || !selectedMessage || aiReplying ? 0.4 : 1,
            color: "var(--color-accent)",
          }}
        >
          <Sparkles size={16} className={aiReplying ? "spinner" : ""} />
        </button>
        <button
          type="button"
          disabled={!hasSelection || !selectedMessage}
          onClick={() => {
            if (!selectedMessage) return;
            openCompose("reply", selectedMessage as never);
          }}
          aria-label={t("messageActions.reply", "Reply")}
          title={t("messageActions.reply", "Reply")}
          className="inbox-toolbar-button"
          style={{ opacity: !hasSelection || !selectedMessage ? 0.4 : 1 }}
        >
          <Reply size={16} />
        </button>
        <button
          type="button"
          disabled={!hasSelection || !selectedMessage}
          onClick={() => {
            if (!selectedMessage) return;
            openCompose("reply-all", selectedMessage as never);
          }}
          aria-label={t("messageActions.replyAll", "Reply all")}
          title={t("messageActions.replyAll", "Reply all")}
          className="inbox-toolbar-button"
          style={{ opacity: !hasSelection || !selectedMessage ? 0.4 : 1 }}
        >
          <ReplyAll size={16} />
        </button>
        <button
          type="button"
          disabled={!hasSelection || !selectedMessage}
          onClick={() => {
            if (!selectedMessage) return;
            openCompose("forward", selectedMessage as never);
          }}
          aria-label={t("messageActions.forward", "Forward")}
          title={t("messageActions.forward", "Forward")}
          className="inbox-toolbar-button"
          style={{ opacity: !hasSelection || !selectedMessage ? 0.4 : 1 }}
        >
          <Forward size={16} />
        </button>
        <button
          type="button"
          disabled={!hasSelection || !selectedMessage}
          onClick={() => {
            if (!selectedMessage) return;
            handleToggleStar(selectedMessage.id, true);
          }}
          aria-label={t("messageActions.star", "Star")}
          title={t("messageActions.star", "Star")}
          className="inbox-toolbar-button"
          style={{ opacity: !hasSelection || !selectedMessage ? 0.4 : 1 }}
        >
          <Star size={16} />
        </button>
        <button
          type="button"
          disabled={!hasSelection || !selectedMessage}
          onClick={() => {
            if (!selectedMessage) return;
            addToast({ message: t("messageActions.archivePending"), type: "info" });
          }}
          aria-label={t("messageActions.archive", "Archive")}
          title={t("messageActions.archive", "Archive")}
          className="inbox-toolbar-button"
          style={{ opacity: !hasSelection || !selectedMessage ? 0.4 : 1 }}
        >
          <Archive size={16} />
        </button>
        <button
          type="button"
          disabled={!hasSelection || !selectedMessage}
          onClick={() => {
            if (!selectedMessage) return;
            const messageId = selectedMessage.id;
            patchMessagesCache(queryClient, (page) => page.filter((item) => item.id !== messageId));
            void deleteMessage(messageId)
              .then(() => {
                setSelectedMessage(null);
                addToast({ message: t("messageActions.deleteSuccess", "Message deleted"), type: "success" });
              })
              .catch(() => {
                queryClient.invalidateQueries({ queryKey: ["messages"] });
                addToast({ message: t("messageActions.deleteFailed", "Failed to delete message"), type: "error" });
              });
          }}
          aria-label={t("messageActions.delete", "Delete")}
          title={t("messageActions.delete", "Delete")}
          className="inbox-toolbar-button"
          style={{ opacity: !hasSelection || !selectedMessage ? 0.4 : 1 }}
        >
          <Trash2 size={16} />
        </button>
        <button
          type="button"
          onClick={() => void handleReceiveMail()}
          aria-label="收取邮件"
          className="inbox-toolbar-button"
          title="收取邮件"
          disabled={syncing}
          style={{ opacity: syncing ? 0.55 : 1 }}
        >
          <RefreshCw size={16} className={syncing ? "spinner" : ""} />
        </button>
        {isTrashFolder && messages.length > 0 && (
          <>
            <button
              onClick={() => setShowTrashConfirm(true)}
              style={{
                background: "none", border: "1px solid var(--color-border)", cursor: "pointer",
                padding: "4px 10px", borderRadius: "4px", color: "var(--color-text-secondary)",
                display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", marginRight: "4px",
              }}
              title={t("messageActions.emptyTrash", "Empty Trash")}
            >
              <Trash2 size={14} />
              {t("messageActions.emptyTrash", "Empty Trash")}
            </button>
            {showTrashConfirm && (
              <ConfirmDialog
                title={t("messageActions.emptyTrash", "Empty Trash")}
                message={t("messageActions.emptyTrashConfirm", "Permanently delete all messages in Trash?")}
                destructive
                onCancel={() => setShowTrashConfirm(false)}
                onConfirm={async () => {
                  setShowTrashConfirm(false);
                  try {
                    const targetAccountIds = activeAccountId ? [activeAccountId] : accounts.map((account) => account.id);
                    const counts = await Promise.all(targetAccountIds.map((accountId) => emptyTrash(accountId)));
                    const count = counts.reduce((sum, current) => sum + current, 0);
                    queryClient.invalidateQueries({ queryKey: ["messages"] });
                    addToast({ message: t("messageActions.emptyTrashSuccess", { count }), type: "success" });
                  } catch {
                    addToast({ message: t("messageActions.emptyTrashFailed"), type: "error" });
                  }
                }}
              />
            )}
          </>
        )}
        {!threadView && (
          <button
            type="button"
            onClick={() => useMailStore.getState().toggleBatchMode()}
            aria-label={t("batch.toggle", "Batch select")}
            className="inbox-toolbar-button"
            title={t("batch.toggle", "Batch select")}
          >
            <CheckSquare size={16} />
          </button>
        )}
        <button
          type="button"
          onClick={toggleThreadView}
          aria-label={threadView ? t("inbox.messageView") : t("inbox.threadView")}
          className="inbox-toolbar-button inbox-toolbar-button--end"
          title={threadView ? t("inbox.messageView") : t("inbox.threadView")}
        >
          {threadView ? <List size={16} /> : <MessageSquare size={16} />}
        </button>
        <button
          type="button"
          onClick={toggleStackedLayout}
          aria-label={stackedLayout ? "切换为左右分栏" : "切换为上下分栏"}
          className="inbox-toolbar-button inbox-toolbar-button--end"
          title={stackedLayout ? "切换为左右分栏" : "切换为上下分栏"}
        >
          {stackedLayout ? <PanelLeft size={16} /> : <PanelTop size={16} />}
        </button>
        {/* SearchBar pushed to the far right */}
        <div className="inbox-toolbar-search" style={{ marginLeft: "auto" }}>
          <SearchBar onSearch={() => {}} onClear={() => {}} />
        </div>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: stackedLayout ? "column" : "row",
          flex: 1,
          minHeight: 0,
          minWidth: 0,
        }}
      >
        {/* List panel */}
        <div
          style={{
            width: !stackedLayout && detailOpen ? `${listWidth}px` : undefined,
            height: stackedLayout && detailOpen ? `${listHeight}px` : undefined,
            flex: !detailOpen ? "1 1 auto" : "0 0 auto",
            flexShrink: 0,
            borderRight: !stackedLayout && detailOpen
              ? "1px solid color-mix(in srgb, var(--color-border) 100%, transparent)"
              : "none",
            borderBottom: stackedLayout && detailOpen
              ? "1px solid color-mix(in srgb, var(--color-border) 100%, transparent)"
              : "none",
            boxShadow: detailOpen
              ? stackedLayout
                ? "0 2px 6px rgba(0,0,0,0.08)"
                : "2px 0 6px rgba(0,0,0,0.08)"
              : "none",
            background: "var(--color-bg-primary)",
            position: "relative",
            zIndex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            minHeight: 0,
            minWidth: 0,
          }}
        >
          {threadView ? (
            <ThreadList
              threads={threads}
              selectedThreadId={selectedThreadId}
              onSelectThread={setSelectedThreadId}
              loading={loadingThreads}
            />
          ) : (
            <MessageList
              messages={messages}
              selectedMessageId={selectedMessageId}
              onSelectMessage={(id) => {
                // 单击只选中邮件；草稿和普通邮件都要双击才执行打开动作。
                useMailStore.getState().selectMessage(id);
              }}
              onOpenMessageTab={(id) => {
                // 双击：开标签 + 该标签只显示邮件详情（无列表，顶部保留常用命令）
                void openMessageOrDraft(id, true);
              }}
              onOpenFullscreen={(id) => {
                // 右键"打开"：同双击效果
                void openMessageOrDraft(id, true);
              }}
              loading={loadingMessages}
              onLoadMore={handleLoadMore}
              hasNextPage={hasNextPage}
              isFetchingNextPage={isFetchingNextPage}
              onToggleStar={handleToggleStar}
            />
          )}
        </div>

        {detailOpen && (
          <div
            role="separator"
            aria-label={stackedLayout ? "调整邮件列表高度" : "调整邮件列表宽度"}
            onMouseDown={stackedLayout ? beginResizeHeight : beginResizeList}
            style={{
              [stackedLayout ? "height" : "width"]: "5px",
              [stackedLayout ? "marginTop" : "marginLeft"]: "-3px",
              [stackedLayout ? "marginBottom" : "marginRight"]: "-2px",
              cursor: stackedLayout ? "row-resize" : "col-resize",
              zIndex: 2,
              flexShrink: 0,
            }}
          />
        )}

        {/* Detail panel */}
        {detailOpen && (
          <div style={{ flex: 1, overflow: "hidden", minHeight: 0, minWidth: 0 }}>
            {threadView && selectedThreadId ? (
              <ThreadView />
            ) : selectedMessageId ? (
              <MessageDetail
                messageId={selectedMessageId}
                onBack={() => setSelectedMessage(null)}
                folderRole={activeFolderRole}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

// Inline ThreadList component using virtualizer
function ThreadList({ threads, selectedThreadId, onSelectThread, loading }: {
  threads: { thread_id: string; subject: string; snippet: string; last_date: number; message_count: number; unread_count: number; is_starred: boolean; participants: string[]; has_attachments: boolean }[];
  selectedThreadId: string | null;
  onSelectThread: (id: string) => void;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: threads.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 76,
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 5,
  });

  // Scroll selected thread into view on keyboard navigation
  useEffect(() => {
    if (!selectedThreadId) return;
    const idx = threads.findIndex((t) => t.thread_id === selectedThreadId);
    if (idx >= 0) {
      virtualizer.scrollToIndex(idx, { align: "auto" });
    }
  }, [selectedThreadId, threads, virtualizer]);

  if (loading) {
    return <MessageListSkeleton />;
  }

  if (threads.length === 0) {
    return (
      <div className="fade-in" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--color-text-secondary)", fontSize: "14px", gap: "8px" }}>
        <Inbox size={32} strokeWidth={1.2} />
        {t("common.noThreads")}
      </div>
    );
  }

  return (
    <div ref={parentRef} className="scroll-region thread-list-scroll" style={{ height: "100%", overflow: "auto" }}>
      <div
        role="listbox"
        aria-label={t("inbox.threadList", "Threads")}
        style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const thread = threads[virtualItem.index];
          return (
            <div
              key={virtualItem.key}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              style={{
                position: "absolute", top: 0, left: 0, width: "100%",
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <ThreadItem
                thread={thread}
                isSelected={thread.thread_id === selectedThreadId}
                onClick={() => onSelectThread(thread.thread_id)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
