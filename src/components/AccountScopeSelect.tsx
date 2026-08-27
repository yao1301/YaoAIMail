import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useAccountsQuery } from "@/hooks/queries";
import { accountLabel } from "@/lib/accountLabel";

/**
 * A single, plain-language control for reusable resources such as styles and
 * product documents. null means the resource is shared by every mailbox.
 */
export default function AccountScopeSelect({
  value,
  onChange,
  label = "适用邮箱账号",
}: {
  value: string[] | null;
  onChange: (value: string[] | null) => void;
  label?: string;
}) {
  const { data: accounts = [] } = useAccountsQuery();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const shared = value === null;
  const selectedIds = value ?? [];
  const allChecked = shared || (accounts.length > 0 && selectedIds.length === accounts.length);
  const summary = shared ? `全部账号${accounts.length ? `（${accounts.length} 个）` : ""}` : selectedIds.length > 0 ? `已选择 ${selectedIds.length} 个账号` : "请选择账号";

  useEffect(() => {
    function close(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <div style={{ display: "grid", gap: 7, fontSize: 12, color: "var(--color-text-secondary)" }}>
      <div style={{ fontWeight: 700, color: "var(--color-text-primary)" }}>{label}</div>
      <div ref={rootRef} style={{ position: "relative" }}>
        <button type="button" onClick={() => setOpen((current) => !current)} style={triggerStyle} aria-expanded={open}>
          <span>{summary}</span><ChevronDown size={15} style={{ transform: open ? "rotate(180deg)" : undefined }} />
        </button>
        {open && <div style={dropdownStyle}>
          <div style={{ padding: "7px 10px", color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)", fontSize: 11 }}>可多选邮箱账号</div>
          <label style={{ ...optionStyle, fontWeight: 700, color: "var(--color-text-primary)" }}>
            <input type="checkbox" checked={allChecked} onChange={() => onChange(allChecked ? [] : null)} />
            全部账号（{accounts.length}）
          </label>
          {accounts.map((account) => {
            const checked = shared || selectedIds.includes(account.id);
            return <label key={account.id} style={{ ...optionStyle, color: checked ? "var(--color-text-primary)" : "var(--color-text-secondary)" }}>
              <input type="checkbox" checked={checked} onChange={() => {
                const currentIds = shared ? accounts.map((item) => item.id) : selectedIds;
                const next = checked ? currentIds.filter((id) => id !== account.id) : [...currentIds, account.id];
                onChange(next.length === accounts.length ? null : next);
              }} />
              {accountLabel(account)}
            </label>;
          })}
          {accounts.length === 0 && <div style={{ padding: 10 }}>还没有邮箱账号</div>}
        </div>}
      </div>
      <span>勾选的账号会使用这份内容；可以同时选择多个账号。</span>
    </div>
  );
}

const triggerStyle: React.CSSProperties = { width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "8px 10px", border: "1px solid var(--color-border)", borderRadius: 7, background: "var(--color-bg-primary)", color: "var(--color-text-primary)", cursor: "pointer", textAlign: "left", fontSize: 12 };
const dropdownStyle: React.CSSProperties = { position: "absolute", zIndex: 200, top: "calc(100% + 5px)", left: 0, right: 0, maxHeight: 280, overflowY: "auto", padding: 4, border: "1px solid var(--color-border)", borderRadius: 8, background: "var(--color-bg-primary)", boxShadow: "0 8px 24px rgba(0,0,0,.18)" };
const optionStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "8px 7px", borderRadius: 5, cursor: "pointer" };
