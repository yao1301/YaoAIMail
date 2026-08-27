import { useEffect, useState } from "react";
import { Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { aiPrompt, getSentSamples, type StyleSample } from "@/lib/api";
import { useAccountsQuery } from "@/hooks/queries";
import { useMailStore } from "@/stores/mail.store";
import type { Account } from "@/lib/ipc-types";

export interface WorkRoleProfile {
  id: string;
  /** 邮箱账号 ID；旧版本没有该字段时会在首次打开时补齐。 */
  accountId: string;
  name: string;
  jobTitle: string;
  company: string;
  responsibilities: string;
  productsMarkets: string;
  permissions: string;
  preferences: string;
  rules: string;
  isActive: boolean;
  useInAi: boolean;
  updatedAt: number;
}

const KEY = "yaoaimail-work-roles-v1";
const ROLE_PRESETS = [
  { name: "综合外贸业务", jobTitle: "外贸业务员", responsibilities: "开发客户、回复询盘、报价、跟进订单和协调工厂。", preferences: "先给结论，再说明依据；结尾明确下一步。" },
  { name: "客户开发", jobTitle: "外贸销售 / 客户开发", responsibilities: "寻找匹配客户、判断采购机会、撰写开发信和持续跟进。", preferences: "专业、具体、简洁，不写群发套话。" },
  { name: "订单跟进", jobTitle: "外贸跟单员", responsibilities: "确认订单、交期、生产进度、装运文件、付款和异常处理。", preferences: "事实优先，把时间节点和责任人写清楚。" },
  { name: "外贸管理", jobTitle: "外贸主管 / 负责人", responsibilities: "管理客户、产品、报价策略、团队协作和关键商务决策。", preferences: "表达稳健，明确风险、选择和需要确认的事项。" },
];

const emptyRole = (accountId: string): WorkRoleProfile => ({
  id: crypto.randomUUID(),
  accountId,
  name: "我的工作角色",
  jobTitle: "",
  company: "",
  responsibilities: "",
  productsMarkets: "",
  permissions: "",
  preferences: "",
  rules: "不要编造价格、交期、付款条件或未经确认的承诺。",
  isActive: false,
  useInAi: false,
  updatedAt: Date.now(),
});

function redactRoleEvidence(text: string): string {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]")
    .replace(/https?:\/\/\S+/gi, "[WEBSITE]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[PHONE_OR_NUMBER]")
    .replace(/\b(?:PO|PI|SO|INV|ORDER|CONTRACT)[-:#\s]*[A-Z0-9-]+\b/gi, "[DOCUMENT_ID]")
    .replace(/[$￥€£]?\s?\d[\d,.]*/g, "[NUMBER]")
    .replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, "[DATE]");
}

function loadRoles(): WorkRoleProfile[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]") as WorkRoleProfile[]; } catch { return []; }
}

function normalizeRoles(roles: WorkRoleProfile[], accountId: string): WorkRoleProfile[] {
  return roles.map((role) => ({ ...role, accountId: role.accountId || accountId }));
}

export function getActiveWorkRole(accountId?: string | null): WorkRoleProfile | null {
  const roles = loadRoles();
  const scoped = accountId ? roles.filter((role) => role.accountId === accountId || !role.accountId) : roles;
  const role = scoped.find((item) => item.isActive) || scoped[0];
  return role?.useInAi ? role : null;
}

export default function WorkRoleTab() {
  const { data: accounts = [] } = useAccountsQuery();
  const activeAccountId = useMailStore((state) => state.activeAccountId);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [roles, setRoles] = useState<WorkRoleProfile[]>(() => loadRoles());
  const [selectedId, setSelectedId] = useState("");
  const [generating, setGenerating] = useState(false);
  const [historyConsent, setHistoryConsent] = useState(false);

  const scopedRoles = roles.filter((role) => !selectedAccountId || role.accountId === selectedAccountId);
  const selected = scopedRoles.find((role) => role.id === selectedId) || scopedRoles[0] || null;

  useEffect(() => { localStorage.setItem(KEY, JSON.stringify(roles)); }, [roles]);
  useEffect(() => {
    if (!selectedAccountId) setSelectedAccountId(activeAccountId || accounts[0]?.id || "");
  }, [accounts, activeAccountId, selectedAccountId]);
  useEffect(() => {
    if (selectedAccountId && roles.some((role) => !role.accountId)) setRoles((old) => normalizeRoles(old, selectedAccountId));
  }, [selectedAccountId, roles]);
  useEffect(() => {
    if (scopedRoles.length && !scopedRoles.some((role) => role.id === selectedId)) setSelectedId(scopedRoles[0].id);
    if (!scopedRoles.length) setSelectedId("");
  }, [scopedRoles, selectedId]);

  function update(patch: Partial<WorkRoleProfile>) {
    if (!selected) return;
    setRoles((old) => old.map((role) => role.id === selected.id ? { ...role, ...patch, updatedAt: Date.now() } : role));
  }

  function addRole(preset = ROLE_PRESETS[0]) {
    if (!selectedAccountId) return;
    const role = { ...emptyRole(selectedAccountId), name: preset.name, jobTitle: preset.jobTitle, responsibilities: preset.responsibilities, preferences: preset.preferences };
    setRoles((old) => [...old, role]);
    setSelectedId(role.id);
  }

  function activate(id: string) {
    setRoles((old) => old.map((role) => role.accountId === selectedAccountId ? { ...role, isActive: role.id === id, useInAi: role.id === id, updatedAt: Date.now() } : role));
    setSelectedId(id);
  }

  async function generateDraft() {
    if (!selected || generating) return;
    setGenerating(true);
    try {
      const system = "你是外贸工作角色整理助手。根据用户提供的工作描述，生成可用于邮件 AI 的角色设定。只输出 JSON，字段为 jobTitle、responsibilities、productsMarkets、permissions、preferences、rules。不要编造用户没有提供的事实。";
      const user = `角色名称：${selected.name}\n公司：${selected.company}\n职位：${selected.jobTitle}\n工作描述：${selected.preferences}\n负责事项：${selected.responsibilities}\n产品与市场：${selected.productsMarkets}\n补充限制：${selected.permissions}\n${selected.rules}`;
      const text = await aiPrompt(system, user);
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("模型没有返回可识别的角色设定");
      update(JSON.parse(match[0]) as Partial<WorkRoleProfile>);
    } catch (error) {
      window.alert(`整理工作角色失败：${String(error)}`);
    } finally {
      setGenerating(false);
    }
  }

  async function generateFromHistory() {
    if (!selected || generating || !historyConsent || !selectedAccountId) return;
    setGenerating(true);
    try {
      const samples: StyleSample[] = await getSentSamples(30, selectedAccountId);
      if (!samples.length) throw new Error("当前账号没有找到可用的已发送邮件样本，请先同步已发送文件夹。");
      const redacted = samples
        .map((sample, index) => `样本 ${index + 1}\n主题：${redactRoleEvidence(sample.subject)}\n正文：${redactRoleEvidence(sample.body)}`)
        .join("\n\n---\n\n")
        .slice(0, 18_000);
      const system = "你是外贸工作角色整理助手。请根据脱敏后的当前邮箱账号已发送邮件样本，提取反复出现的工作职责、产品与市场、可处理范围、沟通偏好和防呆规则。只输出 JSON，字段为 jobTitle、responsibilities、productsMarkets、permissions、preferences、rules。不得带入客户姓名、邮箱、价格、订单号、日期、交期或其他旧邮件事实，也不要猜测。";
      const text = await aiPrompt(system, `当前角色：${JSON.stringify(selected)}\n\n当前账号的脱敏已发送邮件样本：\n${redacted}`);
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("模型没有返回可识别的角色设定");
      update(JSON.parse(match[0]) as Partial<WorkRoleProfile>);
      window.alert(`已根据当前账号 ${samples.length} 封脱敏已发送邮件整理角色，请检查后再设为当前角色。`);
    } catch (error) {
      window.alert(`根据历史邮件整理失败：${String(error)}`);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 20 }}>我的工作角色</h2>
        <p style={hint}>简单理解：告诉 AI 你是谁、平时负责什么、回复邮件有什么习惯。每个邮箱可以有多个角色，写邮件时会按发件账号使用对应角色。</p>
      </div>

      <section style={card}>
        <strong>第一步：选择要设置的邮箱</strong>
        <select value={selectedAccountId} onChange={(event) => setSelectedAccountId(event.target.value)} style={{ ...input, marginTop: 8 }} disabled={!accounts.length}>
          <option value="">请选择邮箱账号</option>
          {accounts.map((account: Account) => <option key={account.id} value={account.id}>{account.display_name ? `${account.display_name} · ` : ""}{account.email}</option>)}
        </select>
      </section>

      {!selectedAccountId ? <div style={empty}>请先选择一个邮箱账号。</div> : <>
        <section style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}><strong>第二步：选择或新建一个角色</strong><button type="button" onClick={() => addRole()} style={secondary}><Plus size={14} />新建角色</button></div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 10 }}>
            {scopedRoles.map((role) => <button key={role.id} type="button" onClick={() => setSelectedId(role.id)} style={{ ...roleButton, background: role.id === selected?.id ? "var(--color-sidebar-active)" : "transparent" }}>{role.name}{role.useInAi ? " · 当前使用" : ""}</button>)}
            {!scopedRoles.length && <span style={hint}>还没有角色，可以从右上角新建，或使用下面的常用模板。</span>}
          </div>
          <select defaultValue="" onChange={(event) => { const preset = ROLE_PRESETS[Number(event.target.value)]; if (preset) addRole(preset); }} style={{ ...input, marginTop: 10 }}>
            <option value="">从常用模板新建…</option>
            {ROLE_PRESETS.map((preset, index) => <option key={preset.name} value={index}>{preset.name}</option>)}
          </select>
        </section>

        {selected && <>
          <section style={card}>
            <strong>第三步：用一句话告诉 AI 你的工作方式</strong>
            <p style={{ ...hint, margin: "5px 0 8px" }}>例如：“我负责家居照明出口，主要开发欧洲客户；回复时先确认数量和目的港，价格和交期需要确认后再承诺。”</p>
            <textarea value={selected.preferences} onChange={(event) => update({ preferences: event.target.value })} placeholder="写下你的职位、产品、客户、日常工作和沟通习惯…" rows={5} style={{ ...input, resize: "vertical", lineHeight: 1.6 }} />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 9 }}>
              <button type="button" onClick={() => activate(selected.id)} style={primary}><Save size={14} />设为这个邮箱当前使用</button>
              <button type="button" disabled={generating} onClick={() => void generateDraft()} style={secondary}><Sparkles size={14} />{generating ? "整理中…" : "让 AI 帮我整理"}</button>
            </div>
          </section>

          <details style={card}>
            <summary style={summary}>可选：补充更详细的工作信息 <span style={hint}>不填也可以先使用</span></summary>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10, marginTop: 12 }}>
              <Field label="角色名称" value={selected.name} onChange={(value) => update({ name: value })} placeholder="例如：欧洲客户开发" />
              <Field label="职位" value={selected.jobTitle} onChange={(value) => update({ jobTitle: value })} placeholder="例如：外贸业务员" />
              <Field label="公司" value={selected.company} onChange={(value) => update({ company: value })} placeholder="公司名称" />
              <Field label="产品与市场" value={selected.productsMarkets} onChange={(value) => update({ productsMarkets: value })} placeholder="产品、国家、客户类型" />
            </div>
            <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
              <Area label="主要负责事项" value={selected.responsibilities} onChange={(value) => update({ responsibilities: value })} placeholder="询盘、报价、订单、交期、售后等" />
              <Area label="可以直接答复或承诺的范围" value={selected.permissions} onChange={(value) => update({ permissions: value })} placeholder="哪些事项可以直接回复，哪些需要确认" />
              <Area label="必须遵守的规则" value={selected.rules} onChange={(value) => update({ rules: value })} placeholder="例如：不猜测价格、交期和付款条件" />
            </div>
          </details>

          <details style={card}>
            <summary style={summary}>可选：从当前账号的历史邮件学习 <span style={hint}>最多 30 封，先脱敏</span></summary>
            <p style={{ ...hint, margin: "10px 0" }}>只读取这个邮箱账号的已发送邮件，脱敏后发送给当前配置的 AI 服务商；不会上传整个邮箱、附件或全部历史邮件。</p>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 7, fontSize: 12, lineHeight: 1.5 }}><input type="checkbox" checked={historyConsent} onChange={(event) => setHistoryConsent(event.target.checked)} />我同意本次使用最多 30 封脱敏样本整理这个工作角色。</label>
            <button type="button" disabled={!historyConsent || generating} onClick={() => void generateFromHistory()} style={{ ...secondary, marginTop: 9, opacity: historyConsent ? 1 : 0.55 }}><Sparkles size={14} />{generating ? "学习中…" : "根据历史邮件整理"}</button>
          </details>

          <button type="button" onClick={() => { if (!window.confirm("确定删除这个工作角色吗？")) return; setRoles((old) => old.filter((role) => role.id !== selected.id)); }} style={{ ...secondary, color: "#b33", alignSelf: "flex-start" }}><Trash2 size={14} />删除当前角色</button>
        </>}
      </>}
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--color-text-secondary)" }}>{label}<input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} style={input} /></label>;
}

function Area({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--color-text-secondary)" }}>{label}<textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={3} style={{ ...input, resize: "vertical", lineHeight: 1.6 }} /></label>;
}

const card: React.CSSProperties = { border: "1px solid var(--color-border)", borderRadius: 10, padding: 14, background: "var(--color-bg-primary)" };
const input: React.CSSProperties = { boxSizing: "border-box", width: "100%", padding: "8px 9px", border: "1px solid var(--color-border)", borderRadius: 7, background: "var(--color-bg-secondary)", color: "var(--color-text-primary)" };
const hint: React.CSSProperties = { color: "var(--color-text-secondary)", fontSize: 13, lineHeight: 1.6 };
const empty: React.CSSProperties = { padding: 16, border: "1px dashed var(--color-border)", borderRadius: 8, color: "var(--color-text-secondary)" };
const summary: React.CSSProperties = { cursor: "pointer", display: "flex", justifyContent: "space-between", gap: 10, listStyle: "none", fontWeight: 600, fontSize: 13 };
const roleButton: React.CSSProperties = { padding: "7px 10px", borderRadius: 7, border: "1px solid var(--color-border)", color: "var(--color-text-primary)", cursor: "pointer" };
const primary: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, padding: "8px 12px", border: 0, borderRadius: 7, background: "var(--color-accent)", color: "#fff", cursor: "pointer" };
const secondary: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, padding: "8px 12px", border: "1px solid var(--color-border)", borderRadius: 7, background: "transparent", color: "var(--color-text-primary)", cursor: "pointer" };
