export function accountLabel(account: { email: string; display_name?: string | null } | undefined): string {
  if (!account) return "未选择邮箱账号";
  return account.display_name?.trim() ? `${account.display_name} · ${account.email}` : account.email;
}
