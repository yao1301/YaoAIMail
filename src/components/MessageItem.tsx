import { memo, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  Star,
  Paperclip,
  Archive,
  ShieldAlert,
  ShieldCheck,
  RotateCcw,
  Reply,
  ReplyAll,
  Forward,
  Pencil,
  MailOpen,
  MailCheck,
  Trash2,
  FolderInput,
  ChevronLeft,
  Sparkles,
  FileDown,
  Filter,
  Mail,
  Printer,
  Paperclip as AttachForward,
  Bot,
} from "lucide-react";
import type { EmailAddress, Folder, Label, MessageSummary } from "@/lib/api";
import {
  updateMessageFlags,
  archiveMessage,
  moveToFolder,
  deleteMessage,
  getMessage,
  listAttachments,
  listFolders,
  aiPrompt,
  buildForwardEml,
  exportMessageEml,
} from "@/lib/api";
import { useToastStore } from "@/stores/toast.store";
import { useComposeStore } from "@/stores/compose.store";
import { useConfirmStore } from "@/stores/confirm.store";
import { useUIStore } from "@/stores/ui.store";
import { patchMessagesCache, restoreMessagesCache, snapshotMessagesCache } from "@/hooks/queries";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import { originalRecipientAddresses } from "@/lib/messageRecipients";

interface Props {
  message: MessageSummary;
  labels?: Label[];
  isSelected: boolean;
  onClick: (event?: React.SyntheticEvent) => void;
  /** 双击：为该邮件单独打开标签页 */
  onDoubleClick?: () => void;
  /** 右键"打开"：全屏标签（同双击效果） */
  onOpenFullscreen?: () => void;
  onToggleStar?: (messageId: string, newStarred: boolean) => void;
  batchMode?: boolean;
  batchSelected?: boolean;
  spamFolderId?: string;
  folderRole?: Folder["role"];
  activeFolderId?: string | null;
  accountColor?: string;
  accountLabel?: string;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isToday) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  if (date.getFullYear() !== now.getFullYear()) {
    return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  }

  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function addressLabel(address: EmailAddress): string {
  return address.name?.trim() || address.address;
}

function recipientLabel(addresses: EmailAddress[]): string {
  return addresses.map(addressLabel).filter(Boolean).join(", ");
}

function MessageItem({ message, labels = [], isSelected, onClick, onDoubleClick, onOpenFullscreen, onToggleStar, batchMode, batchSelected, spamFolderId, folderRole, activeFolderId, accountColor, accountLabel }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showActions, setShowActions] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showMoveFolders, setShowMoveFolders] = useState(false);
  const [moveFolders, setMoveFolders] = useState<Folder[]>([]);
  // 垃圾邮件夹里需要"收件箱"目标：从已加载文件夹找 role=inbox。
  const inboxFolder = moveFolders.find((f) => f.role === "inbox");
  // 进入垃圾邮件夹时预加载文件夹列表，保证"这不是垃圾邮件"可用。
  useEffect(() => {
    if (folderRole === "spam" && moveFolders.length === 0) {
      listFolders(message.account_id)
        .then((folders) => setMoveFolders(folders))
        .catch(() => {});
    }
  }, [folderRole, message.account_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const fontWeight = message.is_read ? "normal" : "600";
  const archiveActionLabel = folderRole === "archive"
    ? t("messageActions.unarchive", "Unarchive")
    : t("messageActions.archive", "Archive");
  const ArchiveActionIcon = folderRole === "archive" ? RotateCcw : Archive;
  const primaryContact = folderRole === "sent" && message.to_list.length > 0
    ? recipientLabel(message.to_list)
    : message.from_name || message.from_address;
  // In batch mode the row highlight is the selection control. The ordinary
  // reading-pane selection must not keep a Ctrl-deselected row looking selected.
  const rowSelected = batchMode ? Boolean(batchSelected) : isSelected;

  function invalidateMessageViews(includeUnreadCounts = false) {
    queryClient.invalidateQueries({ queryKey: ["messages"] });
    queryClient.invalidateQueries({ queryKey: ["threads"] });
    if (includeUnreadCounts) {
      queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] });
    }
  }

  async function openComposeWithMessage(mode: "reply" | "reply-all" | "forward", withAttachments: boolean) {
    const full = await getMessage(message.id);
    if (!full) return;
    const attachments = withAttachments
      ? (await listAttachments(message.id))
          .filter((attachment) => !attachment.is_inline && attachment.local_path)
          .map((attachment) => ({
            name: attachment.filename,
            path: attachment.local_path as string,
            size: attachment.size,
          }))
      : undefined;
    useComposeStore.getState().openCompose(mode, full, attachments ? { attachments } : null);
  }

  /** AI 一键回复：用当前邮件作为上下文生成回复草稿，再打开写信页填入。 */
  const [aiReplying, setAiReplying] = useState(false);
  async function handleAiReply() {
    if (aiReplying) return;
    setAiReplying(true);
    try {
      const full = await getMessage(message.id);
      if (!full) return;
      const sender = full.from_name || full.from_address || "";
      const subject = full.subject || "(无主题)";
      const bodyText = full.body_text?.trim()
        ? full.body_text.slice(0, 4000)
        : "(无正文内容)";
      const system =
        "你是外贸业务员的 AI 邮件助手。请阅读下面的原始邮件，写一封专业、得体的回复草稿。" +
        "要求：直接输出邮件正文（不含主题行、不含称呼前的问候寒暄说明），语气自然、符合商务邮件习惯；" +
        "如果原文是询盘或报价咨询，回复中给出对方需要的要点；不要编造不存在的价格/交期/承诺。";
      const user =
        `【原始邮件】\n发件人：${sender}\n主题：${subject}\n\n${bodyText}\n\n` +
        `请生成回复草稿（直接输出正文，不需要主题行）。`;
      const draft = await aiPrompt(system, user);
      useComposeStore.getState().openCompose("reply", full, { body: draft.trim() });
      useToastStore.getState().addToast({ message: "AI 已生成回复草稿，请检查后发送。", type: "success" });
    } catch (error) {
      useToastStore.getState().addToast({ message: `AI 回复生成失败：${String(error)}`, type: "error" });
    } finally {
      setAiReplying(false);
    }
  }

  async function openMoveFolders() {
    if (moveFolders.length > 0) {
      setShowMoveFolders(true);
      return;
    }
    try {
      const folders = await listFolders(message.account_id);
      setMoveFolders(folders);
      setShowMoveFolders(true);
    } catch (error) {
      useToastStore.getState().addToast({ message: `读取文件夹失败：${String(error)}`, type: "error" });
    }
  }

  async function handleDelete() {
    const ok = await useConfirmStore.getState().confirm({
      title: t("messageActions.delete", "Delete"),
      message: t("messageActions.deleteConfirm", "Move this message to trash?"),
      confirmLabel: t("common.delete", "Delete"),
      destructive: true,
    });
    if (!ok) return;
    const previousLists = snapshotMessagesCache(queryClient);
    patchMessagesCache(queryClient, (page) => page.filter((item) => item.id !== message.id));
    // 本地列表先完成删除；远程移动/删除在后台继续，失败由待重试队列处理。
    useToastStore.getState().addToast({ message: t("messageActions.deleteSuccess", "Message deleted"), type: "success" });
    void deleteMessage(message.id)
      .then(() => invalidateMessageViews(true))
      .catch(() => {
        // 普通删除已在后端进入重试队列，不把邮件重新塞回当前列表。
        restoreMessagesCache(queryClient, previousLists);
        invalidateMessageViews(true);
        useToastStore.getState().addToast({ message: t("messageActions.deleteFailed", "Failed to delete message"), type: "error" });
      });
  }

  async function handleEditDraft() {
    const full = await getMessage(message.id);
    if (!full) return;
    useComposeStore.getState().openCompose("new", null, {
      to: full.to_list.map((address) => address.address),
      cc: full.cc_list.map((address) => address.address),
      bcc: full.bcc_list.map((address) => address.address),
      subject: full.subject,
      body: full.body_text,
    });
  }

  function handleMarkRead(isRead: boolean) {
    updateMessageFlags(message.id, isRead, undefined)
      .then(() => invalidateMessageViews(true))
      .catch(() => useToastStore.getState().addToast({ message: "操作失败，请重试", type: "error" }));
  }

  async function handleForwardAsAttachment() {
    try {
      const emlPath = await buildForwardEml(message.id);
      const name = `${(message.subject || "forward").replace(/[/\\:*?"<>|]/g, "_").slice(0, 60)}.eml`;
      useComposeStore.getState().openCompose("new", null, {
        subject: `Fwd: ${message.subject}`,
        body: "",
        attachments: [{ name, path: emlPath, size: 0 }],
      });
      useToastStore.getState().addToast({ message: "原邮件已作为附件，填写收件人后发送", type: "success" });
    } catch (error) {
      useToastStore.getState().addToast({ message: `生成附件失败：${String(error)}`, type: "error" });
    }
  }

  async function handleExport() {
    try {
      const path = await exportMessageEml(message.id);
      useToastStore.getState().addToast({ message: `已导出：${path}`, type: "success" });
    } catch (error) {
      const msg = String(error);
      if (!msg.includes("已取消")) {
        useToastStore.getState().addToast({ message: `导出失败：${msg}`, type: "error" });
      }
    }
  }

  async function handlePrint() {
    try {
      const full = await getMessage(message.id);
      if (!full) return;
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";
      document.body.appendChild(iframe);
      const doc = iframe.contentDocument;
      if (doc) {
        doc.open();
        doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(full.subject)}</title>
<style>body{font-family:system-ui,'Microsoft YaHei',sans-serif;padding:24px;max-width:760px;margin:0 auto;color:#222;font-size:14px}
h2{margin:0 0 10px} .meta{color:#666;font-size:12px;margin-bottom:18px} pre{white-space:pre-wrap;line-height:1.7;font-family:inherit}
hr{border:none;border-top:1px solid #ddd;margin:16px 0}</style></head><body>
<h2>${esc(full.subject)}</h2>
<div class="meta">发件人：${esc(full.from_name || full.from_address)} &lt;${esc(full.from_address)}&gt;<br>日期：${new Date(full.date * 1000).toLocaleString("zh-CN")}</div>
<hr><pre>${esc(full.body_text)}</pre></body></html>`);
        doc.close();
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      }
      setTimeout(() => iframe.remove(), 60_000);
    } catch (error) {
      useToastStore.getState().addToast({ message: `打印失败：${String(error)}`, type: "error" });
    }
  }

  function handleCreateFilter() {
    // 已发送：用原收件人；收件箱/其他：用原发件人 → 预填规则草稿
    const isSent = folderRole === "sent" && message.to_list.length > 0;
    const field = isSent ? "to" : "from";
    const contact = isSent ? message.to_list[0].address : message.from_address;
    useUIStore.getState().setPendingRuleDraftText(`${field}: ${contact}`);
    useUIStore.getState().setActiveView("settings");
    useUIStore.getState().setSettingsTab("rules");
    useToastStore.getState().addToast({ message: "已用该邮件的收发件人创建过滤器草稿", type: "success" });
  }

  function handleNewToSender() {
    // 这个命令的语义是“相同接收人”，无论邮件位于哪个文件夹，都应
    // 读取原邮件 To，而不是把收到的邮件错误地改发给原发件人。
    const targets = originalRecipientAddresses(message.to_list);
    if (targets.length === 0) {
      useToastStore.getState().addToast({ message: "原邮件没有可用的收件人地址", type: "error" });
      return;
    }
    useComposeStore.getState().openCompose("new", null, { to: targets });
  }

  const moveItems: ContextMenuItem[] = showMoveFolders
    ? [
        {
          label: "返回",
          icon: <ChevronLeft size={14} />,
          keepOpen: true,
          onClick: () => setShowMoveFolders(false),
        },
        ...moveFolders
          .filter((folder) => folder.id !== activeFolderId)
          .map((folder) => ({
            label: folder.name,
            keepOpen: true,
            onClick: async () => {
              try {
                await moveToFolder(message.id, folder.id);
                invalidateMessageViews(true);
                useToastStore.getState().addToast({ message: `已移动到「${folder.name}」`, type: "success" });
              } catch (error) {
                useToastStore.getState().addToast({ message: `移动失败：${String(error)}`, type: "error" });
              }
            },
          })),
      ]
    : [];

  const menuItems: ContextMenuItem[] = showMoveFolders
    ? moveItems
    : [
        { label: "打开", icon: <MailOpen size={14} />, onClick: () => (onOpenFullscreen ? onOpenFullscreen() : onClick()) },
        {
          label: aiReplying ? "AI 回复生成中…" : "AI 回复",
          icon: <Sparkles size={14} />,
          disabled: aiReplying,
          onClick: () => void handleAiReply(),
        },
        { label: "回复", icon: <Reply size={14} />, onClick: () => void openComposeWithMessage("reply", false) },
        { label: "回复全部", icon: <ReplyAll size={14} />, onClick: () => void openComposeWithMessage("reply-all", false) },
        { label: "带附件回复全部", icon: <ReplyAll size={14} />, onClick: () => void openComposeWithMessage("reply-all", true) },
        {
          label: "编辑",
          icon: <Pencil size={14} />,
          onClick: () => void handleEditDraft(),
        },
        { label: "转发", icon: <Forward size={14} />, onClick: () => void openComposeWithMessage("forward", false) },
        {
          label: "作为附件转发",
          icon: <AttachForward size={14} />,
          onClick: () => void handleForwardAsAttachment(),
        },
        {
          label: "发送新邮件给相同接收人",
          icon: <Mail size={14} />,
          disabled: message.to_list.length === 0,
          onClick: () => handleNewToSender(),
        },
        { separator: true },
        {
          label: "创建过滤器",
          icon: <Filter size={14} />,
          onClick: () => handleCreateFilter(),
        },
        {
          label: "导出邮件",
          icon: <FileDown size={14} />,
          onClick: () => void handleExport(),
        },
        {
          label: "打印邮件",
          icon: <Printer size={14} />,
          onClick: () => void handlePrint(),
        },
        {
          label: "发送到 AI 写作",
          icon: <Sparkles size={14} />,
          onClick: () => {
            useUIStore.getState().enqueueAiContext(message.id, message.subject || message.snippet || "邮件");
            useUIStore.getState().openRightPanel("aiWriting");
            useToastStore.getState().addToast({ message: "已发送到 AI 写作的补充上下文", type: "success" });
          },
        },
        {
          label: "发送到 AI 开发客户",
          icon: <Sparkles size={14} />,
          onClick: () => {
            useUIStore.getState().enqueueLeadContext(message.id, message.subject || message.snippet || "邮件");
            useUIStore.getState().setActiveView("leadFinder");
            useToastStore.getState().addToast({ message: "已发送到 AI 开发客户上下文，点击搜索即可使用", type: "success" });
          },
        },
        {
          label: "发送到首页 AI 工作台",
          icon: <Bot size={14} />,
          onClick: () => {
            useUIStore.getState().enqueueHomeContext(message.id, message.subject || message.snippet || "邮件");
            useUIStore.getState().setActiveView("kanban");
            useToastStore.getState().addToast({ message: "已发送到首页 AI 工作台上下文", type: "success" });
          },
        },
        { separator: true },
        {
          label: message.is_starred ? "取消星标" : "星标",
          icon: <Star size={14} />,
          onClick: () => {
            updateMessageFlags(message.id, undefined, !message.is_starred)
              .then(() => {
                invalidateMessageViews();
                queryClient.invalidateQueries({ queryKey: ["starred-messages"] });
              })
              .catch(() => useToastStore.getState().addToast({ message: "操作失败，请重试", type: "error" }));
            onToggleStar?.(message.id, !message.is_starred);
          },
        },
        { label: message.is_read ? "标记为未读" : "标记为已读", icon: message.is_read ? <MailCheck size={14} /> : <MailOpen size={14} />, onClick: () => handleMarkRead(!message.is_read) },
        {
          label: folderRole === "archive" ? "取消归档" : "归档",
          icon: folderRole === "archive" ? <RotateCcw size={14} /> : <Archive size={14} />,
          onClick: () => {
            const previousLists = snapshotMessagesCache(queryClient);
            patchMessagesCache(queryClient, (page) => page.filter((item) => item.id !== message.id));
            archiveMessage(message.id)
              .then((result) => {
                if (result === "skipped") return;
                invalidateMessageViews(true);
                useToastStore.getState().addToast({
                  message: result === "unarchived" ? "已移回收件箱" : "已归档",
                  type: "success",
                });
              })
              .catch(() => {
                restoreMessagesCache(queryClient, previousLists);
                useToastStore.getState().addToast({ message: "归档失败", type: "error" });
              });
          },
        },
        { label: "移动到文件夹", icon: <FolderInput size={14} />, keepOpen: true, onClick: () => void openMoveFolders() },
        { separator: true },
        // 垃圾邮件夹里：把误判的邮件移回收件箱（"不是垃圾邮件"）
        ...(folderRole === "spam" && inboxFolder
          ? [{
              label: "这不是垃圾邮件",
              icon: <ShieldCheck size={14} />,
              onClick: () => {
                moveToFolder(message.id, inboxFolder.id)
                  .then(() => invalidateMessageViews(true))
                  .catch(() => useToastStore.getState().addToast({ message: "操作失败，请重试", type: "error" }));
              },
            }]
          : []),
        ...(spamFolderId
          ? [{
              label: "标记为垃圾邮件",
              icon: <ShieldAlert size={14} />,
              onClick: () => {
                moveToFolder(message.id, spamFolderId)
                  .then(() => invalidateMessageViews(true))
                  .catch(() => useToastStore.getState().addToast({ message: "操作失败，请重试", type: "error" }));
              },
            }]
          : []),
        { separator: true },
        { label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: () => void handleDelete() },
      ];

  return (
    <div
      className={`message-list-row${message.is_read ? "" : " message-list-row--unread"}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/x-pebble-message-id", message.id);
        event.dataTransfer.setData("text/plain", `邮件：${message.subject}`);
      }}
      tabIndex={0}
      role="option"
      aria-selected={rowSelected}
      style={{
        position: "relative",
        color: "var(--color-text-primary)",
        fontWeight,
        cursor: "pointer",
        padding: "10px 14px",
        borderBottom: "1px solid var(--color-border)",
        height: "76px",
        boxSizing: "border-box",
        overflow: "hidden",
        background: rowSelected ? "var(--color-sidebar-active)" : "transparent",
        transition: "background-color 0.12s ease",
      }}
      onMouseEnter={() => {
        setShowActions(true);
      }}
      onMouseLeave={() => {
        setShowActions(false);
      }}
      onFocus={() => {
        setShowActions(true);
      }}
      onBlur={(e) => {
        // Only hide if focus leaves this element entirely (not moving to a child)
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setShowActions(false);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(e);
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setShowMoveFolders(false);
        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {accountColor && (
        <span
          aria-label={accountLabel}
          title={accountLabel}
          style={{
            position: "absolute",
            left: 0,
            top: "10px",
            bottom: "10px",
            width: "3px",
            borderRadius: "0 3px 3px 0",
            backgroundColor: accountColor,
          }}
        />
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2px" }}>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            fontSize: "13px",
            overflow: "hidden",
            whiteSpace: "nowrap",
            flex: 1,
            marginRight: "8px",
            minWidth: 0,
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {primaryContact}
          </span>
          {message.has_replies && (
            <span
              title="已回复"
              aria-label="已回复"
              style={{ display: "inline-flex", alignItems: "center", gap: "2px", flexShrink: 0, color: "var(--color-success, #2e8b57)", fontSize: "10px", fontWeight: 500 }}
            >
              <Reply size={11} />
              已回复
            </span>
          )}
          {!message.is_read && (
            <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "var(--color-accent)", flexShrink: 0 }} />
          )}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
          {message.is_starred && (
            <Star size={13} fill="#f59e0b" color="#f59e0b" />
          )}
          {message.has_attachments && (
            <Paperclip size={13} color="var(--color-text-secondary)" />
          )}
          <span
            style={{
              fontSize: "11px",
              color: "var(--color-text-secondary)",
              fontWeight: "normal",
            }}
          >
            {formatDate(message.date)}
          </span>
        </div>
      </div>
      <div
        style={{
          fontSize: "12.5px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          marginBottom: "2px",
        }}
      >
        {message.subject || t("inbox.noSubject")}
      </div>
      <div
        style={{
          fontSize: "12px",
          color: "var(--color-text-secondary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontWeight: "normal",
        }}
      >
        {message.snippet}
        {labels.length > 0 && labels.map((l) => (
          <span
            key={l.id}
            style={{
              display: "inline-block",
              fontSize: "10px",
              padding: "0 5px",
              borderRadius: "3px",
              backgroundColor: l.color + "22",
              color: l.color,
              border: `1px solid ${l.color}44`,
              marginLeft: "6px",
              verticalAlign: "middle",
              lineHeight: "16px",
              fontWeight: 500,
            }}
          >
            {l.name}
          </span>
        ))}
      </div>
      {showActions && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            right: "8px",
            top: "50%",
            transform: "translateY(-50%)",
            display: "flex",
            alignItems: "center",
            gap: "2px",
            backgroundColor: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            borderRadius: "6px",
            padding: "2px",
            boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
          }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              const previousLists = snapshotMessagesCache(queryClient);
              patchMessagesCache(queryClient, (page) => page.filter((m) => m.id !== message.id));
              archiveMessage(message.id)
                .then((result) => {
                  if (result === "skipped") {
                    restoreMessagesCache(queryClient, previousLists);
                    return;
                  }
                  invalidateMessageViews(true);
                  const msg = result === "unarchived"
                    ? t("messageActions.unarchiveSuccess", "Message moved to inbox")
                    : t("messageActions.archiveSuccess", "Message archived");
                  useToastStore.getState().addToast({ message: msg, type: "success" });
                })
                .catch(() => {
                  restoreMessagesCache(queryClient, previousLists);
                  queryClient.invalidateQueries({ queryKey: ["messages"] });
                  const msg = folderRole === "archive"
                    ? t("messageActions.unarchiveFailed", "Failed to unarchive")
                    : t("messageActions.archiveFailed", "Failed to archive");
                  useToastStore.getState().addToast({ message: msg, type: "error" });
                });
            }}
            aria-label={archiveActionLabel}
            title={archiveActionLabel}
            style={{
              padding: "4px",
              border: "none",
              background: "transparent",
              borderRadius: "4px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              color: "var(--color-text-secondary)",
            }}
          >
            <ArchiveActionIcon size={14} />
          </button>
          {spamFolderId && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const previousLists = snapshotMessagesCache(queryClient);
                patchMessagesCache(queryClient, (page) => page.filter((m) => m.id !== message.id));
                moveToFolder(message.id, spamFolderId)
                  .then(() => {
                    invalidateMessageViews(true);
                    useToastStore.getState().addToast({ message: t("messageActions.spamSuccess", "Marked as spam"), type: "success" });
                  })
                  .catch(() => {
                    restoreMessagesCache(queryClient, previousLists);
                    queryClient.invalidateQueries({ queryKey: ["messages"] });
                    useToastStore.getState().addToast({ message: t("messageActions.spamFailed", "Failed to mark as spam"), type: "error" });
                  });
              }}
              aria-label={t("messageActions.reportSpam", "Report spam")}
              title={t("messageActions.reportSpam", "Report spam")}
              style={{
                padding: "4px",
                border: "none",
                background: "transparent",
                borderRadius: "4px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                color: "var(--color-text-secondary)",
              }}
            >
              <ShieldAlert size={14} />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleMarkRead(!message.is_read);
            }}
            aria-label={message.is_read ? t("messageActions.markUnread", "Mark as unread") : t("messageActions.markRead", "Mark as read")}
            title={message.is_read ? t("messageActions.markUnread", "Mark as unread") : t("messageActions.markRead", "Mark as read")}
            style={{
              padding: "4px",
              border: "none",
              background: "transparent",
              borderRadius: "4px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              color: "var(--color-text-secondary)",
            }}
          >
            {message.is_read ? <MailCheck size={14} /> : <MailOpen size={14} />}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              updateMessageFlags(message.id, undefined, !message.is_starred)
                .then(() => {
                  invalidateMessageViews();
                  queryClient.invalidateQueries({ queryKey: ["starred-messages"] });
                  queryClient.invalidateQueries({ queryKey: ["message", message.id] });
                })
                .catch(console.error);
              if (onToggleStar) onToggleStar(message.id, !message.is_starred);
            }}
            aria-label={message.is_starred ? t("messageActions.unstar") : t("messageActions.star")}
            aria-pressed={message.is_starred}
            title={message.is_starred ? t("messageActions.unstar") : t("messageActions.star")}
            style={{
              padding: "4px",
              border: "none",
              background: "transparent",
              borderRadius: "4px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              color: message.is_starred ? "#f59e0b" : "var(--color-text-secondary)",
            }}
          >
            <Star
              size={14}
              fill={message.is_starred ? "#f59e0b" : "none"}
              color={message.is_starred ? "#f59e0b" : "currentColor"}
            />
          </button>
        </div>
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems}
          onClose={() => {
            setContextMenu(null);
            setShowMoveFolders(false);
          }}
        />
      )}
    </div>
  );
}

export default memo(MessageItem);
