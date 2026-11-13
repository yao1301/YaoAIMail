import type { Account, PendingMailOpsSummary } from './ipc-types';
import { useToastStore } from '@/stores/toast.store';
import { mailAccountTitle, reportAppError, safeErrorMessage } from './appErrors';
import { getProfileStorageNamespace, profileLocalStorage } from './profileStorage';

export const MAIL_ERROR_NOTICES_KEY = 'pebble-mail-error-notices-v1';
export type MailFailure = { account_id?: string | null; operation_id?: string | null; op_type?: string | null; message: string };
const memory = new Set<string>();

// Persist only opaque identifiers + a fingerprint, never mail/error text or credentials.
function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
function noticeIdentity(error: MailFailure) {
  return `${error.account_id ?? ''}:${error.operation_id ?? ''}:${fingerprint(safeErrorMessage(error.message))}`;
}
function readSeen(): string[] {
  try {
    const stored: unknown = JSON.parse(profileLocalStorage.getItem(MAIL_ERROR_NOTICES_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === 'string').slice(-256) : [];
  } catch { return []; }
}

export function forgetMailFailure(operationId: string) {
  const retained = readSeen().filter(key => !key.includes(`:${operationId}:`));
  for (const key of memory) if (key.startsWith(`${getProfileStorageNamespace() ?? ''}\0`) && key.includes(`:${operationId}:`)) memory.delete(key);
  try { profileLocalStorage.setItem(MAIL_ERROR_NOTICES_KEY, JSON.stringify(retained)); } catch { /* In-memory deduplication remains. */ }
}

export function reportMailFailure(error: MailFailure, accounts: Account[]) {
  if (!error.message) return;
  if (error.operation_id) {
    const key = noticeIdentity(error);
    const memoryKey = `${getProfileStorageNamespace() ?? ''}\0${key}`;
    if (readSeen().includes(key) || memory.has(memoryKey)) return;
    const seen = [...readSeen(), key].slice(-256);
    try { profileLocalStorage.setItem(MAIL_ERROR_NOTICES_KEY, JSON.stringify(seen)); }
    catch {
      if (memory.size >= 256) memory.delete(memory.values().next().value!);
      memory.add(memoryKey);
    } // Storage failure must not produce a popup on every poll.
  }
  const labels: Record<string, string> = { send: '邮件发送待处理', delete: '删除未完成', delete_permanent: '永久删除未完成',
    move_to_folder: '移动未完成', archive: '归档未完成', unarchive: '取消归档未完成', restore: '恢复未完成', update_flags: '邮件标记未同步', sync: '邮件同步失败', connection: '邮件连接失败' };
  const context = labels[error.op_type ?? ''] ?? '邮件操作未完成';
  const title = mailAccountTitle(error.account_id, accounts);
  if (error.operation_id) useToastStore.getState().addToast({ type: 'error', duration: 0, title, message: `${context}：${safeErrorMessage(error.message)}` });
  else reportAppError(error.message, context, { title, dedupeKey: error.account_id ?? '' });
}

export function pendingSummaryFailure(summary: PendingMailOpsSummary, scope: string | null): MailFailure | null {
  return summary.last_error ? { message: summary.last_error, account_id: summary.last_error_account_id ?? scope,
    operation_id: summary.last_error_operation_id, op_type: summary.last_error_op_type } : null;
}
