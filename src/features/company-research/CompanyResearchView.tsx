import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Building2, ExternalLink, Globe2, Search, ShieldCheck, Trash2, Radar, Plus, RefreshCw } from "lucide-react";
import {
  deleteCompanyResearch,
  listCompanyResearch,
  researchCompany,
  type CompanyResearchReport,
  agentRun,
} from "@/lib/api";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { useToastStore } from "@/stores/toast.store";
import { useUIStore } from "@/stores/ui.store";
import ExternalApiKeyPanel from "@/components/ExternalApiKeyPanel";
import MarkdownView from "@/lib/renderMarkdown";
import { useBackgroundTasksStore } from "@/stores/backgroundTasks.store";

export default function CompanyResearchView() {
  type CompetitorWatch = { id: string; name: string; url: string; focus: string; lastChecked: number; lastSnapshot: string; lastChange: string };
  const researchDraft = useUIStore((s) => s.companyResearchDraft);
  const setResearchDraft = useUIStore((s) => s.setCompanyResearchDraft);
  const [company, setCompany] = useState(() => researchDraft?.company ?? "");
  const [website, setWebsite] = useState(() => researchDraft?.website ?? "");
  const [country, setCountry] = useState(() => researchDraft?.country ?? "");
  const [reports, setReports] = useState<CompanyResearchReport[]>([]);
  const [selected, setSelected] = useState<CompanyResearchReport | null>(null);
  const [watchName, setWatchName] = useState("");
  const [watchUrl, setWatchUrl] = useState("");
  const [watchFocus, setWatchFocus] = useState("产品、价格、认证、渠道和市场定位变化");
  const [watches, setWatches] = useState<CompetitorWatch[]>(() => { try { return JSON.parse(localStorage.getItem("yaoaimail-competitor-watches-v1") || "[]") as CompetitorWatch[]; } catch { return []; } });
  const [checkingWatchId, setCheckingWatchId] = useState<string | null>(null);
  const researchTask = useBackgroundTasksStore((state) => state.tasks.companyResearch);
  const startTask = useBackgroundTasksStore((state) => state.start);
  const clearTask = useBackgroundTasksStore((state) => state.clear);
  const busy = researchTask?.status === "running";

  // 输入变更 → 同步到 store，切页回来保留
  useEffect(() => {
    setResearchDraft({ company, website, country });
  }, [company, website, country, setResearchDraft]);


  useEffect(() => {
    void listCompanyResearch().then((items) => {
      setReports(items);
      setSelected(items[0] ?? null);
    }).catch(() => {});
  }, []);

  // Apply the background task's finished report (works both while the view is
  // open and after the user navigates back).
  useEffect(() => {
    if (researchTask?.status !== "success" || !researchTask.result) return;
    const report = researchTask.result as CompanyResearchReport;
    setSelected(report);
    setReports((old) => [report, ...old.filter((item) => item.id !== report.id)]);
    clearTask("companyResearch");
  }, [researchTask, clearTask]);

  async function run() {
    if (!company.trim() && !website.trim()) return;
    startTask("companyResearch", "客户背景调研", () =>
      researchCompany(company, website, country),
    );
  }

  async function removeReport(id: string) {
    try {
      const next = await deleteCompanyResearch(id);
      setReports(next);
      setSelected((current) => (current?.id === id ? (next[0] ?? null) : current));
      useToastStore.getState().addToast({ message: "调研记录已删除。", type: "success" });
    } catch (error) {
      useToastStore.getState().addToast({ message: `删除失败：${extractErrorMessage(error)}`, type: "error" });
    }
  }

  const open = (url: string) => invoke("open_external_url", { url });

  useEffect(() => { localStorage.setItem("yaoaimail-competitor-watches-v1", JSON.stringify(watches)); }, [watches]);

  function addWatch() {
    if (!watchName.trim() || !watchUrl.trim()) return;
    setWatches((old) => [{ id: crypto.randomUUID(), name: watchName.trim(), url: watchUrl.trim(), focus: watchFocus.trim(), lastChecked: 0, lastSnapshot: "", lastChange: "尚未检查" }, ...old]);
    setWatchName(""); setWatchUrl("");
  }

  async function checkWatch(watch: CompetitorWatch) {
    setCheckingWatchId(watch.id);
    try {
      const result = await agentRun(
        "你是外贸竞品公开信息监控助手。访问指定公开网站，提取与监控重点有关的最新事实。将本次事实与上次快照比较；没有证据时写未知，禁止猜测。输出两部分：本次快照、变化摘要，并附来源网址。",
        `竞品：${watch.name}\n公开网址：${watch.url}\n监控重点：${watch.focus}\n上次快照：${watch.lastSnapshot || "首次检查，无历史快照"}`,
      );
      const text = result.content.trim();
      setWatches((old) => old.map((item) => item.id === watch.id ? { ...item, lastChecked: Date.now(), lastSnapshot: text.slice(0, 6000), lastChange: text.slice(0, 500) } : item));
    } catch (error) { useToastStore.getState().addToast({ message: `竞品检查失败：${extractErrorMessage(error)}`, type: "error" }); }
    finally { setCheckingWatchId(null); }
  }

  return (
    <div style={{ height: "100%", display: "grid", gridTemplateColumns: "260px minmax(0,1fr)", overflow: "hidden" }}>
      <aside style={{ borderRight: "1px solid var(--color-border)", padding: 14, overflow: "auto" }}>
        <h2 style={{ margin: "0 0 6px", fontSize: 16 }}>调研记录</h2>
        <p style={hint}>报告保存在本地用户数据目录。</p>
        {reports.map((report) => (
          <div key={report.id} style={{
            display: "flex", alignItems: "center", gap: 6, marginBottom: 7,
            border: "1px solid var(--color-border)",
            background: selected?.id === report.id ? "var(--color-sidebar-active)" : "transparent",
            borderRadius: 7, padding: "4px 6px",
          }}>
            <button type="button" onClick={() => setSelected(report)} style={{
              flex: 1, minWidth: 0, textAlign: "left", border: 0, background: "transparent",
              color: "var(--color-text-primary)", padding: 5, cursor: "pointer",
            }}>
              <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {report.companyName || report.website}
              </strong>
              <div style={hint}>{report.country || "国家未知"} · {new Date(report.createdAt * 1000).toLocaleDateString()}</div>
            </button>
            <button
              type="button"
              onClick={() => void removeReport(report.id)}
              title="删除记录"
              aria-label="删除记录"
              style={{ border: 0, background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", padding: 5, display: "flex" }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </aside>
      <main className="scroll-region" style={{ overflow: "auto", padding: "22px 26px" }}>
        <div style={{ maxWidth: 980, margin: "0 auto" }}>
          <h1 style={{ margin: 0, fontSize: 22 }}>AI 客户背景调研</h1>
          <p style={{ ...hint, margin: "6px 0 16px" }}>
            同时核验官网多页面、GLEIF 法人身份、经营能力、贸易与供应链、负面新闻、诉讼/破产/制裁线索和公开联系方式。AI 只综合带来源的证据，不把“没有搜到”误判为“没有风险”。
          </p>
          <ExternalApiKeyPanel />
          <section style={card}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 180px", gap: 9 }}>
              <input style={input} value={company} onChange={(event) => setCompany(event.target.value)} placeholder="公司名称，如 Acme Trading Ltd" />
              <input style={input} value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="官网或邮箱域名，如 acme.com" />
              <input style={input} value={country} onChange={(event) => setCountry(event.target.value)} placeholder="国家/地区（可选）" />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 9, flexWrap: "wrap" }}>
              <button type="button" disabled={busy} onClick={() => void run()} style={primary}>
                {busy ? <RefreshCw size={15} className="spinner" /> : <Search size={15} />}{busy ? "正在进行多源调查…" : "开始 AI 多源资信调研"}
              </button>
            </div>
          </section>
          <section style={card}>
            <Title icon={<Radar size={16} />} text="竞品变化监控" />
            <p style={hint}>保存公开网站和关注重点。软件显示到期状态；点击检查后对比上次快照，不会在后台消耗 API 额度。</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr 1.4fr auto", gap: 7 }}><input style={input} value={watchName} onChange={(e) => setWatchName(e.target.value)} placeholder="竞品名称" /><input style={input} value={watchUrl} onChange={(e) => setWatchUrl(e.target.value)} placeholder="公开官网网址" /><input style={input} value={watchFocus} onChange={(e) => setWatchFocus(e.target.value)} placeholder="监控重点" /><button type="button" onClick={addWatch} style={primary}><Plus size={14} />添加</button></div>
            <div style={{ display: "grid", gap: 7, marginTop: 9 }}>{watches.map((watch) => <div key={watch.id} style={{ padding: 8, border: "1px solid var(--color-border)", borderRadius: 7, fontSize: 12 }}><div style={{ display: "flex", alignItems: "center", gap: 7 }}><strong style={{ flex: 1 }}>{watch.name}</strong><span style={{ color: !watch.lastChecked || Date.now() - watch.lastChecked > 7 * 86_400_000 ? "#b42318" : "#2f855a" }}>{!watch.lastChecked ? "未检查" : Date.now() - watch.lastChecked > 7 * 86_400_000 ? "已到期" : "本周已检查"}</span><button type="button" disabled={checkingWatchId === watch.id} onClick={() => void checkWatch(watch)} style={primary}>{checkingWatchId === watch.id ? <RefreshCw size={12} className="spinner" /> : <Radar size={12} />}{checkingWatchId === watch.id ? "检查中…" : "立即检查"}</button><button type="button" onClick={() => setWatches((old) => old.filter((item) => item.id !== watch.id))} style={{ border: 0, background: "transparent", color: "#b42318", cursor: "pointer" }}><Trash2 size={13} /></button></div>{watch.lastChange && <div style={{ marginTop: 5, color: "var(--color-text-secondary)", whiteSpace: "pre-wrap", maxHeight: 100, overflow: "auto" }}>{watch.lastChange}</div>}</div>)}</div>
          </section>
          {selected && <Report report={selected} open={open} />}
        </div>
      </main>
    </div>
  );
}

function Report({ report, open }: { report: CompanyResearchReport; open: (url: string) => Promise<unknown> }) {
  return (
    <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
      <GateSummary report={report} />
      {report.analysis && (
        <section style={card}>
          <Title icon={<Search size={16} />} text="六道闸门综合分析" />
          <div style={{ padding: "10px 12px", borderRadius: 8, background: "var(--color-bg-secondary)" }}>
            <MarkdownView text={report.analysis} />
          </div>
        </section>
      )}
      {!report.analysis && (
        <section style={card}>
          <Title icon={<Search size={16} />} text="六道闸门综合分析" />
          <p style={hint}>本次未生成 AI 分析（未配置 AI 模型或调用失败）。请在设置 → AI 模型 中配置后重新调研；公开信息部分不受影响。</p>
        </section>
      )}
      <section style={card}>
        <Title icon={<Globe2 size={16} />} text="官网公开信息" />
        <strong>{report.websiteTitle || report.companyName || "未识别到网站标题"}</strong>
        <p style={{ fontSize: 13, lineHeight: 1.7 }}>{report.websiteDescription || "官网未提供可读取的描述，或网站阻止自动访问。"}</p>
        <div style={hint}>公开邮箱：{report.publicEmails.length ? report.publicEmails.join("、") : "未在首页发现"}</div>
      </section>
      <section style={card}>
        <Title icon={<Building2 size={16} />} text="法人身份匹配（GLEIF）" />
        {report.legalMatches.length ? report.legalMatches.map((item) => (
          <div key={item.lei} style={{ padding: "9px 0", borderBottom: "1px solid var(--color-border)", fontSize: 13 }}>
            <strong>{item.legalName}</strong>
            <div style={hint}>{item.country} {item.city} · 状态 {item.registrationStatus || "未知"} · LEI {item.lei}</div>
            <div style={hint}>{item.address}</div>
          </div>
        )) : <p style={hint}>未发现LEI匹配。很多中小企业没有LEI，这不等于公司不存在。</p>}
      </section>
      <section style={card}>
        <Title icon={<ShieldCheck size={16} />} text="证据与风险核验入口" />
        {report.sources.map((source) => (
          <button key={source.url} type="button" onClick={() => void open(source.url)} style={sourceButton}>
            <span>{source.title}<small style={{ ...hint, display: "block" }}>状态：{source.status}</small></span>
            <ExternalLink size={14} />
          </button>
        ))}
        {report.warnings.map((warning) => <div key={warning} style={{ ...hint, color: "#b7791f", marginTop: 6 }}>{warning}</div>)}
      </section>
    </div>
  );
}

function GateSummary({ report }: { report: CompanyResearchReport }) {
  const hasWebsite = Boolean(report.websiteTitle || report.websiteDescription || report.sources.some((source) => source.title.includes("官网页面")));
  const hasLegal = report.legalMatches.length > 0;
  const hasSearch = report.sources.some((source) => ["Tavily 搜索源", "Brave 搜索源", "Firecrawl 搜索与网页正文"].includes(source.title) && source.status === "checked");
  const gates: Array<[string, string, boolean, string]> = [
    ["主体身份", hasLegal ? "已找到 GLEIF 法人匹配" : "未找到 LEI 法人匹配", hasLegal, hasLegal ? "继续核对名称与地址" : "从当地企业登记处补查"],
    ["官网与经营痕迹", hasWebsite ? "官网或公司页面可读取" : "官网证据不足", hasWebsite, hasWebsite ? "核对产品、团队和地址" : "确认真实官网域名"],
    ["实时消息面", hasSearch ? "已执行经营、贸易和负面风险搜索" : "没有实时搜索证据", hasSearch, hasSearch ? "查看报告中的正负面证据" : "配置 Tavily / Brave / Firecrawl"],
    ["公开联系方式", report.publicEmails.length > 0 ? `发现 ${report.publicEmails.length} 个企业邮箱` : "未发现公开企业邮箱", report.publicEmails.length > 0, report.publicEmails.length > 0 ? "核对来源和验证状态" : "继续检查联系/团队页面"],
    ["AI 风险综合", report.analysis ? "已生成带来源的风险报告" : "尚未生成 AI 综合结论", Boolean(report.analysis), report.analysis ? "人工复核关键结论" : "检查 AI 模型配置"],
    ["交易决策", hasWebsite || hasLegal || hasSearch ? "具备初步调查证据" : "证据严重不足", hasWebsite || hasLegal || hasSearch, "按报告建议设置付款和验真条件"],
  ];
  return (
    <section style={card}>
      <Title icon={<ShieldCheck size={16} />} text="资信调查证据覆盖" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 8 }}>
        {gates.map(([name, detail, ready, next]) => (
          <div key={name} style={{ border: "1px solid var(--color-border)", borderRadius: 8, padding: "9px 10px", background: "var(--color-bg-secondary)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: 12, fontWeight: 700 }}>
              <span>{name}</span><span style={{ color: ready ? "#2f855a" : "#b7791f" }}>{ready ? "有证据" : "待核验"}</span>
            </div>
            <div style={{ ...hint, marginTop: 5 }}>{detail}</div>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{next}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Title({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <h3 style={{ margin: "0 0 10px", fontSize: 14, display: "flex", gap: 7, alignItems: "center" }}>{icon}{text}</h3>;
}

const card: React.CSSProperties = { border: "1px solid var(--color-border)", borderRadius: 10, padding: 15, background: "var(--color-bg-primary)" };
const hint: React.CSSProperties = { margin: "4px 0", color: "var(--color-text-secondary)", fontSize: 12, lineHeight: 1.6 };
const input: React.CSSProperties = { width: "100%", boxSizing: "border-box", border: "1px solid var(--color-border)", borderRadius: 7, padding: "9px 10px", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)" };
const primary: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, marginTop: 10, border: 0, borderRadius: 7, padding: "9px 15px", background: "var(--color-accent)", color: "#fff", cursor: "pointer" };
const sourceButton: React.CSSProperties = { width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", textAlign: "left", padding: "9px 10px", marginBottom: 6, border: "1px solid var(--color-border)", borderRadius: 7, background: "var(--color-bg-secondary)", color: "var(--color-text-primary)", cursor: "pointer" };
