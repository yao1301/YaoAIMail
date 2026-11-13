import { useWorkspaceState } from '@/lib/workspaceState';
import { useEffect } from "react";
import { Check, Save, Sparkles, X } from "lucide-react";
import { aiPrompt, getSentSamples, type StyleSample } from "@/lib/api";
import { useAccountsQuery } from "@/hooks/queries";
import { useMailStore } from "@/stores/mail.store";
import type { Account } from "@/lib/ipc-types";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { SettingsFeedback, type SettingsNotice } from "./SettingsFeedback";

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
  /** 固定预设的 ID；同一邮箱的每个预设只保存一份。 */
  presetId?: string | null;
}

const KEY = "yaoaimail-work-roles-v1";
const ADD_CUSTOM_ROLE = "__add_custom_role";
const ROLE_PRESETS = [
  { id: "general", name: "综合外贸业务", jobTitle: "外贸业务员", responsibilities: "开发客户、回复询盘、报价、跟进订单和协调工厂。", preferences: "先给结论，再说明依据；结尾明确下一步。" },
  { id: "customer-development", name: "客户开发", jobTitle: "外贸销售 / 客户开发", responsibilities: "寻找匹配客户、判断采购机会、撰写开发信和持续跟进。", preferences: "专业、具体、简洁，不写群发套话。" },
  { id: "order-follow-up", name: "订单跟进", jobTitle: "外贸跟单员", responsibilities: "确认订单、交期、生产进度、装运文件、付款和异常处理。", preferences: "事实优先，把时间节点和责任人写清楚。" },
  { id: "management", name: "外贸管理", jobTitle: "外贸主管 / 负责人", responsibilities: "管理客户、产品、报价策略、团队协作和关键商务决策。", preferences: "表达稳健，明确风险、选择和需要确认的事项。" },
];

const emptyRole = (accountId: string, id: string): WorkRoleProfile => ({
  id,
  accountId,
  name: "自定义工作角色",
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
  presetId: null,
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

function migrateRoles(roles: WorkRoleProfile[]): WorkRoleProfile[] {
  const presetByName = new Map(ROLE_PRESETS.map((preset) => [preset.name, preset]));
  const groups = new Map<string, WorkRoleProfile[]>();
  const custom: WorkRoleProfile[] = [];

  for (const role of roles) {
    const preset = role.presetId === undefined
      ? presetByName.get(role.name)
      : ROLE_PRESETS.find((item) => item.id === role.presetId);
    if (!preset) {
      custom.push({ ...role, name: role.name || "自定义工作角色" });
      continue;
    }
    const key = `${role.accountId || ""}:${preset.id}`;
    groups.set(key, [...(groups.get(key) || []), { ...role, presetId: preset.id }]);
  }

  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => Number(b.isActive || b.useInAi) - Number(a.isActive || a.useInAi) || (b.updatedAt || 0) - (a.updatedAt || 0));
    const [primary, ...duplicates] = ordered;
    custom.push(primary);
    // Preserve genuinely customized duplicate legacy roles as custom roles.
    for (const duplicate of duplicates) {
      const sameContent = ["jobTitle", "company", "responsibilities", "productsMarkets", "permissions", "preferences", "rules"]
        .every((field) => duplicate[field as keyof WorkRoleProfile] === primary[field as keyof WorkRoleProfile]);
      if (!sameContent) custom.push({ ...duplicate, presetId: null, name: `${duplicate.name}（自定义）` });
    }
  }
  return custom;
}

function normalizeRoles(roles: WorkRoleProfile[], accountId: string): WorkRoleProfile[] {
  return roles.map((role) => ({ ...role, accountId: role.accountId || accountId }));
}

function findActiveRole(roles: WorkRoleProfile[]): WorkRoleProfile | null {
  const role = roles.find((item) => item.isActive) || roles[0];
  return role?.useInAi ? role : null;
}

export function getActiveWorkRole(accountId?: string | null): WorkRoleProfile | null {
  const roles = loadRoles();
  return findActiveRole(accountId ? roles.filter((role) => role.accountId === accountId || !role.accountId) : roles);
}

export default function WorkRoleTab() {
  const { data: accounts = [] } = useAccountsQuery();
  const activeAccountId = useMailStore((state) => state.activeAccountId);
  const [selectedAccountId, setSelectedAccountId] = useWorkspaceState("src/features/settings/WorkRoleTab.tsx:WorkRoleTab:selectedAccountId", "");
  const [roles, setRoles] = useWorkspaceState<WorkRoleProfile[]>("src/features/settings/WorkRoleTab.tsx:WorkRoleTab:roles", () => migrateRoles(loadRoles()));
  const [drafts, setDrafts] = useWorkspaceState<Record<string, WorkRoleProfile>>("src/features/settings/WorkRoleTab.tsx:WorkRoleTab:drafts", {});
  const [selectedId, setSelectedId] = useWorkspaceState("src/features/settings/WorkRoleTab.tsx:WorkRoleTab:selectedId", "");
  const [generating, setGenerating] = useWorkspaceState("src/features/settings/WorkRoleTab.tsx:WorkRoleTab:generating", false);
  const [historyConsent, setHistoryConsent] = useWorkspaceState("src/features/settings/WorkRoleTab.tsx:WorkRoleTab:historyConsent", false);
  const [feedback, setFeedback] = useWorkspaceState<(SettingsNotice & { action: string; target: string }) | null>("src/features/settings/WorkRoleTab.tsx:WorkRoleTab:feedback", null);

  const scopedRoles = roles.filter((role) => role.accountId === selectedAccountId);
  const activeRole = findActiveRole(scopedRoles);
  const presetRoles = ROLE_PRESETS.map((preset) => {
    const saved = scopedRoles.find((role) => role.presetId === preset.id);
    if (saved) return saved;
    const { id: presetId, ...content } = preset;
    return { ...emptyRole(selectedAccountId, `preset:${selectedAccountId}:${presetId}`), ...content, presetId };
  });
  const pendingCustomRole = Object.values(drafts).find((role) =>
    role.accountId === selectedAccountId && !role.presetId && !scopedRoles.some((saved) => saved.id === role.id));
  const customRoles = scopedRoles.filter((role) => !role.presetId);
  if (pendingCustomRole) customRoles.push(pendingCustomRole);
  const selectedRole = [...presetRoles, ...customRoles].find((role) => role.id === selectedId)
    ?? activeRole ?? scopedRoles[0] ?? presetRoles[0];
  const draft = drafts[selectedRole.id];
  const selected = draft ?? selectedRole;
  const editingActiveRole = selected.id === activeRole?.id;

  useEffect(() => {
    if (!selectedAccountId) setSelectedAccountId(activeAccountId || accounts[0]?.id || "");
  }, [accounts, activeAccountId, selectedAccountId]);
  useEffect(() => {
    if (selectedAccountId && roles.some((role) => !role.accountId)) setRoles((old) => normalizeRoles(old, selectedAccountId));
  }, [selectedAccountId, roles]);
  useEffect(() => {
    setHistoryConsent(false);
  }, [selected.id, setHistoryConsent]);

  function update(patch: Partial<WorkRoleProfile>) {
    setDrafts((old) => ({ ...old, [selected.id]: { ...(old[selected.id] ?? selected), ...patch } }));
  }

  function forgetDraft(id: string) {
    setDrafts((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
  }

  function writeRoles(action: "save" | "delete" | "disable", change: (latest: WorkRoleProfile[]) => WorkRoleProfile[]) {
    setFeedback(null);
    try {
      const latest = migrateRoles(loadRoles()).map((role) => role.accountId ? role : {
        ...role,
        accountId: roles.find((known) => known.id === role.id)?.accountId || selectedAccountId,
      });
      const next = change(latest);
      localStorage.setItem(KEY, JSON.stringify(next));
      setRoles(next);
      return next;
    } catch (error) {
      const title = { save: "保存", delete: "删除", disable: "停用" }[action];
      setFeedback({ action, target: action === "disable" ? selectedAccountId : selected.id, message: `${title}工作角色失败：${extractErrorMessage(error)}`, kind: "error" });
      return null;
    }
  }

  function removeSelectedCustomRole() {
    if (selected.presetId) return;
    if (selected.id !== pendingCustomRole?.id) {
      if (!window.confirm("确定删除这个自定义工作角色吗？")) return;
      if (!writeRoles("delete", (latest) => latest.filter((role) => role.id !== selected.id))) return;
    }
    forgetDraft(selected.id);
    setSelectedId("");
  }

  function chooseRole(value: string) {
    if (value !== ADD_CUSTOM_ROLE) {
      setSelectedId(value);
      return;
    }
    const role = pendingCustomRole ?? emptyRole(selectedAccountId, crypto.randomUUID());
    setDrafts((old) => ({ ...old, [role.id]: role }));
    setSelectedId(role.id);
  }

  function saveRole(enable: boolean) {
    const saved = writeRoles("save", (latest) => {
      const previous = latest.find((role) => role.accountId === selectedAccountId &&
        (role.id === selected.id || (selected.presetId && role.presetId === selected.presetId)));
      const role = {
        ...(draft ?? previous ?? selected),
        id: previous?.id ?? selected.id,
        isActive: enable || !!previous?.isActive,
        useInAi: enable || !!previous?.useInAi,
        updatedAt: Date.now(),
      };
      const next = latest.map((item) => {
        if (item.id === role.id) return role;
        return enable && item.accountId === selectedAccountId ? { ...item, isActive: false, useInAi: false } : item;
      });
      if (!previous) next.push(role);
      return next;
    });
    if (saved) {
      forgetDraft(selected.id);
      const savedRole = saved.find((role) => role.accountId === selectedAccountId &&
        (role.id === selected.id || (selected.presetId && role.presetId === selected.presetId)));
      if (savedRole) {
        setSelectedId(savedRole.id);
        if (!enable) setFeedback({ action: "save", target: savedRole.id, message: "角色修改已保存。", kind: "success" });
      }
    }
  }

  function disableRole() {
    writeRoles("disable", (latest) => latest.map((role) => role.accountId === selectedAccountId
      ? { ...role, isActive: false, useInAi: false } : role));
  }

  function applyGeneratedFields(text: string) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("模型没有返回可识别的角色设定");
    const result = JSON.parse(match[0]);
    const patch: Partial<WorkRoleProfile> = {};
    for (const field of ["jobTitle", "responsibilities", "productsMarkets", "permissions", "preferences", "rules"] as const) {
      if (typeof result[field] === "string") patch[field] = result[field];
    }
    if (!Object.keys(patch).length) throw new Error("模型没有返回可识别的角色设定");
    update(patch);
  }

  async function generateDraft() {
    if (generating) return;
    setFeedback(null);
    setGenerating(true);
    try {
      const system = "你是外贸工作角色整理助手。根据用户提供的工作描述，生成可用于邮件 AI 的角色设定。只输出 JSON，字段为 jobTitle、responsibilities、productsMarkets、permissions、preferences、rules。不要编造用户没有提供的事实。";
      const user = `角色名称：${selected.name}\n公司：${selected.company}\n职位：${selected.jobTitle}\n工作描述：${selected.preferences}\n负责事项：${selected.responsibilities}\n产品与市场：${selected.productsMarkets}\n补充限制：${selected.permissions}\n${selected.rules}`;
      const text = await aiPrompt(system, user);
      applyGeneratedFields(text);
    } catch (error) {
      setFeedback({ action: "generate", target: selected.id, message: `整理工作角色失败：${extractErrorMessage(error)}`, kind: "error" });
    } finally {
      setGenerating(false);
    }
  }

  async function generateFromHistory() {
    if (generating || !historyConsent || !selectedAccountId) return;
    setFeedback(null);
    setHistoryConsent(false);
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
      applyGeneratedFields(text);
      setFeedback({ action: "history", target: selected.id, message: `已根据 ${samples.length} 封脱敏邮件整理角色内容。请检查后保存。`, kind: "success" });
    } catch (error) {
      setFeedback({ action: "history", target: selected.id, message: `根据历史邮件整理失败：${extractErrorMessage(error)}`, kind: "error" });
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 20 }}>我的工作角色</h2>
        <p style={hint}>告诉 AI 你的职责和写邮件的习惯。每个邮箱可以启用一个角色，AI 写作时会按发件邮箱使用。</p>
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
          <strong>第二步：选择工作角色</strong>
          <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
            <select aria-label="选择要编辑的工作角色" value={selected.id} onChange={(event) => chooseRole(event.target.value)} style={input}>
              <optgroup label="预设工作角色">
                {presetRoles.map((role, index) => <option key={role.id} value={role.id}>{role.name || ROLE_PRESETS[index].name}{role.id === activeRole?.id ? " · 已启用" : ""}</option>)}
              </optgroup>
              <optgroup label="我的自定义角色">
                {customRoles.map((role) => <option key={role.id} value={role.id}>{role.name || "自定义工作角色"}{role.id === activeRole?.id ? " · 已启用" : ""}</option>)}
                <option value={ADD_CUSTOM_ROLE}>＋ 自定义工作角色</option>
              </optgroup>
            </select>
            {!selected.presetId && <button type="button" disabled={generating} onClick={removeSelectedCustomRole} title="删除这个自定义工作角色" aria-label="删除这个自定义工作角色" style={deleteButton}><X size={15} /></button>}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px", marginTop: 8 }}>
            <span role="status" style={hint}>{activeRole ? <>此邮箱的 AI 写作正在使用 <strong>「{activeRole.name || "自定义工作角色"}」</strong></> : "此邮箱尚未启用工作角色。"}</span>
            {activeRole && <button type="button" onClick={disableRole} style={secondary}>停用角色</button>}
          </div>
          <SettingsFeedback notice={(feedback?.action === "delete" && feedback.target === selected.id) || (feedback?.action === "disable" && feedback.target === selectedAccountId) ? feedback : null} />
        </section>

          <section style={card}>
            <strong>第三步：用一句话告诉 AI 你的工作方式</strong>
            <p style={{ ...hint, margin: "5px 0 8px" }}>例如：“我负责跟进客户询价和订单，回复时先确认数量和交货地点，核实价格和交期后再答复。”</p>
            <textarea value={selected.preferences} onChange={(event) => update({ preferences: event.target.value })} placeholder="写下你的职位、产品、客户、日常工作和沟通习惯…" rows={5} style={{ ...input, resize: "vertical", lineHeight: 1.6 }} />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 9 }}>
              {!editingActiveRole && <button type="button" disabled={generating} onClick={() => saveRole(true)} style={primary}><Check size={14} />{draft ? "保存并启用" : "启用此角色"}</button>}
              {draft && <button type="button" disabled={generating} onClick={() => saveRole(false)} style={editingActiveRole ? primary : secondary}><Save size={14} />{editingActiveRole ? "保存修改" : "只保存"}</button>}
              <button type="button" disabled={generating} onClick={() => void generateDraft()} style={secondary}><Sparkles size={14} />{generating ? "整理中…" : "让 AI 帮我整理"}</button>
            </div>
            <SettingsFeedback notice={feedback?.target === selected.id && (feedback.action === "save" || feedback.action === "generate") ? feedback : null} />
            {draft && <p role="status" style={{ ...hint, margin: "8px 0 0" }}>此角色有未保存的修改。</p>}
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
            <label style={{ display: "flex", alignItems: "flex-start", gap: 7, fontSize: 12, lineHeight: 1.5 }}><input type="checkbox" checked={historyConsent} onChange={(event) => setHistoryConsent(event.target.checked)} />我同意本次使用最多 30 封脱敏邮件整理角色内容。</label>
            <button type="button" disabled={!historyConsent || generating} onClick={() => void generateFromHistory()} style={{ ...secondary, marginTop: 9, opacity: historyConsent ? 1 : 0.55 }}><Sparkles size={14} />{generating ? "学习中…" : "根据历史邮件整理"}</button>
            <SettingsFeedback notice={feedback?.action === "history" && feedback.target === selected.id ? feedback : null} />
          </details>

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
const primary: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, padding: "8px 12px", border: 0, borderRadius: 7, background: "var(--color-accent)", color: "#fff", cursor: "pointer" };
const secondary: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, padding: "8px 12px", border: "1px solid var(--color-border)", borderRadius: 7, background: "transparent", color: "var(--color-text-primary)", cursor: "pointer" };
const deleteButton: React.CSSProperties = { flex: "0 0 auto", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 38, height: 38, border: "1px solid #fecaca", borderRadius: 7, background: "#fff1f2", color: "#dc2626", cursor: "pointer" };
