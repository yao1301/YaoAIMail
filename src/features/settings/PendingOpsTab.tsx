import { useWorkspaceState } from '@/lib/workspaceState';
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Clock, RefreshCw, Trash2 } from "lucide-react";
import type { PendingMailOp } from "@/lib/api";
import { dismissFailedPendingMailOps, retryPendingSendOnce, retryPendingSendPostprocessing, confirmPendingSendDelivered, cancelWorkbenchSchedule } from "@/lib/api";
import ConfirmDialog from "@/components/ConfirmDialog";
import { mailAccountTitle, reportAppError, safeErrorMessage } from "@/lib/appErrors";
import { useToastStore } from "@/stores/toast.store";
import { SettingsFeedback, type SettingsNotice } from "./SettingsFeedback";
import {
  pendingMailOpsQueryKey,
  pendingMailOpsSummaryQueryKey,
  useAccountsQuery,
  usePendingMailOpsQuery,
  usePendingMailOpsSummary,
} from "@/hooks/queries";
import { useMailStore } from "@/stores/mail.store";
import { useUIStore } from "@/stores/ui.store";

const metricStyle: React.CSSProperties = {
  minWidth: "132px",
  padding: "12px",
  border: "1px solid var(--color-border)",
  borderRadius: "6px",
  background: "var(--color-bg-secondary)",
};

const tableHeaderStyle: React.CSSProperties = {
  padding: "9px 10px",
  textAlign: "left",
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--color-text-secondary)",
  borderBottom: "1px solid var(--color-border)",
  whiteSpace: "nowrap",
};

const tableCellStyle: React.CSSProperties = {
  padding: "10px",
  fontSize: "12px",
  color: "var(--color-text-primary)",
  borderBottom: "1px solid var(--color-border)",
  verticalAlign: "top",
};

function formatTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString();
}

function statusTone(status: PendingMailOp["status"]) {
  if (status === "failed") {
    return {
      color: "var(--color-warning, #d97706)",
      background: "rgba(217, 119, 6, 0.12)",
    };
  }
  if (status === "in_progress") {
    return {
      color: "var(--color-accent)",
      background: "rgba(37, 99, 235, 0.12)",
    };
  }
  return {
    color: "var(--color-text-secondary)",
    background: "var(--color-bg-hover)",
  };
}

export default function PendingOpsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const [selectedAccountId, setSelectedAccountId] = useWorkspaceState<string | null>("src/features/settings/PendingOpsTab.tsx:PendingOpsTab:selectedAccountId", activeAccountId);
  const [retryTarget, setRetryTarget] = useWorkspaceState<string | null>("src/features/settings/PendingOpsTab.tsx:PendingOpsTab:retryTarget", null);
  const [retrying, setRetrying] = useWorkspaceState<string | null>("src/features/settings/PendingOpsTab.tsx:PendingOpsTab:retrying", null);
  const [cancelTarget,setCancelTarget]=useWorkspaceState<PendingMailOp|null>("src/features/settings/PendingOpsTab.tsx:PendingOpsTab:cancelTarget", null);
  const [confirmedTarget,setConfirmedTarget]=useWorkspaceState<PendingMailOp|null>("src/features/settings/PendingOpsTab.tsx:PendingOpsTab:confirmedTarget", null);
  const [actionError, setActionError] = useWorkspaceState<(SettingsNotice & { id: string; scheduled?: boolean }) | null>("src/features/settings/PendingOpsTab.tsx:PendingOpsTab:actionError", null);

  function showActionError(id: string, label: string, error: unknown, scheduled = false) {
    setActionError({ id, scheduled, kind: "error", message: `${label}：${safeErrorMessage(error)}` });
    reportAppError(error, label);
  }

  async function confirmSent() {
    const target=confirmedTarget; if (!target || retrying) return;
    setConfirmedTarget(null); setRetrying(target.id);
    setActionError(null);
    try { await confirmPendingSendDelivered(target.account_id,target.id); useToastStore.getState().addToast({type:'success',message:'已结束待发记录，没有发送任何邮件'}); await refresh(); }
    catch(error) { showActionError(target.id, '确认已发送未完成', error); }
    finally { setRetrying(null); }
  }
  async function continueArchive(id:string) {
    if(retrying)return;setRetrying(id);
    setActionError(null);
    try {await retryPendingSendPostprocessing(id);useToastStore.getState().addToast({type:'info',message:'已安排继续归档和后续处理，不会重新发送邮件'});await refresh();}
    catch(error){showActionError(id, '继续归档未提交', error);}
    finally{setRetrying(null);}
  }

  async function cancelSchedule(){
    const target=cancelTarget;if(!target||retrying)return;setCancelTarget(null);setRetrying(target.id);
    setActionError(null);
    try{await cancelWorkbenchSchedule(target.account_id,target.id);useToastStore.getState().addToast({type:'success',message:'已取消定时任务，邮件已恢复为草稿'});await refresh();}
    catch(error){showActionError(target.id, '取消失败，请核对队列中的发送状态', error, true);}
    finally{setRetrying(null);}
  }

  async function retryOne() {
    if (!retryTarget || retrying) return;
    const id = retryTarget; setRetryTarget(null); setRetrying(id);
    setActionError(null);
    try {
      await retryPendingSendOnce(id);
      useToastStore.getState().addToast({ type: "info", message: "已提交一次发送重试；若再失败将暂停，不会反复自动发送" });
      await refresh();
    } catch (e) { showActionError(id, "重试未提交", e); }
    finally { setRetrying(null); }
  }

  const accountsQuery = useAccountsQuery();
  const summaryQuery = usePendingMailOpsSummary(selectedAccountId);
  const opsQuery = usePendingMailOpsQuery(selectedAccountId);

  const accountsById = useMemo(() => {
    return new Map((accountsQuery.data ?? []).map((account) => [account.id, account]));
  }, [accountsQuery.data]);

  useEffect(() => {
    const unlisten = listen("mail:pending-ops-changed", () => {
      queryClient.invalidateQueries({ queryKey: pendingMailOpsSummaryQueryKey(selectedAccountId) });
      queryClient.invalidateQueries({ queryKey: pendingMailOpsQueryKey(selectedAccountId) });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [queryClient, selectedAccountId]);

  function statusLabel(status: PendingMailOp["status"]) {
    if (status === "failed") return t("pendingOps.statusValue.failed", "Failed");
    if (status === "in_progress") return t("pendingOps.statusValue.inProgress", "Retrying");
    return t("pendingOps.statusValue.pending", "Pending");
  }

  function operationLabel(opType: string) {
    const key = `pendingOps.ops.${opType}`;
    const fallbacks: Record<string, string> = {
      archive: "Archive",
      unarchive: "Unarchive",
      restore: "Restore",
      delete: "Delete",
      delete_permanent: "Delete permanently",
      update_flags: "Update flags",
      move_to_folder: "Move to folder",
      send: "Send",
    };
    return t(key, fallbacks[opType] ?? opType);
  }

  function accountLabel(accountId: string) {
    const account = accountsById.get(accountId);
    return account?.email ?? t("pendingOps.unknownAccount", "Unknown account");
  }

  async function refresh() {
    await Promise.all([summaryQuery.refetch(), opsQuery.refetch()]);
  }

  async function dismissFailed() {
    await dismissFailedPendingMailOps(selectedAccountId);
    await refresh();
  }

  const summary = summaryQuery.data ?? {
    pending_count: 0,
    in_progress_count: 0,
    failed_count: 0,
    total_active_count: 0,
    last_error: null,
    updated_at: null,
  };
  const ops = opsQuery.data ?? [];
  const loading = summaryQuery.isLoading || opsQuery.isLoading;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "16px",
          marginBottom: "18px",
        }}
      >
        <div>
          <h2
            style={{
              fontSize: "18px",
              fontWeight: 600,
              color: "var(--color-text-primary)",
              marginTop: 0,
              marginBottom: "8px",
            }}
          >
            {t("pendingOps.title", "Remote Writes")}
          </h2>
          <p
            style={{
              margin: 0,
              fontSize: "13px",
              lineHeight: 1.5,
              color: "var(--color-text-secondary)",
              maxWidth: "640px",
            }}
          >
            {t(
              "pendingOps.description",
              "Queued mail changes are retried in the background until the provider accepts them.",
            )}
          </p>
        </div>

        <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
          {summary.failed_count > 0 && (
            <button
              type="button"
              onClick={dismissFailed}
              title={t("pendingOps.dismissFailed", "Dismiss failed")}
              aria-label={t("pendingOps.dismissFailed", "Dismiss failed")}
              style={{
                height: "34px",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "0 12px",
                borderRadius: "6px",
                border: "1px solid var(--color-border)",
                background: "var(--color-bg-secondary)",
                color: "var(--color-warning, #d97706)",
                cursor: "pointer",
                fontSize: "12px",
                fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              <Trash2 size={14} />
              {t("pendingOps.dismissFailed", "Dismiss failed")}
            </button>
          )}
          <button
            type="button"
            onClick={refresh}
            title={t("pendingOps.refresh", "Refresh")}
            aria-label={t("pendingOps.refresh", "Refresh")}
            disabled={summaryQuery.isFetching || opsQuery.isFetching}
            style={{
              width: "34px",
              height: "34px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "6px",
              border: "1px solid var(--color-border)",
              background: "var(--color-bg-secondary)",
              color: "var(--color-text-primary)",
              cursor: "pointer",
              opacity: summaryQuery.isFetching || opsQuery.isFetching ? 0.65 : 1,
              flexShrink: 0,
            }}
          >
            <RefreshCw size={15} className={summaryQuery.isFetching || opsQuery.isFetching ? "app-spin" : undefined} />
          </button>
        </div>
      </div>

      <label
        htmlFor="pending-ops-account"
        style={{
          display: "block",
          fontSize: "12px",
          fontWeight: 600,
          color: "var(--color-text-secondary)",
          marginBottom: "6px",
        }}
      >
        {t("pendingOps.accountFilter", "Account")}
      </label>
      <select
        id="pending-ops-account"
        value={selectedAccountId ?? "all"}
        onChange={(event) => {
          const value = event.target.value;
          setSelectedAccountId(value === "all" ? null : value);
        }}
        style={{
          width: "min(360px, 100%)",
          padding: "8px 10px",
          borderRadius: "6px",
          border: "1px solid var(--color-border)",
          background: "var(--color-bg-secondary)",
          color: "var(--color-text-primary)",
          fontSize: "13px",
          marginBottom: "18px",
        }}
      >
        <option value="all">{t("pendingOps.allAccounts", "All accounts")}</option>
        {(accountsQuery.data ?? []).map((account) => (
          <option key={account.id} value={account.id}>
            {account.email}
          </option>
        ))}
      </select>

      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "18px" }}>
        <Metric label={t("pendingOps.pending", "Pending")} value={summary.pending_count} />
        <Metric label={t("pendingOps.retrying", "Retrying")} value={summary.in_progress_count} />
        <Metric label={t("pendingOps.failed", "Failed")} value={summary.failed_count} />
        <Metric label={t("pendingOps.active", "Active")} value={summary.total_active_count} />
      </div>

      {summary.last_error && (
        <div
          role="alert"
          style={{
            display: "flex",
            gap: "8px",
            alignItems: "flex-start",
            padding: "10px 12px",
            marginBottom: "18px",
            borderRadius: "6px",
            border: "1px solid rgba(217, 119, 6, 0.3)",
            background: "rgba(217, 119, 6, 0.1)",
            color: "var(--color-warning, #d97706)",
            fontSize: "12px",
            lineHeight: 1.45,
          }}
        >
          <AlertCircle size={15} style={{ marginTop: "1px", flexShrink: 0 }} />
          <span>
            <strong style={{ display: 'block', marginBottom: 4 }}>{mailAccountTitle(summary.last_error_account_id ?? selectedAccountId, accountsQuery.data ?? [])}</strong>
            <strong>{t("pendingOps.latestError", "Latest error")}: </strong>
            {safeErrorMessage(summary.last_error)}
          </span>
        </div>
      )}

      <h3
        style={{
          fontSize: "14px",
          fontWeight: 600,
          marginTop: 0,
          marginBottom: "10px",
          color: "var(--color-text-primary)",
        }}
      >
        {t("pendingOps.queue", "Queue")}
      </h3>

      {loading ? (
        <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
          {t("common.loading", "Loading...")}
        </div>
      ) : ops.length === 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "16px 0",
            color: "var(--color-text-secondary)",
            fontSize: "13px",
          }}
        >
          <Clock size={15} />
          <span>{t("pendingOps.empty", "No pending remote writes.")}</span>
        </div>
      ) : (
        <div className="scroll-region pending-ops-table-scroll" style={{ overflowX: "auto", border: "1px solid var(--color-border)", borderRadius: "6px" }}>
          <table style={{ width: "100%", minWidth: "840px", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--color-bg-secondary)" }}>
                <th style={tableHeaderStyle}>{t("pendingOps.status", "Status")}</th>
                <th style={tableHeaderStyle}>{t("pendingOps.operation", "Operation")}</th>
                <th style={tableHeaderStyle}>{t("pendingOps.attempts", "Attempts")}</th>
                <th style={tableHeaderStyle}>{t("pendingOps.message", "Message")}</th>
                <th style={tableHeaderStyle}>{t("pendingOps.account", "Account")}</th>
                <th style={tableHeaderStyle}>{t("pendingOps.updated", "Updated")}</th>
                <th style={tableHeaderStyle}>{t("pendingOps.lastError", "Last error")}</th>
              </tr>
            </thead>
            <tbody>
              {ops.map((op) => {
                const tone = statusTone(op.status);
                return (
                  <tr key={op.id}>
                    <td style={tableCellStyle}>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          borderRadius: "999px",
                          padding: "2px 8px",
                          fontSize: "11px",
                          fontWeight: 600,
                          color: tone.color,
                          background: tone.background,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {op.dismissed ? "已忽略" : statusLabel(op.status)}
                      </span>
                    </td>
                    <td style={tableCellStyle}>{operationLabel(op.op_type)}
                      {op.workbench_schedule&&op.status==='pending'&&op.next_retry_at!=null&&<div style={{marginTop:6}}>计划：{formatTimestamp(op.next_retry_at)}
                        {op.next_retry_at>Date.now()/1000&&op.attempts===0&&!op.server_accepted&&<button type="button" disabled={Boolean(retrying)} onClick={()=>setCancelTarget(op)}>取消定时并恢复草稿</button>}
                      </div>}
                      <SettingsFeedback notice={actionError?.id === op.id && actionError.scheduled ? actionError : null} />
                    </td>
                    <td style={tableCellStyle}>{op.op_type === "send" && op.status === "failed" && op.next_retry_at == null ? "已暂停" : op.attempts}</td>
                    <td style={{ ...tableCellStyle, fontFamily: "var(--font-mono, monospace)" }}>
                      <button type="button" onClick={() => {
                        useMailStore.getState().setActiveAccountId(op.account_id);
                        const ui = useUIStore.getState(); ui.openMessageInInbox(op.message_id);
                        ui.setMessageDetailId(op.message_id); ui.setActiveView("messageDetail");
                      }}>查看邮件</button>
                    </td>
                    <td style={tableCellStyle}>{accountLabel(op.account_id)}</td>
                    <td style={tableCellStyle}>{formatTimestamp(op.updated_at)}</td>
                    <td style={{ ...tableCellStyle, color: op.last_error ? "var(--color-warning, #d97706)" : "var(--color-text-secondary)" }}>
                      {op.last_error ? safeErrorMessage(op.last_error) : "-"}
                      {op.op_type === "send" && op.status === "failed" && <div style={{ marginTop: 8 }}>
                        <span style={{ display: "block", marginBottom: 6 }}>{op.duplicate_submission ? "已核实为重复待发副本，禁止从此任务重发。" : op.server_accepted ? "发件服务器已接受邮件，请勿重发；需要处理本地存档或后续操作。" : "自动发送重试已暂停，请先核对是否已经发出。"}</span>
                        {!op.server_accepted && !op.duplicate_submission && <button type="button" disabled={Boolean(retrying)} onClick={() => setRetryTarget(op.id)}>核对后重试一次</button>}
                        {op.server_accepted && <button type="button" disabled={Boolean(retrying)} onClick={() => void continueArchive(op.id)}>继续归档</button>}
                        {!op.server_accepted && <button type="button" disabled={Boolean(retrying)} onClick={() => setConfirmedTarget(op)} style={{marginLeft:6}}>已发送，结束待发</button>}
                      </div>}
                      <SettingsFeedback notice={actionError?.id === op.id && !actionError.scheduled ? actionError : null} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {retryTarget && <ConfirmDialog title="确认重试发送？" message="发送失败有时只表示结果未确认。请先检查已发送及收件方，确保这不是已发出或重复提交的邮件。确认后仅重试一次；失败不会自动反复发送。" confirmLabel="已核对，重试一次" onConfirm={() => void retryOne()} onCancel={() => setRetryTarget(null)} />}
      {confirmedTarget&&<ConfirmDialog title="确认这封邮件已经发送？" message="请先核对已发送记录或收件方。确认后只结束这条待发记录：已归类邮件保留原位置，重复待发副本在核验已发送原件后收起；不会发送任何邮件。" confirmLabel="我已确认发送，结束待发" onConfirm={()=>void confirmSent()} onCancel={()=>setConfirmedTarget(null)}/>}
      {cancelTarget&&<ConfirmDialog title="取消此定时任务？" message="仅能取消尚未到期、尚未开始发送的任务；成功后邮件恢复为草稿，不会发送。" confirmLabel="确认取消并恢复草稿" onConfirm={()=>void cancelSchedule()} onCancel={()=>setCancelTarget(null)}/>}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div style={metricStyle}>
      <div
        style={{
          fontSize: "11px",
          fontWeight: 600,
          color: "var(--color-text-secondary)",
          marginBottom: "5px",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "22px",
          fontWeight: 650,
          lineHeight: 1,
          color: "var(--color-text-primary)",
        }}
      >
        {value}
      </div>
    </div>
  );
}
