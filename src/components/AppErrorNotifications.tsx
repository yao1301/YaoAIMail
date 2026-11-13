import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { reportAppError } from "@/lib/appErrors";
import { isResizeObserverDeliveryWarning } from "@/lib/observeResizeFrame";
import { queryClient } from '@/lib/query-client';
import type { Account } from '@/lib/ipc-types';
import { reportMailFailure, type MailFailure } from '@/lib/mailErrorNotifications';
import { listAccounts } from '@/lib/api';

export default function AppErrorNotifications() {
  useEffect(() => {
    const rejection = (event: PromiseRejectionEvent) => reportAppError(event.reason, "后台操作失败");
    const runtime = (event: ErrorEvent) => {
      // Browser delivery warning has no thrown Error. Real exceptions still surface.
      if (!event.error && isResizeObserverDeliveryWarning(event.message)) {
        event.preventDefault();
        return;
      }
      reportAppError(event.error || event.message, "界面运行错误");
    };
    window.addEventListener("unhandledrejection", rejection);
    window.addEventListener("error", runtime);
    let active = true;
    const unlisten: UnlistenFn[] = [];
    const add = <T,>(name: string, callback: (payload: T) => void) => {
      void listen<T>(name, (event) => callback(event.payload)).then((fn) => {
        if (active) unlisten.push(fn); else fn();
      }).catch((e) => reportAppError(e, "错误通知监听失败"));
    };
    const notifyMail = (error: MailFailure) => {
      const accounts = queryClient.getQueryData<Account[]>(['accounts']) ?? [];
      if (!error.account_id || accounts.some(account => account.id === error.account_id)) {
        reportMailFailure(error, accounts);
      } else {
        // Share the existing query if an early native error beats account loading.
        void queryClient.ensureQueryData({ queryKey: ['accounts'], queryFn: listAccounts })
          .then(loaded => { if (active) reportMailFailure(error, loaded); })
          .catch(() => { if (active) reportMailFailure(error, accounts); });
      }
    };
    add<MailFailure>("mail:operation-error", notifyMail);
    add<MailFailure>("mail:error", (e) => notifyMail({ ...e, op_type: 'connection' }));
    add<{ account_id?: string; status?: string; message?: string }>("mail:sync-progress", (e) => {
      if (e.status === "error") notifyMail({ account_id: e.account_id, op_type: 'sync', message: e.message || "收取邮件失败" });
    });
    return () => {
      active = false; unlisten.forEach((fn) => fn());
      window.removeEventListener("unhandledrejection", rejection);
      window.removeEventListener("error", runtime);
    };
  }, []);
  return null;
}
