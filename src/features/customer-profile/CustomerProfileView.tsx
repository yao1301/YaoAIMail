import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, Plus, Trash2, Search, CalendarClock, RefreshCw, PenLine, Columns3, List, Mail, ShieldCheck } from "lucide-react";
import ContextMenu from "@/components/ContextMenu";
import {
  listCustomerMemories,
  saveCustomerMemory,
  deleteCustomerMemory,
  listAddressBookContacts,
  listCompanyResearch,
  researchCompany,
  listAccounts,
  buildCustomerMemory,
  agentRun,
  listThreadMessages,
  type CustomerMemory,
  type Account,
  type AddressBookContact,
  type CompanyResearchReport,
  type FollowUpEntry,
  type FollowUpSequenceStep,
  type SearchHit,
  searchMessages,
} from "@/lib/api";
import { useMailStore } from "@/stores/mail.store";
import { useUIStore } from "@/stores/ui.store";
import { useToastStore } from "@/stores/toast.store";
import { useBackgroundTasksStore } from "@/stores/backgroundTasks.store";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { formatProfileText } from "@/lib/profileText";

const SOURCE_TAGS = ["展会", "社媒", "谷歌开发", "邮件往来", "官网询盘", "客户转介绍", "其他"];
/** 跟进阶段（唯一互斥，按销售漏斗推进） */
const STAGE_TAGS = ["待开发", "已联系", "已报价", "已寄样", "谈判中", "已成交", "流失"];
/** 特征标签（可多选） */
const FEATURE_TAGS = ["价格敏感", "质量优先", "交期紧急", "需要认证", "定制需求", "要过样品", "长期合作", "有竞品关系"];
/** 客户分层：存 A/B/C，界面显示中文（重点客户/常规客户/培育客户） */
const TIER_TAGS: Array<{ value: string; label: string }> = [
  { value: "A", label: "重点客户" },
  { value: "B", label: "常规客户" },
  { value: "C", label: "培育客户" },
];
function tierLabel(value: string | undefined | null): string {
  return TIER_TAGS.find((t) => t.value === value)?.label ?? value ?? "";
}
function tierColor(value: string): string {
  return value === "A" ? "#dc3545" : value === "B" ? "#f59e0b" : "#6b7280";
}

const FOLLOW_CHANNELS = ["邮件", "电话", "WhatsApp", "微信", "展会", "样品", "其他"];

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  border: "1px solid var(--color-border)",
  borderRadius: "6px",
  background: "#fff",
  color: "var(--color-text-primary)",
  fontSize: "13px",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "12px",
  marginBottom: "5px",
  color: "var(--color-text-secondary)",
};

function tagChip(active: boolean): React.CSSProperties {
  return {
    border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border)"}`,
    borderRadius: "14px",
    padding: "4px 10px",
    fontSize: "12px",
    background: active ? "color-mix(in srgb, var(--color-accent) 16%, transparent)" : "transparent",
    color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
    cursor: "pointer",
  };
}

type ProfileForm = Pick<CustomerMemory, "email" | "name" | "company" | "summary" | "profile" | "source" | "status" | "stage" | "tags" | "tier" | "nextFollowUp" | "followUps" | "accountIds" | "followUpSequence" | "followUpSequencePaused">;

function emptyForm(): ProfileForm {
  return { email: "", name: "", company: "", summary: "", profile: "", source: "", status: "", stage: "", tags: [], tier: "", nextFollowUp: 0, followUps: [], accountIds: [], followUpSequence: [], followUpSequencePaused: false };
}

/** 客户管理：现有客户的全面画像 + 跟进标记（来源/阶段/特征标签/分层）+ 跟进记录。 */
export default function CustomerProfileView() {
  const [memories, setMemories] = useState<CustomerMemory[]>([]);
  const [contacts, setContacts] = useState<AddressBookContact[]>([]);
  const [researches, setResearches] = useState<CompanyResearchReport[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [form, setForm] = useState(emptyForm());
  const customerSearchStore = useUIStore((s) => s.customerProfileSearch);
  const customerFilterStore = useUIStore((s) => s.customerProfileFilter);
  const setCustomerSearch = useUIStore((s) => s.setCustomerProfileSearch);
  const setCustomerFilter = useUIStore((s) => s.setCustomerProfileFilter);
  const [search, setSearch] = useState(customerSearchStore);
  const [tagFilter, setTagFilter] = useState(customerFilterStore);
  const [accountFilter, setAccountFilter] = useState("all");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [busy, setBusy] = useState(false);
  const [generatedSources, setGeneratedSources] = useState<string[]>([]);
  const [followChannel, setFollowChannel] = useState("邮件");
  const [followNote, setFollowNote] = useState("");
  const profileTask = useBackgroundTasksStore((state) => state.tasks.customerProfile);
  const startTask = useBackgroundTasksStore((state) => state.start);
  const clearTask = useBackgroundTasksStore((state) => state.clear);
  const researchTask = useBackgroundTasksStore((state) => state.tasks.customerCompanyResearch);
  const researching = researchTask?.status === "running";
  const emailInputRef = useRef<HTMLInputElement>(null);
  const [memoryMenu, setMemoryMenu] = useState<{ x: number; y: number; memory: CustomerMemory } | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "kanban">("list");
  const [emailActivities, setEmailActivities] = useState<SearchHit[]>([]);
  const [nextAction, setNextAction] = useState("");

  const customerProfileEmail = useUIStore((s) => s.customerProfileEmail);

  function handleSearchChange(q: string) {
    setSearch(q);
    setCustomerSearch(q);
  }
  function handleFilterChange(f: string) {
    setTagFilter(f);
    setCustomerFilter(f);
  }

  async function refreshMemories(preferredEmail?: string) {
    // memories 与 accounts 分开：accounts 失败不应阻塞客户列表
    const [list] = await Promise.all([listCustomerMemories()]);
    setMemories(list);
    void listAccounts()
      .then((accList) => setAccounts(accList))
      .catch(() => {});
    if (preferredEmail) {
      const match = list.find(
        (m) => m.email.toLowerCase() === preferredEmail.toLowerCase()
          || m.contacts.some((c) => c.email.toLowerCase() === preferredEmail.toLowerCase()),
      );
      if (match) {
        selectMemory(match);
        return;
      }
    }
  }

  useEffect(() => {
    let cancelled = false;
    listCustomerMemories()
      .then((list) => { if (!cancelled) setMemories(list); })
      .catch(() => {});
    listAddressBookContacts()
      .then((list) => { if (!cancelled) setContacts(list); })
      .catch(() => {});
    listCompanyResearch()
      .then((list) => { if (!cancelled) setResearches(list); })
      .catch(() => {});
    listAccounts()
      .then((list) => { if (!cancelled) setAccounts(list); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  /** 客户资信调研完成 → 刷新调研列表（新报告会出现在该客户名下）。 */
  useEffect(() => {
    if (researchTask?.status !== "success" || !researchTask.result) return;
    void listCompanyResearch().then((list) => setResearches(list)).catch(() => {});
    clearTask("customerCompanyResearch");
  }, [researchTask, clearTask]);

  /** 对当前客户发起资信调研：优先用公司名，网站取客户邮箱域名。 */
  async function handleRunResearch() {
    const company = form.company.trim();
    const email = form.email.trim();
    if (!company && !email) {
      useToastStore.getState().addToast({ message: "请先填写客户的公司名称或邮箱，再生成资信调研。", type: "error" });
      return;
    }
    const domain = email.includes("@") ? email.split("@")[1]?.trim() : "";
    startTask("customerCompanyResearch", `资信调研（${company || email}）`, async () => {
      const report = await researchCompany(company, domain, "");
      return report;
    }, { successMessage: "资信调研已完成，结果已加入该客户。" });
  }

  /** 当前客户的调研记录：按公司名或邮箱域名匹配。 */
  const customerResearches = useMemo(() => {
    const company = form.company.trim().toLowerCase().replace(/\s+/g, "");
    const email = form.email.trim().toLowerCase();
    const domain = email.includes("@") ? email.split("@")[1] ?? "" : "";
    return researches.filter((r) => {
      const rCompany = (r.companyName || "").toLowerCase().replace(/\s+/g, "");
      const rWebsite = (r.website || "").toLowerCase();
      if (company && (rCompany.includes(company) || company.includes(rCompany))) return true;
      if (domain && (rWebsite === domain || rWebsite.endsWith(`.${domain}`) || domain.endsWith(rWebsite))) return true;
      if (domain && r.publicEmails.some((e) => e.toLowerCase().endsWith(`@${domain}`))) return true;
      return false;
    });
  }, [researches, form.company, form.email]);

  // 从地址本跳转过来：预填邮箱并新建画像
  useEffect(() => {
    if (customerProfileEmail) {
      const email = customerProfileEmail;
      useUIStore.getState().setCustomerProfileEmail(null);
      const existing = memories.find(
        (m) => m.email.toLowerCase() === email.toLowerCase()
          || m.contacts.some((c) => c.email.toLowerCase() === email.toLowerCase()),
      );
      if (existing) {
        selectMemory(existing);
      } else {
        setSelectedId("");
        setForm({ ...emptyForm(), email });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerProfileEmail]);

  function selectMemory(m: CustomerMemory) {
    setSelectedId(m.id);
    setForm({
      email: m.email,
      name: m.name,
      company: m.company,
      summary: m.summary,
      profile: m.profile,
      source: m.source,
      status: m.status,
      stage: m.stage,
      tags: m.tags,
      tier: m.tier,
      nextFollowUp: m.nextFollowUp,
      followUps: m.followUps,
      accountIds: m.accountIds ?? [],
      followUpSequence: m.followUpSequence ?? [],
      followUpSequencePaused: m.followUpSequencePaused ?? false,
    });
  }

  useEffect(() => {
    if (!form.email.trim()) { setEmailActivities([]); return; }
    let cancelled = false;
    void searchMessages(form.email.trim(), 80).then((hits) => {
      if (!cancelled) setEmailActivities(hits.sort((a, b) => (b.date || 0) - (a.date || 0)));
    }).catch(() => { if (!cancelled) setEmailActivities([]); });
    return () => { cancelled = true; };
  }, [selectedId, form.email]);

  useEffect(() => {
    const sequenceStart = Math.min(...(form.followUpSequence ?? []).map((step) => step.dueAt));
    if (!Number.isFinite(sequenceStart) || form.followUpSequencePaused) return;
    const hasNewReply = emailActivities.some((hit) =>
      hit.from_address?.trim().toLowerCase() === form.email.trim().toLowerCase()
      && (hit.date || 0) * 1000 >= sequenceStart,
    );
    if (hasNewReply) setForm((old) => ({ ...old, followUpSequencePaused: true }));
  }, [emailActivities, form.email, form.followUpSequence, form.followUpSequencePaused]);

  function newProfile() {
    setSelectedId("");
    setForm(emptyForm());
    setGeneratedSources([]);
    emailInputRef.current?.focus();
  }

  // 后台生成画像完成 → 填充表单 + 自动追加邮件跟进记录
  // （组件重挂载后仍会执行；把生成时的邮箱/公司/姓名一并带回，避免丢失）
  useEffect(() => {
    const task = profileTask;
    if (task?.status !== "success" || !task.result) return;
    const r = task.result as {
      email?: string;
      name?: string;
      company?: string;
      companyReset?: boolean;
      profile?: string;
      summary?: string;
      followUp?: FollowUpEntry;
      sources?: string[];
    };
    // 归属校验：任务是为哪个邮箱生成的，就只能填进哪个客户的表单。
    // 否则在 A 客户启动生成、切到 B 客户后，任务完成会把 A 的画像
    // 覆盖进 B 的表单（张冠李戴）。
    const taskEmail = (r.email ?? "").trim().toLowerCase();
    const currentEmail = (form.email ?? "").trim().toLowerCase();
    if (taskEmail && currentEmail && taskEmail !== currentEmail) {
      clearTask("customerProfile");
      return;
    }
    setForm((old) => ({
      ...old,
      email: r.email || old.email,
      name: r.name || old.name,
      // companyReset=true（域名与公司名冲突）：清掉脏公司名，避免再次误导 AI
      company: r.companyReset ? "" : (r.company || old.company),
      summary: r.summary || old.summary,
      profile: r.profile || old.profile,
      followUps: r.followUp ? [r.followUp, ...(old.followUps ?? [])] : old.followUps,
    }));
    setGeneratedSources(r.sources ?? []);
    clearTask("customerProfile");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileTask, clearTask, form.email]);

  // 更新画像完成 → 更新表单
  const updateTask = useBackgroundTasksStore((state) => state.tasks.customerProfileUpdate);
  useEffect(() => {
    const task = updateTask;
    if (task?.status !== "success" || !task.result) return;
    const r = task.result as {
      email?: string;
      summary?: string;
      profile?: string;
      followUp?: FollowUpEntry;
      accountIds?: string[];
    };
    // 归属校验：任务结果只能填进它对应的客户表单，
    // 避免在 A 客户启动更新、切到 B 后把 A 的画像覆盖进 B。
    const taskEmail = (r.email ?? "").trim().toLowerCase();
    const currentEmail = (form.email ?? "").trim().toLowerCase();
    if (taskEmail && currentEmail && taskEmail !== currentEmail) {
      clearTask("customerProfileUpdate");
      return;
    }
    setForm((old) => ({
      ...old,
      summary: r.summary || old.summary,
      profile: r.profile ? formatProfileText(r.profile) : old.profile,
      followUps: r.followUp ? [r.followUp, ...(old.followUps ?? [])] : old.followUps,
      accountIds: (r.accountIds && r.accountIds.length > 0) ? r.accountIds : old.accountIds,
    }));
    clearTask("customerProfileUpdate");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateTask, clearTask, form.email]);

  // 列表右键"更新画像"完成 → 刷新列表
  const listUpdateTask = useBackgroundTasksStore((state) => state.tasks.customerProfileListUpdate);
  useEffect(() => {
    if (listUpdateTask?.status !== "success") return;
    void refreshMemories().then(() => clearTask("customerProfileListUpdate"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listUpdateTask, clearTask]);

  /** 列表右键：更新并直接保存该客户的画像（后台运行）。 */
  function updateAndSaveMemory(m: CustomerMemory) {
    if (m.email === form.email) {
      // 当前正在编辑该客户 → 走表单更新流程
      setSelectedId(m.id);
      selectMemory(m);
      updateProfile(m.email);
      return;
    }
    startTask("customerProfileListUpdate", `更新画像（${m.email}）`, async () => {
      const updated = await buildCustomerMemory(m.email, 500, m.profile || "");
      return saveCustomerMemory({
        id: m.id,
        email: m.email,
        name: updated.name || m.name,
        company: updated.company || m.company,
        summary: updated.summary,
        profile: updated.profile,
        source: m.source,
        status: m.status,
        stage: m.stage,
        tags: m.tags,
        tier: m.tier,
        nextFollowUp: m.nextFollowUp,
        followUps: m.followUps,
        accountIds: updated.accountIds ?? m.accountIds ?? [],
        followUpSequence: m.followUpSequence ?? [],
        followUpSequencePaused: m.followUpSequencePaused ?? false,
      });
    }, { successMessage: `「${m.email}」画像已更新` });
  }

  /** 更新画像：重新获取该客户的所有往来邮件 + AI 增量更新（保留原有画像），
   *  完成后自动追加一条"邮件"跟进记录。 */
  function updateProfile(emailOverride?: string) {
    const emailForTask = (emailOverride || form.email).trim();
    if (!emailForTask) {
      useToastStore.getState().addToast({ message: "请先填写客户邮箱", type: "error" });
      return;
    }
    const existingProfile = form.profile || "";
    startTask("customerProfileUpdate", "更新客户画像（重新获取全部邮件）", async () => {
      // limit 传大值：尽量覆盖全部往来邮件（后端按时间取最新 N 封分析）
      const updated = await buildCustomerMemory(emailForTask, 500, existingProfile);
      const followUp: FollowUpEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        date: Date.now(),
        channel: "邮件",
        note: `已根据最新往来邮件更新画像（分析 ${updated.messageCount} 封邮件）`,
      };
      return {
        email: emailForTask,
        summary: updated.summary,
        profile: updated.profile,
        followUp,
        accountIds: updated.accountIds ?? [],
      };
    }, {
      successMessage: "画像已按最新邮件更新",
    });
  }

  function addFollowUp() {
    if (!followNote.trim()) return;
    const entry: FollowUpEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date: Date.now(),
      channel: followChannel,
      note: followNote.trim(),
    };
    setForm((old) => ({ ...old, followUps: [entry, ...(old.followUps ?? [])] }));
    setFollowNote("");
  }

  function removeFollowUp(id: string) {
    setForm((old) => ({ ...old, followUps: (old.followUps ?? []).filter((f) => f.id !== id) }));
  }

  function pickContact(contact: AddressBookContact) {
    setForm((old) => ({
      ...old,
      email: contact.email,
      name: old.name || contact.name,
      company: old.company || contact.company,
      // 从地址本带过来时自动关联其归属账号
      accountIds: contact.accountId && !(old.accountIds ?? []).includes(contact.accountId)
        ? [...(old.accountIds ?? []), contact.accountId]
        : old.accountIds ?? [],
    }));
  }

  const filteredMemories = useMemo(() => {
    const q = search.trim().toLowerCase();
    return memories.filter((m) => {
      if (tagFilter && m.source !== tagFilter && m.stage !== tagFilter && m.status !== tagFilter && m.tier !== tagFilter) return false;
      // 账号筛选：多账号下按接触账号区分
      if (accountFilter !== "all" && !(m.accountIds ?? []).includes(accountFilter)) return false;
      if (!q) return true;
      return [m.email, m.name, m.company, m.summary].some((v) => v.toLowerCase().includes(q));
    });
  }, [memories, search, tagFilter, accountFilter]);

  const filteredContacts = useMemo(() => {
    if (!tagFilter) return contacts;
    return contacts.filter((c) => c.role === tagFilter || c.tags.includes(tagFilter));
  }, [contacts, tagFilter]);

  async function save() {
    if (!form.email.trim()) {
      useToastStore.getState().addToast({ message: "请填写客户邮箱", type: "error" });
      return;
    }
    // 客户必须关联具体账号："全部账号"只是汇总视图
    if ((form.accountIds ?? []).length === 0) {
      useToastStore.getState().addToast({ message: "请至少关联一个账号（客户归属具体账号才能按账号管理；可从地址本选择联系人自动带出）。", type: "error" });
      return;
    }
    setBusy(true);
    try {
      const saved = await saveCustomerMemory({
        id: selectedId || undefined,
        email: form.email.trim(),
        name: form.name,
        company: form.company,
        summary: form.summary,
        profile: form.profile,
        source: form.source,
        status: form.status,
        stage: form.stage,
        tags: form.tags,
        tier: form.tier,
        nextFollowUp: form.nextFollowUp,
        followUps: form.followUps,
        accountIds: form.accountIds ?? [],
        followUpSequence: form.followUpSequence ?? [],
        followUpSequencePaused: form.followUpSequencePaused ?? false,
      });
      setSelectedId(saved.id);
      // 本地更新列表，不依赖网络刷新（刷新失败也不影响保存结果展示）
      setMemories((old) => {
        const exists = old.some((m) => m.id === saved.id);
        const next = exists ? old.map((m) => (m.id === saved.id ? saved : m)) : [saved, ...old];
        return next;
      });
      void refreshMemories().catch(() => {});
      useToastStore.getState().addToast({ message: "客户画像已保存", type: "success" });
    } catch (err) {
      useToastStore.getState().addToast({ message: `保存失败：${extractErrorMessage(err)}`, type: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selectedId) return;
    setBusy(true);
    try {
      const list = await deleteCustomerMemory(selectedId);
      setMemories(list);
      setSelectedId("");
      setForm(emptyForm());
      useToastStore.getState().addToast({ message: "已删除客户画像", type: "success" });
    } catch (err) {
      useToastStore.getState().addToast({ message: `删除失败：${extractErrorMessage(err)}`, type: "error" });
    } finally {
      setBusy(false);
    }
  }

  /** 生成客户画像：Agent 自主联网（web_search/fetch_url/GLEIF）+ 当前邮件上下文 → AI 画像。
   *  后台任务运行，切换页面不中断；完成后自动补一条"邮件跟进记录"。 */
  async function generateProfile() {
    if (!form.email.trim() && !form.company.trim()) {
      useToastStore.getState().addToast({ message: "请先填写客户邮箱或公司名", type: "error" });
      return;
    }
    setGeneratedSources([]);
    const emailForTask = form.email;
    const nameForTask = form.name;
    // 域名-公司名冲突检测：如果邮箱域名与填写的公司名明显不匹配
    // （如 secondflor.com vs Florador Group），说明公司名字段可能是
    // 历史脏数据/串了别的客户。此时以邮箱域名为准，不把公司名传给 AI，
    // 避免 AI 按错误公司名搜索、生成张冠李戴的画像。
    let companyForTask = form.company;
    let companyConflict = false;
    if (emailForTask.trim() && companyForTask.trim()) {
      const domainPart = emailForTask.split("@")[1]?.split(".")[0]?.toLowerCase() ?? "";
      const companyWords = companyForTask.toLowerCase().replace(/[^a-z0-9]/g, " ").split(/\s+/).filter((w) => w.length >= 3);
      if (domainPart && companyWords.length > 0 && !companyWords.some((w) => domainPart.includes(w) || w.includes(domainPart))) {
        companyConflict = true;
        companyForTask = "";
      }
    }

    startTask("customerProfile", "生成客户画像（AI 联网）", async () => {
      // 当前打开的邮件线程作为上下文
      let mailContext = "";
      let threadCount = 0;
      let lastSubject = "";
      try {
        const messageId = useMailStore.getState().selectedMessageId;
        if (messageId) {
          const thread = await listThreadMessages(messageId);
          threadCount = thread.length;
          const recent = thread
            .sort((a, b) => a.date - b.date)
            .slice(-4)
            .map((msg) => `${msg.from_name || msg.from_address} → ${msg.subject}\n${msg.body_text.slice(0, 1200)}`)
            .join("\n---\n");
          mailContext = recent ? `与客户往来的邮件（最近 ${thread.slice(-4).length} 封）：\n${recent}` : "";
          lastSubject = thread[thread.length - 1]?.subject ?? "";
        }
      } catch {
        mailContext = "";
      }

      const system = `你是一位资深外贸客户画像分析师。你可以使用 web_search / fetch_url / gleif_company 工具自主联网搜索该客户的公开信息（官网、主营产品、公司规模、行业地位、新闻动态等），再结合提供的往来邮件，生成一份精炼的客户画像。
要求：
1. 用中文输出，直接给结论，不要客套话。
2. 结构分点：客户概况（公司/地区/规模）→ 业务特征（主营产品/采购模式/决策关键点）→ 与我方往来情况 → 沟通要点（时区/语言/沟通偏好）→ 机会与风险。
3. 区分已知事实与推测，推测必须标注（推测）。
4. 信息不足时明确写出"缺失：xxx"，绝不编造具体数字、价格、订单。
5. 末尾另起一段列出你实际使用的信息来源网址（如果有）。
6. 即使 web_search 工具不可用，也必须用 fetch_url 或你的知识完成任务，最后必须输出完整画像。`;
      const user = [
        emailForTask ? `客户邮箱：${emailForTask}` : "",
        nameForTask ? `联系人：${nameForTask}` : "",
        companyForTask ? `公司：${companyForTask}` : "",
        `【重要】该客户的身份以"客户邮箱"（尤其是邮箱域名，如 secondflor.com）为准。请严格围绕该邮箱对应的公司做调研，不要把它和名字相似、域名相近的其他公司（如 florador.eu 等）混淆；如果邮箱域名与填写的公司名不一致，以邮箱域名为准并说明这个差异。`,
        mailContext ? `【与客户的往来邮件】\n${mailContext}` : "",
      ].filter(Boolean).join("\n\n");

      const result = await agentRun(system, user || "（无额外信息，请联网搜索后给出客户画像框架）");
      const clean = formatProfileText(result.content);
      const followUp: FollowUpEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        date: Date.now(),
        channel: "邮件",
        note: threadCount > 0
          ? `AI 生成画像时分析了 ${threadCount} 封往来邮件${lastSubject ? `，最近一封主题：${lastSubject.slice(0, 60)}` : ""}`
          : "AI 生成画像（未关联往来邮件）",
      };
      return {
        email: emailForTask,
        name: nameForTask,
        company: companyForTask,
        companyReset: companyConflict,
        profile: clean,
        summary: clean.split("\n").find((l) => l.trim())?.slice(0, 90) ?? "",
        followUp,
        sources: result.sources,
      };
    }, {
      successMessage: "客户画像已生成（后台完成），已自动记录邮件跟进",
    });
  }

  function createFollowUpSequence() {
    const now = Date.now();
    const definitions = [
      [0, "首次联系", "结合客户背景说明匹配价值，提出一个低门槛问题"],
      [3, "价值补充", "补充一个产品优势、案例或资料，不重复首封"],
      [7, "需求确认", "询问采购计划、规格、数量或当前供应难点"],
      [14, "礼貌收尾", "简短确认是否暂不推进，并保留未来联系入口"],
    ] as const;
    const steps: FollowUpSequenceStep[] = definitions.map(([dayOffset, title, instruction]) => ({
      id: crypto.randomUUID(), dayOffset, title, instruction, status: "pending", dueAt: now + dayOffset * 86_400_000,
    }));
    setForm((old) => ({ ...old, followUpSequence: steps, followUpSequencePaused: false, nextFollowUp: steps[0].dueAt }));
  }

  function suggestNextActionLocally() {
    const lastMail = emailActivities[0];
    const stage = form.stage || "待开发";
    const overdue = form.nextFollowUp > 0 && form.nextFollowUp < Date.now();
    const action = stage === "已成交" ? "核对交付、付款和复购节点，安排一次交付后的满意度回访。"
      : stage === "流失" ? "暂不继续高频联系；记录流失原因，并设置一个较长期的市场变化提醒。"
      : stage === "已报价" ? "确认客户是否收到报价，优先询问规格、价格或交期中哪一项仍需澄清。"
      : stage === "已寄样" ? "确认样品签收和测试时间，约定明确的反馈日期与评价标准。"
      : stage === "谈判中" ? "列出尚未确认的商业条款，只推动一个最关键的下一步，避免同时追问过多问题。"
      : stage === "已联系" ? "提供一个与客户业务直接相关的价值点，并提出一个 30 秒即可回答的问题。"
      : "先确认客户与产品的匹配点，再发送一封短而具体的首次开发邮件。";
    setNextAction(`${overdue ? "【已逾期】" : ""}${action}${lastMail?.subject ? ` 最近邮件主题：“${lastMail.subject}”。` : ""}`);
  }

  function openSequenceDraft(step: FollowUpSequenceStep) {
    const instruction = `给 ${form.name || form.company || form.email} <${form.email}> 写跟进邮件。当前阶段：${form.stage || "待开发"}。本次目标：${step.instruction}。请先检查当前打开的邮件上下文和用户选择的资料，再生成草稿。`;
    const ui = useUIStore.getState();
    ui.setAiWritingTurns([...ui.aiWritingTurns, { role: "user", content: instruction }]);
    ui.openRightPanel("aiWriting");
    setForm((old) => ({ ...old, followUpSequence: old.followUpSequence.map((item) => item.id === step.id ? { ...item, status: "draft_ready" } : item) }));
    useToastStore.getState().addToast({ message: "跟进任务已准备好，请在 AI 写作中结合邮件上下文生成草稿", type: "info" });
  }

  if (viewMode === "kanban") {
    return <div className="scroll-region" style={{ height: "100%", overflow: "auto", padding: 18, boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}><h2 style={{ margin: 0, flex: 1, fontSize: 18 }}>客户管理看板</h2><button type="button" onClick={() => setViewMode("list")} style={tagChip(false)}><List size={13} /> 列表与详情</button></div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${STAGE_TAGS.length}, minmax(210px, 1fr))`, gap: 10, minWidth: STAGE_TAGS.length * 220 }}>
        {STAGE_TAGS.map((stage) => <section key={stage} style={{ border: "1px solid var(--color-border)", borderRadius: 9, background: "var(--color-bg-secondary)", minHeight: 240 }}>
          <header style={{ padding: "9px 10px", fontWeight: 700, fontSize: 13, borderBottom: "1px solid var(--color-border)" }}>{stage} · {filteredMemories.filter((m) => (m.stage || STAGE_TAGS[0]) === stage).length}</header>
          <div style={{ padding: 7, display: "grid", gap: 7 }}>{filteredMemories.filter((m) => (m.stage || STAGE_TAGS[0]) === stage).map((m) => <button key={m.id} type="button" onClick={() => { selectMemory(m); setViewMode("list"); }} style={{ padding: 9, textAlign: "left", border: "1px solid var(--color-border)", borderRadius: 7, background: "var(--color-bg)", cursor: "pointer" }}><strong style={{ display: "block" }}>{m.company || m.name || m.email}</strong><span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{m.email}</span>{m.nextFollowUp > 0 && <span style={{ display: "block", marginTop: 5, fontSize: 10, color: m.nextFollowUp < Date.now() ? "#b42318" : "var(--color-accent)" }}>跟进：{new Date(m.nextFollowUp).toLocaleDateString()}</span>}</button>)}</div>
        </section>)}
      </div>
    </div>;
  }

  return (
    <div style={{ display: "flex", gap: 14, height: "100%", minHeight: 0, padding: "18px 20px", boxSizing: "border-box" }}>
      {/* 左侧：画像列表 */}
      <div style={{ width: 300, flexShrink: 0, display: "flex", flexDirection: "column", border: "1px solid var(--color-border)", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--color-border)" }}>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" onClick={() => setViewMode("kanban")} title="客户看板" style={{ padding: "6px 9px", border: "1px solid var(--color-border)", borderRadius: 6, background: "transparent", cursor: "pointer" }}><Columns3 size={15} /></button>
            <div style={{ position: "relative", flex: 1 }}>
              <Search size={14} style={{ position: "absolute", left: 8, top: 8, color: "var(--color-text-secondary)" }} />
              <input
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="搜索邮箱 / 姓名 / 公司"
                style={{ ...inputStyle, paddingLeft: 28 }}
              />
            </div>
            <select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              style={{ ...inputStyle, width: "auto", maxWidth: "150px" }}
              title="按账号筛选客户"
            >
              <option value="all">全部账号</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.display_name?.trim() || account.email.split("@")[0] || account.email}
                </option>
              ))}
            </select>
            <button type="button" onClick={newProfile} title="新建客户画像" style={{ padding: "6px 10px", border: 0, borderRadius: 6, background: "var(--color-accent)", color: "#fff", cursor: "pointer" }}>
              <Plus size={15} />
            </button>
          </div>
          <select value={tagFilter} onChange={(e) => handleFilterChange(e.target.value)} style={{ ...inputStyle, marginTop: 8, fontSize: 12 }}>
            <option value="">全部客户</option>
            <optgroup label="跟进阶段">
              {STAGE_TAGS.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
            </optgroup>
            <optgroup label="客户来源">
              {SOURCE_TAGS.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
            </optgroup>
            <optgroup label="客户分层">
              {TIER_TAGS.map((tag) => <option key={tag.value} value={tag.value}>{tag.label}</option>)}
            </optgroup>
          </select>
        </div>
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {filteredMemories.length === 0 && (
            <div style={{ padding: 14, fontSize: 12, color: "var(--color-text-secondary)" }}>暂无客户画像。可在右侧选择地址本联系人后点击“生成客户画像”。</div>
          )}
          {filteredMemories.map((m) => {
            const isActive = m.id === selectedId;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => selectMemory(m)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMemoryMenu({ x: event.clientX, y: event.clientY, memory: m });
                }}
                style={{
                  display: "block", width: "100%", textAlign: "left", padding: "9px 12px",
                  border: 0, borderBottom: "1px solid var(--color-border)", cursor: "pointer",
                  background: isActive ? "var(--color-sidebar-active)" : "transparent",
                  boxShadow: isActive ? "inset 3px 0 0 var(--color-accent)" : "none",
                }}
              >
                <strong style={{ fontSize: 13, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {m.name || m.company || m.email}
                </strong>
                <span style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.email}</span>
                {(m.source || m.stage || m.tier || m.tags?.length) && (
                  <span style={{ marginTop: 3, display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {m.tier && <span style={{ fontSize: 10, fontWeight: 700, color: "#fff", background: tierColor(m.tier), borderRadius: 8, padding: "0 5px" }}>{tierLabel(m.tier)}</span>}
                    {m.source && <span style={{ fontSize: 10, color: "var(--color-accent)", border: "1px solid var(--color-accent)", borderRadius: 8, padding: "0 5px" }}>{m.source}</span>}
                    {m.stage && <span style={{ fontSize: 10, color: "#2f855a", border: "1px solid #2f855a", borderRadius: 8, padding: "0 5px" }}>{m.stage}</span>}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      {memoryMenu && (
        <ContextMenu
          x={memoryMenu.x}
          y={memoryMenu.y}
          items={[
            {
              label: "编辑客户画像",
              icon: <PenLine size={14} />,
              onClick: () => selectMemory(memoryMenu.memory),
            },
            {
              label: "更新画像（重新获取邮件 + AI）",
              icon: <RefreshCw size={14} />,
              onClick: () => updateAndSaveMemory(memoryMenu.memory),
            },
            { separator: true },
            {
              label: "删除客户画像",
              icon: <Trash2 size={14} />,
              danger: true,
              onClick: () => {
                void deleteCustomerMemory(memoryMenu.memory.id)
                  .then((list) => {
                    setMemories(list);
                    if (selectedId === memoryMenu.memory.id) {
                      setSelectedId("");
                      setForm(emptyForm());
                    }
                    useToastStore.getState().addToast({ message: "已删除客户画像", type: "success" });
                  })
                  .catch((err) => useToastStore.getState().addToast({ message: `删除失败：${extractErrorMessage(err)}`, type: "error" }));
              },
            },
          ]}
          onClose={() => setMemoryMenu(null)}
        />
      )}

      {/* 右侧：编辑区 */}
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto", border: "1px solid var(--color-border)", borderRadius: 10, padding: 16, boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 16, flex: 1 }}>客户管理{selectedId ? " · 编辑" : " · 新建"}</h2>
          <button
            type="button"
            disabled={profileTask?.status === "running"}
            onClick={() => void generateProfile()}
            style={{ padding: "8px 14px", border: 0, borderRadius: 6, background: "var(--color-accent)", color: "#fff", fontWeight: 600, cursor: profileTask?.status === "running" ? "not-allowed" : "pointer", opacity: profileTask?.status === "running" ? 0.6 : 1 }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Sparkles size={14} className={profileTask?.status === "running" ? "spinner" : ""} />
              {profileTask?.status === "running" ? "正在生成画像（可切到其他页面，完成后自动填充）…" : "生成客户画像（AI+联网）"}
            </span>
          </button>
          <button type="button" disabled={busy} onClick={() => void save()} style={{ padding: "8px 14px", border: 0, borderRadius: 6, background: "var(--color-accent)", color: "#fff", cursor: busy ? "not-allowed" : "pointer" }}>保存</button>
          {selectedId && (
            <button type="button" disabled={busy} onClick={() => void remove()} style={{ padding: "8px 12px", border: "1px solid var(--color-border)", borderRadius: 6, background: "transparent", color: "#dc3545", cursor: busy ? "not-allowed" : "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Trash2 size={13} /> 删除
            </button>
          )}
        </div>

        {/* 邮箱（与地址本联动） */}
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>客户邮箱（可从地址本选择）</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              ref={emailInputRef}
              list="customer-profile-emails"
              value={form.email}
              onChange={(e) => setForm((old) => ({ ...old, email: e.target.value }))}
              placeholder="输入邮箱，或从地址本下拉选择"
              style={{ ...inputStyle, flex: 1, minWidth: 220 }}
            />
            <datalist id="customer-profile-emails">
              {contacts.map((c) => (
                <option key={c.id} value={c.email}>{c.name || c.company || c.email}</option>
              ))}
            </datalist>
            <select
              value=""
              onChange={(e) => {
                const contact = contacts.find((c) => c.email === e.target.value);
                if (contact) pickContact(contact);
              }}
              style={{ ...inputStyle, width: 200 }}
            >
              <option value="">从地址本选择…</option>
              {(tagFilter ? filteredContacts : contacts).map((c) => (
                <option key={c.id} value={c.email}>{c.name || "?"} &lt;{c.email}&gt;{c.role ? ` · ${c.role}` : ""}</option>
              ))}
            </select>
            <select
              value={tagFilter}
              onChange={(e) => handleFilterChange(e.target.value)}
              style={{ ...inputStyle, width: 150 }}
            >
              <option value="">全部标签</option>
              {["客户", "供应商", "服务商", "内部联系人"].map((r) => <option key={r} value={r}>{r}</option>)}
              {Array.from(new Set(contacts.flatMap((c) => c.tags))).map((tag) => <option key={tag} value={tag}>{tag}</option>)}
            </select>
          </div>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>
            输入几个字符会自动弹出匹配的地址本联系人；也可以按角色/标签筛选后从下拉选择。
          </div>
        </div>

        {/* 关联账号：客户必须归属具体账号（"全部账号"只是汇总） */}
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>关联账号（必选；从地址本选择联系人会自动带出）</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {accounts.map((acc) => {
              const on = (form.accountIds ?? []).includes(acc.id);
              return (
                <button
                  key={acc.id}
                  type="button"
                  onClick={() => setForm((old) => ({
                    ...old,
                    accountIds: on
                      ? (old.accountIds ?? []).filter((x) => x !== acc.id)
                      : [...(old.accountIds ?? []), acc.id],
                  }))}
                  style={tagChip(on)}
                >
                  {acc.display_name?.trim() || acc.email.split("@")[0] || acc.email}
                </button>
              );
            })}
            {(form.accountIds ?? []).length === 0 && (
              <span style={{ fontSize: 11, color: "#dc3545", alignSelf: "center" }}>未关联账号，无法保存</span>
            )}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>联系人姓名</label>
            <input value={form.name} onChange={(e) => setForm((old) => ({ ...old, name: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>公司</label>
            <input value={form.company} onChange={(e) => setForm((old) => ({ ...old, company: e.target.value }))} style={inputStyle} />
          </div>
        </div>

        {/* 手动标注 */}
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>客户来源（点击切换）</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {SOURCE_TAGS.map((tag) => (
              <button key={tag} type="button" onClick={() => setForm((old) => ({ ...old, source: old.source === tag ? "" : tag }))} style={tagChip(form.source === tag)}>
                {tag}
              </button>
            ))}
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>跟进阶段（唯一状态，点击推进/回退）</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {STAGE_TAGS.map((tag) => (
              <button key={tag} type="button" onClick={() => setForm((old) => ({ ...old, stage: old.stage === tag ? "" : tag }))} style={tagChip(form.stage === tag)}>
                {tag}
              </button>
            ))}
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>特征标签（可多选）</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {FEATURE_TAGS.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setForm((old) => {
                  const has = (old.tags ?? []).includes(tag);
                  return { ...old, tags: has ? (old.tags ?? []).filter((x) => x !== tag) : [...(old.tags ?? []), tag] };
                })}
                style={tagChip((form.tags ?? []).includes(tag))}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 14, alignItems: "center", marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>客户分层</label>
            <div style={{ display: "flex", gap: 6 }}>
              {TIER_TAGS.map((tag) => (
                <button
                  key={tag.value}
                  type="button"
                  onClick={() => setForm((old) => ({ ...old, tier: old.tier === tag.value ? "" : tag.value }))}
                  style={{
                    minWidth: 34, height: 30, padding: "0 8px", borderRadius: 6, border: `1px solid ${form.tier === tag.value ? "var(--color-accent)" : "var(--color-border)"}`,
                    background: form.tier === tag.value ? "var(--color-accent)" : "transparent",
                    color: form.tier === tag.value ? "#fff" : "var(--color-text-secondary)",
                    fontWeight: 700, cursor: "pointer", fontSize: 12,
                  }}
                >
                  {tag.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={labelStyle}>下次跟进日期</label>
            <input
              type="date"
              value={form.nextFollowUp ? new Date(form.nextFollowUp).toISOString().slice(0, 10) : ""}
              onChange={(e) => setForm((old) => ({ ...old, nextFollowUp: e.target.value ? new Date(e.target.value + "T00:00:00").getTime() : 0 }))}
              style={inputStyle}
            />
          </div>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", maxWidth: 200 }}>
            {form.nextFollowUp > 0 ? `将在 ${new Date(form.nextFollowUp).toLocaleDateString("zh-CN")} 跟进` : "未设置跟进提醒"}
          </div>
        </div>
        <div style={{ marginBottom: 12, border: "1px solid var(--color-border)", borderRadius: 8, padding: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ ...labelStyle, margin: 0, flex: 1 }}>自动跟进序列（自动排期与提醒，发送前人工确认）</label>
            <button type="button" onClick={createFollowUpSequence} style={tagChip(false)}><CalendarClock size={12} />创建 0/3/7/14 天序列</button>
            {(form.followUpSequence ?? []).length > 0 && <button type="button" onClick={() => setForm((old) => ({ ...old, followUpSequencePaused: !old.followUpSequencePaused }))} style={tagChip(form.followUpSequencePaused)}>{form.followUpSequencePaused ? "继续序列" : "暂停序列"}</button>}
          </div>
          {(form.followUpSequence ?? []).length === 0 ? <div style={{ marginTop: 7, fontSize: 12, color: "var(--color-text-secondary)" }}>尚未建立序列。系统不会自动发送邮件。</div> : <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {form.followUpSequence.map((step) => <div key={step.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 8px", borderRadius: 6, background: "var(--color-bg-secondary)", fontSize: 12 }}>
              <span style={{ width: 72, color: step.dueAt < Date.now() && step.status === "pending" ? "#b42318" : "var(--color-text-secondary)" }}>{new Date(step.dueAt).toLocaleDateString()}</span>
              <strong style={{ width: 70 }}>{step.title}</strong><span style={{ flex: 1 }}>{step.instruction}</span>
              <span style={{ color: "var(--color-accent)" }}>{step.status === "draft_ready" ? "草稿已准备" : step.status === "completed" ? "已完成" : "待处理"}</span>
              <button type="button" disabled={form.followUpSequencePaused} onClick={() => openSequenceDraft(step)} style={tagChip(false)}><Mail size={12} />交给 AI 写作</button>
            </div>)}
          </div>}
        </div>
        <div style={{ marginBottom: 12, border: "1px solid var(--color-border)", borderRadius: 8, padding: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
            <label style={{ ...labelStyle, margin: 0, flex: 1 }}>客户活动与跟进（邮件 + 人工记录）</label>
            <button type="button" onClick={suggestNextActionLocally} style={tagChip(false)}><Sparkles size={12} />下一步建议</button>
            <button
              type="button"
              disabled={updateTask?.status === "running" || profileTask?.status === "running"}
              onClick={() => updateProfile()}
              style={tagChip(updateTask?.status === "running")}
              title="重新获取该客户的所有往来邮件并更新画像"
            >
              <RefreshCw size={12} className={updateTask?.status === "running" ? "spinner" : ""} />
              {updateTask?.status === "running" ? "更新中…" : "更新画像"}
            </button>
          </div>
          {nextAction && <div style={{ padding: "7px 9px", marginBottom: 7, borderRadius: 6, background: "color-mix(in srgb, var(--color-accent) 10%, transparent)", fontSize: 12 }}><strong>建议：</strong>{nextAction}</div>}
          <div style={{ maxHeight: 240, overflowY: "auto", display: "grid", gap: 5, marginBottom: 8 }}>
            {[...emailActivities.map((hit) => ({ id: `mail-${hit.message_id}`, date: (hit.date || 0) * 1000, channel: "邮件", note: `${hit.subject || "无主题"} · ${hit.snippet || ""}`, manual: false })), ...(form.followUps ?? []).map((item) => ({ ...item, manual: true }))].sort((a, b) => b.date - a.date).slice(0, 80).map((activity) => <div key={activity.id} style={{ display: "flex", gap: 7, padding: "5px 7px", borderRadius: 6, background: "var(--color-bg-secondary)", fontSize: 11 }}><span style={{ color: "var(--color-text-secondary)", flexShrink: 0 }}>{activity.date ? new Date(activity.date).toLocaleString() : ""}</span><strong style={{ color: "var(--color-accent)" }}>{activity.channel}</strong><span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activity.note}</span>{activity.manual && <button type="button" onClick={() => removeFollowUp(activity.id)} title="删除人工记录" style={{ border: 0, background: "transparent", color: "#dc3545", cursor: "pointer" }}>×</button>}</div>)}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <select value={followChannel} onChange={(e) => setFollowChannel(e.target.value)} style={{ ...inputStyle, width: 110 }}>
              {FOLLOW_CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <input
              value={followNote}
              onChange={(e) => setFollowNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addFollowUp(); }}
              placeholder="添加人工跟进记录，回车保存"
              style={{ ...inputStyle, flex: 1 }}
            />
            <button type="button" onClick={addFollowUp} style={{ padding: "6px 12px", border: 0, borderRadius: 6, background: "var(--color-accent)", color: "#fff", cursor: "pointer" }}>
              <CalendarClock size={14} />
            </button>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>一句话概况</label>
          <input value={form.summary} onChange={(e) => setForm((old) => ({ ...old, summary: e.target.value }))} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>画像详情（AI 联网生成后可手动修改）</label>
          <textarea
            value={form.profile}
            onChange={(e) => setForm((old) => ({ ...old, profile: e.target.value }))}
            style={{ ...inputStyle, minHeight: 260, resize: "vertical", lineHeight: 1.6, fontFamily: "inherit" }}
          />
        </div>

        {generatedSources.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--color-text-secondary)" }}>
            <strong>AI 联网参考来源：</strong>
            <span style={{ wordBreak: "break-all" }}>{generatedSources.join("  ·  ")}</span>
          </div>
        )}

        <div style={{ marginTop: 14, borderTop: "1px solid var(--color-border)", paddingTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
            <label style={{ ...labelStyle, margin: 0 }}>资信调研</label>
            <button
              type="button"
              disabled={researching}
              onClick={() => void handleRunResearch()}
              title="基于客户公司名称/邮箱域名，联网执行多源资信调研并把结果加入本客户"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                border: "1px solid var(--color-border)", borderRadius: 14,
                padding: "4px 12px", fontSize: 12,
                background: researching ? "var(--color-bg-secondary)" : "transparent",
                color: "var(--color-accent)", cursor: researching ? "default" : "pointer",
              }}
            >
              {researching ? <RefreshCw size={13} className="spinner" /> : <ShieldCheck size={13} />}
              {researching ? "调研进行中…" : "生成资信调研"}
            </button>
            {customerResearches.length > 0 && (
              <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                {customerResearches.length} 条记录，点击可把公开信息并入画像详情
              </span>
            )}
          </div>
          {customerResearches.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {customerResearches.slice(0, 8).map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    const parts: string[] = [];
                    if (r.analysis) parts.push(`调研分析：\n${formatProfileText(r.analysis)}`);
                    if (r.websiteTitle) parts.push(`官网：${r.websiteTitle}`);
                    if (r.websiteDescription) parts.push(`官网介绍：${r.websiteDescription}`);
                    if (r.publicEmails.length) parts.push(`公开邮箱：${r.publicEmails.join("、")}`);
                    setForm((old) => ({ ...old, profile: [old.profile, parts.join("\n")].filter(Boolean).join("\n\n") }));
                  }}
                  title={`${new Date(r.createdAt * 1000).toLocaleDateString()} 生成`}
                  style={{ padding: "5px 10px", fontSize: 12, border: "1px solid var(--color-border)", borderRadius: 14, background: "transparent", cursor: "pointer", color: "var(--color-text-primary)" }}
                >
                  {r.websiteTitle || r.companyName || r.website}
                </button>
              ))}
            </div>
          )}
          {customerResearches.length === 0 && (
            <span style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
              还没有该客户的调研记录。点击"生成资信调研"联网核验公司身份、经营、贸易与风险证据，结果会自动加入本客户。
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
