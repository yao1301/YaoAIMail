import { useWorkspaceState, useWorkspaceInitEffect } from '@/lib/workspaceState';
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  getExternalServiceUsage,
  getExternalServiceKeyStatus,
  saveExternalServiceApiKey,
  setDeepseekSearchEnabled,
  validateExternalServiceApiKey,
  type ExternalServiceUsage,
  type ExternalServiceKeyStatus,
  type ExternalServiceProvider as Provider,
} from "@/lib/api";
import { useToastStore } from "@/stores/toast.store";
import { SettingsFeedback, type SettingsNotice } from "./SettingsFeedback";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import AiSearchSettings from "./AiSearchSettings";
import ExternalServiceKeyList from "@/components/ExternalServiceKeyList";

const PROVIDERS: Array<{ id: Provider; name: string; purpose: string; docs: string }> = [
  { id: "deepseek", name: "DeepSeek 网页搜索与读取", purpose: "用于开发客户和资信调研。可以填已有的 DeepSeek 官方 API Key，不影响当前 AI 模型。", docs: "https://api-docs.deepseek.com/guides/search/" },
  { id: "tavily", name: "Tavily", purpose: "实时网页搜索与检索摘要", docs: "https://docs.tavily.com/documentation/api-reference/endpoint/search" },
  { id: "brave", name: "Brave Search", purpose: "实时网页搜索结果", docs: "https://api-dashboard.search.brave.com/app/documentation/web-search/get-started" },
  { id: "firecrawl", name: "Firecrawl", purpose: "网页搜索与网页内容抓取", docs: "https://docs.firecrawl.dev/api-reference/endpoint/search" },
  { id: "hunter", name: "Hunter", purpose: "验证已经找到的邮箱地址", docs: "https://help.hunter.io/en/articles/12633706-how-to-verify-emails-via-api-with-code-examples" },
];

export default function ExternalServicesTab() {
  const [status, setStatus] = useWorkspaceState<ExternalServiceKeyStatus>("src/features/settings/ExternalServicesTab.tsx:ExternalServicesTab:status", { tavilyConfigured: false, braveConfigured: false, firecrawlConfigured: false, hunterConfigured: false, tavilyKeyCount: 0, braveKeyCount: 0, firecrawlKeyCount: 0, hunterKeyCount: 0 });
  const [drafts, setDrafts] = useWorkspaceState<Partial<Record<Provider, string>>>("src/features/settings/ExternalServicesTab.tsx:ExternalServicesTab:drafts", {});
  const [saving, setSaving] = useWorkspaceState<Provider | null>("src/features/settings/ExternalServicesTab.tsx:ExternalServicesTab:saving", null);
  const [advancedOpen, setAdvancedOpen] = useWorkspaceState("src/features/settings/ExternalServicesTab.tsx:ExternalServicesTab:advancedOpen", false);
  const [usage, setUsage] = useWorkspaceState<Partial<Record<Provider, ExternalServiceUsage>>>("src/features/settings/ExternalServicesTab.tsx:ExternalServicesTab:usage", {});
  const [feedback, setFeedback] = useWorkspaceState<Partial<Record<Provider | "deepseekToggle", SettingsNotice>>>("src/features/settings/ExternalServicesTab.tsx:ExternalServicesTab:feedback", {});

  useWorkspaceInitEffect("src/features/settings/ExternalServicesTab.tsx:", () => {
    void getExternalServiceKeyStatus().then(setStatus).catch((error) => {
      useToastStore.getState().addToast({ message: `读取 API 配置失败：${extractErrorMessage(error)}`, type: "error" });
    });
  }, []);

  function isConfigured(provider: Provider) {
    return status[`${provider}Configured` as keyof ExternalServiceKeyStatus];
  }

  useEffect(() => {
    if (!advancedOpen) return;
    for (const provider of PROVIDERS) {
      if (provider.id !== "deepseek" && status[`${provider.id}Configured` as keyof ExternalServiceKeyStatus]) {
        void getExternalServiceUsage(provider.id).then((next) => setUsage((old) => ({ ...old, [provider.id]: next }))).catch(() => {});
      }
    }
  }, [advancedOpen, status.tavilyConfigured, status.braveConfigured, status.firecrawlConfigured, status.hunterConfigured]);

  async function save(provider: Provider) {
    setSaving(provider);
    setFeedback((current) => ({ ...current, [provider]: undefined }));
    try {
      const key = drafts[provider]?.trim();
      if (!key) return;
      const checked = await validateExternalServiceApiKey(provider, key);
      if (!checked.valid) throw new Error(checked.message);
      setStatus(await saveExternalServiceApiKey(provider, key));
      setUsage((old) => ({ ...old, [provider]: checked }));
      setDrafts((current) => ({ ...current, [provider]: "" }));
      setFeedback((current) => ({ ...current, [provider]: { message: "API Key 已加密保存。", kind: "success" } }));
    } catch (error) {
      setFeedback((current) => ({ ...current, [provider]: { message: `保存失败：${extractErrorMessage(error)}`, kind: "error" } }));
    } finally {
      setSaving(null);
    }
  }

  async function setDeepseekEnabled(enabled: boolean) {
    setSaving("deepseek");
    setFeedback((current) => ({ ...current, deepseekToggle: undefined }));
    try {
      setStatus(await setDeepseekSearchEnabled(enabled));
      setFeedback((current) => ({ ...current, deepseekToggle: { message: enabled ? "已开启 DeepSeek 付费搜索。" : "已关闭 DeepSeek 付费搜索。", kind: "success" } }));
    } catch (error) {
      setFeedback((current) => ({ ...current, deepseekToggle: { message: `修改失败：${extractErrorMessage(error)}`, kind: "error" } }));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div>
      <h2 style={{ margin: "0 0 14px", fontSize: 18 }}>联网搜索与数据服务</h2>
      <AiSearchSettings />
      <details onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
      <summary style={{cursor: "pointer", fontSize: 13, marginBottom: 12}}>自备外部服务 API（高级，可选）</summary>
      <p style={hint}>
        这些服务由各自的服务商提供。API Key 会在本机加密保存；实际调用时，会将必要的公司、域名或邮箱信息发送给对应服务商。
      </p>
      <div style={{ ...notice, marginBottom: 18 }}>
        普通使用不需要填写这些内容。此处保留自备服务的配置；密钥验证或实际调用可能消耗服务商额度，不会自动发送邮件。缓存与请求保护使用软件默认值，无需调节。
      </div>
      {PROVIDERS.map((provider) => (
        <section key={provider.id} style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 14 }}>{provider.name}</h3>
              <p style={{ ...hint, marginBottom: 8 }}>{provider.purpose}</p>
            </div>
            {provider.id === "deepseek" && status.deepseekConfigured && <span style={{ color: "#15803d", fontSize: 12 }}>
              {status.deepseekSearchEnabled ? "付费搜索已开启" : "Key 已保存，付费搜索未开启"}
            </span>}
          </div>
          {usage[provider.id] && <p style={{ ...hint, margin: "0 0 8px", color: usage[provider.id]?.remaining != null && usage[provider.id]?.limit != null && (usage[provider.id]?.remaining ?? 0) <= Math.max(10, (usage[provider.id]?.limit ?? 0) * 0.1) ? "#b45309" : undefined }}>
            {usage[provider.id]?.remaining != null && usage[provider.id]?.limit != null
              ? `剩余 ${usage[provider.id]?.remaining} / ${usage[provider.id]?.limit} ${usage[provider.id]?.unit}`
              : usage[provider.id]?.message}
          </p>}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="password"
              value={drafts[provider.id] ?? ""}
              aria-label={`${provider.name} API Key`}
              onChange={(event) => setDrafts((current) => ({ ...current, [provider.id]: event.target.value }))}
              placeholder={isConfigured(provider.id) ? provider.id === "deepseek" ? "粘贴新 Key 以替换" : "继续粘贴一个新 Key（会加入轮换列表）" : "在这里粘贴 API Key"}
              autoComplete="new-password"
              style={input}
            />
            <button type="button" disabled={saving !== null || !drafts[provider.id]?.trim()} onClick={() => void save(provider.id)} style={primary}>
              {saving === provider.id ? "保存中" : "保存"}
            </button>
          </div>
          <SettingsFeedback notice={feedback[provider.id]} />
          <ExternalServiceKeyList provider={provider.id} name={provider.name} status={status} busy={saving !== null}
            onBusyChange={busy => setSaving(busy ? provider.id : null)} onStatusChange={next => {
              setStatus(next);
              setUsage(old => { const copy = { ...old }; delete copy[provider.id]; return copy; });
            }} />
          {provider.id === "deepseek" ? <div style={{ marginTop: 12 }}>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 7, fontSize: 13, lineHeight: 1.6 }}>
              <input type="checkbox" checked={Boolean(status.deepseekSearchEnabled)} disabled={!status.deepseekConfigured || saving !== null}
                aria-describedby="deepseek-billing-help" onChange={event => void setDeepseekEnabled(event.target.checked)} />
              允许在搜客和资信调研中使用 DeepSeek 付费搜索
            </label>
            <SettingsFeedback notice={feedback.deepseekToggle} />
            <p id="deepseek-billing-help" style={{ ...hint, margin: "6px 0 0" }}>
              默认关闭，保存 Key 不会自动开启。网页搜索和网页读取各按有结果的请求收费，当前均为每 1,000 次 0.75 美元，由 DeepSeek 从你的 API 账户扣费，大模型费用另计。一次任务可能包含多次请求。
              勾选后记住选择，任务中不再弹窗；关闭后停止后续 DeepSeek 调用，已发出的请求仍会正常结束。
            </p>
          </div> : <p style={{ ...hint, margin: "8px 0 0" }}>可保存备用 Key。统一搜索仅在认证／额度错误时最多尝试一个备用 Key；没有命中不换 Key，限流进入冷却。服务商额度与计费以其控制台为准。</p>}
          <button type="button" onClick={() => void invoke("open_external_url", { url: provider.docs })} style={linkButton}>查看官方 API 文档</button>
        </section>
      ))}
      </details>
    </div>
  );
}

const card: React.CSSProperties = { border: "1px solid var(--color-border)", borderRadius: 9, padding: 14, marginBottom: 12, background: "var(--color-bg-primary)" };
const hint: React.CSSProperties = { color: "var(--color-text-secondary)", fontSize: 12, lineHeight: 1.65 };
const notice: React.CSSProperties = { padding: 11, borderRadius: 8, border: "1px solid #d97706", background: "rgba(217,119,6,0.08)", color: "var(--color-text-primary)", fontSize: 12, lineHeight: 1.65 };
const input: React.CSSProperties = { flex: 1, minWidth: 0, boxSizing: "border-box", padding: "9px 10px", border: "1px solid var(--color-border)", borderRadius: 7, background: "var(--color-bg-secondary)", color: "var(--color-text-primary)" };
const primary: React.CSSProperties = { border: 0, borderRadius: 7, padding: "9px 14px", background: "var(--color-accent)", color: "#fff", cursor: "pointer", whiteSpace: "nowrap" };
const linkButton: React.CSSProperties = { border: 0, padding: "8px 0 0", background: "transparent", color: "var(--color-accent)", cursor: "pointer", fontSize: 12 };
