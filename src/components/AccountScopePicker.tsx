import { useAccountsQuery } from "@/hooks/queries";
import { accountLabel } from "@/lib/accountLabel";

export default function AccountScopePicker({
  accountId,
  onChange,
  label = "本次使用的邮箱账号",
  followActive = false,
}: {
  accountId?: string | null;
  onChange?: (accountId: string) => void;
  label?: string;
  followActive?: boolean;
}) {
  const { data: accounts = [] } = useAccountsQuery();
  const current = accounts.find((account) => account.id === accountId);
  return (
    <label style={{ display: "grid", gap: 5, fontSize: 12, color: "var(--color-text-secondary)" }}>
      <span style={{ fontWeight: 700, color: "var(--color-text-primary)" }}>{label}</span>
      <select
        value={accountId ?? ""}
        disabled={!onChange}
        onChange={(event) => { if (event.currentTarget.value && onChange) onChange(event.currentTarget.value); }}
        style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", border: "1px solid var(--color-border)", borderRadius: 7, background: "var(--color-bg-primary)", color: "var(--color-text-primary)" }}
      >
        {followActive && <option value="">跟随左侧已选邮箱{current ? `（${accountLabel(current)}）` : ""}</option>}
        {!followActive && !accountId && <option value="">请选择邮箱账号</option>}
        {accounts.map((account) => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
      </select>
      <span>已选择：{accountLabel(current)}</span>
    </label>
  );
}
