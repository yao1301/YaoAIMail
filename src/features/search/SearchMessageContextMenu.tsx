import { useEffect, useMemo, useState } from "react";
import { Archive, Bot, ChevronLeft, Filter, FolderInput, Forward, Mail, MailCheck, MailOpen, Reply, ReplyAll, Sparkles, Star, Trash2, Send } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { Folder, Message } from "@/lib/api";
import { archiveMessage, deleteMessage, getMessage, listFolders, moveToFolder, updateMessageFlags } from "@/lib/api";
import ContextMenu, { type ContextMenuItem } from "@/components/ContextMenu";
import { useComposeStore } from "@/stores/compose.store";
import { useConfirmStore } from "@/stores/confirm.store";
import { useToastStore } from "@/stores/toast.store";
import { useUIStore } from "@/stores/ui.store";
import { originalRecipientFields } from "@/lib/messageRecipients";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { useSendDrafts } from '@/hooks/useSendDrafts';
import { usePrepareMessageDeletion } from "@/hooks/useMessageDeletionNavigation";

type Props = {
  x: number;
  y: number;
  messageId: string;
  folderIds: string[];
  folderRole?: Folder["role"];
  fallbackLabel: string;
  onOpen: () => void;
  onChanged: () => void;
  onClose: () => void;
};

export default function SearchMessageContextMenu({ x, y, messageId, folderIds, folderRole, fallbackLabel, onOpen, onChanged, onClose }: Props) {
  const queryClient = useQueryClient();
  const prepareDeletion = usePrepareMessageDeletion();
  const { sendDrafts, sending } = useSendDrafts();
  const [message, setMessage] = useState<Message | null>(null);
  const [loadingError, setLoadingError] = useState("");
  const [folders, setFolders] = useState<Folder[]>([]);
  const [showMoveFolders, setShowMoveFolders] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMessage(messageId)
      .then((item) => { if (!cancelled) setMessage(item); })
      .catch((error) => { if (!cancelled) setLoadingError(extractErrorMessage(error)); });
    return () => { cancelled = true; };
  }, [messageId]);

  function refresh(includeUnread = false) {
    queryClient.invalidateQueries({ queryKey: ["messages"] });
    queryClient.invalidateQueries({ queryKey: ["threads"] });
    queryClient.invalidateQueries({ queryKey: ["search"] });
    if (includeUnread) queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] });
    onChanged();
  }

  function toastError(action: string, error: unknown) {
    useToastStore.getState().addToast({ message: `${action}失败：${extractErrorMessage(error)}`, type: "error" });
  }

  function openCompose(mode: "reply" | "reply-all" | "forward") {
    if (message) useComposeStore.getState().openCompose(mode, message);
  }

  async function openMoveFolders() {
    if (!message) return;
    try {
      const items = folders.length ? folders : await listFolders(message.account_id);
      setFolders(items);
      setShowMoveFolders(true);
    } catch (error) {
      toastError("读取文件夹", error);
    }
  }

  async function handleDelete() {
    const ok = await useConfirmStore.getState().confirm({ title: "删除邮件", message: "将这封邮件移到废纸篓？", confirmLabel: "删除", destructive: true });
    if (!ok) return;
    const completeDeletion = prepareDeletion([messageId]);
    try {
      await deleteMessage(messageId);
      completeDeletion([messageId]);
      refresh(true);
      useToastStore.getState().addToast({ message: "邮件已移到废纸篓", type: "success" });
    } catch (error) {
      completeDeletion([]);
      toastError("删除", error);
    }
  }

  const items = useMemo<ContextMenuItem[]>(() => {
    if (showMoveFolders) {
      return [
        { label: "返回", icon: <ChevronLeft size={14} />, keepOpen: true, onClick: () => setShowMoveFolders(false) },
        ...folders.filter((folder) => !folderIds.includes(folder.id)).map((folder) => ({
          label: folder.name,
          keepOpen: true,
          onClick: () => void moveToFolder(messageId, folder.id)
            .then(() => { refresh(true); onClose(); useToastStore.getState().addToast({ message: `已移动到「${folder.name}」`, type: "success" }); })
            .catch((error) => toastError("移动", error)),
        })),
      ];
    }
    if (!message) {
      return [
        { label: "打开", icon: <MailOpen size={14} />, onClick: onOpen },
        { label: loadingError ? `邮件读取失败：${loadingError}` : "正在读取邮件操作…", disabled: true, onClick: () => undefined },
      ];
    }
    return [
      { label: "打开", icon: <MailOpen size={14} />, onClick: onOpen },
      ...(message.is_draft ? [{ label: '发送', icon: <Send size={14} />, disabled: sending, onClick: () => void sendDrafts([message.id]) }] : []),
      { label: "回复", icon: <Reply size={14} />, onClick: () => openCompose("reply") },
      { label: "回复全部", icon: <ReplyAll size={14} />, onClick: () => openCompose("reply-all") },
      { label: "转发", icon: <Forward size={14} />, onClick: () => openCompose("forward") },
      {
        label: "发送新邮件给相同接收人", icon: <Mail size={14} />,
        disabled: message.to_list.length + message.cc_list.length + message.bcc_list.length === 0,
        onClick: () => {
          const recipients = originalRecipientFields(message.to_list, message.cc_list, message.bcc_list);
          if (recipients.to.length + recipients.cc.length + recipients.bcc.length > 0) {
            useComposeStore.getState().openCompose("new", null, recipients);
          }
        },
      },
      { separator: true },
      {
        label: "创建过滤器", icon: <Filter size={14} />,
        onClick: () => {
          const useRecipients = folderRole === "sent" && message.to_list.length > 0;
          const value = useRecipients ? message.to_list[0].address : message.from_address;
          const ui = useUIStore.getState();
          ui.setPendingRuleDraftText(`${useRecipients ? "to" : "from"}: ${value}`);
          ui.setSettingsTab("rules");
          ui.setActiveView("settings");
        },
      },
      {
        label: "发送到 AI 写作", icon: <Sparkles size={14} />,
        onClick: () => { const ui = useUIStore.getState(); ui.enqueueAiContext(messageId, message.subject || fallbackLabel); ui.openRightPanel("aiWriting"); },
      },
      {
        label: "发送到首页 AI 工作台", icon: <Bot size={14} />,
        onClick: () => { const ui = useUIStore.getState(); ui.enqueueHomeContext(messageId, message.subject || fallbackLabel); ui.setActiveView("kanban"); },
      },
      { separator: true },
      {
        label: message.is_starred ? "取消星标" : "星标", icon: <Star size={14} />,
        onClick: () => void updateMessageFlags(messageId, undefined, !message.is_starred)
          .then(() => { queryClient.invalidateQueries({ queryKey: ["starred-messages"] }); refresh(); })
          .catch((error) => toastError("星标", error)),
      },
      {
        label: message.is_read ? "标记为未读" : "标记为已读", icon: message.is_read ? <MailCheck size={14} /> : <MailOpen size={14} />,
        onClick: () => void updateMessageFlags(messageId, !message.is_read, undefined).then(() => refresh(true)).catch((error) => toastError("标记", error)),
      },
      {
        label: folderRole === "archive" ? "取消归档" : "归档", icon: <Archive size={14} />,
        onClick: () => void archiveMessage(messageId).then(() => refresh(true)).catch((error) => toastError("归档", error)),
      },
      { label: "移动到文件夹", icon: <FolderInput size={14} />, keepOpen: true, onClick: () => void openMoveFolders() },
      { separator: true },
      { label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: () => void handleDelete() },
    ];
  }, [fallbackLabel, folderIds, folderRole, folders, loadingError, message, messageId, onClose, onOpen, queryClient, showMoveFolders,sending]); // eslint-disable-line react-hooks/exhaustive-deps

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
