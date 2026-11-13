import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { deleteExternalServiceApiKey, listExternalServiceApiKeys, type ExternalServiceKeyEntry, type ExternalServiceKeyStatus, type ExternalServiceProvider } from "@/lib/api";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { useToastStore } from "@/stores/toast.store";

/** Shared by settings and the research shortcut; never receives clear saved keys. */
export default function ExternalServiceKeyList({ provider, name, status, busy, onBusyChange, onStatusChange }: {
  provider: ExternalServiceProvider; name: string; status: ExternalServiceKeyStatus | null;
  busy: boolean; onBusyChange: (busy: boolean) => void; onStatusChange: (status: ExternalServiceKeyStatus) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<ExternalServiceKeyEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const deleting = useRef(false);
  const configured = Boolean(status?.[`${provider}Configured`]);
  const count = status?.[`${provider}KeyCount`] ?? 0;

  useEffect(() => {
    if (!expanded || !configured) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setDeleteError(null);
    setConfirmId(null);
    void listExternalServiceApiKeys(provider).then(rows => {
      if (!cancelled) setEntries(rows);
    }).catch(reason => {
      if (!cancelled) { setEntries([]); setError(`读取失败：${extractErrorMessage(reason)}`); }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [expanded, configured, provider, status, retry]);

  async function remove(entry: ExternalServiceKeyEntry) {
    if (busy || deleting.current) return;
    deleting.current = true;
    onBusyChange(true);
    setDeleteError(null);
    try {
      const next = await deleteExternalServiceApiKey(provider, entry.id);
      setEntries(old => old.filter(row => row.id !== entry.id));
      setConfirmId(null);
      onStatusChange(next);
      useToastStore.getState().addToast({ message: `已删除 ${name} 的这条 API Key。`, type: "success" });
    } catch (reason) {
      setDeleteError({ id: entry.id, message: `删除失败：${extractErrorMessage(reason)}` });
    } finally {
      deleting.current = false;
      onBusyChange(false);
    }
  }

  if (!configured) return <div style={{ ...hint, marginTop: 8 }}>未配置</div>;
  return <div style={{ marginTop: 8, fontSize: 12 }}>
    <button type="button" aria-expanded={expanded} aria-label={`${name} 已配置 ${count} 个 Key`} disabled={busy}
      onClick={() => setExpanded(value => !value)} style={{ ...button, color: "var(--color-accent)", display: "inline-flex", alignItems: "center", gap: 4 }}>
      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}已配置 {count} 个 Key
    </button>
    {expanded && <div aria-label={`${name} 已保存的 API Key`} style={{ marginTop: 6 }}>
      {loading ? <div style={hint}>正在读取…</div> : entries.map((entry, index) => <div key={entry.id}
        style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "5px 0", borderBottom: "1px solid var(--color-border)" }}>
        <span style={hint}>Key {index + 1}</span><code style={{ flex: 1 }}>{entry.maskedKey}</code>
        {confirmId === entry.id ? <>
          <span style={hint}>仅删除这一条？</span>
          <button type="button" disabled={busy} onClick={() => void remove(entry)} style={{ ...button, color: "#dc3545" }}>确认删除</button>
          <button type="button" disabled={busy} onClick={() => { setConfirmId(null); setDeleteError(null); }} style={button}>取消</button>
        </> : <button type="button" disabled={busy} title="仅删除这一条 API Key" aria-label={`删除 ${name} Key ${index + 1}`}
          onClick={() => setConfirmId(entry.id)} style={{ ...button, color: "#dc3545" }}><Trash2 size={14} /></button>}
        {deleteError?.id === entry.id && <div role="alert" style={{ width: "100%", color: "var(--color-error, #dc3545)" }}>{deleteError.message}</div>}
      </div>)}
      {!loading && !error && entries.length === 0 && <div style={hint}>列表已变更，请重新读取。</div>}
      {error && <div role="alert" style={{ color: "#dc3545", marginTop: 6 }}>{error}</div>}
      {!loading && (error || entries.length === 0) && <button type="button" disabled={busy} style={button} onClick={() => setRetry(value => value + 1)}>重新读取</button>}
    </div>}
  </div>;
}
const hint: React.CSSProperties = { color: "var(--color-text-secondary)", fontSize: 12, lineHeight: 1.6 };
const button: React.CSSProperties = { border: 0, borderRadius: 4, padding: "4px 6px", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", fontSize: 12 };
