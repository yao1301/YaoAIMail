import { useEffect, useState } from "react";
import { KeyRound, ExternalLink } from "lucide-react";
import {
  deleteExternalServiceApiKey,
  getExternalServiceUsage,
  getExternalServiceKeyStatus,
  saveExternalServiceApiKey,
  validateExternalServiceApiKey,
  type ExternalServiceUsage,
  type ExternalServiceKeyStatus,
} from "@/lib/api";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { useToastStore } from "@/stores/toast.store";

type Provider = "tavily" | "brave" | "firecrawl" | "hunter";

const PROVIDERS: Array<{
  id: Provider;
  label: string;
  placeholder: string;
  docs: string;
}> = [
  {
    id: "tavily",
    label: "Tavily Search API",
    placeholder: "tvly-…（搜索补充，不填也能用）",
    docs: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
  },
  {
    id: "brave",
    label: "Brave Search API",
    placeholder: "BSA…（搜索补充，不填也能用）",
    docs: "https://api-dashboard.search.brave.com/app/documentation/web-search/get-started",
  },
  {
    id: "firecrawl",
    label: "Firecrawl Search / Scrape",
    placeholder: "fc-…（云端 Key；自托管可不填）",
    docs: "https://docs.firecrawl.dev/api-reference/endpoint/search",
  },
  {
    id: "hunter",
    label: "Hunter Email Verifier",
    placeholder: "Hunter API Key（邮箱验证，不填也能用）",
    docs: "https://help.hunter.io/en/articles/12633706-how-to-verify-emails-via-api-with-code-examples",
  },
];

/**
 * Optional API key configuration used by AI research features. Keys are
 * optional — the model's own knowledge works without them; search services
 * merely add live sources. Keys are encrypted by the backend and never shown.
 */
export default function ExternalApiKeyPanel() {
  const [status, setStatus] = useState<ExternalServiceKeyStatus | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<Partial<Record<Provider, ExternalServiceUsage>>>({});

  async function refresh() {
    try {
      setStatus(await getExternalServiceKeyStatus());
    } catch {
      setStatus({ tavilyConfigured: false, braveConfigured: false, firecrawlConfigured: false, hunterConfigured: false, tavilyKeyCount: 0, braveKeyCount: 0, firecrawlKeyCount: 0, hunterKeyCount: 0 });
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function save(provider: "tavily" | "brave" | "firecrawl" | "hunter") {
    const key = (values[provider] ?? "").trim();
    if (!key) return;
    setBusy(true);
    try {
      const checked = await validateExternalServiceApiKey(provider, key);
      if (!checked.valid) throw new Error(checked.message);
      const next = await saveExternalServiceApiKey(provider, key);
      setStatus(next);
      setUsage((old) => ({ ...old, [provider]: checked }));
      setValues((old) => ({ ...old, [provider]: "" }));
      useToastStore.getState().addToast({
        message: "API Key 已加密保存，仅在本机使用。",
        type: "success",
      });
    } catch (error) {
      useToastStore.getState().addToast({
        message: `保存失败：${extractErrorMessage(error)}`,
        type: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove(provider: "tavily" | "brave" | "firecrawl" | "hunter") {
    setBusy(true);
    try {
      setStatus(await deleteExternalServiceApiKey(provider));
      setUsage((old) => { const next = { ...old }; delete next[provider]; return next; });
      useToastStore.getState().addToast({ message: "已删除该 API Key。", type: "success" });
    } catch (error) {
      useToastStore.getState().addToast({
        message: `删除失败：${extractErrorMessage(error)}`,
        type: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function refreshUsage(provider: "tavily" | "brave" | "firecrawl" | "hunter") {
    try {
      const next = await getExternalServiceUsage(provider);
      setUsage((old) => ({ ...old, [provider]: next }));
    } catch {
      // Usage is a soft signal; a failed usage endpoint never blocks research.
    }
  }

  useEffect(() => {
    if (!status) return;
    const providers = PROVIDERS.filter((provider) => status[`${provider.id}Configured` as keyof ExternalServiceKeyStatus]);
    for (const provider of providers) void refreshUsage(provider.id);
  }, [status?.tavilyConfigured, status?.braveConfigured, status?.firecrawlConfigured, status?.hunterConfigured]);

  return (
    <section style={{
      border: "1px dashed var(--color-border)",
      borderRadius: 10,
      padding: "12px 14px",
      background: "color-mix(in srgb, var(--color-accent) 4%, transparent)",
      marginBottom: 14,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
        <KeyRound size={15} />
        <strong style={{ fontSize: 13 }}>可选：补充联网搜索 / 邮箱验证</strong>
        <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
          不填也能用（AI 先用自己的知识，这里的服务只是补充信源）
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 8 }}>
        {PROVIDERS.map((provider) => {
          const configured = status?.[`${provider.id}Configured` as keyof ExternalServiceKeyStatus];
          const providerUsage = usage[provider.id];
          return (
            <div key={provider.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                <span>{provider.label}</span>
                <span style={{
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 8,
                  background: configured ? "rgba(34,197,94,0.15)" : "rgba(100,116,139,0.15)",
                  color: configured ? "#16a34a" : "var(--color-text-secondary)",
                }}>
                  {configured ? "已配置" : "未配置"}
                </span>
                <a href={provider.docs} target="_blank" rel="noreferrer" style={{ color: "var(--color-accent)", display: "flex", alignItems: "center", gap: 2 }}>
                  官方文档 <ExternalLink size={10} />
                </a>
              </div>
              {providerUsage && (
                <div style={{ fontSize: 10, color: providerUsage.remaining != null && providerUsage.limit != null && providerUsage.remaining <= Math.max(10, providerUsage.limit * 0.1) ? "#b45309" : "var(--color-text-secondary)" }}>
                  {providerUsage.remaining != null && providerUsage.limit != null
                    ? `剩余 ${providerUsage.remaining} / ${providerUsage.limit} ${providerUsage.unit}`
                    : providerUsage.message}
                </div>
              )}
              <div style={{ display: "flex", gap: 5 }}>
                <input
                  type="password"
                  value={values[provider.id] ?? ""}
                  onChange={(event) => setValues((old) => ({ ...old, [provider.id]: event.target.value }))}
                  placeholder={provider.placeholder}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: "6px 8px",
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    background: "var(--color-bg-secondary)",
                    color: "var(--color-text-primary)",
                    fontSize: 12,
                  }}
                />
                <button
                  type="button"
                  disabled={busy || !(values[provider.id] ?? "").trim()}
                  onClick={() => void save(provider.id)}
                  style={{ padding: "5px 10px", border: 0, borderRadius: 6, background: "var(--color-accent)", color: "#fff", fontSize: 12, cursor: busy ? "default" : "pointer" }}
                >
                  保存
                </button>
                {configured && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(provider.id)}
                    style={{ padding: "5px 10px", border: 0, borderRadius: 6, background: "transparent", color: "#dc3545", fontSize: 12, cursor: busy ? "default" : "pointer" }}
                  >
                    删除
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
