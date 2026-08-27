import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  deleteExternalServiceApiKey,
  getExternalServiceUsage,
  getExternalServiceKeyStatus,
  saveExternalServiceApiKey,
  validateExternalServiceApiKey,
  type ExternalServiceUsage,
  type ExternalServiceKeyStatus,
} from "@/lib/api";
import { useToastStore } from "@/stores/toast.store";
import { extractErrorMessage } from "@/lib/extractErrorMessage";

type Provider = "tavily" | "brave" | "firecrawl" | "hunter";

const PROVIDERS: Array<{ id: Provider; name: string; purpose: string; docs: string }> = [
  { id: "tavily", name: "Tavily", purpose: "实时网页搜索与检索摘要", docs: "https://docs.tavily.com/documentation/api-reference/endpoint/search" },
  { id: "brave", name: "Brave Search", purpose: "实时网页搜索结果", docs: "https://api-dashboard.search.brave.com/app/documentation/web-search/get-started" },
  { id: "firecrawl", name: "Firecrawl", purpose: "网页搜索与网页内容抓取", docs: "https://docs.firecrawl.dev/api-reference/endpoint/search" },
  { id: "hunter", name: "Hunter", purpose: "验证已经找到的邮箱地址", docs: "https://help.hunter.io/en/articles/12633706-how-to-verify-emails-via-api-with-code-examples" },
];

export default function ExternalServicesTab() {
  const [status, setStatus] = useState<ExternalServiceKeyStatus>({ tavilyConfigured: false, braveConfigured: false, firecrawlConfigured: false, hunterConfigured: false, tavilyKeyCount: 0, braveKeyCount: 0, firecrawlKeyCount: 0, hunterKeyCount: 0 });
  const [drafts, setDrafts] = useState<Record<Provider, string>>({ tavily: "", brave: "", firecrawl: "", hunter: "" });
  const [saving, setSaving] = useState<Provider | null>(null);
  const [usage, setUsage] = useState<Partial<Record<Provider, ExternalServiceUsage>>>({});

  useEffect(() => {
    void getExternalServiceKeyStatus().then(setStatus).catch((error) => {
      useToastStore.getState().addToast({ message: `读取 API 配置失败：${extractErrorMessage(error)}`, type: "error" });
    });
  }, []);

  function isConfigured(provider: Provider) {
    return status[`${provider}Configured` as keyof ExternalServiceKeyStatus];
  }

  function keyCount(provider: Provider) {
    return status[`${provider}KeyCount` as keyof ExternalServiceKeyStatus] as number;
  }

  useEffect(() => {
    for (const provider of PROVIDERS) {
      if (status[`${provider.id}Configured` as keyof ExternalServiceKeyStatus]) {
        void getExternalServiceUsage(provider.id).then((next) => setUsage((old) => ({ ...old, [provider.id]: next }))).catch(() => {});
      }
    }
  }, [status.tavilyConfigured, status.braveConfigured, status.firecrawlConfigured, status.hunterConfigured]);

  async function save(provider: Provider) {
    setSaving(provider);
    try {
      const checked = await validateExternalServiceApiKey(provider, drafts[provider]);
      if (!checked.valid) throw new Error(checked.message);
      setStatus(await saveExternalServiceApiKey(provider, drafts[provider]));
      setUsage((old) => ({ ...old, [provider]: checked }));
      setDrafts((current) => ({ ...current, [provider]: "" }));
      useToastStore.getState().addToast({ message: `${provider} API Key 已加密保存`, type: "success" });
    } catch (error) {
      useToastStore.getState().addToast({ message: `保存失败：${extractErrorMessage(error)}`, type: "error" });
    } finally {
      setSaving(null);
    }
  }

  async function remove(provider: Provider) {
    try {
      setStatus(await deleteExternalServiceApiKey(provider));
      setUsage((old) => { const next = { ...old }; delete next[provider]; return next; });
      useToastStore.getState().addToast({ message: `${provider} API Key 已删除`, type: "success" });
    } catch (error) {
      useToastStore.getState().addToast({ message: `删除失败：${extractErrorMessage(error)}`, type: "error" });
    }
  }

  return (
    <div>
      <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>外部数据源 API</h2>
      <p style={hint}>
        Tavily、Brave 和 Hunter 属于独立的第三方服务。API Key 会在本机加密保存，不会进入分享压缩包；只有后续实际调用对应服务时，才会把必要的公司、域名或邮箱信息发送给该服务。
      </p>
      <div style={{ ...notice, marginBottom: 18 }}>
        当前版本先提供安全配置入口。实时搜索和邮箱验证接入时会再次显示服务、数据范围和可能的费用，不会因为填写 Key 就自动搜索或自动发送邮件。
      </div>
      {PROVIDERS.map((provider) => (
        <section key={provider.id} style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 14 }}>{provider.name}</h3>
              <p style={{ ...hint, marginBottom: 8 }}>{provider.purpose}</p>
            </div>
            <span style={{ color: isConfigured(provider.id) ? "#15803d" : "var(--color-text-secondary)", fontSize: 12 }}>
              {isConfigured(provider.id) ? `已配置 ${keyCount(provider.id)} 个 Key` : "未配置"}
            </span>
          </div>
          {usage[provider.id] && <p style={{ ...hint, margin: "0 0 8px", color: usage[provider.id]?.remaining != null && usage[provider.id]?.limit != null && (usage[provider.id]?.remaining ?? 0) <= Math.max(10, (usage[provider.id]?.limit ?? 0) * 0.1) ? "#b45309" : undefined }}>
            {usage[provider.id]?.remaining != null && usage[provider.id]?.limit != null
              ? `剩余 ${usage[provider.id]?.remaining} / ${usage[provider.id]?.limit} ${usage[provider.id]?.unit}`
              : usage[provider.id]?.message}
          </p>}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="password"
              value={drafts[provider.id]}
              onChange={(event) => setDrafts((current) => ({ ...current, [provider.id]: event.target.value }))}
              placeholder={isConfigured(provider.id) ? "继续粘贴一个新 Key（会加入轮换列表）" : "在这里粘贴 API Key"}
              autoComplete="new-password"
              style={input}
            />
            <button type="button" disabled={saving === provider.id || !drafts[provider.id].trim()} onClick={() => void save(provider.id)} style={primary}>
              {saving === provider.id ? "保存中" : "保存"}
            </button>
            {isConfigured(provider.id) && <button type="button" onClick={() => void remove(provider.id)} style={danger}>删除</button>}
          </div>
          <p style={{ ...hint, margin: "8px 0 0" }}>可以添加多个账号的 Key。调用失败、额度耗尽或被限流时，软件会自动尝试下一个。</p>
          <button type="button" onClick={() => void invoke("open_external_url", { url: provider.docs })} style={linkButton}>查看官方 API 文档</button>
        </section>
      ))}
    </div>
  );
}

const card: React.CSSProperties = { border: "1px solid var(--color-border)", borderRadius: 9, padding: 14, marginBottom: 12, background: "var(--color-bg-primary)" };
const hint: React.CSSProperties = { color: "var(--color-text-secondary)", fontSize: 12, lineHeight: 1.65 };
const notice: React.CSSProperties = { padding: 11, borderRadius: 8, border: "1px solid #d97706", background: "rgba(217,119,6,0.08)", color: "var(--color-text-primary)", fontSize: 12, lineHeight: 1.65 };
const input: React.CSSProperties = { flex: 1, minWidth: 0, boxSizing: "border-box", padding: "9px 10px", border: "1px solid var(--color-border)", borderRadius: 7, background: "var(--color-bg-secondary)", color: "var(--color-text-primary)" };
const primary: React.CSSProperties = { border: 0, borderRadius: 7, padding: "9px 14px", background: "var(--color-accent)", color: "#fff", cursor: "pointer", whiteSpace: "nowrap" };
const danger: React.CSSProperties = { border: 0, borderRadius: 7, padding: "9px 12px", background: "rgba(220,53,69,0.12)", color: "#dc3545", cursor: "pointer", whiteSpace: "nowrap" };
const linkButton: React.CSSProperties = { border: 0, padding: "8px 0 0", background: "transparent", color: "var(--color-accent)", cursor: "pointer", fontSize: 12 };
