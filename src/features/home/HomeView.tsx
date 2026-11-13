import { useWorkspaceState } from '@/lib/workspaceState';
import { useEffect } from "react";
import { listAccounts } from "@/lib/api";
import { useMailStore } from "@/stores/mail.store";
import HomeAiWorkbench from "./HomeAiWorkbench";

/**
 * 首页只保留一个核心入口：AI 工作台。
 * 汇率、节假日、时区等可随时查询的业务小工具统一放在右侧“外贸工具”面板，
 * 避免首页被多个重复看板挤占，也让首页对新用户更容易理解。
 */
export default function HomeView() {
  const activeAccountId = useMailStore((state) => state.activeAccountId);
  const setActiveAccountId = useMailStore((state) => state.setActiveAccountId);
  const setSearchScope = useMailStore((state) => state.setSearchScope);
  const [accounts, setAccounts] = useWorkspaceState<Awaited<ReturnType<typeof listAccounts>>>("src/features/home/HomeView.tsx:HomeView:accounts", []);

  useEffect(() => {
    let cancelled = false;
    listAccounts()
      .then((items) => {
        if (!cancelled) setAccounts(items);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeAccountId && accounts[0]?.id) {
      setActiveAccountId(accounts[0].id);
      setSearchScope({ kind: "account", accountId: accounts[0].id });
    }
  }, [accounts, activeAccountId, setActiveAccountId, setSearchScope]);

  return (
    <div className="scroll-region" style={{ padding: "28px 22px 30px", overflow: "auto", minHeight: "100%" }}>
      <div style={{ maxWidth: 900, margin: "0 auto 20px", padding: "4px 10px 0", textAlign: "center" }}>
        <h1 style={{ maxWidth: 820, margin: "0 auto", fontSize: "clamp(26px, 3vw, 40px)", lineHeight: 1.28, letterSpacing: "-0.028em", fontWeight: 750, color: "var(--color-text-primary)" }}>
          问邮件、查资料、写邮件、开发客户，<span style={{ color: "var(--color-accent)", whiteSpace: "nowrap" }}>一句话就行</span>
        </h1>
        <p style={{ maxWidth: 650, margin: "9px auto 0", color: "var(--color-text-secondary)", fontSize: 13, lineHeight: 1.65 }}>
          只问当前账号，AI 会读取与问题相关的邮件、客户和资料，并把引用内容直接连回原文。
        </p>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 7, marginTop: 12, padding: "5px 9px 5px 11px", border: "1px solid var(--color-border)", borderRadius: 999, background: "var(--color-bg-secondary)", color: "var(--color-text-secondary)", fontSize: 12 }}>
          当前工作账号
          <select
            aria-label="选择首页 AI 使用的邮箱账号"
            value={activeAccountId || ""}
            onChange={(event) => {
              const accountId = event.target.value;
              if (!accountId) return;
              setActiveAccountId(accountId);
              setSearchScope({ kind: "account", accountId });
            }}
            style={{ fontSize: 12, fontWeight: 600, border: 0, outline: 0, borderRadius: 999, padding: "2px 4px", background: "transparent", color: "var(--color-text-primary)" }}
            disabled={!accounts.length}
          >
            {accounts.length ? accounts.map((item) => <option key={item.id} value={item.id}>{item.display_name || item.email}</option>) : <option value="">未设置邮箱</option>}
          </select>
        </label>
      </div>
      <HomeAiWorkbench />
    </div>
  );
}
