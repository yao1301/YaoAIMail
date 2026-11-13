import { Reply, ReplyAll, Forward, Star, Archive, Trash2, RotateCcw, RefreshCw, Send } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToastStore } from "@/stores/toast.store";
import { useTranslation } from "react-i18next";
import { useUpdateFlagsMutation } from "@/hooks/mutations/useUpdateFlagsMutation";
import { useComposeStore } from "@/stores/compose.store";
import { archiveMessage, deleteMessage, redownloadMessage, restoreMessage } from "@/lib/api";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import type { Message } from "@/lib/api";
import {
  patchMessagesCache,
  snapshotMessagesCache,
  restoreMessagesCache,
} from "@/hooks/queries";
import { useState } from "react";
import ConfirmDialog from "./ConfirmDialog";
import { useSendDrafts } from '@/hooks/useSendDrafts';
import { usePrepareMessageDeletion } from "@/hooks/useMessageDeletionNavigation";

interface Props {
  message: Message;
  folderRole?: string | null;
  onBack: () => void;
  onMessageUpdate: (msg: Message) => void;
}

export default function MessageActionToolbar({
  message,
  folderRole,
  onBack,
  onMessageUpdate,
}: Props) {
  const { t } = useTranslation();
  const openCompose = useComposeStore((s) => s.openCompose);
  const queryClient = useQueryClient();
  const prepareDeletion = usePrepareMessageDeletion();
  const { sendDrafts, sending } = useSendDrafts();
  const flagsMutation = useUpdateFlagsMutation();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [redownloading, setRedownloading] = useState(false);

  function invalidateMessageViews(includeUnreadCounts = false) {
    queryClient.invalidateQueries({ queryKey: ["messages"] });
    queryClient.invalidateQueries({ queryKey: ["threads"] });
    if (includeUnreadCounts) {
      queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] });
    }
  }

  const actions: Array<{
    icon: React.ComponentType<{ size?: number }>;
    label: string;
    action: () => void;
    active?: boolean;
    disabled?: boolean;
  }> = [
    ...(message.is_draft ? [{ icon: Send, label: '发送草稿', action: () => { void sendDrafts([message.id]); }, disabled: sending }] : []),
    { icon: Reply, label: t("messageActions.reply"), action: () => openCompose("reply", message) },
    { icon: ReplyAll, label: t("messageActions.replyAll"), action: () => openCompose("reply-all", message) },
    { icon: Forward, label: t("messageActions.forward"), action: () => openCompose("forward", message) },
    {
      icon: RefreshCw,
      label: t("messageActions.redownload", "重新下载邮件"),
      action: async () => {
        if (redownloading) return;
        setRedownloading(true);
        try {
          const updated = await redownloadMessage(message.id);
          onMessageUpdate(updated);
          useToastStore.getState().addToast({
            message: t("messageActions.redownloadSuccess", "邮件已重新下载并修复"),
            type: "success",
          });
        } catch (error) {
          useToastStore.getState().addToast({
            message: `${t("messageActions.redownloadFailed", "重新下载邮件失败")}: ${extractErrorMessage(error)}`,
            type: "error",
          });
        } finally {
          setRedownloading(false);
        }
      },
      disabled: redownloading,
    },
    {
      icon: Star,
      label: message.is_starred ? t("messageActions.unstar") : t("messageActions.star"),
      action: () => {
        flagsMutation.mutate(
          { messageId: message.id, isStarred: !message.is_starred },
          { onSuccess: () => onMessageUpdate({ ...message, is_starred: !message.is_starred }) },
        );
      },
      active: message.is_starred,
    },
    {
      icon: folderRole === "archive" ? RotateCcw : Archive,
      label: folderRole === "archive"
        ? t("messageActions.unarchive", "Unarchive")
        : t("messageActions.archive"),
      action: async () => {
        const previousLists = snapshotMessagesCache(queryClient);
        patchMessagesCache(queryClient, (page) => page.filter((m) => m.id !== message.id));
        try {
          const result = await archiveMessage(message.id);
          if (result === "skipped") return;
          invalidateMessageViews(true);
          if (result === "unarchived") {
            useToastStore.getState().addToast({
              message: t("messageActions.unarchiveSuccess", "Message moved to inbox"),
              type: "success",
            });
          } else {
            useToastStore.getState().addToast({
              message: t("messageActions.archiveSuccess", "Message archived"),
              type: "success",
            });
          }
          onBack();
        } catch {
          restoreMessagesCache(queryClient, previousLists);
          useToastStore.getState().addToast({
            message: folderRole === "archive"
              ? t("messageActions.unarchiveFailed", "Failed to unarchive")
              : t("messageActions.archiveFailed", "Failed to archive message"),
            type: "error",
          });
        }
      },
    },
    ...(folderRole === "trash" ? [{
      icon: RotateCcw,
      label: t("messageActions.restore", "Restore"),
      action: async () => {
        const previousLists = snapshotMessagesCache(queryClient);
        patchMessagesCache(queryClient, (page) => page.filter((m) => m.id !== message.id));
        try {
          await restoreMessage(message.id);
          invalidateMessageViews(true);
          useToastStore.getState().addToast({
            message: t("messageActions.restoreSuccess", "Message restored to inbox"),
            type: "success",
          });
          onBack();
        } catch {
          restoreMessagesCache(queryClient, previousLists);
          useToastStore.getState().addToast({
            message: t("messageActions.restoreFailed", "Failed to restore message"),
            type: "error",
          });
        }
      },
    }] : []),
    {
      icon: Trash2,
      label: t("messageActions.delete"),
      action: () => setShowDeleteConfirm(true),
    },
  ];

  return (
    <>
      <div style={{ display: "flex", flexWrap: 'wrap', alignItems: 'center', gap: "2px", padding: "4px 16px 4px 48px", position: "relative" }}>
        {actions.map(({ icon: Icon, label, action, active, disabled }, i) => (
          <button
            key={i}
            onClick={disabled ? undefined : action}
            title={label}
            aria-label={label}
            style={{
              background: "none",
              border: "none",
              cursor: disabled ? "default" : "pointer",
              padding: "6px 8px",
              borderRadius: "4px",
              color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
              display: "flex",
              alignItems: "center",
              transition: "background-color 0.12s ease, color 0.12s ease",
              opacity: disabled ? 0.35 : 1,
            }}
            onMouseEnter={disabled ? undefined : (e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = "var(--color-bg-hover)"; }}
            onMouseLeave={disabled ? undefined : (e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent"; }}
          >
            <Icon size={16} />
          </button>
        ))}
      </div>

      {showDeleteConfirm && (
        <ConfirmDialog
          title={t("messageActions.delete", "Delete")}
          message={t("messageActions.deleteConfirm", "Move this message to trash?")}
          confirmLabel={t("common.delete", "Delete")}
          destructive
          onCancel={() => setShowDeleteConfirm(false)}
          onConfirm={async () => {
            setShowDeleteConfirm(false);
            const completeDeletion = prepareDeletion([message.id]);
            const previousLists = snapshotMessagesCache(queryClient);
            patchMessagesCache(queryClient, (page) => page.filter((m) => m.id !== message.id));
            try {
              await deleteMessage(message.id);
              invalidateMessageViews(true);
              useToastStore.getState().addToast({
                message: t("messageActions.deleteSuccess", "Message deleted"),
                type: "success",
              });
              if (!completeDeletion([message.id])) onBack();
            } catch {
              restoreMessagesCache(queryClient, previousLists, [message.id]);
              completeDeletion([]);
              useToastStore.getState().addToast({
                message: t("messageActions.deleteFailed", "Failed to delete message"),
                type: "error",
              });
            }
          }}
        />
      )}
    </>
  );
}
