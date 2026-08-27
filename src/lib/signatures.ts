import { invoke } from "@tauri-apps/api/core";

const LEGACY_STORAGE_KEY = "pebble-signatures";

function clearLegacySignatures() {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch { /* ignored */ }
}

export interface EmailSignature {
  id: string;
  name: string;
  content: string;
  is_default: boolean;
}

/** 返回该账号当前默认签名的正文（无签名返回空字符串）。 */
export async function getSignature(accountId: string): Promise<string> {
  const signature = await invoke<string>("get_email_signature", { accountId });
  clearLegacySignatures();
  return signature;
}

/** 兼容旧的单签名保存（内部转为该账号唯一一条默认签名）。 */
export async function setSignature(accountId: string, signature: string): Promise<void> {
  await invoke<void>("set_email_signature", { accountId, signature });
  clearLegacySignatures();
}

/** 列出该账号的全部签名。 */
export async function listEmailSignatures(accountId: string): Promise<EmailSignature[]> {
  return invoke<EmailSignature[]>("list_email_signatures", { accountId });
}

/** 新增（signatureId 为空）或更新一条签名，返回该账号最新签名列表。 */
export async function saveEmailSignature(
  accountId: string,
  signatureId: string | null,
  name: string,
  content: string,
): Promise<EmailSignature[]> {
  return invoke<EmailSignature[]>("save_email_signature", {
    accountId,
    signatureId,
    name,
    content,
  });
}

/** 删除一条签名，返回最新列表。 */
export async function deleteEmailSignature(
  accountId: string,
  signatureId: string,
): Promise<EmailSignature[]> {
  return invoke<EmailSignature[]>("delete_email_signature", { accountId, signatureId });
}

/** 设为默认签名，返回最新列表。 */
export async function setDefaultEmailSignature(
  accountId: string,
  signatureId: string,
): Promise<EmailSignature[]> {
  return invoke<EmailSignature[]>("set_default_email_signature", { accountId, signatureId });
}
