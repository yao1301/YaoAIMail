import { useWorkspaceState, useWorkspaceInitEffect } from '@/lib/workspaceState';
import { getGlobalProxy, getMailProxy, saveSharedProxySettings } from "@/lib/api";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { inputStyle } from "@/styles/form";
import { useToastStore } from "@/stores/toast.store";

export default function GlobalProxySettings() {
  const [enabled, setEnabled] = useWorkspaceState("src/features/settings/GlobalProxySettings.tsx:GlobalProxySettings:enabled", false);
  const [host, setHost] = useWorkspaceState("src/features/settings/GlobalProxySettings.tsx:GlobalProxySettings:host", "");
  const [port, setPort] = useWorkspaceState("src/features/settings/GlobalProxySettings.tsx:GlobalProxySettings:port", "");
  const [mailUseProxy, setMailUseProxy] = useWorkspaceState("src/features/settings/GlobalProxySettings.tsx:GlobalProxySettings:mailUseProxy", false);
  const [legacyMailDiffers, setLegacyMailDiffers] = useWorkspaceState("src/features/settings/GlobalProxySettings.tsx:GlobalProxySettings:legacyMailDiffers", false);
  const [loaded, setLoaded] = useWorkspaceState("src/features/settings/GlobalProxySettings.tsx:GlobalProxySettings:loaded", false);
  const [saving, setSaving] = useWorkspaceState("src/features/settings/GlobalProxySettings.tsx:GlobalProxySettings:saving", false);
  const [error, setError] = useWorkspaceState("src/features/settings/GlobalProxySettings.tsx:GlobalProxySettings:error", "");
  useWorkspaceInitEffect("src/features/settings/GlobalProxySettings.tsx:", () => {
    let active = true;
    Promise.all([getGlobalProxy(), getMailProxy()]).then(([proxy, mail]) => {
      if (!active) return;
      const displayed = proxy ?? mail;
      setEnabled(Boolean(displayed));
      setHost(displayed?.host ?? "");
      setPort(displayed ? String(displayed.port) : "");
      setMailUseProxy(Boolean(mail));
      setLegacyMailDiffers(Boolean(proxy && mail && (proxy.host !== mail.host || proxy.port !== mail.port)));
      setLoaded(true);
    }).catch((e) => { if (active) setError(extractErrorMessage(e)); });
    return () => { active = false; };
  }, []);

  async function save() {
    setSaving(true); setError("");
    try {
      if (enabled && (!host.trim() || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
        throw new Error("请填写代理地址和有效端口（1–65535）");
      }
      await saveSharedProxySettings(enabled ? host.trim() : undefined, enabled ? Number(port) : undefined, enabled && mailUseProxy);
      setLegacyMailDiffers(false);
      useToastStore.getState().addToast({ type: "success", message: "代理设置已保存" });
    } catch (e) { setError(extractErrorMessage(e)); }
    finally { setSaving(false); }
  }

  return <section aria-label="统一代理">
    <h3 style={{ fontSize: 15, margin: "0 0 8px" }}>代理设置</h3>
    <p style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>地址只填一次。各模型是否使用，在该模型配置底部勾选。</p>
    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
      <input type="checkbox" checked={enabled} disabled={!loaded || saving} onChange={(e) => setEnabled(e.target.checked)} />启用代理设置
    </label>
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
      <label style={{ flex: "1 1 180px", fontSize: 12 }}>代理地址<input aria-label="代理地址" value={host} disabled={!loaded || saving || !enabled} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" style={inputStyle} /></label>
      <label style={{ width: 110, fontSize: 12 }}>端口<input aria-label="代理端口" value={port} type="number" min={1} max={65535} disabled={!loaded || saving || !enabled} onChange={(e) => setPort(e.target.value)} style={inputStyle} /></label>
    </div>
    {enabled && <p style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>填写代理软件里的 SOCKS 端口。</p>}
    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginTop: 12 }}>
      <input type="checkbox" checked={mailUseProxy} disabled={!loaded || saving || !enabled} onChange={(e) => setMailUseProxy(e.target.checked)} />邮件也使用此代理（通常不需要）
    </label>
    {legacyMailDiffers && <p role="note" style={{ fontSize: 12 }}>原邮件代理地址与上方不同；保存后将统一使用上方地址，单个邮箱的自定义设置不变。</p>}
    {error && <p role="alert" style={{ color: "var(--color-error)" }}>{error}</p>}
    <button type="button" disabled={!loaded || saving} onClick={() => void save()} style={{ padding: "7px 12px", marginTop: 12 }}>{saving ? "正在保存…" : "保存代理设置"}</button>
  </section>;
}
