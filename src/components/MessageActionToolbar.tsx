import { Reply, ReplyAll, Forward, Star, Archive, Trash2, RotateCcw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToastStore } from "@/stores/toast.store";
import { useTranslation } from "react-i18next";
import { useUpdateFlagsMutation } from "@/hooks/mutations/useUpdateFlagsMutation";
import { useComposeStore } from "@/stores/compose.store";
import { archiveMessage, deleteMessage, restoreMessage } from "@/lib/api";
import type { Message } from "@/lib/api";
import {
  patchMessagesCache,
  snapshotMessagesCache,
  restoreMessagesCache,
} from "@/hooks/queries";
import { useState } from "react";
import ConfirmDialog from "./ConfirmDialog";

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
  const flagsMutation = useUpdateFlagsMutation();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

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
    { icon: Reply, label: t("messageActions.reply"), action: () => openCompose("reply", message) },
    { icon: ReplyAll, label: t("messageActions.replyAll"), action: () => openCompose("reply-all", message) },
    { icon: Forward, label: t("messageActions.forward"), action: () => openCompose("forward", message) },
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
      <div style={{ display: "flex", gap: "2px", padding: "4px 16px 4px 48px", position: "relative" }}>
        {actions.map(({ icon: Icon, label, action, active, disabled }, i) => (
          <button
            key={i}
            onClick={disabled ? undefined : action}
            title={disabled ? label + " (coming soon)" : label}
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
            const previousLists = snapshotMessagesCache(queryClient);
            patchMessagesCache(queryClient, (page) => page.filter((m) => m.id !== message.id));
            try {
              await deleteMessage(message.id);
              invalidateMessageViews(true);
              useToastStore.getState().addToast({
                message: t("messageActions.deleteSuccess", "Message deleted"),
                type: "success",
              });
              onBack();
            } catch {
              restoreMessagesCache(queryClient, previousLists);
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
