import { useEffect, useState } from "react";
import { FileText, Library, X } from "lucide-react";
import { listKnowledgeItems, type KnowledgeItem } from "@/lib/api";

export default function KnowledgePicker({
  accountId,
  selectedIds,
  onChange,
  label = "选择资料",
}: {
  accountId?: string | null;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => { setItems([]); setOpen(false); }, [accountId]);
  async function toggle() {
    if (!open && items.length === 0) {
      setLoading(true);
      try { setItems(await listKnowledgeItems(accountId)); } finally { setLoading(false); }
    }
    setOpen((value) => !value);
  }
  function toggleItem(id: string) {
    onChange(selectedIds.includes(id) ? selectedIds.filter((value) => value !== id) : [...selectedIds, id]);
  }
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button type="button" onClick={() => void toggle()} style={pickerButton}><Library size={13} />{label}{selectedIds.length > 0 ? `（${selectedIds.length}）` : ""}</button>
      {open && <div style={pickerPanel}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, padding: "7px 9px", borderBottom: "1px solid var(--color-border)" }}>
          <span style={{ fontSize: 11, color: "var(--color-text-secondary)", flex: 1, minWidth: 0 }}>只会把勾选的资料片段提供给本次 AI 任务</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="关闭资料选择"
            title="关闭"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, border: 0, borderRadius: 4, background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", flexShrink: 0 }}
          >
            <X size={14} />
          </button>
        </div>
        {loading ? <div style={empty}>正在读取资料…</div> : items.length === 0 ? <div style={empty}>当前账号没有可用资料</div> : items.map((item) => <label key={item.id} style={itemRow}>
          <input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => toggleItem(item.id)} />
          <FileText size={13} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
        </label>)}
        {selectedIds.length > 0 && <button type="button" onClick={() => onChange([])} style={clearButton}><X size={12} />清除选择</button>}
      </div>}
    </div>
  );
}

const pickerButton: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 9px", border: "1px solid var(--color-border)", borderRadius: 6, background: "var(--color-bg-primary)", color: "var(--color-text-primary)", cursor: "pointer", fontSize: 12 };
const pickerPanel: React.CSSProperties = { position: "absolute", zIndex: 100, top: "calc(100% + 5px)", left: 0, width: 280, maxHeight: 280, overflowY: "auto", border: "1px solid var(--color-border)", borderRadius: 8, background: "var(--color-bg-primary)", boxShadow: "0 8px 24px rgba(0,0,0,.18)" };
const itemRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, padding: "8px 9px", fontSize: 12, cursor: "pointer", color: "var(--color-text-primary)" };
const empty: React.CSSProperties = { padding: 12, fontSize: 12, color: "var(--color-text-secondary)" };
const clearButton: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 3, margin: "3px 8px 8px", border: 0, background: "transparent", color: "var(--color-accent)", cursor: "pointer", fontSize: 11 };
