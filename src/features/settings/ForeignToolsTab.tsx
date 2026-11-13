import { useWorkspaceState } from '@/lib/workspaceState';
import { useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Calculator, CalendarDays, Clock3, Copy, ExternalLink, PackageSearch, Plus, RefreshCw, Search, TrendingUp, X } from "lucide-react";
import { aiPrompt, getDashboardData, type DashboardData } from "@/lib/api";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { useToastStore } from "@/stores/toast.store";
import MarkdownView from "@/lib/renderMarkdown";
import TrackingTools from "./TrackingTools";
import { FOREIGN_TOOL_SOURCES, hsCodeLookupUrl } from "./foreignToolSources";

const HS_SYSTEM = `你是外贸商品归类辅助员。请基于当前有效的 HS 2022 或目的国最新税则判断，不要沿用已经失效的编码。先判断商品本质、材料、功能、工作方式、是否成套、功率和用途，再给出最可能的编码、需要排除的候选、仍需确认的参数，并提醒用户最终在 WCO 或目的国官方税则复核。不确定时保留 6 位，不要编造十位税号。用中文回答。`;

const CONTAINERS = {
  "20GP": [5.9, 2.35, 2.39, 28],
  "40GP": [12.03, 2.35, 2.39, 58],
  "40HQ": [12.03, 2.35, 2.69, 68],
  "45HQ": [13.55, 2.35, 2.69, 78],
} as const;

const ZONES_KEY = "yaoaimail-foreign-tool-zones-v2";
const CURRENCIES_KEY = "yaoaimail-foreign-tool-currencies-v1";

/** 世界主要城市（按大洲分组）。同一时区可对应多个城市（如北京/上海、悉尼/墨尔本）。 */
const REGION_CITIES: Array<{ region: string; cities: Array<[string, string]> }> = [
  {
    region: "亚洲",
    cities: [
      ["北京", "Asia/Shanghai"], ["上海", "Asia/Shanghai"], ["香港", "Asia/Hong_Kong"], ["台北", "Asia/Taipei"],
      ["东京", "Asia/Tokyo"], ["首尔", "Asia/Seoul"], ["新加坡", "Asia/Singapore"], ["曼谷", "Asia/Bangkok"],
      ["吉隆坡", "Asia/Kuala_Lumpur"], ["雅加达", "Asia/Jakarta"], ["马尼拉", "Asia/Manila"], ["胡志明市", "Asia/Ho_Chi_Minh"],
      ["孟买", "Asia/Kolkata"], ["新德里", "Asia/Kolkata"], ["达卡", "Asia/Dhaka"], ["迪拜", "Asia/Dubai"],
      ["利雅得", "Asia/Riyadh"], ["多哈", "Asia/Qatar"], ["科威特城", "Asia/Kuwait"], ["伊斯坦布尔", "Europe/Istanbul"],
      ["德黑兰", "Asia/Tehran"], ["特拉维夫", "Asia/Jerusalem"], ["安曼", "Asia/Amman"], ["巴格达", "Asia/Baghdad"],
    ],
  },
  {
    region: "欧洲",
    cities: [
      ["伦敦", "Europe/London"], ["巴黎", "Europe/Paris"], ["柏林", "Europe/Berlin"], ["马德里", "Europe/Madrid"],
      ["罗马", "Europe/Rome"], ["阿姆斯特丹", "Europe/Amsterdam"], ["布鲁塞尔", "Europe/Brussels"], ["维也纳", "Europe/Vienna"],
      ["苏黎世", "Europe/Zurich"], ["斯德哥尔摩", "Europe/Stockholm"], ["奥斯陆", "Europe/Oslo"], ["哥本哈根", "Europe/Copenhagen"],
      ["赫尔辛基", "Europe/Helsinki"], ["华沙", "Europe/Warsaw"], ["布拉格", "Europe/Prague"], ["布达佩斯", "Europe/Budapest"],
      ["雅典", "Europe/Athens"], ["里斯本", "Europe/Lisbon"], ["都柏林", "Europe/Dublin"], ["莫斯科", "Europe/Moscow"],
      ["基辅", "Europe/Kyiv"], ["布加勒斯特", "Europe/Bucharest"], ["贝尔格莱德", "Europe/Belgrade"],
    ],
  },
  {
    region: "美洲",
    cities: [
      ["纽约", "America/New_York"], ["洛杉矶", "America/Los_Angeles"], ["芝加哥", "America/Chicago"], ["丹佛", "America/Denver"],
      ["旧金山", "America/Los_Angeles"], ["西雅图", "America/Los_Angeles"], ["迈阿密", "America/New_York"], ["休斯顿", "America/Chicago"],
      ["拉斯维加斯", "America/Los_Angeles"], ["凤凰城", "America/Phoenix"], ["多伦多", "America/Toronto"], ["温哥华", "America/Vancouver"],
      ["蒙特利尔", "America/Toronto"], ["墨西哥城", "America/Mexico_City"], ["圣保罗", "America/Sao_Paulo"], ["里约热内卢", "America/Sao_Paulo"],
      ["布宜诺斯艾利斯", "America/Argentina/Buenos_Aires"], ["圣地亚哥", "America/Santiago"], ["波哥大", "America/Bogota"],
      ["利马", "America/Lima"], ["加拉加斯", "America/Caracas"], ["哈瓦那", "America/Havana"], ["巴拿马城", "America/Panama"],
      ["圣胡安", "America/Puerto_Rico"],
    ],
  },
  {
    region: "非洲",
    cities: [
      ["开罗", "Africa/Cairo"], ["约翰内斯堡", "Africa/Johannesburg"], ["开普敦", "Africa/Johannesburg"],
      ["拉各斯", "Africa/Lagos"], ["内罗毕", "Africa/Nairobi"], ["阿克拉", "Africa/Accra"], ["卡萨布兰卡", "Africa/Casablanca"],
      ["突尼斯", "Africa/Tunis"], ["亚的斯亚贝巴", "Africa/Addis_Ababa"], ["达累斯萨拉姆", "Africa/Dar_es_Salaam"], ["阿尔及尔", "Africa/Algiers"],
    ],
  },
  {
    region: "大洋洲",
    cities: [
      ["悉尼", "Australia/Sydney"], ["墨尔本", "Australia/Sydney"], ["布里斯班", "Australia/Brisbane"], ["珀斯", "Australia/Perth"],
      ["阿德莱德", "Australia/Adelaide"], ["奥克兰", "Pacific/Auckland"], ["惠灵顿", "Pacific/Auckland"], ["斐济", "Pacific/Fiji"],
      ["火奴鲁鲁", "Pacific/Honolulu"],
    ],
  },
];

const DEFAULT_CITIES: Array<{ city: string; zone: string }> = [
  { city: "北京", zone: "Asia/Shanghai" },
  { city: "伦敦", zone: "Europe/London" },
  { city: "纽约", zone: "America/New_York" },
  { city: "迪拜", zone: "Asia/Dubai" },
];

const DEFAULT_CURRENCIES: Array<{ code: string; amount: number }> = [
  { code: "USD", amount: 1 }, { code: "EUR", amount: 1 }, { code: "GBP", amount: 1 },
  { code: "HKD", amount: 1 }, { code: "JPY", amount: 100 },
];
const CURRENCY_NAMES: Record<string, string> = {
  AED: "阿联酋迪拉姆", AUD: "澳元", BGN: "保加利亚列弗", BRL: "巴西雷亚尔", CAD: "加元", CHF: "瑞士法郎",
  CNY: "人民币", CZK: "捷克克朗", DKK: "丹麦克朗", EUR: "欧元", GBP: "英镑", HKD: "港币",
  HUF: "匈牙利福林", IDR: "印尼盾", ILS: "以色列新谢克尔", INR: "印度卢比", ISK: "冰岛克朗",
  JPY: "日元", KRW: "韩元", MXN: "墨西哥比索", MYR: "马来西亚林吉特", NOK: "挪威克朗",
  NZD: "新西兰元", PHP: "菲律宾比索", PLN: "波兰兹罗提", RON: "罗马尼亚列伊", SAR: "沙特里亚尔",
  SEK: "瑞典克朗", SGD: "新加坡元", THB: "泰铢", TRY: "土耳其里拉", USD: "美元", ZAR: "南非兰特",
};

const COUNTRY_NAMES: Record<string, string> = {
  CN: "中国",
  GB: "英国",
  US: "美国",
};

function currencyLabel(code: string) {
  return CURRENCY_NAMES[code] ? `${CURRENCY_NAMES[code]}（${code}）` : code;
}

export default function ForeignToolsTab() {
  const [hsInput, setHsInput] = useWorkspaceState("src/features/settings/ForeignToolsTab.tsx:ForeignToolsTab:hsInput", "");
  const [hsOutput, setHsOutput] = useWorkspaceState("src/features/settings/ForeignToolsTab.tsx:ForeignToolsTab:hsOutput", "");
  const [hsBusy, setHsBusy] = useWorkspaceState("src/features/settings/ForeignToolsTab.tsx:ForeignToolsTab:hsBusy", false);
  const [container, setContainer] = useWorkspaceState<keyof typeof CONTAINERS>("src/features/settings/ForeignToolsTab.tsx:ForeignToolsTab:container", "40HQ");
  const [length, setLength] = useWorkspaceState("src/features/settings/ForeignToolsTab.tsx:ForeignToolsTab:length", 50);
  const [width, setWidth] = useWorkspaceState("src/features/settings/ForeignToolsTab.tsx:ForeignToolsTab:width", 40);
  const [height, setHeight] = useWorkspaceState("src/features/settings/ForeignToolsTab.tsx:ForeignToolsTab:height", 35);
  const [weight, setWeight] = useWorkspaceState("src/features/settings/ForeignToolsTab.tsx:ForeignToolsTab:weight", 12);
  const [dashboard, setDashboard] = useWorkspaceState<DashboardData | null>("src/features/settings/ForeignToolsTab.tsx:ForeignToolsTab:dashboard", null);
  const [dashboardBusy, setDashboardBusy] = useWorkspaceState("src/features/settings/ForeignToolsTab.tsx:ForeignToolsTab:dashboardBusy", false);
  const [now, setNow] = useWorkspaceState("src/features/settings/ForeignToolsTab.tsx:ForeignToolsTab:now", () => new Date());
  const [newCity, setNewCity] = useWorkspaceState("src/features/settings/ForeignToolsTab.tsx:ForeignToolsTab:newCity", "北京");
  const [newCurrency, setNewCurrency] = useWorkspaceState("src/features/settings/ForeignToolsTab.tsx:ForeignToolsTab:newCurrency", "AUD");
  const [currencies, setCurrencies] = useWorkspaceState<Array<{ code: string; amount: number }>>("src/features/settings/ForeignToolsTab.tsx:ForeignToolsTab:currencies", () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(CURRENCIES_KEY) || "null");
      if (!Array.isArray(parsed)) return DEFAULT_CURRENCIES;
      const valid = parsed.filter((item) => typeof item?.code === "string" && /^[A-Z]{3}$/.test(item.code) && Number(item.amount) > 0);
      return valid;
    } catch { return DEFAULT_CURRENCIES; }
  });
  const [zones, setZones] = useWorkspaceState<Array<{ city: string; zone: string }>>("src/features/settings/ForeignToolsTab.tsx:ForeignToolsTab:zones", () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(ZONES_KEY) || "null");
      return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_CITIES;
    } catch { return DEFAULT_CITIES; }
  });

  useEffect(() => { localStorage.setItem(ZONES_KEY, JSON.stringify(zones)); }, [zones]);
  useEffect(() => { localStorage.setItem(CURRENCIES_KEY, JSON.stringify(currencies)); }, [currencies]);
  useEffect(() => {
    void refreshDashboard();
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  async function refreshDashboard() {
    setDashboardBusy(true);
    try { setDashboard(await getDashboardData()); }
    catch (error) { useToastStore.getState().addToast({ message: `业务数据刷新失败：${extractErrorMessage(error)}`, type: "error" }); }
    finally { setDashboardBusy(false); }
  }

  async function runHs() {
    if (!hsInput.trim() || hsBusy) return;
    setHsBusy(true);
    try { setHsOutput(await aiPrompt(HS_SYSTEM, `待归类商品：${hsInput.trim()}`)); }
    catch (error) { useToastStore.getState().addToast({ message: `查询失败：${extractErrorMessage(error)}`, type: "error" }); }
    finally { setHsBusy(false); }
  }

  const loading = useMemo(() => {
    const [insideL, insideW, insideH, usable] = CONTAINERS[container];
    const cartonVolume = (length * width * height) / 1_000_000;
    const volume = insideL * insideW * insideH;
    const byVolume = cartonVolume > 0 ? Math.floor((volume * 0.88) / cartonVolume) : 0;
    const byWeight = weight > 0 ? Math.floor((usable * 1000) / weight) : 0;
    return { volume, cartonVolume, byVolume, byWeight, estimated: Math.max(0, Math.min(byVolume, byWeight)) };
  }, [container, length, width, height, weight]);

  async function open(url: string) {
    try { await invoke("open_external_url", { url }); return true; }
    catch (error) {
      useToastStore.getState().addToast({ message: `无法打开查询网站：${extractErrorMessage(error)}`, type: "error" });
      return false;
    }
  }
  const holidays = (dashboard?.holidays ?? []).filter((item) => new Date(`${item.date}T23:59:59`) >= now).slice(0, 8);
  const cnyPerUsd = dashboard?.usdRates?.CNY;
  const availableCurrencies = [...new Set(["USD", "EUR", "GBP", "HKD", "JPY", "AUD", "CAD", "CHF", "CNY", "NZD", "SGD", "KRW", "INR", "THB", "MYR", "IDR", "PHP", "AED", "SAR", "TRY", "MXN", "BRL", "ZAR", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", ...Object.keys(dashboard?.usdRates ?? {})])].sort();

  return (
    <div>
      <h2 style={{ margin: "0 0 5px", fontSize: 18 }}>外贸工具</h2>
      <p style={hint}>工具按场景分类，默认折叠；点击标题展开，需要时再使用。</p>

      <ToolSection icon={<CalendarDays size={16} />} title="世界节假日">
        <div style={toolbar}><button type="button" onClick={() => void refreshDashboard()} style={iconButton} title="刷新节假日数据"><RefreshCw size={14} className={dashboardBusy ? "spinner" : ""} /></button></div>
        <div style={gridCards}>
          {holidays.length ? holidays.map((item) => <div key={`${item.countryCode}-${item.date}-${item.name}`} style={miniCard}><strong>{item.date}</strong> · {COUNTRY_NAMES[item.countryCode] || item.countryCode}<br /><span style={hint}>{item.localName || item.name}</span></div>) : <span style={hint}>暂未获取近期节假日数据。</span>}
        </div>
        <small style={hint}>数据用于工作提醒，具体工作日请以当地官方日历为准。</small>
      </ToolSection>

      <ToolSection icon={<TrendingUp size={16} />} title="参考汇率">
        <div style={toolbar}><button type="button" onClick={() => void refreshDashboard()} style={iconButton} title="刷新汇率数据"><RefreshCw size={14} className={dashboardBusy ? "spinner" : ""} /></button></div>
        <div style={{ display: "grid", gap: 6 }}>
          {currencies.map((item, index) => {
            const usdRate = item.code === "USD" ? 1 : dashboard?.usdRates?.[item.code];
            const rate = cnyPerUsd && usdRate ? (cnyPerUsd / usdRate) * item.amount : null;
            return <div key={`${item.code}-${index}`} style={{ ...row, alignItems: "center" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
                <input type="number" min="0.0001" step="any" value={item.amount} onChange={(event) => setCurrencies((items) => items.map((entry, i) => i === index ? { ...entry, amount: Math.max(0.0001, Number(event.target.value) || 1) } : entry))} style={{ ...input, width: 90 }} aria-label={`${item.code} 换算数量`} />
                <select value={item.code} onChange={(event) => setCurrencies((items) => items.map((entry, i) => i === index ? { ...entry, code: event.target.value } : entry))} style={{ ...input, minWidth: 156, flex: 1 }} aria-label="修改币种">
                  {availableCurrencies.map((code) => <option key={code} value={code}>{currencyLabel(code)}</option>)}
                </select>
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <strong style={{ color: "var(--color-accent)" }}>{rate === null ? "—" : `${rate.toFixed(rate >= 100 ? 2 : 4)} 元`}</strong>
                <button type="button" onClick={() => setCurrencies((items) => items.filter((_, i) => i !== index))} style={removeButton} title="删除这个币种"><X size={12} /></button>
              </span>
            </div>;
          })}
          {currencies.length === 0 && <span style={hint}>还没有常用币种，可从下方添加。</span>}
        </div>
        <div style={{ display: "flex", gap: 7, marginTop: 10 }}>
          <select value={newCurrency} onChange={(event) => setNewCurrency(event.target.value)} style={{ ...input, flex: 1 }}>
            {availableCurrencies.map((code) => <option key={code} value={code}>{currencyLabel(code)}</option>)}
          </select>
          <button type="button" onClick={() => {
            if (currencies.some((item) => item.code === newCurrency)) {
              useToastStore.getState().addToast({ message: `${newCurrency} 已在常用汇率中`, type: "info" });
              return;
            }
            setCurrencies((items) => [...items, { code: newCurrency, amount: newCurrency === "JPY" || newCurrency === "KRW" ? 100 : 1 }]);
          }} style={secondary}><Plus size={13} />添加</button>
        </div>
        <small style={hint}>可直接修改币种和换算数量，也可新增或删除；设置会保存在当前用户配置中。汇率日期：{dashboard?.exchangeDate ?? "暂未获取"}；成交请以银行牌价为准。</small>
      </ToolSection>

      <ToolSection icon={<Clock3 size={16} />} title="多时区">
        <div style={{ display: "grid", gap: 2 }}>
          {zones.map((item) => (
            <div key={item.city} style={row}>
              <span>{item.city}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <strong>{formatZoneTime(now, item.zone)}</strong>
                <button type="button" onClick={() => setZones((items) => items.filter((entry) => entry.city !== item.city))} style={removeButton} title="删除这个城市"><X size={12} /></button>
              </span>
            </div>
          ))}
          {zones.length === 0 && <span style={hint}>还没有城市，从下方下拉选择添加。</span>}
        </div>
        <div style={{ display: "flex", gap: 7, marginTop: 10 }}>
          <select
            value={newCity}
            onChange={(event) => setNewCity(event.target.value)}
            style={{ ...input, flex: 1 }}
            title="选择城市后点击添加"
          >
            {REGION_CITIES.map((group) => (
              <optgroup key={group.region} label={group.region}>
                {group.cities.map(([city, zone]) => (
                  <option key={city} value={city}>{city} · {zone.replace(/_/g, " ")}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              const option = REGION_CITIES.flatMap((group) => group.cities).find(([city]) => city === newCity);
              if (option && !zones.some((item) => item.city === option[0])) {
                setZones((items) => [...items, { city: option[0], zone: option[1] }]);
              } else if (option) {
                useToastStore.getState().addToast({ message: `${option[0]} 已在列表中。`, type: "info" });
              }
            }}
            style={secondary}
          >
            <Plus size={13} />添加
          </button>
        </div>
        <div style={{ marginTop: 6 }}>
          <small style={hint}>共 {REGION_CITIES.reduce((sum, group) => sum + group.cities.length, 0)} 个主要城市，按大洲分组。</small>
        </div>
      </ToolSection>

      <ToolSection icon={<Search size={16} />} title="HS 编码辅助查询">
        <textarea style={{ ...input, minHeight: 74, resize: "vertical" }} value={hsInput} onChange={(event) => setHsInput(event.target.value)} placeholder="尽量写清材料、用途、工作原理、功率、是否成套、附件以及目的国；不要只写商品名称。" />
        <button type="button" disabled={hsBusy} onClick={() => void runHs()} style={primary}>{hsBusy ? "正在分析…" : "按最新 HS 辅助判断"}</button>
        <div style={links}>{[["HS编码网（过滤过期编码）", hsCodeLookupUrl(hsInput)], ["WCO Trade Tools", FOREIGN_TOOL_SOURCES.wco], ["中国海关查询目录", FOREIGN_TOOL_SOURCES.customs]].map(([label, url]) => <LinkButton key={label} label={label} url={url} open={open} />)}</div>
        {hsOutput && <Result text={hsOutput} />}
      </ToolSection>

      <ToolSection icon={<PackageSearch size={16} />} title="物流、集装箱与空运追踪">
        <TrackingTools />
      </ToolSection>

      <ToolSection icon={<Calculator size={16} />} title="装柜数量快速估算">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(108px,1fr))", gap: 8 }}>
          <Field label="柜型"><select style={input} value={container} onChange={(event) => setContainer(event.target.value as keyof typeof CONTAINERS)}>{Object.keys(CONTAINERS).map((key) => <option key={key}>{key}</option>)}</select></Field>
          <Field label="箱长 cm"><input type="number" style={input} value={length} onChange={(event) => setLength(Number(event.target.value))} /></Field>
          <Field label="箱宽 cm"><input type="number" style={input} value={width} onChange={(event) => setWidth(Number(event.target.value))} /></Field>
          <Field label="箱高 cm"><input type="number" style={input} value={height} onChange={(event) => setHeight(Number(event.target.value))} /></Field>
          <Field label="每箱 kg"><input type="number" style={input} value={weight} onChange={(event) => setWeight(Number(event.target.value))} /></Field>
        </div>
        <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: "var(--color-bg-secondary)", fontSize: 13, lineHeight: 1.8 }}>估算可装 <strong style={{ color: "var(--color-accent)", fontSize: 20 }}>{loading.estimated}</strong> 箱<div style={hint}>柜内体积约 {loading.volume.toFixed(1)} m³；单箱 {loading.cartonVolume.toFixed(3)} m³；体积上限约 {loading.byVolume} 箱，重量上限约 {loading.byWeight} 箱。</div><div style={hint}>按 88% 空间利用率粗估，实际还会受摆放方向、托盘、柜门尺寸、限重和重心影响。</div></div>
      </ToolSection>
    </div>
  );
}

function formatZoneTime(now: Date, timeZone: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
}

function ToolSection({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return <details style={card}><summary style={summary}><span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><span style={{ color: "var(--color-accent)" }}>{icon}</span><strong>{title}</strong></span><span style={hint}>展开</span></summary><div style={{ marginTop: 12 }}>{children}</div></details>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label style={{ fontSize: 12 }}><span style={{ display: "block", marginBottom: 4, color: "var(--color-text-secondary)" }}>{label}</span>{children}</label>; }
function LinkButton({ label, url, open }: { label: string; url: string; open: (url: string) => Promise<unknown> }) { return <button type="button" onClick={() => void open(url)} style={secondary}>{label}<ExternalLink size={12} /></button>; }
function Result({ text }: { text: string }) { return <div style={{ marginTop: 12 }}><button type="button" onClick={() => void navigator.clipboard.writeText(text)} style={{ ...secondary, float: "right" }}><Copy size={12} />复制</button><div style={{ clear: "both", padding: 12, borderRadius: 8, background: "var(--color-bg-secondary)" }}><MarkdownView text={text} /></div></div>; }

const card: React.CSSProperties = { border: "1px solid var(--color-border)", borderRadius: 10, padding: 15, marginTop: 14 };
const summary: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, cursor: "pointer", listStyle: "none", fontSize: 14 };
const miniCard: React.CSSProperties = { padding: 9, borderRadius: 7, background: "var(--color-bg-secondary)", fontSize: 12 };
const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--color-border)", fontSize: 12 };
const toolbar: React.CSSProperties = { display: "flex", justifyContent: "flex-end", marginBottom: 8 };
const gridCards: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8 };
const links: React.CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 9 };
const hint: React.CSSProperties = { color: "var(--color-text-secondary)", fontSize: 12, lineHeight: 1.6 };
const input: React.CSSProperties = { width: "100%", boxSizing: "border-box", border: "1px solid var(--color-border)", borderRadius: 7, padding: "8px 9px", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)" };
const primary: React.CSSProperties = { marginTop: 9, border: 0, borderRadius: 7, padding: "8px 14px", background: "var(--color-accent)", color: "#fff", cursor: "pointer" };
const secondary: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "space-between", gap: 6, border: "1px solid var(--color-border)", borderRadius: 7, padding: "7px 9px", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)", cursor: "pointer", fontSize: 12 };
const iconButton: React.CSSProperties = { border: 0, background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", display: "flex" };
const removeButton: React.CSSProperties = { border: 0, background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", display: "inline-flex", padding: 2 };
