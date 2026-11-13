import { FOREIGN_TOOL_SOURCES, trackTraceLookupUrl } from "./foreignToolSources";
import { identifyTrackingLookup, type TrackingLookup, type TrackingLookupKind } from "./trackingLookup";

export type TrackingMode = "auto" | TrackingLookupKind;
export const TRACKING_TYPES: ReadonlyArray<{ value: TrackingMode; label: string }> = [
  { value: "auto", label: "自动识别" }, { value: "container", label: "集装箱号" },
  { value: "billOfLading", label: "海运提单号" }, { value: "aircargo", label: "空运提单号" },
  { value: "shipment", label: "快递单号" }, { value: "vessel", label: "IMO / MMSI" },
];
export interface TrackingSource { id: string; name: string; url: string; prefilled: boolean }
export interface TrackingPlan { lookup: TrackingLookup; warning?: string; sources: TrackingSource[] }
export interface TrackingHistoryEntry { number: string; kind: TrackingLookupKind; openedAt: number }

/** Keep providers independent of recognition: a container owner is not necessarily its carrier. */
export function trackingSources(lookup: TrackingLookup): TrackingSource[] {
  const sources: TrackingSource[] = [{ id: "default", name: lookup.provider, url: lookup.url, prefilled: true }];
  if (lookup.kind === "container" || lookup.kind === "billOfLading") {
    sources.push(
      { id: "maersk", name: "Maersk 官网", url: FOREIGN_TOOL_SOURCES.maersk, prefilled: false },
      { id: "msc", name: "MSC 官网", url: FOREIGN_TOOL_SOURCES.msc, prefilled: false },
      { id: "cma", name: "CMA CGM 官网", url: FOREIGN_TOOL_SOURCES.cma, prefilled: false },
    );
  } else if (lookup.kind === "shipment") {
    sources.push(
      { id: "dhl", name: "DHL 官网", url: FOREIGN_TOOL_SOURCES.dhl, prefilled: false },
      { id: "ups", name: "UPS 官网", url: FOREIGN_TOOL_SOURCES.ups, prefilled: false },
    );
  }
  return sources;
}

function containerChecksum(number: string) {
  let sum = 0;
  for (let index = 0; index < 10; index++) {
    const code = number.charCodeAt(index);
    const base = code >= 65 ? code - 55 : code - 48;
    const value = code >= 65 ? base + Math.floor((base - 1) / 10) : base;
    sum += value * 2 ** index;
  }
  return sum % 11 % 10 === Number(number[10]);
}

/** Offline input checks only: never assert a shipment exists or has been delivered. */
export function prepareTracking(input: string, mode: TrackingMode = "auto"): { plan?: TrackingPlan; error?: string } {
  const raw = input.trim().toUpperCase();
  if (!raw) return { error: "请先输入一个单号。" };
  if (raw.length > 80 || !/^[A-Z0-9\s:：-]+$/.test(raw) || /[\r\n]/.test(raw)) {
    return { error: "请只输入一个单号，不要粘贴网址、多行内容或邮件正文。" };
  }
  let lookup = identifyTrackingLookup(raw)!;
  const kind = mode === "auto" ? lookup.kind : mode;
  const explicit = kind === "vessel" ? raw.replace(/^(?:IMO|MMSI)[\s:：-]*/, "")
    : kind === "aircargo" ? raw.replace(/^AWB[\s:：-]*/, "") : raw;
  let number = explicit.replace(/[\s-]/g, "");
  if (!/^[A-Z0-9]{5,40}$/.test(number)) return { error: "请检查单号，通常应为 5–40 位字母或数字。" };
  if (kind === "container" && !/^[A-Z]{3}[UJZ]\d{7}$/.test(number)) {
    return { error: "集装箱号应为 4 个字母和 7 位数字，请检查输入或切换查询类型。" };
  }
  if (kind === "vessel" && !/^(?:\d{7}|\d{9})$/.test(number)) {
    return { error: "请输入 7 位 IMO 号或 9 位 MMSI 号。" };
  }
  if (kind === "aircargo") {
    if (!/^\d{11}$/.test(number)) return { error: "空运提单号应为 11 位数字，可使用 123-12345678 格式。" };
    number = `${number.slice(0, 3)}-${number.slice(3)}`;
  }
  if (kind === "container" || kind === "aircargo" || kind === "billOfLading") {
    const label = TRACKING_TYPES.find(item => item.value === kind)!.label;
    const provider = kind === "container" ? "Track-Trace 集装箱查询" : kind === "aircargo" ? "Track-Trace 空运查询" : "Track-Trace 海运提单查询";
    lookup = { kind, normalized: number, label, provider, url: trackTraceLookupUrl(kind, number) };
  } else if (kind === "vessel") {
    lookup = { kind, normalized: number, label: number.length === 9 ? "船舶 MMSI" : "船舶 IMO 号", provider: "VesselFinder 船舶查询", url: `${FOREIGN_TOOL_SOURCES.vessel}?name=${encodeURIComponent(number)}` };
  } else {
    lookup = { kind, normalized: number, label: "物流 / 快递单号", provider: "17TRACK 国际物流查询", url: `${FOREIGN_TOOL_SOURCES.shipment}?nums=${encodeURIComponent(number)}` };
  }
  let warning: string | undefined;
  if (kind === "container" && !containerChecksum(number)) warning = "集装箱号校验位不一致，请核对原单；仍可继续到网站查询。";
  if (kind === "aircargo" && Number(number.slice(4, 11)) % 7 !== Number(number[11])) warning = "空运提单号校验位不一致，请核对原单；仍可继续查询。";
  if (mode === "auto" && kind === "shipment") warning = "暂按快递单号查询；如果是海运或空运提单，请在左侧切换类型。";
  return { plan: { lookup, warning, sources: trackingSources(lookup) } };
}

export function rememberTracking(history: TrackingHistoryEntry[], lookup: TrackingLookup, now = Date.now()): TrackingHistoryEntry[] {
  return [{ number: lookup.normalized, kind: lookup.kind, openedAt: now },
    ...history.filter(item => item.number !== lookup.normalized || item.kind !== lookup.kind)].slice(0, 10);
}
