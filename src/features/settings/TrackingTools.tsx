import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, ExternalLink, Search, X } from "lucide-react";
import { useWorkspaceState } from "@/lib/workspaceState";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { prepareTracking, rememberTracking, TRACKING_TYPES, type TrackingHistoryEntry, type TrackingMode, type TrackingPlan, type TrackingSource } from "./trackingModule";
import "./TrackingTools.css";

const KEY = "settings:logistics:";
export default function TrackingTools() {
  const [number, setNumber] = useWorkspaceState(KEY + "number", "");
  const [mode, setMode] = useWorkspaceState<TrackingMode>(KEY + "mode", "auto");
  const [plan, setPlan] = useWorkspaceState<TrackingPlan | null>(KEY + "plan", null);
  const [history, setHistory] = useWorkspaceState<TrackingHistoryEntry[]>(KEY + "history", []);
  const [status, setStatus] = useWorkspaceState(KEY + "status", "");
  const [error, setError] = useWorkspaceState(KEY + "error", "");
  const [busy, setBusy] = useWorkspaceState(KEY + "busy", false);
  const opening = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function resetFeedback() { setPlan(null); setStatus(""); setError(""); }
  async function openSource(current: TrackingPlan, source: TrackingSource) {
    if (opening.current || busy) return;
    opening.current = true; setBusy(true); setStatus(""); setError("");
    try {
      await invoke("open_external_url", { url: source.url });
      setHistory(previous => rememberTracking(previous, current.lookup));
      setStatus(`已打开 ${source.name}。${source.prefilled ? "单号已随链接传入，请在网站确认查询。" : "请复制单号后，在网站粘贴查询。"}`);
    } catch (reason) {
      setError(`无法打开查询网站：${extractErrorMessage(reason)}。可重试或改用下方其他入口。`);
    } finally { opening.current = false; setBusy(false); }
  }
  function query() {
    const result = prepareTracking(number, mode);
    setError(result.error ?? ""); setStatus(""); setPlan(result.plan ?? null);
    if (result.plan) void openSource(result.plan, result.plan.sources[0]);
  }
  async function copy() {
    if (!plan) return;
    try { await navigator.clipboard.writeText(plan.lookup.normalized); setStatus("单号已复制，可粘贴到查询网站。"); setError(""); }
    catch { setError("未能复制单号，请选中上方单号手动复制。"); }
  }

  return <div className="tracking-tools">
    <form onSubmit={event => { event.preventDefault(); query(); }} className="tracking-tools-form">
      <select aria-label="物流查询类型" value={mode} disabled={busy} onChange={event => { setMode(event.target.value as TrackingMode); resetFeedback(); }}>
        {TRACKING_TYPES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      <input ref={inputRef} aria-label="物流智能查询单号" maxLength={80} value={number} disabled={busy} placeholder="输入单号、集装箱号或 IMO / MMSI" onChange={event => { setNumber(event.target.value); resetFeedback(); }} />
      <button type="submit" className="tracking-tools-primary" disabled={busy}><Search size={14} />{busy ? "正在打开…" : "查询"}</button>
    </form>
    <p className="tracking-tools-hint">自动识别常见单号；海运提单或识别不准时，可手动切换类型。查询结果在外部网站显示。</p>
    {plan && <section className="tracking-tools-result" aria-label="查询信息">
      <div className="tracking-tools-number"><span>{plan.lookup.label}</span><strong>{plan.lookup.normalized}</strong><button type="button" onClick={() => void copy()} title="复制单号" aria-label="复制单号"><Copy size={14} /></button></div>
      {plan.warning && <p className="tracking-tools-hint">{plan.warning}</p>}
      {plan.sources.length > 1 && <div className="tracking-tools-alternatives">
        <span className="tracking-tools-hint">查不到？换个入口：</span>
        {plan.sources.map(source => <button type="button" key={source.id} disabled={busy} title={source.prefilled ? "携带单号打开查询页" : "打开官网后粘贴单号，仅查询该承运人的货件"} onClick={() => void openSource(plan, source)}>{source.name}<ExternalLink size={12} /></button>)}
      </div>}
      {(plan.lookup.kind === "container" || plan.lookup.kind === "billOfLading") && <p className="tracking-tools-hint">请选择实际承运人的官网；箱号前缀不一定代表本次承运人。</p>}
      {plan.lookup.kind === "vessel" && <p className="tracking-tools-hint">船舶位置不等于集装箱轨迹。</p>}
    </section>}
    {error && <p role="alert" className="tracking-tools-error">{error}</p>}
    {status && <p role="status" className="tracking-tools-hint">{status}</p>}
    {history.length > 0 && <div className="tracking-tools-history">
      <div className="tracking-tools-history-title"><span>最近查询 · 本次使用</span><button type="button" onClick={() => setHistory([])} title="清空查询记录" aria-label="清空查询记录"><X size={13} /></button></div>
      <div className="tracking-tools-history-items">{history.map(item => <button type="button" disabled={busy} key={`${item.kind}:${item.number}`} title="填入单号，不会自动查询" onClick={() => { setNumber(item.number); setMode(item.kind); resetFeedback(); inputRef.current?.focus(); }}><span>{TRACKING_TYPES.find(type => type.value === item.kind)?.label}</span>{item.number}</button>)}</div>
    </div>}
  </div>;
}
