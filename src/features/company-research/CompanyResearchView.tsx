import { useWorkspaceState, useWorkspaceInitEffect, useWorkspaceIsTransferring } from '@/lib/workspaceState';
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Building2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileSearch,
  Globe2,
  Landmark,
  Loader2,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  deleteCompanyResearch,
  listCompanyResearch,
  researchCompany,
  type CompanyDossier,
  type CompanyFinding,
  type CompanyProfileField,
  type CompanyRegistryCheck,
  type CompanyResearchReport,
  type ResearchSource,
} from "@/lib/api";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { useToastStore } from "@/stores/toast.store";
import { useUIStore } from "@/stores/ui.store";
import ExternalApiKeyPanel from "@/components/ExternalApiKeyPanel";
import MarkdownView from "@/lib/renderMarkdown";
import { useBackgroundTasksStore } from "@/stores/backgroundTasks.store";
import { EmailVerificationScope,EmailVerificationSelect,MailboxCheckInfo,useMailboxPresentation } from '@/components/EmailVerificationPanel';

type Opener = (url: string) => Promise<unknown>;

const EMPTY_DOSSIER: CompanyDossier = {
  profile: [],
  findings: [],
  risks: [],
  gaps: [],
  summary: "",
  riskLevel: "unknown",
  dropped: 0,
};

const RISK_LEVELS: Record<string, { label: string; color: string }> = {
  high: { label: "高风险", color: "#c53030" },
  medium: { label: "中等风险", color: "#b7791f" },
  low: { label: "低风险", color: "#2f855a" },
  unknown: { label: "证据不足", color: "var(--color-text-secondary)" },
};

const SEVERITIES: Record<string, { label: string; color: string }> = {
  high: { label: "严重", color: "#c53030" },
  medium: { label: "需留意", color: "#b7791f" },
  low: { label: "轻微", color: "#2f855a" },
};

const REGISTRY_STATUS: Record<string, { label: string; color: string }> = {
  checked: { label: "已核验", color: "#2f855a" },
  no_match: { label: "未查到记录", color: "#b7791f" },
  skipped: { label: "已跳过", color: "var(--color-text-secondary)" },
  failed: { label: "查询失败", color: "#c53030" },
  error: { label: "查询失败", color: "#c53030" },
  candidate: { label: "主体待确认", color: "#b7791f" },
  screened: { label: "名称初筛完成，非合规放行", color: "var(--color-text-secondary)" },
  not_configured: { label: "未配置", color: "var(--color-text-secondary)" },
};

export default function CompanyResearchView() {
  const transferring = useWorkspaceIsTransferring();
  const researchDraft = useUIStore((s) => s.companyResearchDraft);
  const setResearchDraft = useUIStore((s) => s.setCompanyResearchDraft);
  const [company, setCompany] = useWorkspaceState("src/features/company-research/CompanyResearchView.tsx:CompanyResearchView:company", () => researchDraft?.company ?? "");
  const [website, setWebsite] = useWorkspaceState("src/features/company-research/CompanyResearchView.tsx:CompanyResearchView:website", () => researchDraft?.website ?? "");
  const [country, setCountry] = useWorkspaceState("src/features/company-research/CompanyResearchView.tsx:CompanyResearchView:country", () => researchDraft?.country ?? "");
  const [vat, setVat] = useWorkspaceState("src/features/company-research/CompanyResearchView.tsx:CompanyResearchView:vat", () => researchDraft?.vat ?? "");
  const [reports, setReports] = useWorkspaceState<CompanyResearchReport[]>("src/features/company-research/CompanyResearchView.tsx:CompanyResearchView:reports", []);
  const [selected, setSelected] = useWorkspaceState<CompanyResearchReport | null>("src/features/company-research/CompanyResearchView.tsx:CompanyResearchView:selected", null);
  const [progress, setProgress] = useWorkspaceState("src/features/company-research/CompanyResearchView.tsx:CompanyResearchView:progress", "正在开始调查");
  const researchTask = useBackgroundTasksStore((state) => state.tasks.companyResearch);
  const startTask = useBackgroundTasksStore((state) => state.start);
  const clearTask = useBackgroundTasksStore((state) => state.clear);
  const busy = researchTask?.status === "running";

  // 输入变更 → 同步到 store，切页回来保留
  useEffect(() => {
    setResearchDraft({ company, website, country, vat });
  }, [company, website, country, vat, setResearchDraft]);

  useWorkspaceInitEffect('src/features/company-research/CompanyResearchView.tsx:', () => {
    void listCompanyResearch()
      .then((items) => {
        setReports(items);
        setSelected(items[0] ?? null);
      })
      .catch(() => {});
  }, []);

  // Apply the background task's finished report (works both while the view is
  // open and after the user navigates back).
  useEffect(() => {
    if (transferring || researchTask?.status !== "success" || !researchTask.result) return;
    const report = researchTask.result as CompanyResearchReport;
    setSelected(report);
    setReports((old) => [report, ...old.filter((item) => item.id !== report.id)]);
    clearTask("companyResearch");
  }, [transferring, researchTask, clearTask]);

  function run() {
    if (!company.trim() && !website.trim()) {
      useToastStore.getState().addToast({ message: "先填公司名称或官网地址。", type: "error" });
      return;
    }
    setProgress("正在确认公司主体");
    startTask("companyResearch", "客户资信调查", () =>
      researchCompany(company, website, country, vat, stage=>{
        setProgress(stage);
        useBackgroundTasksStore.setState(state=>{
          const task=state.tasks.companyResearch;
          return task?.status==='running'?{tasks:{...state.tasks,companyResearch:{...task,progress:stage}}}:state;
        });
      }),
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

  const open: Opener = (url) => invoke("open_external_url", { url });

  return (
    <div style={{ height: "100%", display: "grid", gridTemplateColumns: "260px minmax(0,1fr)", overflow: "hidden" }}>
      <aside style={{ borderRight: "1px solid var(--color-border)", padding: 14, overflow: "auto" }}>
        <h2 style={{ margin: "0 0 6px", fontSize: 16 }}>调研记录</h2>
        <p style={hint}>报告保存在本地用户数据目录。</p>
        {reports.map((report) => (
          <div
            key={report.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 7,
              border: "1px solid var(--color-border)",
              background: selected?.id === report.id ? "var(--color-sidebar-active)" : "transparent",
              borderRadius: 7,
              padding: "4px 6px",
            }}
          >
            <button
              type="button"
              onClick={() => setSelected(report)}
              style={{
                flex: 1,
                minWidth: 0,
                textAlign: "left",
                border: 0,
                background: "transparent",
                color: "var(--color-text-primary)",
                padding: 5,
                cursor: "pointer",
              }}
            >
              <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {report.companyName || report.website}
              </strong>
              <div style={hint}>
                {[report.country, new Date(report.createdAt * 1000).toLocaleString()].filter(Boolean).join(' · ')}
              </div>
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
          <h1 style={{ margin: 0, fontSize: 22 }}>客户资信调查</h1>
          <p style={{ ...hint, margin: "6px 0 16px" }}>
            填公司名称或官网即可调查公司背景、经营能力和交易风险。报告附来源，区分公开披露、未读原文的检索线索与分析判断；增值税号有就填。
          </p>
          <ExternalApiKeyPanel />
          <section style={card}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 9 }}>
              <input style={input} value={company} onChange={(event) => setCompany(event.target.value)} placeholder="公司名称，如 Acme Trading Ltd" />
              <input style={input} value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="官网或邮箱域名，如 acme.com" />
              <input style={input} value={country} onChange={(event) => setCountry(event.target.value)} placeholder="国家/地区，如 Germany" />
              <input style={input} value={vat} onChange={(event) => setVat(event.target.value)} placeholder="增值税号，如 DE123456789（可选）" title="填写公司的增值税号，供调查时核对登记信息。没有税号也可以开始调查。" />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 9, flexWrap: "wrap" }}>
              <button type="button" disabled={busy} onClick={run} style={{ ...primary, opacity: busy ? 0.7 : 1 }}>
                {busy ? <Loader2 size={15} className="app-spin" /> : <Search size={15} />}
                {busy ? `${researchTask?.progress || progress}…` : "开始调查"}
              </button>
            </div>
          </section>
          {selected && <Report report={selected} open={open} />}
          {selected && <PreviousResearch selected={selected} reports={reports} />}
        </div>
      </main>
    </div>
  );
}

function Report({ report, open }: { report: CompanyResearchReport; open: Opener }) {
  const structured = (report.structureVersion ?? 0) >= 2;
  return structured ? <StructuredReport report={report} open={open} /> : <LegacyReport report={report} open={open} />;
}

function StructuredReport({ report, open }: { report: CompanyResearchReport; open: Opener }) {
  const narrativeFirst = (report.structureVersion ?? 0) >= 4;
  const dossier = report.dossier ?? EMPTY_DOSSIER;
  const risks = dossier.risks;
  const registries = report.registries ?? [];
  const registryLinks = report.registryLinks ?? [];
  const nothing =
    !report.analysis && dossier.profile.length === 0 &&
    dossier.findings.length === 0 &&
    risks.length === 0 &&
    report.publicEmails.length === 0 &&
    !report.websiteDescription &&
    registries.every((item) => item.status !== "checked");

  return (
    <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
      <section style={card}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between" }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 18, wordBreak: "break-word" }}>
              {report.companyName || report.website || "未命名公司"}
            </h2>
            <div style={{ ...hint, marginTop: 4 }}>
              {[
                report.country || (narrativeFirst ? "" : "国家未知"),
                report.website || "未提供官网",
                report.pagesRead ? `读过 ${report.pagesRead} 页资料` : "",
                new Date(report.createdAt * 1000).toLocaleString(),
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
          {!narrativeFirst && <RiskBadge level={dossier.riskLevel} />}
        </div>
        {dossier.summary && <p style={{ margin: "10px 0 0", fontSize: 13.5, lineHeight: 1.75 }}>{dossier.summary}</p>}
      </section>

      {(report.structureVersion??0)>=5 && report.investigation && <section style={{...card,padding:'10px 14px'}} aria-label="调查资料覆盖">
        <div style={{fontSize:12,color:'var(--color-text-secondary)'}}>已读官网 {report.investigation.officialPages} 页 · 外部正文 {report.investigation.externalPages} 页 · 外部站点 {report.investigation.externalSites} 个</div>
        <details style={{marginTop:6}}>
          <summary style={{fontSize:12,cursor:'pointer'}}>查看取证范围</summary>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(190px,1fr))',gap:6,marginTop:8}}>
            {report.investigation.areas.map(area=><div key={area.key} style={hint}><strong>{area.label}</strong>：{area.status==='materials_read'?`已读 ${area.documents} 份材料`:area.status==='screened'?'已完成限定范围的名称初筛':area.status==='candidate'?'存在待核对名称候选':area.status==='searched_no_readable_evidence'?'已检索，未取得可读原文':area.status==='error'||area.status==='failed'?'本轮查询未完成':'本轮未完成此项'}</div>)}
          </div>
          <p style={{...hint,marginBottom:0}}>站点数不代表独立所有权；已读材料不等于事实全部核实。未取得资料不代表没有风险。</p>
        </details>
      </section>}

      {report.analysis && <section style={card} aria-label="完整调查报告" onClick={(event)=>{
        const anchor=(event.target as Element).closest('a');const href=anchor?.getAttribute('href');
        if(href && /^https?:\/\//i.test(href)){event.preventDefault();void open(href);}
      }}>
        <Title icon={<FileSearch size={16} />} text="综合资信调查" />
        <MarkdownView text={report.analysis} style={{fontSize:14,lineHeight:1.85,overflowWrap:'anywhere'}} />
      </section>}
      {narrativeFirst && !report.analysis && <section style={card}>
        <p style={hint}>本次完整分析未生成，原因见下方调查提示。已取得的公开信息仍保留，历史报告不会被覆盖。</p>
      </section>}

      {nothing && (
        <section style={card}>
          <p style={{ ...hint, margin: 0 }}>
            这次没有拿到可核实的资料，不代表对方有问题，只代表网上能找到的依据不足。下面的待核实清单和官方登记入口可以直接补查。
          </p>
        </section>
      )}

      {dossier.profile.length > 0 && (narrativeFirst ? <details style={card}><summary>登记信息依据</summary><ProfileCard fields={dossier.profile} open={open} /></details> : <ProfileCard fields={dossier.profile} open={open} />)}
      {(report.publicEmails.length > 0 || report.websiteDescription) && <section style={card} aria-label="官网公开信息">
        <Title icon={<Globe2 size={16} />} text="官网公开信息" />
        {report.websiteDescription && <p style={{fontSize:13,lineHeight:1.7,margin:'6px 0'}}>{report.websiteDescription}</p>}
        {report.publicEmails.length > 0 && <EmailVerificationScope emails={report.publicEmails}>{report.publicEmails.map(email=><ReportMailbox key={email} email={email}/>)}</EmailVerificationScope>}
        {report.publicEmails.length > 0 && <p style={hint}>官网公开的联系地址，未验证可投递性或采购岗位。</p>}
        {report.website && <button type="button" onClick={()=>void open(report.website)} style={linkButton}>打开官网来源</button>}
      </section>}
      {risks.length > 0 && <RiskList risks={risks} open={open} />}
      {!!report.contacts?.length && <section style={card} aria-label="公开联系人证据">
        <h3 style={{marginTop:0}}>公开联系人</h3>
        <p style={hint}>公开姓名与职位不等于当前任职或采购权限。历史人物不能作为现任联系人。</p>
        {report.contacts.map((person,index)=><div key={`${person.name}-${index}`} style={{fontSize:13,marginBottom:8}}>
          <strong>{person.name}</strong> · {person.role} · {person.currentStatus==='historical'?'历史人物，非现任联系依据':'任职与权限待确认'}
          <button type="button" style={linkButton} onClick={()=>void open(person.sourceUrl)}>人物来源</button>
          <details><summary>查看原文{person.sourceDate?`（${person.sourceDate}）`:''}</summary><p>{person.quote}</p></details>
        </div>)}
      </section>}
      {!!report.buyingSignals?.length && <details style={card}><summary>经营与贸易信号（不代表当前采购意向或信用评级）</summary>
        {report.buyingSignals.map((signal,index)=><p key={index} style={{fontSize:13}}>{signal.summary} <button type="button" style={linkButton} onClick={()=>void open(signal.sourceUrl)}>查看来源</button></p>)}
      </details>}
      {dossier.findings.length > 0 && <FindingList findings={dossier.findings} open={open} />}
      {registries.length > 0 && (narrativeFirst ? <details style={card}><summary style={{cursor:'pointer'}}>官方登记查询详情</summary><RegistryList registries={registries} open={open} /></details> : <RegistryList registries={registries} open={open} />)}
      {!narrativeFirst && <GapList gaps={dossier.gaps} dropped={dossier.dropped} links={registryLinks} open={open} />}
      {narrativeFirst && registryLinks.length > 0 && <details style={card}><summary style={{cursor:'pointer'}}>官方登记补查入口</summary><GapList gaps={[]} dropped={0} links={registryLinks} open={open} /></details>}
      {report.warnings.length > 0 && <Warnings items={report.warnings} />}
      <Sources items={report.sources} open={open} />
    </div>
  );
}

function ReportMailbox({email}:{email:string}){
  const {presentation}=useMailboxPresentation(email,[]);
  return <div style={{fontSize:12,padding:'6px 0',borderBottom:'1px solid var(--color-border)'}}>
    <label style={{display:'inline-flex',gap:6,alignItems:'center'}}><EmailVerificationSelect email={email}/><strong>{email}</strong></label>
    <span style={{marginLeft:10}}>{presentation.deliveryLabel}</span><MailboxCheckInfo email={email}/>
  </div>;
}

function PreviousResearch({selected,reports}:{selected:CompanyResearchReport;reports:CompanyResearchReport[]}){
  const host=(url:string)=>{try{return new URL(url).hostname.replace(/^www\./,'').toLowerCase();}catch{return '';}};
  const currentHost=host(selected.website);
  const previous=reports.filter(r=>r.id!==selected.id && r.createdAt<selected.createdAt && currentHost && host(r.website)===currentHost).sort((a,b)=>b.createdAt-a.createdAt)[0];
  if(!previous)return null;
  const oldUrls=new Set(previous.sources.map(s=>s.url));
  const added=selected.sources.filter(s=>s.status==='checked' && !oldUrls.has(s.url));
  return <details style={{...card,marginTop:12}} aria-label="与历史调查对比">
    <summary style={{cursor:'pointer',fontSize:13}}>与上一份调查对比</summary>
    <p style={hint}>上次：{new Date(previous.createdAt*1000).toLocaleString()} · 本次新增已读资料入口 {added.length} 个</p>
    {(previous.structureVersion??0)>=5 && (selected.structureVersion??0)>=5 && previous.investigation && selected.investigation && <p style={hint}>外部正文：{previous.investigation.externalPages} → {selected.investigation.externalPages} 页；外部站点：{previous.investigation.externalSites} → {selected.investigation.externalSites} 个。</p>}
    <p style={hint}>这里只比较取证覆盖，不将新找到的旧资料当作公司新发生的事件。历史报告仍保留在左侧。</p>
  </details>;
}

function RiskBadge({ level }: { level: string }) {
  const meta = RISK_LEVELS[level] ?? RISK_LEVELS.unknown;
  return (
    <span
      style={{
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        border: `1px solid ${meta.color}`,
        color: meta.color,
        borderRadius: 999,
        padding: "4px 11px",
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      <ShieldCheck size={13} />
      {meta.label}
    </span>
  );
}

function ProfileCard({ fields, open }: { fields: CompanyProfileField[]; open: Opener }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <section style={card}>
      <Title icon={<Building2 size={16} />} text="客户档案" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(255px, 1fr))", gap: 8 }}>
        {fields.map((field, index) => {
          const key = `${field.key}-${index}`;
          const isOpen = Boolean(expanded[key]);
          const hasEvidence = Boolean(field.quote || field.url);
          return (
            <div key={key} style={{ border: "1px solid var(--color-border)", borderRadius: 8, padding: "8px 10px", background: "var(--color-bg-secondary)" }}>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{field.label || field.key}</div>
              {field.level==='reported' && <div style={{fontSize:10,color:'var(--color-text-secondary)'}}>第三方披露，待交叉核验</div>}
              {field.level==='published' && <div style={{fontSize:10,color:'var(--color-text-secondary)'}}>官网披露</div>}
              <div style={{ fontSize: 13, lineHeight: 1.65, wordBreak: "break-word" }}>{field.value}</div>
              {hasEvidence && (
                <button
                  type="button"
                  onClick={() => setExpanded((old) => ({ ...old, [key]: !isOpen }))}
                  style={linkButton}
                >
                  {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  依据原文
                </button>
              )}
              {isOpen && field.quote && <blockquote style={quote}>{field.quote}</blockquote>}
              {isOpen && field.url && (
                <button type="button" onClick={() => void open(field.url)} style={linkButton}>
                  <ExternalLink size={12} />
                  打开来源
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function RiskList({ risks, open }: { risks: CompanyFinding[]; open: Opener }) {
  return (
    <section style={card}>
      <Title icon={<ShieldAlert size={16} />} text={`风险与关注点（${risks.length}）`} />
      <div style={{ display: "grid", gap: 10 }}>
        {risks.map((risk, index) => {
          const meta = SEVERITIES[risk.severity ?? ""] ?? { label: "待定", color: "var(--color-text-secondary)" };
          return (
            <div key={index} style={{ borderLeft: `3px solid ${meta.color}`, paddingLeft: 10 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: meta.color, flexShrink: 0 }}>{meta.label}</span>
                <span style={{ fontSize: 13.5, lineHeight: 1.7 }}>{risk.text}</span>
              </div>
              {risk.quote && <blockquote style={quote}>{risk.quote}</blockquote>}
              {risk.url && (
                <button type="button" onClick={() => void open(risk.url)} style={linkButton}>
                  <ExternalLink size={12} />
                  查看来源
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FindingList({ findings, open }: { findings: CompanyFinding[]; open: Opener }) {
  return (
    <section style={card}>
      <Title icon={<FileSearch size={16} />} text={`查到的关键事实（${findings.length}）`} />
      <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
        {findings.map((finding, index) => (
          <li key={index} style={{ fontSize: 13, lineHeight: 1.7 }}>
            {finding.text}
            {finding.url && (
              <button type="button" onClick={() => void open(finding.url)} style={{ ...linkButton, marginLeft: 6 }}>
                <ExternalLink size={12} />
                来源
              </button>
            )}
            {finding.quote && <blockquote style={quote}>{finding.quote}</blockquote>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RegistryList({ registries, open }: { registries: CompanyRegistryCheck[]; open: Opener }) {
  return (
    <section style={card}>
      <Title icon={<Landmark size={16} />} text="官方登记核验" />
      <div style={{ display: "grid", gap: 8 }}>
        {registries.map((item, index) => {
          const meta = REGISTRY_STATUS[item.status] ?? { label: item.status, color: "var(--color-text-secondary)" };
          return (
            <div key={`${item.name}-${index}`} style={{ border: "1px solid var(--color-border)", borderRadius: 8, padding: "9px 10px", background: "var(--color-bg-secondary)" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", justifyContent: "space-between" }}>
                <strong style={{ fontSize: 13 }}>{item.name}</strong>
                <span style={{ fontSize: 11, fontWeight: 700, color: meta.color, flexShrink: 0 }}>{meta.label}</span>
              </div>
              <div style={{ ...hint, marginTop: 4 }}>{item.summary}</div>
              {item.items.length > 0 && (
                <ul style={{ margin: "6px 0 0", paddingLeft: 16, fontSize: 12, lineHeight: 1.7, color: "var(--color-text-secondary)" }}>
                  {item.items.map((detail, detailIndex) => (
                    <li key={detailIndex}>{detail}</li>
                  ))}
                </ul>
              )}
              {item.url && (
                <button type="button" onClick={() => void open(item.url)} style={linkButton}>
                  <ExternalLink size={12} />
                  打开官方页面
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function GapList({
  gaps,
  dropped,
  links,
  open,
}: {
  gaps: string[];
  dropped: number;
  links: ResearchSource[];
  open: Opener;
}) {
  if (gaps.length === 0 && dropped === 0 && links.length === 0) return null;
  return (
    <section style={card}>
      <Title icon={<FileSearch size={16} />} text="还需要你自己核实的" />
      {gaps.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 5 }}>
          {gaps.map((gap, index) => (
            <li key={index} style={{ fontSize: 13, lineHeight: 1.7 }}>
              {gap}
            </li>
          ))}
        </ul>
      )}
      {dropped > 0 && (
        <p style={{ ...hint, marginTop: 8 }}>
          另外 {dropped} 条信息在资料里找不到原文依据，已经丢弃，不写进结论。
        </p>
      )}
      {links.length > 0 && (
        <>
          <div style={{ ...hint, marginTop: 10 }}>官方登记处，点开自己查：</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
            {links.map((link, index) => (
              <button key={`${link.url}-${index}`} type="button" onClick={() => void open(link.url)} style={chip}>
                {link.title}
                <ExternalLink size={11} />
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function Warnings({ items }: { items: string[] }) {
  return (
    <details style={card}>
      <summary style={{cursor:'pointer',fontSize:13}}>本次调查的提示（{items.length}）</summary>
      {items.map((item, index) => (
        <div key={index} style={{ ...hint, color: "#b7791f" }}>
          {item}
        </div>
      ))}
    </details>
  );
}

function Sources({ items, open }: { items: ResearchSource[]; open: Opener }) {
  if (items.length === 0) return null;
  return (
    <details style={card}>
      <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 700 }}>
        资料与线索（{items.length}）
      </summary>
      <div style={{ marginTop: 10 }}>
        {items.map((source, index) => (
          <button key={`${source.url}-${index}`} type="button" onClick={() => void open(source.url)} style={sourceButton}>
            <span>
              {source.title}
              <small style={{ ...hint, display: "block" }}>{({checked:'已取得资料',search_only:'仅检索摘要，未读原文',no_match:'本次无匹配记录',candidate:'名称候选，主体待确认',error:'查询未完成',failed:'查询未完成'} as Record<string,string>)[source.status] ?? source.status}</small>
            </span>
            <ExternalLink size={14} />
          </button>
        ))}
      </div>
    </details>
  );
}

/** Historical reports keep their complete narrative, without forcing a rewrite. */
function LegacyReport({ report, open }: { report: CompanyResearchReport; open: Opener }) {
  return (
    <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
      <section style={card}>
        <h2 style={{ margin: 0, fontSize: 18, wordBreak: "break-word" }}>{report.companyName || report.website}</h2>
        <div style={{ ...hint, marginTop: 4 }}>
          {report.country || "国家未单独记录"} · 生成于 {new Date(report.createdAt * 1000).toLocaleDateString()}
        </div>
      </section>
      {report.analysis ? (
        <section style={card} onClick={(event)=>{
          const href=(event.target as Element).closest('a')?.getAttribute('href');
          if(href && /^https?:\/\//i.test(href)){event.preventDefault();void open(href);}
        }}>
          <Title icon={<Search size={16} />} text="综合分析" />
          <div style={{ padding: "10px 12px", borderRadius: 8, background: "var(--color-bg-secondary)" }}>
            <MarkdownView text={report.analysis} />
          </div>
        </section>
      ) : (
        <section style={card}>
          <Title icon={<Search size={16} />} text="综合分析" />
          <p style={hint}>这次没生成文字分析（没配 AI 模型或调用失败）。官网公开信息不受影响。</p>
        </section>
      )}
      <section style={card}>
        <Title icon={<Globe2 size={16} />} text="官网公开信息" />
        <strong>{report.websiteTitle || report.companyName || "未识别到网站标题"}</strong>
        <p style={{ fontSize: 13, lineHeight: 1.7 }}>
          {report.websiteDescription || "官网没有提供可读取的描述，或者网站阻止了自动访问。"}
        </p>
        <div style={hint}>公开邮箱：{report.publicEmails.length ? report.publicEmails.join("、") : "没在首页看到"}</div>
      </section>
      <section style={card}>
        <Title icon={<Building2 size={16} />} text="法人身份匹配（GLEIF）" />
        {report.legalMatches.length ? (
          report.legalMatches.map((item) => (
            <div key={item.lei} style={{ padding: "9px 0", borderBottom: "1px solid var(--color-border)", fontSize: 13 }}>
              <strong>{item.legalName}</strong>
              <div style={hint}>
                {item.country} {item.city} · 状态 {item.registrationStatus || "未知"} · LEI {item.lei}
              </div>
              <div style={hint}>{item.address}</div>
            </div>
          ))
        ) : (
          <p style={hint}>没找到 LEI 匹配。很多中小企业没有 LEI，这不等于公司不存在。</p>
        )}
      </section>
      {report.warnings.length > 0 && <Warnings items={report.warnings} />}
      <Sources items={report.sources} open={open} />
    </div>
  );
}

function Title({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <h3 style={{ margin: "0 0 10px", fontSize: 14, display: "flex", gap: 7, alignItems: "center" }}>
      {icon}
      {text}
    </h3>
  );
}

const card: CSSProperties = {
  border: "1px solid var(--color-border)",
  borderRadius: 10,
  padding: 15,
  background: "var(--color-bg-primary)",
};
const hint: CSSProperties = { margin: "4px 0", color: "var(--color-text-secondary)", fontSize: 12, lineHeight: 1.6 };
const input: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid var(--color-border)",
  borderRadius: 7,
  padding: "9px 10px",
  background: "var(--color-bg-secondary)",
  color: "var(--color-text-primary)",
};
const primary: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  border: 0,
  borderRadius: 7,
  padding: "9px 15px",
  background: "var(--color-accent)",
  color: "#fff",
  cursor: "pointer",
};
const sourceButton: CSSProperties = {
  width: "100%",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  textAlign: "left",
  padding: "9px 10px",
  marginBottom: 6,
  border: "1px solid var(--color-border)",
  borderRadius: 7,
  background: "var(--color-bg-secondary)",
  color: "var(--color-text-primary)",
  cursor: "pointer",
};
const linkButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  marginTop: 4,
  border: 0,
  background: "transparent",
  color: "var(--color-accent)",
  cursor: "pointer",
  fontSize: 11,
  padding: 0,
};
const quote: CSSProperties = {
  margin: "6px 0 0",
  padding: "2px 0 2px 8px",
  borderLeft: "2px solid var(--color-border)",
  color: "var(--color-text-secondary)",
  fontSize: 11.5,
  lineHeight: 1.65,
};
const chip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  border: "1px solid var(--color-border)",
  borderRadius: 999,
  padding: "4px 10px",
  background: "var(--color-bg-secondary)",
  color: "var(--color-text-primary)",
  fontSize: 12,
  cursor: "pointer",
};
