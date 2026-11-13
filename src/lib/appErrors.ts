import { extractErrorMessage } from "./extractErrorMessage";
import { useToastStore } from "@/stores/toast.store";
import type { Account } from "./ipc-types";

const recent = new Map<string, number>();

/** Error notices must not expose credentials echoed by an upstream gateway. */
export function safeErrorMessage(error: unknown): string {
  return extractErrorMessage(error)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[凭据已隐藏]@")
    .replace(/\bBearer\s+[a-z0-9._~+/=-]+/gi, "Bearer [已隐藏]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, "$1[已隐藏]")
    .replace(/\b(?:sk-|AIza)[a-z0-9_-]{12,}/gi, "[密钥已隐藏]")
    .slice(0, 1200);
}

/** One persistent, dismissible notification per failure, not per polling tick. */
export function reportAppError(error: unknown, context = "操作失败", options: { title?: string; dedupeKey?: string } = {}) {
  const message = safeErrorMessage(error);
  if (/^(?:AbortError|cancelled|canceled|用户取消)$/i.test(message)) return;
  const now = Date.now();
  const key = JSON.stringify([options.dedupeKey ?? '', options.title ?? '', message]);
  if (now - (recent.get(key) ?? -Infinity) < 60_000) return;
  recent.set(key, now);
  for (const [key, time] of recent) if (now - time > 300_000) recent.delete(key);
  useToastStore.getState().addToast({ type: "error", duration: 0, message: `${context}：${message}`, ...(options.title ? { title: options.title } : {}) });
}

export function mailAccountTitle(accountId: string | null | undefined, accounts: Pick<Account, 'id' | 'email' | 'display_name'>[]): string {
  const account = accounts.find(item => item.id === accountId);
  if (!account?.email) return accountId ? `邮箱账户（${accountId.slice(0, 8)}，信息尚未加载）` : '邮箱账户尚未识别';
  return account.display_name?.trim() ? `${account.display_name.trim()} · ${account.email}` : account.email;
}
