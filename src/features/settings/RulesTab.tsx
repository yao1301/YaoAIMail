import { useEffect, useMemo, useState } from "react";
import {
  Pencil, Play, Plus, Settings2, Trash2, X,
} from "lucide-react";
import {
  applyRulesToFolder,
  createRule,
  deleteRule,
  listRules,
  updateRule,
  type Rule,
} from "@/lib/api";
import { type ApplyRulesReport } from "@/lib/ipc-types";
import { useAccountsQuery, useFoldersForAccountsQuery } from "@/hooks/queries";
import { listen } from "@tauri-apps/api/event";
import { useUIStore } from "@/stores/ui.store";
import { useToastStore } from "@/stores/toast.store";
import { useMailStore } from "@/stores/mail.store";
import {
  parseRuleActions,
  parseRuleConditions,
  serializeRuleActions,
  type ActionType,
  type ConditionField,
  type ConditionOp,
} from "./rule-json";
import { queryClient } from "@/lib/query-client";

// ─── 类型（与 rule-json / 后端一致）───────────────────────────────────────

interface ConditionInput {
  field: ConditionField;
  op: ConditionOp;
  value: string;
}

interface ActionInput {
  type: ActionType;
  value?: string;
}

interface RuleFormData {
  name: string;
  priority: number;
  is_enabled: boolean;
  account_id: string;
  /** 触发时机："on_receive" / "on_send" */
  triggerWhen: string[];
  /** 执行条件逻辑：and=所有条件 or=任一条件 none=无条件 */
  conditionLogic: "and" | "or" | "none";
  conditions: ConditionInput[];
  actions: ActionInput[];
}

const CONDITION_FIELD_LABELS: Record<ConditionField, string> = {
  from: "发件人",
  to: "收件人",
  subject: "主题",
  body: "正文",
  has_attachment: "有附件",
  domain: "发件人域名",
};

const CONDITION_OP_LABELS: Record<ConditionOp, string> = {
  contains: "包含",
  not_contains: "不包含",
  equals: "等于",
  starts_with: "开始是",
  ends_with: "结束是",
};

const ACTION_LABELS: Record<ActionType, string> = {
  MoveToFolder: "移动到文件夹",
  AddLabel: "添加标签",
  MarkRead: "标记已读",
  Archive: "归档到 Archive",
  SetKanbanColumn: "设置看板列",
};

const KANBAN_LABELS: Record<string, string> = {
  todo: "待处理",
  waiting: "等待回复",
  done: "已完成",
};

const DEFAULT_CONDITION: ConditionInput = { field: "from", op: "contains", value: "" };
const DEFAULT_ACTION: ActionInput = { type: "Archive" };

const emptyForm: RuleFormData = {
  name: "",
  priority: 1,
  is_enabled: true,
  account_id: "",
  triggerWhen: ["on_receive"],
  conditionLogic: "and",
  conditions: [{ ...DEFAULT_CONDITION }],
  actions: [{ ...DEFAULT_ACTION }],
};

function parseConditions(json: string): ConditionInput[] {
  return parseRuleConditions(json);
}

function serializeActions(actions: ActionInput[]): string {
  return serializeRuleActions(actions);
}

function parseActions(json: string): ActionInput[] {
  return parseRuleActions(json);
}

function conditionsSummary(rule: Rule): string {
  try {
    const logic = parseConditionLogic(rule.conditions);
    if (logic === "none") return "无条件限制";
    const conditions = parseConditions(rule.conditions);
    if (conditions.length === 0) return "无条件限制";
    const connector = logic === "or" ? " 或 " : " 且 ";
    return conditions
      .map((c) => {
        if (c.field === "has_attachment") {
          return c.op === "equals" && c.value === "true" ? "有附件" : "无附件";
        }
        return `${CONDITION_FIELD_LABELS[c.field] ?? c.field} ${CONDITION_OP_LABELS[c.op] ?? c.op} “${c.value}”`;
      })
      .join(connector);
  } catch {
    return "（条件解析失败）";
  }
}

function actionsSummary(rule: Rule): string {
  try {
    const actions = parseActions(rule.actions);
    return actions
      .map((a) => {
        const label = ACTION_LABELS[a.type] ?? a.type;
        if (a.type === "MoveToFolder" && a.value) return `${label} → ${a.value}`;
        if (a.type === "AddLabel" && a.value) return `${label}：${a.value}`;
        return label;
      })
      .join("；");
  } catch {
    return "（动作解析失败）";
  }
}

// ─── 主组件 ────────────────────────────────────────────────────────────────

export default function RulesTab() {
  const { data: accounts = [] } = useAccountsQuery();
  const activeAccountId = useMailStore((state) => state.activeAccountId);
  const [selectedAccountId, setSelectedAccountId] = useState(activeAccountId ?? "");
  const { data: folders = [] } = useFoldersForAccountsQuery(
    selectedAccountId ? [selectedAccountId] : [],
  );
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(false);

  const [editing, setEditing] = useState<{ rule: Rule | null; form: RuleFormData } | null>(null);
  const [execTarget, setExecTarget] = useState<{ rule: Rule | null } | null>(null);
  const [execFolderId, setExecFolderId] = useState("");
  const [execRunning, setExecRunning] = useState(false);
  const [execProgress, setExecProgress] = useState<{ processed: number; matched: number } | null>(null);
  const [execReport, setExecReport] = useState<ApplyRulesReport | null>(null);

  // 后台执行规则：监听进度与完成事件（apply_rules_to_folder 已改为后台分批执行，
  // 命令立即返回，不再长时间阻塞弹窗）。
  useEffect(() => {
    const unlistenProgress = listen<{ processed: number; matched: number; actions_applied: number }>(
      "rules:apply-progress",
      (event) => {
        setExecProgress({ processed: event.payload.processed, matched: event.payload.matched });
      },
    );
    const unlistenDone = listen<{ phase: string; report?: ApplyRulesReport; error?: string }>(
      "rules:apply-done",
      (event) => {
        setExecRunning(false);
        setExecProgress(null);
        setExecTarget(null);
        if (event.payload.phase === "error") {
          useToastStore.getState().addToast({ message: `执行失败：${event.payload.error ?? "未知错误"}`, type: "error" });
          return;
        }
        const report = event.payload.report;
        if (!report) {
          useToastStore.getState().addToast({ message: "规则执行完成，但没有收到报告", type: "error" });
          return;
        }
        setExecReport(report);
        // 0 命中时给具体原因（避免用户以为是 bug）。规则引擎已按账号 + 评估多重过滤。
        if (report.processed === 0) {
          const folderName = accountFolders.find((f) => f.id === execFolderId)?.name ?? "该文件夹";
          useToastStore.getState().addToast({
            message: `「${folderName}」里没有邮件（请确认文件夹和账号是否匹配）`,
            type: "error",
          });
        } else if (report.matched === 0) {
          useToastStore.getState().addToast({
            message: `检查了 ${report.processed} 封，但没一封符合规则条件。请检查条件字段/操作符/值是否正确`,
            type: "info",
          });
        } else {
          useToastStore.getState().addToast({
            message: `已对 ${report.processed} 封邮件执行规则，命中 ${report.matched} 封`,
            type: "success",
          });
        }
        queryClient.invalidateQueries({ queryKey: ["folders"] });
        queryClient.invalidateQueries({ queryKey: ["messages"] });
      },
    );
    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenDone.then((fn) => fn());
    };
  }, [execFolderId, folders]);

  // 默认选中第一个账号（没有账号时留空）
  useEffect(() => {
    if (!selectedAccountId && accounts.length > 0) {
      setSelectedAccountId(accounts[0].id);
    }
  }, [accounts, selectedAccountId]);

  // 监听右键邮件"创建过滤器"传来的草稿（如 "from: someone@example.com"）：
  // 直接打开新建规则弹窗，把首条条件预填进去，并清掉 draft 防止重复消费。
  const pendingDraft = useUIStore((s) => s.pendingRuleDraftText);
  useEffect(() => {
    if (!pendingDraft) return;
    const match = pendingDraft.match(/^(from|to|subject|body|domain):\s*(.+)$/i);
    const field = (match?.[1]?.toLowerCase() ?? "from") as ConditionInput["field"];
    const value = match ? match[2].trim() : pendingDraft.trim();
    setEditing({
      rule: null,
      form: {
        ...emptyForm,
        account_id: selectedAccountId || "",
        name: `从「${value}」筛选`,
        conditions: [{ field, op: "contains", value }],
        actions: [{ ...DEFAULT_ACTION }],
        triggerWhen: ["on_receive"],
      },
    });
    useUIStore.getState().setPendingRuleDraftText(null);
    useToastStore.getState().addToast({ message: "已按该邮件预填规则条件，请在弹窗中确认/补充", type: "success" });
  }, [pendingDraft, selectedAccountId]);

  // 加载规则
  useEffect(() => {
    if (!selectedAccountId) {
      setRules([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void listRules(selectedAccountId)
      .then((data) => {
        if (!cancelled) setRules(data);
      })
      .catch(() => {
        if (!cancelled) useToastStore.getState().addToast({ message: "规则加载失败", type: "error" });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedAccountId]);

  const accountFolders = useMemo(() => folders, [folders]);

  function openNewRule() {
    setEditing({ rule: null, form: { ...emptyForm, account_id: selectedAccountId } });
  }

  function openEditRule(rule: Rule) {
    setEditing({
      rule,
      form: {
        name: rule.name,
        priority: rule.priority,
        is_enabled: rule.is_enabled,
        account_id: rule.account_id || selectedAccountId,
        triggerWhen: parseTriggerWhen(rule.trigger_when),
        conditionLogic: parseConditionLogic(rule.conditions),
        conditions: parseConditions(rule.conditions),
        actions: parseActions(rule.actions),
      },
    });
  }

  async function saveRule() {
    if (!editing) return;
    const form = editing.form;
    if (!form.name.trim()) {
      useToastStore.getState().addToast({ message: "请填写规则名称", type: "error" });
      return;
    }
    if (form.conditionLogic !== "none" && form.conditions.length === 0) {
      useToastStore.getState().addToast({ message: "请至少添加一个条件，或选择“无条件限制”", type: "error" });
      return;
    }
    if (form.actions.length === 0) {
      useToastStore.getState().addToast({ message: "请至少添加一个动作", type: "error" });
      return;
    }
    const conditionsJson = buildConditionsJson(form);
    const actionsJson = serializeActions(form.actions);
    try {
      if (editing.rule) {
        const updated: Rule = {
          ...editing.rule,
          name: form.name.trim(),
          priority: form.priority,
          is_enabled: form.is_enabled,
          account_id: form.account_id,
          trigger_when: JSON.stringify(form.triggerWhen),
          conditions: conditionsJson,
          actions: actionsJson,
          updated_at: Date.now(),
        };
        await updateRule(updated);
        useToastStore.getState().addToast({ message: "规则已更新。", type: "success" });
      } else {
        const created: Rule = {
          id: "", name: form.name.trim(), priority: form.priority,
          conditions: conditionsJson, actions: actionsJson, is_enabled: form.is_enabled,
          account_id: form.account_id, trigger_when: JSON.stringify(form.triggerWhen),
          created_at: Date.now(), updated_at: Date.now(),
        };
        await createRule(created);
        useToastStore.getState().addToast({ message: "规则已创建。", type: "success" });
      }
      queryClient.invalidateQueries({ queryKey: ["rules"] });
      setEditing(null);
      // 刷新列表
      const data = await listRules(selectedAccountId);
      setRules(data);
    } catch (err) {
      useToastStore.getState().addToast({ message: `保存失败：${String(err)}`, type: "error" });
    }
  }

  async function removeRule(rule: Rule) {
    try {
      await deleteRule(rule.id);
      setRules((old) => old.filter((item) => item.id !== rule.id));
      useToastStore.getState().addToast({ message: "规则已删除。", type: "success" });
    } catch (err) {
      useToastStore.getState().addToast({ message: `删除失败：${String(err)}`, type: "error" });
    }
  }

  async function toggleRuleEnabled(rule: Rule) {
    try {
      await updateRule({ ...rule, is_enabled: !rule.is_enabled, updated_at: Date.now() });
      setRules((old) => old.map((item) => (item.id === rule.id ? { ...item, is_enabled: !item.is_enabled } : item)));
    } catch (err) {
      useToastStore.getState().addToast({ message: `操作失败：${String(err)}`, type: "error" });
    }
  }

  async function runExecute() {
    if (!execFolderId) {
      useToastStore.getState().addToast({ message: "请选择要套用规则的文件夹", type: "error" });
      return;
    }
    setExecRunning(true);
    setExecReport(null);
    setExecProgress(null);
    try {
      // 命令已改为后台执行：立即返回，进度/完成走事件（rules:apply-progress / rules:apply-done）。
      await applyRulesToFolder(
        selectedAccountId,
        execFolderId,
        execTarget?.rule ? [execTarget.rule.id] : undefined,
      );
      useToastStore.getState().addToast({ message: "已在后台执行，请稍候…", type: "info" });
    } catch (err) {
      setExecRunning(false);
      useToastStore.getState().addToast({ message: `启动失败：${String(err)}`, type: "error" });
    }
  }

  if (accounts.length === 0) {
    return <p style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>请先添加邮箱账号，再设置邮件规则。</p>;
  }

  const triggerWhenLabels: Record<string, string> = {
    on_receive: "收取邮件时",
    on_send: "发送邮件时",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 900 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 15, display: "flex", alignItems: "center", gap: 6 }}>
          <Settings2 size={16} />过滤器规则
        </h3>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>账号</label>
          <select
            value={selectedAccountId}
            onChange={(event) => setSelectedAccountId(event.target.value)}
            style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)", fontSize: 12 }}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>{account.email}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={openNewRule}
            style={{ padding: "6px 12px", border: 0, borderRadius: 6, background: "var(--color-accent)", color: "#fff", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12 }}
          >
            <Plus size={13} />新建规则
          </button>
        </div>
      </div>

      <div style={{ fontSize: 11.5, color: "var(--color-text-secondary)", padding: "8px 10px", background: "var(--color-bg-secondary)", borderRadius: 6, marginBottom: 10, lineHeight: 1.55 }}>
        触发时机只在 <strong>收取邮件时</strong>自动评估；<strong>已发送文件夹里的旧邮件不会自动执行规则</strong>。
        如要让历史已发邮件按规则归档，点规则右侧的"执行"按钮，选「已发送」文件夹手动跑一遍即可（不会删除邮件，只移动/打标签等）。
      </div>

      {loading ? (
        <p style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>加载中…</p>
      ) : rules.length === 0 ? (
        <div style={{ padding: "24px", border: "1px dashed var(--color-border)", borderRadius: 8, textAlign: "center", fontSize: 13, color: "var(--color-text-secondary)" }}>
          还没有规则。点“新建规则”创建：符合条件的邮件会自动执行指定动作（移动到文件夹、打标签、标记已读等）。
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rules.map((rule) => (
            <div key={rule.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", border: "1px solid var(--color-border)", borderRadius: 8, background: "var(--color-bg-secondary)", flexWrap: "wrap" }}>
              <input
                type="checkbox"
                checked={rule.is_enabled}
                onChange={() => void toggleRuleEnabled(rule)}
                title={rule.is_enabled ? "点击停用" : "点击启用"}
              />
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{rule.name}</div>
                <div style={{ fontSize: 11.5, color: "var(--color-text-secondary)", marginTop: 2 }}>
                  条件：{conditionsSummary(rule)}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--color-text-secondary)" }}>
                  动作：{actionsSummary(rule)}
                </div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>
                  触发：{rule.trigger_when && parseTriggerWhen(rule.trigger_when).length > 0
                    ? parseTriggerWhen(rule.trigger_when).map((t) => triggerWhenLabels[t] ?? t).join("、")
                    : "收取邮件时"} · 优先级 {rule.priority}
                </div>
              </div>
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                <button type="button" onClick={() => setExecTarget({ rule })} style={smallBtn} title="对该账号现有邮件套用此规则">
                  <Play size={12} />执行
                </button>
                <button type="button" onClick={() => openEditRule(rule)} style={smallBtn} title="编辑规则">
                  <Pencil size={12} />编辑
                </button>
                <button type="button" onClick={() => void removeRule(rule)} style={{ ...smallBtn, color: "#b42318" }} title="删除规则">
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ─── 新建/编辑规则弹窗（Foxmail 风格） ─── */}
      {editing && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.45)" }} onClick={() => setEditing(null)}>
          <div style={{ width: 620, maxWidth: "94vw", maxHeight: "88vh", overflow: "auto", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 10, padding: 16, boxShadow: "0 10px 30px rgba(0,0,0,0.2)" }} onClick={(event) => event.stopPropagation()}>
            <h3 style={{ margin: "0 0 12px", fontSize: 15 }}>{editing.rule ? "编辑规则" : "新建规则"}</h3>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
              <label style={{ fontSize: 12 }}>
                <span style={{ display: "block", marginBottom: 4, color: "var(--color-text-secondary)" }}>规则名称</span>
                <input
                  value={editing.form.name}
                  onChange={(event) => setEditing({ ...editing, form: { ...editing.form, name: event.target.value } })}
                  placeholder="例：包含某关键词的邮件"
                  style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)" }}
                />
              </label>
              <label style={{ fontSize: 12 }}>
                <span style={{ display: "block", marginBottom: 4, color: "var(--color-text-secondary)" }}>优先级（数字越小越先执行）</span>
                <input
                  type="number"
                  value={editing.form.priority}
                  onChange={(event) => setEditing({ ...editing, form: { ...editing.form, priority: Number(event.target.value) || 1 } })}
                  style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)" }}
                />
              </label>
              <label style={{ fontSize: 12, display: "flex", alignItems: "flex-end", gap: 6, paddingBottom: 6 }}>
                <input type="checkbox" checked={editing.form.is_enabled} onChange={(event) => setEditing({ ...editing, form: { ...editing.form, is_enabled: event.target.checked } })} />
                <span>启用此规则</span>
              </label>
            </div>

            <div style={{ fontSize: 12, marginBottom: 8 }}>
              <span style={{ display: "block", marginBottom: 4, color: "var(--color-text-secondary)" }}>执行时机</span>
              {(["on_receive", "on_send"] as const).map((trigger) => (
                <label key={trigger} style={{ display: "inline-flex", alignItems: "center", gap: 5, marginRight: 14, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={editing.form.triggerWhen.includes(trigger)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...editing.form.triggerWhen, trigger]
                        : editing.form.triggerWhen.filter((item) => item !== trigger);
                      setEditing({ ...editing, form: { ...editing.form, triggerWhen: next } });
                    }}
                  />
                  {triggerWhenLabels[trigger]}
                </label>
              ))}
            </div>

            <div style={{ fontSize: 12, marginBottom: 8 }}>
              <span style={{ display: "block", marginBottom: 4, color: "var(--color-text-secondary)" }}>执行条件</span>
              {([
                { value: "and", label: "满足以下所有条件" },
                { value: "or", label: "满足以下任一条件" },
                { value: "none", label: "无条件限制" },
              ] as const).map((option) => (
                <label key={option.value} style={{ display: "inline-flex", alignItems: "center", gap: 5, marginRight: 14, cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="condition-logic"
                    checked={editing.form.conditionLogic === option.value}
                    onChange={() => setEditing({ ...editing, form: { ...editing.form, conditionLogic: option.value } })}
                  />
                  {option.label}
                </label>
              ))}
            </div>

            {editing.form.conditionLogic !== "none" && (
              <div style={{ border: "1px solid var(--color-border)", borderRadius: 8, padding: 8, marginBottom: 10 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {editing.form.conditions.map((condition, index) => (
                    <div key={index} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <select
                        value={condition.field}
                        onChange={(event) => {
                          const conditions = [...editing.form.conditions];
                          conditions[index] = { ...conditions[index], field: event.target.value as ConditionField };
                          setEditing({ ...editing, form: { ...editing.form, conditions } });
                        }}
                        style={fieldSelect}
                      >
                        {(Object.keys(CONDITION_FIELD_LABELS) as ConditionField[]).map((field) => (
                          <option key={field} value={field}>{CONDITION_FIELD_LABELS[field]}</option>
                        ))}
                      </select>
                      <select
                        value={condition.op}
                        onChange={(event) => {
                          const conditions = [...editing.form.conditions];
                          conditions[index] = { ...conditions[index], op: event.target.value as ConditionOp };
                          setEditing({ ...editing, form: { ...editing.form, conditions } });
                        }}
                        style={fieldSelect}
                      >
                        {(Object.keys(CONDITION_OP_LABELS) as ConditionOp[]).map((op) => (
                          <option key={op} value={op}>{CONDITION_OP_LABELS[op]}</option>
                        ))}
                      </select>
                      {condition.field !== "has_attachment" ? (
                        <input
                          value={condition.value}
                          onChange={(event) => {
                            const conditions = [...editing.form.conditions];
                            conditions[index] = { ...conditions[index], value: event.target.value };
                            setEditing({ ...editing, form: { ...editing.form, conditions } });
                          }}
                          placeholder="值"
                          style={{ flex: 1, minWidth: 120, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)", fontSize: 12 }}
                        />
                      ) : (
                        <select
                          value={condition.value || "true"}
                          onChange={(event) => {
                            const conditions = [...editing.form.conditions];
                            conditions[index] = { ...conditions[index], value: event.target.value };
                            setEditing({ ...editing, form: { ...editing.form, conditions } });
                          }}
                          style={{ ...fieldSelect, flex: 1, minWidth: 120 }}
                        >
                          <option value="true">有附件</option>
                          <option value="false">无附件</option>
                        </select>
                      )}
                      <button type="button" onClick={() => setEditing({ ...editing, form: { ...editing.form, conditions: editing.form.conditions.filter((_, i) => i !== index) } })} style={iconBtnSmall} title="删除条件">
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
                <button type="button" onClick={() => setEditing({ ...editing, form: { ...editing.form, conditions: [...editing.form.conditions, { ...DEFAULT_CONDITION }] } })} style={{ ...smallBtn, marginTop: 6 }}>
                  <Plus size={12} />添加条件
                </button>
              </div>
            )}

            <div style={{ border: "1px solid var(--color-border)", borderRadius: 8, padding: 8, marginBottom: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {editing.form.actions.map((action, index) => (
                  <div key={index} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <select
                      value={action.type}
                      onChange={(event) => {
                        const actions = [...editing.form.actions];
                        actions[index] = { type: event.target.value as ActionType, value: undefined };
                        setEditing({ ...editing, form: { ...editing.form, actions } });
                      }}
                      style={fieldSelect}
                    >
                      {(Object.keys(ACTION_LABELS) as ActionType[]).map((type) => (
                        <option key={type} value={type}>{ACTION_LABELS[type]}</option>
                      ))}
                    </select>
                    {action.type === "MoveToFolder" && (
                      <select
                        value={action.value ?? ""}
                        onChange={(event) => {
                          const actions = [...editing.form.actions];
                          actions[index] = { ...actions[index], value: event.target.value };
                          setEditing({ ...editing, form: { ...editing.form, actions } });
                        }}
                        style={{ ...fieldSelect, flex: 1, minWidth: 160 }}
                      >
                        <option value="">选择文件夹…</option>
                        {accountFolders.map((folder) => (
                          <option key={folder.id} value={folder.id}>{folder.name}</option>
                        ))}
                      </select>
                    )}
                    {action.type === "AddLabel" && (
                      <input
                        value={action.value ?? ""}
                        onChange={(event) => {
                          const actions = [...editing.form.actions];
                          actions[index] = { ...actions[index], value: event.target.value };
                          setEditing({ ...editing, form: { ...editing.form, actions } });
                        }}
                        placeholder="标签名，如：客户/重要"
                        style={{ flex: 1, minWidth: 160, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)", fontSize: 12 }}
                      />
                    )}
                    {action.type === "SetKanbanColumn" && (
                      <select
                        value={action.value ?? "todo"}
                        onChange={(event) => {
                          const actions = [...editing.form.actions];
                          actions[index] = { ...actions[index], value: event.target.value };
                          setEditing({ ...editing, form: { ...editing.form, actions } });
                        }}
                        style={{ ...fieldSelect, flex: 1, minWidth: 120 }}
                      >
                        {(Object.keys(KANBAN_LABELS)).map((column) => (
                          <option key={column} value={column}>{KANBAN_LABELS[column]}</option>
                        ))}
                      </select>
                    )}
                    <button type="button" onClick={() => setEditing({ ...editing, form: { ...editing.form, actions: editing.form.actions.filter((_, i) => i !== index) } })} style={iconBtnSmall} title="删除动作">
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" onClick={() => setEditing({ ...editing, form: { ...editing.form, actions: [...editing.form.actions, { ...DEFAULT_ACTION }] } })} style={{ ...smallBtn, marginTop: 6 }}>
                <Plus size={12} />添加动作
              </button>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={() => setEditing(null)}>取消</button>
              <button type="button" onClick={() => void saveRule()} style={{ padding: "6px 14px", border: 0, borderRadius: 6, background: "var(--color-accent)", color: "#fff", cursor: "pointer" }}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── 手动执行规则弹窗 ─── */}
      {execTarget && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.45)" }} onClick={() => { setExecTarget(null); setExecReport(null); }}>
          <div style={{ width: 520, maxWidth: "92vw", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 10, padding: 16, boxShadow: "0 10px 30px rgba(0,0,0,0.2)" }} onClick={(event) => event.stopPropagation()}>
            <h3 style={{ margin: "0 0 10px", fontSize: 15, display: "flex", alignItems: "center", gap: 6 }}>
              <Play size={15} />执行规则{execTarget.rule ? `：${execTarget.rule.name}` : ""}
            </h3>
            <p style={{ fontSize: 12.5, color: "var(--color-text-secondary)", margin: "0 0 12px" }}>
              选择要套用规则的文件夹，程序会逐封检查该文件夹里的邮件并执行符合条件的动作（移动到文件夹、打标签、标记已读等）。不会删除任何邮件。
            </p>
            <label style={{ display: "block", fontSize: 12, marginBottom: 12 }}>
              <span style={{ display: "block", marginBottom: 4, color: "var(--color-text-secondary)" }}>要套用规则的文件夹</span>
              <select value={execFolderId} onChange={(event) => setExecFolderId(event.target.value)} style={{ width: "100%", padding: "7px 9px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)" }}>
                <option value="">选择文件夹…</option>
                {accountFolders.map((folder) => (
                  <option key={folder.id} value={folder.id}>{folder.name}</option>
                ))}
              </select>
            </label>

            {execRunning && (
              <div style={{ marginBottom: 12, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-bg-secondary)", fontSize: 12.5 }}>
                <div style={{ fontWeight: 600, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: "50%", border: "2px solid var(--color-accent)", borderTopColor: "transparent", animation: "spin 0.8s linear infinite" }} />
                  正在后台执行…
                </div>
                <div style={{ color: "var(--color-text-secondary)" }}>
                  {execProgress
                    ? `已检查 ${execProgress.processed} 封 · 命中 ${execProgress.matched} 封（可关掉此窗口继续做其他事，完成后会提示）`
                    : "准备中…（可关掉此窗口继续做其他事，完成后会提示）"}
                </div>
              </div>
            )}

            {execReport && (
              <div style={{ marginBottom: 12, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-bg-secondary)", fontSize: 12.5 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>执行报告</div>
                <div>共检查 <strong>{execReport.processed}</strong> 封 · 命中规则 <strong>{execReport.matched}</strong> 封 · 应用动作 <strong>{execReport.actions_applied}</strong> 次</div>
                {execReport.matched_messages.length > 0 && (
                  <div style={{ marginTop: 6, maxHeight: 140, overflow: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
                    {execReport.matched_messages.slice(0, 50).map((message, index) => (
                      <div key={index} style={{ fontSize: 11.5, display: "flex", gap: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <span style={{ color: "#2f855a", flexShrink: 0 }}>✓</span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{message.subject}（{message.from_address}）</span>
                      </div>
                    ))}
                  </div>
                )}
                {execReport.errors.length > 0 && (
                  <div style={{ marginTop: 6, maxHeight: 120, overflow: "auto", color: "#b42318", fontSize: 11.5, display: "flex", flexDirection: "column", gap: 3 }}>
                    {execReport.errors.slice(0, 20).map((error, index) => (
                      <div key={index} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>✗ {error.subject}：{error.error}</div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={() => { setExecTarget(null); setExecReport(null); }}>关闭</button>
              <button
                type="button"
                disabled={execRunning || !execFolderId}
                onClick={() => void runExecute()}
                style={{ padding: "6px 14px", border: 0, borderRadius: 6, background: "var(--color-accent)", color: "#fff", cursor: execRunning ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}
              >
                {execRunning ? "执行中…" : <><Play size={13} />开始执行</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────

const fieldSelect: React.CSSProperties = {
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--color-border)",
  background: "var(--color-bg-secondary)",
  color: "var(--color-text-primary)",
  fontSize: 12,
};

const smallBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "4px 8px", fontSize: 12,
  border: "1px solid var(--color-border)", borderRadius: 6,
  background: "transparent", color: "var(--color-text-primary)", cursor: "pointer",
};

const iconBtnSmall: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 26, height: 26, border: "none", borderRadius: 6,
  background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer",
};

/** 解析 trigger_when JSON，兼容旧数据（空数组/非法返回 []）。 */
function parseTriggerWhen(json: string): string[] {
  try {
    const value = JSON.parse(json || "[]");
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && (item === "on_receive" || item === "on_send"));
    }
  } catch { /* 忽略 */ }
  return ["on_receive"];
}

/** 从 conditions JSON 推断条件逻辑（旧数据没有 operator 时默认 and；无条件返回 none）。 */
function parseConditionLogic(json: string): "and" | "or" | "none" {
  try {
    const parsed = JSON.parse(json || "{}");
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.conditions) && parsed.conditions.length === 0) {
      return "none";
    }
    if (parsed && parsed.operator === "or") return "or";
    if (parsed && parsed.operator === "and") return "and";
    // 兼容旧数据：直接是数组（无 operator 包装）
    if (Array.isArray(parsed)) {
      return parsed.length === 0 ? "none" : "and";
    }
  } catch { /* 忽略 */ }
  return "and";
}

/** 根据条件逻辑构建 conditions JSON（与后端 RuleConditionSet 兼容）。 */
function buildConditionsJson(form: RuleFormData): string {
  if (form.conditionLogic === "none") {
    return JSON.stringify({ operator: "and", conditions: [] });
  }
  const conditions = form.conditions
    .filter((condition) => condition.field !== "has_attachment" || condition.value === "true")
    .map((condition) => ({ field: condition.field, op: condition.op, value: condition.value }));
  return JSON.stringify({ operator: form.conditionLogic, conditions });
}
