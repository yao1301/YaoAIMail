import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { useMailStore } from "../stores/mail.store";
import { useUIStore } from "../stores/ui.store";
import { listFolders } from "../lib/api";

interface NotificationOpenPayload {
  account_id?: string;
  message_id?: string;
}

export function useNotificationOpenNavigation() {
  const setActiveAccountId = useMailStore((s) => s.setActiveAccountId);
  const setActiveFolderId = useMailStore((s) => s.setActiveFolderId);
  const openMessageInInbox = useUIStore((s) => s.openMessageInInbox);
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlisten = listen<NotificationOpenPayload>("mail:notification-open", (event) => {
      const accountId = event.payload.account_id;
      const messageId = event.payload.message_id;
      if (!messageId) return;

      void (async () => {
        queryClient.invalidateQueries({ queryKey: ["messages"] });
        queryClient.invalidateQueries({ queryKey: ["threads"] });
        if (accountId) {
          // setActiveAccountId intentionally clears the current folder. Resolve
          // the target inbox first, otherwise notification clicks land on an
          // empty mail view and look as if nothing happened.
          const folders = await listFolders(accountId).catch(() => []);
          const inboxFolder = folders.find((folder) => folder.role === "inbox");
          setActiveAccountId(accountId);
          if (inboxFolder) setActiveFolderId(inboxFolder.id);
          queryClient.invalidateQueries({ queryKey: ["folders", accountId] });
        }
        openMessageInInbox(messageId);
      })();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [openMessageInInbox, queryClient, setActiveAccountId, setActiveFolderId]);
}
