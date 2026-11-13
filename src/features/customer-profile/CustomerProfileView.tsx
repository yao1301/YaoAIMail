import { useWorkspaceState, useWorkspaceIsTransferring, useWorkspaceInitEffect } from '@/lib/workspaceState';
import { useEffect, useMemo, useRef } from "react";
import { observeResizeFrame } from "@/lib/observeResizeFrame";
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
  refreshCustomerProfile,
  type CustomerMemory,
  type Account,
  type AddressBookContact,
  type CompanyResearchReport,
  type FollowUpEntry,
  type FollowUpSequenceStep,
  type CustomerMailActivity,
  getCustomerProfileMail,
} from "@/lib/api";
import { useMailStore } from "@/stores/mail.store";
import { useUIStore } from "@/stores/ui.store";
import { useToastStore } from "@/stores/toast.store";
import { useBackgroundTasksStore } from "@/stores/backgroundTasks.store";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { formatProfileText } from "@/lib/profileText";
import { invoke } from "@tauri-apps/api/core";
import "./CustomerProfileView.css";
import CustomerCrmOverview from "./CustomerCrmOverview";

const SOURCE_TAGS = ["展会", "社媒", "谷歌开发", "邮件往来", "官网询盘", "客户转介绍", "其他"];
/** 跟进阶段（唯一互斥，按销售漏斗推进） */
const STAGE_TAGS = ["待开发", "已联系", "已报价", "已寄样", "谈判中", "已成交", "流失"];
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

type ProfileForm = Pick<CustomerMemory, "email" | "name" | "company" | "summary" | "profile" | "source" | "status" | "stage" | "tags" | "tier" | "nextFollowUp" | "followUps" | "followUpSequence" | "followUpSequencePaused"> & {accountIds:string[]};

function emptyForm(): ProfileForm {
  return { email: "", name: "", company: "", summary: "", profile: "", source: "", status: "", stage: "", tags: [], tier: "", nextFollowUp: 0, followUps: [], accountIds: [], followUpSequence: [], followUpSequencePaused: false };
}
function memoryForm(m:CustomerMemory):ProfileForm{
  return {email:m.email,name:m.name,company:m.company,summary:m.summary,profile:m.profile,source:m.source,status:m.status,stage:m.stage,tags:m.tags,tier:m.tier,nextFollowUp:m.nextFollowUp,followUps:m.followUps,accountIds:m.accountIds??[],followUpSequence:m.followUpSequence??[],followUpSequencePaused:m.followUpSequencePaused??false};
}

/** 客户管理：现有客户的全面画像 + 跟进标记（来源/阶段/特征标签/分层）+ 跟进记录。 */
export default function CustomerProfileView() {
  const transferring = useWorkspaceIsTransferring();
  const [memories, setMemories] = useWorkspaceState<CustomerMemory[]>("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:memories", []);
  const [contacts, setContacts] = useWorkspaceState<AddressBookContact[]>("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:contacts", []);
  const [researches, setResearches] = useWorkspaceState<CompanyResearchReport[]>("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:researches", []);
  const [selectedId, setSelectedId] = useWorkspaceState<string>("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:selectedId", "");
  const [form, setForm] = useWorkspaceState("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:form", emptyForm());
  const formRef = useRef(form); formRef.current = form;
  const [loaded, setLoaded] = useWorkspaceState("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:loaded", false);
  const customerSearchStore = useUIStore((s) => s.customerProfileSearch);
  const customerFilterStore = useUIStore((s) => s.customerProfileFilter);
  const setCustomerSearch = useUIStore((s) => s.setCustomerProfileSearch);
  const setCustomerFilter = useUIStore((s) => s.setCustomerProfileFilter);
  const [search, setSearch] = useWorkspaceState("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:search", customerSearchStore);
  const [tagFilter, setTagFilter] = useWorkspaceState("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:tagFilter", customerFilterStore);
  const [accountFilter, setAccountFilter] = useWorkspaceState("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:accountFilter", "all");
  const [accounts, setAccounts] = useWorkspaceState<Account[]>("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:accounts", []);
  const [busy, setBusy] = useWorkspaceState("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:busy", false);
  const [generatedSources, setGeneratedSources] = useWorkspaceState<string[]>("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:generatedSources", []);
  const [followChannel, setFollowChannel] = useWorkspaceState("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:followChannel", "邮件");
  const [followNote, setFollowNote] = useWorkspaceState("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:followNote", "");
  const profileTask = useBackgroundTasksStore((state) => state.tasks.customerProfile);
  const startTask = useBackgroundTasksStore((state) => state.start);
  const clearTask = useBackgroundTasksStore((state) => state.clear);
  const researchTask = useBackgroundTasksStore((state) => state.tasks.customerCompanyResearch);
  const researching = researchTask?.status === "running";
  const emailInputRef = useRef<HTMLInputElement>(null);
  const profileTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [memoryMenu, setMemoryMenu] = useWorkspaceState<{ x: number; y: number; memory: CustomerMemory } | null>("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:memoryMenu", null);
  const [viewMode, setViewMode] = useWorkspaceState<"list" | "kanban">("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:viewMode", "list");
  const [emailActivities, setEmailActivities] = useWorkspaceState<CustomerMailActivity[]>("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:emailActivities", []);
  const [nextAction, setNextAction] = useWorkspaceState("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:nextAction", "");
  const [showBasic, setShowBasic] = useWorkspaceState("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:showBasic", true);
  const [showAllActivity, setShowAllActivity] = useWorkspaceState("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:showAllActivity", false);
  const [contactFilter, setContactFilter] = useWorkspaceState("src/features/customer-profile/CustomerProfileView.tsx:CustomerProfileView:contactFilter", "");
  const activityRef = useRef<HTMLElement>(null);

  const customerProfileEmail = useUIStore((s) => s.customerProfileEmail);
  const selectedMemory = memories.find((m) => m.id === selectedId);
  const hasUnsavedChanges = selectedMemory ? JSON.stringify(memoryForm(selectedMemory)) !== JSON.stringify(form) : Boolean(form.email || form.company || form.profile);
  const nextPlanStep = form.followUpSequence.filter((step) => step.status !== 'completed' && step.status !== 'skipped').sort((a,b) => a.dueAt-b.dueAt)[0];

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

  // 画像详情自动增高：长画像全文直接铺开阅读，不再挤在固定高度的小框里滚很多屏。
  // 布局稳定前测 scrollHeight 会偏高（宽度未定、换行更多），所以除了内容/客户变化时
  // 立即贴合一次，还用 ResizeObserver 盯住自身尺寸变化反复贴合，保证高度始终等于内容高度。
  useEffect(() => {
    const el = profileTextareaRef.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(560, Math.max(280, el.scrollHeight))}px`;
    };
    // Height writes must not feed the observer; only a width change needs refitting.
    return observeResizeFrame(el, fit, true);
  }, [form.profile, selectedId]);

  useWorkspaceInitEffect('src/features/customer-profile/CustomerProfileView.tsx:', () => {
    let cancelled = false;
    listCustomerMemories()
      .then((list) => { if (!cancelled) { setMemories(list); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
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
    if (transferring || researchTask?.status !== "success" || !researchTask.result) return;
    void listCompanyResearch().then((list) => setResearches(list)).catch(() => {});
    clearTask("customerCompanyResearch");
  }, [transferring, researchTask, clearTask]);

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
      let rHost = "";
      try { rHost = new URL(r.website.includes("://") ? r.website : "https://" + r.website).hostname.replace(/^www\./, "").toLowerCase(); } catch { /* Not a usable company identity. */ }
      if (company && rCompany && company === rCompany) return true;
      if (domain && rHost === domain && !["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "qq.com", "163.com"].includes(domain)) return true;
      return false;
    }).sort((a, b) => b.createdAt - a.createdAt);
  }, [researches, form.company, form.email]);

  // 从地址本跳转过来：预填邮箱并新建画像
  useEffect(() => {
    if (customerProfileEmail && loaded) {
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
  }, [customerProfileEmail, loaded]);

  function selectMemory(m: CustomerMemory) {
    setNextAction(""); setEmailActivities([]); setShowAllActivity(false); setShowBasic(false);
    setGeneratedSources(m.profileSources ?? []);
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
    if (!selectedId) { setEmailActivities([]); return; }
    let cancelled = false;
    setEmailActivities([]);
    void getCustomerProfileMail(selectedId).then((hits) => {
      if (!cancelled) setEmailActivities(hits.sort((a, b) => (b.date || 0) - (a.date || 0)));
    }).catch(() => { if (!cancelled) setEmailActivities([]); });
    return () => { cancelled = true; };
  }, [selectedId, memories]);

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
    setNextAction(""); setEmailActivities([]); setShowAllActivity(false); setShowBasic(true);
    setSelectedId("");
    setForm(emptyForm());
    setGeneratedSources([]);
    emailInputRef.current?.focus();
  }

  // Results are already saved natively. Refresh the list even after switching
  // customer, but never replace another customer's form or unsaved edits.
  useEffect(() => {
    if (transferring || !loaded || profileTask?.status !== "success" || !profileTask.result) return;
    const result = profileTask.result as { memory: CustomerMemory; snapshot: string; foreground: boolean };
    const memory = result.memory;
    setMemories((old) => [memory, ...old.filter((m) => m.id !== memory.id)]);
    const current = formRef.current;
    if (result.foreground && current.email.trim().toLowerCase() === memory.email.toLowerCase()) {
      const snapshot = JSON.parse(result.snapshot) as ProfileForm;
      // Merge generated fields independently. A reply can pause a plan while
      // generation runs; that must not hide the newly generated profile.
      setForm((old) => ({ ...old,
        profile: old.profile === snapshot.profile ? memory.profile : old.profile,
        summary: old.summary === snapshot.summary ? memory.summary : old.summary,
        name: old.name === snapshot.name ? memory.name : old.name,
        company: old.company === snapshot.company ? memory.company : old.company,
      }));
      if (current.profile === snapshot.profile) setGeneratedSources(memory.profileSources ?? []);
    }
    clearTask("customerProfile");
  }, [transferring, profileTask, loaded, clearTask]);

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
  function openActivityMail(id:string){
    const message=emailActivities.find((m)=>m.message_id===id);if(!message)return;
    useMailStore.getState().setActiveAccountId(message.account_id);
    const ui=useUIStore.getState();ui.openMessageInInbox(id);ui.setMessageDetailId(id);ui.setActiveView('messageDetail');
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
    if (!contactFilter) return contacts;
    return contacts.filter((c) => c.role === contactFilter || c.tags.includes(contactFilter));
  }, [contacts, contactFilter]);

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

  async function generateProfile(target?: CustomerMemory) {
    if (busy || useBackgroundTasksStore.getState().tasks.customerProfile?.status === "running") return;
    if (target?.id === selectedId) target = undefined;
    const originalForm = JSON.stringify(formRef.current);
    const snapshot: ProfileForm = target ? {
      email: target.email, name: target.name, company: target.company, summary: target.summary,
      profile: target.profile, source: target.source, status: target.status, stage: target.stage,
      tags: target.tags, tier: target.tier, nextFollowUp: target.nextFollowUp, followUps: target.followUps,
      accountIds: target.accountIds ?? [], followUpSequence: target.followUpSequence ?? [],
      followUpSequencePaused: target.followUpSequencePaused ?? false,
    } : { ...form, accountIds: [...form.accountIds] };
    if (!snapshot.email.trim()) {
      useToastStore.getState().addToast({ message: "请填写客户邮箱，以便读取正确的往来邮件", type: "error" }); return;
    }
    if (!snapshot.accountIds.length) {
      const active = useMailStore.getState().activeAccountId;
      if (active && accounts.some((a) => a.id === active)) snapshot.accountIds = [active];
      else if (accounts.length === 1) snapshot.accountIds = [accounts[0].id];
    }
    if (!snapshot.accountIds.length) {
      useToastStore.getState().addToast({ message: "请选择用于分析邮件的关联账号", type: "error" }); return;
    }
    setBusy(true);
    try {
      const saved = await saveCustomerMemory({ ...snapshot, id: target?.id || selectedId || undefined, email: snapshot.email.trim() });
      const foreground = !target && JSON.stringify(formRef.current) === originalForm;
      if (foreground) { setForm(snapshot); setSelectedId(saved.id); }
      setMemories((old) => [saved, ...old.filter((m) => m.id !== saved.id)]);
      const updating = Boolean(snapshot.profile.trim());
      startTask("customerProfile", updating ? "更新客户画像" : "生成客户画像", async () => ({
        memory: await refreshCustomerProfile(saved.id), snapshot: JSON.stringify(snapshot), foreground,
      }), { successMessage: "客户画像已更新并自动保存" });
    } catch (err) {
      useToastStore.getState().addToast({ message: "无法开始生成：" + extractErrorMessage(err), type: "error" });
    } finally { setBusy(false); }
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
    <div className="customer-manager">
      {/* 左侧：画像列表 */}
      <aside className="customer-manager__list">
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
      </aside>
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
              label: "更新客户画像（邮件 + 公开资料）",
              icon: <RefreshCw size={14} />,
              onClick: () => void generateProfile(memoryMenu.memory),
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
      <main className="customer-manager__detail">
        <div className="customer-manager__toolbar">
          <div className="customer-manager__heading"><h2>{form.name || form.company || "客户画像"}</h2><span>{selectedId ? "客户资料与往来记录" : "添加客户，自动整理往来与公开资料"}</span><span className={hasUnsavedChanges ? "crm-unsaved" : "crm-saved"} role="status">{hasUnsavedChanges ? "有未保存修改" : selectedId ? "已保存" : "新客户"}</span></div>
          <button
            type="button"
            disabled={busy || profileTask?.status === "running"}
            onClick={() => void generateProfile()}
            style={{ padding: "8px 14px", border: 0, borderRadius: 6, background: "var(--color-accent)", color: "#fff", fontWeight: 600, cursor: profileTask?.status === "running" ? "not-allowed" : "pointer", opacity: profileTask?.status === "running" ? 0.6 : 1 }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Sparkles size={14} className={profileTask?.status === "running" ? "spinner" : ""} />
              {profileTask?.status === "running" ? "正在更新…" : form.profile.trim() ? "更新客户画像" : "生成客户画像"}
            </span>
          </button>
          <button type="button" disabled={busy} onClick={() => void save()} style={{ padding: "8px 14px", border: 0, borderRadius: 6, background: "transparent", color: "var(--color-text-primary)", cursor: busy ? "not-allowed" : "pointer", outline: "1px solid var(--color-border)" }}>保存修改</button>
          {selectedId && (
            <button type="button" disabled={busy} onClick={() => void remove()} style={{ padding: "8px 12px", border: "1px solid var(--color-border)", borderRadius: 6, background: "transparent", color: "#dc3545", cursor: busy ? "not-allowed" : "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Trash2 size={13} /> 删除
            </button>
          )}
        </div>

        <div className="customer-manager__intro">自动读取关联账号的往来邮件，并同步公开资料；生成后自动保存。</div>
        {profileTask?.status === "running" && <div className="customer-manager__status" role="status">正在读取邮件、查找公开资料并整理画像，可切换到其他页面。</div>}
        {profileTask?.status === "error" && <div className="customer-manager__status customer-manager__status--error" role="alert">{profileTask.error}<button type="button" onClick={() => clearTask("customerProfile")} aria-label="关闭错误提示">×</button></div>}
        <CustomerCrmOverview customer={form} mail={emailActivities} planSummary={form.followUpSequence.length ? form.followUpSequencePaused ? '跟进计划已暂停' : nextPlanStep ? `下一步：${nextPlanStep.title}` : '跟进计划已完成' : ''} onChange={(change) => setForm((old) => ({ ...old, ...change }))} onShowActivity={() => activityRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}/>
        <div className="crm-workspace"><div className="crm-workspace__main">
        <section className="customer-manager__section customer-manager__profile" aria-label="客户画像"><h3>客户画像</h3>
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>一句话概况</label>
          <input value={form.summary} onChange={(e) => setForm((old) => ({ ...old, summary: e.target.value }))} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>画像详情（可编辑，保留邮件与网页依据）</label>
          <textarea
            ref={profileTextareaRef}
            value={form.profile}
            onChange={(e) => setForm((old) => ({ ...old, profile: e.target.value }))}
            style={{ ...inputStyle, minHeight: 260, resize: "vertical", lineHeight: 1.6, fontFamily: "inherit", overflowY: "auto" }}
          />
        </div>

        {selectedId && memories.find((m) => m.id === selectedId) && <div className="customer-manager__coverage">画像更新于 {new Date(memories.find((m) => m.id === selectedId)!.updatedAt * 1000).toLocaleString()} · 分析 {memories.find((m) => m.id === selectedId)!.messageCount} 封邮件正文片段</div>}
        {(memories.find((m) => m.id === selectedId)?.generationWarnings ?? []).map((warning) => <p key={warning} className="customer-manager__coverage">{warning}</p>)}
        {memories.find((m) => m.id === selectedId)?.previousProfile && <details className="customer-manager__previous"><summary>查看保留的历史画像（不代表本轮已核实）</summary><pre>{memories.find((m) => m.id === selectedId)?.previousProfile}</pre></details>}
        {generatedSources.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--color-text-secondary)" }}>
            <strong>AI 联网参考来源：</strong>
            <div className="customer-manager__sources">{generatedSources.map((url) => <button key={url} type="button" onClick={() => void invoke("open_external_url", { url })}>{url}</button>)}</div>
          </div>
        )}

        </section>
        <section className="customer-manager__section crm-activity" aria-label="往来与跟进" ref={activityRef}><h3>往来与跟进</h3>
        <div style={{ marginBottom: 12, border: "1px solid var(--color-border)", borderRadius: 8, padding: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
            <label style={{ ...labelStyle, margin: 0, flex: 1 }}>客户活动与跟进（邮件 + 人工记录）</label>
            <button type="button" onClick={suggestNextActionLocally} style={tagChip(false)}><Sparkles size={12} />下一步建议</button>

          </div>
          {nextAction && <div style={{ padding: "7px 9px", marginBottom: 7, borderRadius: 6, background: "color-mix(in srgb, var(--color-accent) 10%, transparent)", fontSize: 12 }}><strong>按当前阶段的规则建议：</strong>{nextAction}</div>}
          <div style={{ maxHeight: 240, overflowY: "auto", display: "grid", gap: 5, marginBottom: 8 }}>
            {[...emailActivities.map((hit) => ({ id: `mail-${hit.message_id}`, date: (hit.date || 0) * 1000, channel: "邮件", note: `${hit.subject || "无主题"} · ${hit.snippet || ""}`, manual: false })), ...(form.followUps ?? []).map((item) => ({ ...item, manual: true }))].sort((a, b) => b.date - a.date).slice(0, showAllActivity ? 80 : 5).map((activity) => <div key={activity.id} style={{ display: "flex", gap: 7, padding: "5px 7px", borderRadius: 6, background: "var(--color-bg-secondary)", fontSize: 11 }}><span style={{ color: "var(--color-text-secondary)", flexShrink: 0 }}>{activity.date ? new Date(activity.date).toLocaleString() : ""}</span><strong style={{ color: "var(--color-accent)" }}>{activity.channel}</strong>{activity.manual ? <span className="crm-activity__note">{activity.note}</span> : <button type="button" className="crm-activity__mail" title={activity.note} onClick={() => openActivityMail(activity.id.slice(5))}>{activity.note}</button>}{activity.manual && <button type="button" onClick={() => removeFollowUp(activity.id)} title="删除人工记录" style={{ border: 0, background: "transparent", color: "#dc3545", cursor: "pointer" }}>×</button>}</div>)}
          </div>
          {emailActivities.length + form.followUps.length > 5 && <button type="button" className="crm-text-button" onClick={() => setShowAllActivity((v) => !v)}>{showAllActivity ? "收起较早记录" : "查看全部往来记录"}</button>}
          <div style={{ display: "flex", gap: 6 }}>
            <select value={followChannel} onChange={(e) => setFollowChannel(e.target.value)} style={{ ...inputStyle, width: 110 }}>
              {FOLLOW_CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <input
              value={followNote}
              onChange={(e) => setFollowNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addFollowUp(); }}
              placeholder="记录跟进情况，回车添加"
              style={{ ...inputStyle, flex: 1 }}
            />
            <button type="button" onClick={addFollowUp} style={{ padding: "6px 12px", border: 0, borderRadius: 6, background: "var(--color-accent)", color: "#fff", cursor: "pointer" }}>
              <CalendarClock size={14} />
            </button>
          </div>
        </div>

        </section>
</div><aside className="crm-workspace__side">
        <section className="customer-manager__section crm-plan" aria-label="跟进计划"><h3>跟进计划</h3>
        {form.followUpSequence.length > 0 && <div className="crm-plan__next"><span>{form.followUpSequencePaused ? '计划已暂停' : nextPlanStep ? '下一步' : '计划已完成'}</span>{nextPlanStep && <strong>{nextPlanStep.title} · {new Date(nextPlanStep.dueAt).toLocaleDateString()}</strong>}</div>}
        <div style={{ marginBottom: 12, border: "1px solid var(--color-border)", borderRadius: 8, padding: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ ...labelStyle, margin: 0, flex: 1 }}>跟进计划（发送前人工确认）</label>
            <button type="button" onClick={createFollowUpSequence} style={tagChip(false)}><CalendarClock size={12} />创建跟进计划</button>
            {(form.followUpSequence ?? []).length > 0 && <button type="button" onClick={() => setForm((old) => ({ ...old, followUpSequencePaused: !old.followUpSequencePaused }))} style={tagChip(form.followUpSequencePaused)}>{form.followUpSequencePaused ? "继续序列" : "暂停序列"}</button>}
          </div>
          {(form.followUpSequence ?? []).length === 0 ? <div style={{ marginTop: 7, fontSize: 12, color: "var(--color-text-secondary)" }}>尚未设置跟进计划。可创建计划安排下一步，系统不会自动发送。</div> : <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {form.followUpSequence.map((step) => <div key={step.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 8px", borderRadius: 6, background: "var(--color-bg-secondary)", fontSize: 12 }}>
              <span style={{ width: 72, color: step.dueAt < Date.now() && step.status === "pending" ? "#b42318" : "var(--color-text-secondary)" }}>{new Date(step.dueAt).toLocaleDateString()}</span>
              <strong style={{ width: 70 }}>{step.title}</strong><span style={{ flex: 1 }}>{step.instruction}</span>
              <span style={{ color: "var(--color-accent)" }}>{step.status === "draft_ready" ? "草稿已准备" : step.status === "completed" ? "已完成" : "待处理"}</span>
              <button type="button" disabled={form.followUpSequencePaused} onClick={() => openSequenceDraft(step)} style={tagChip(false)}><Mail size={12} />交给 AI 写作</button>
            </div>)}
          </div>}
        </div>        </section>
        <section className="customer-manager__section crm-research" aria-label="资信调查"><h3>资信调查</h3>
        <div>
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
              {researching ? "调研进行中…" : customerResearches.length ? "更新资信调查" : "开始资信调查"}
            </button>
            {customerResearches.length > 0 && (
              <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                {customerResearches.length} 条记录，点击可把公开信息并入画像详情
              </span>
            )}
          </div>
          {customerResearches[0] && <article className="crm-research__snapshot"><span>最近调查 · {new Date(customerResearches[0].createdAt * 1000).toLocaleDateString()}</span><strong>{customerResearches[0].companyName || customerResearches[0].websiteTitle || "公司资料"}</strong><p>{customerResearches[0].dossier?.summary || formatProfileText(customerResearches[0].analysis || customerResearches[0].websiteDescription || "已保存调查资料，请结合正文与来源查看。").split("\n").filter((line) => line.trim()).slice(0, 3).join(" ").slice(0, 220)}</p><span>公开资料与风险线索，不等同信用或履约保证</span></article>}
          {customerResearches.length > 0 && <details className="crm-research__reports"><summary>查看完整报告与历史资料（{customerResearches.length}）</summary><div className="crm-research__full">{formatProfileText(customerResearches[0]?.analysis || customerResearches[0]?.dossier?.summary || "暂无正文")}</div></details>}
          {customerResearches.length > 0 && (
            <details className="crm-research__reports"><summary>将历史资料并入画像</summary><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {customerResearches.slice(0, 8).map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    const parts: string[] = [];
                    const dossier = r.dossier;
                    if (r.analysis && (r.structureVersion ?? 0) >= 4) parts.push(`完整调研分析：\n${formatProfileText(r.analysis)}`);
                    else if (dossier?.summary) parts.push(`调研结论：${dossier.summary}`);
                    if (dossier?.profile?.length) {
                      parts.push(
                        `客户档案：\n${dossier.profile
                          .map((field) => `${field.label || field.key}：${field.value}`)
                          .join("\n")}`,
                      );
                    }
                    if (dossier?.risks?.length) {
                      parts.push(`风险与关注点：\n${dossier.risks.map((risk) => `· ${risk.text}`).join("\n")}`);
                    }
                    if (dossier?.gaps?.length) {
                      parts.push(`待核实：\n${dossier.gaps.map((gap) => `· ${gap}`).join("\n")}`);
                    }
                    if (r.analysis && (r.structureVersion ?? 0) < 4 && !dossier?.summary) parts.push(`调研分析：\n${formatProfileText(r.analysis)}`);
                    if (r.websiteTitle) parts.push(`官网：${r.websiteTitle}`);
                    if (r.websiteDescription) parts.push(`官网介绍：${r.websiteDescription}`);
                    if (r.publicEmails.length) parts.push(`公开邮箱：${r.publicEmails.join("、")}`);
                    setForm((old) => ({ ...old, profile: [old.profile, parts.join("\n\n")].filter(Boolean).join("\n\n") }));
                  }}
                  title={`${new Date(r.createdAt * 1000).toLocaleDateString()} 生成`}
                  style={{ padding: "5px 10px", fontSize: 12, border: "1px solid var(--color-border)", borderRadius: 14, background: "transparent", cursor: "pointer", color: "var(--color-text-primary)" }}
                >
                  {r.websiteTitle || r.companyName || r.website}
                </button>
              ))}
            </div></details>
          )}
          {customerResearches.length === 0 && (
            <span style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
              尚未进行资信调查。可查找公司身份、经营及风险资料；没有调查不能视为低风险。
            </span>
          )}
        </div>
        </section>
        <details className="customer-manager__section crm-basic" open={showBasic} onToggle={(e) => setShowBasic(e.currentTarget.open)}><summary>编辑基本资料与关联账号</summary>
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
              {(contactFilter ? filteredContacts : contacts).map((c) => (
                <option key={c.id} value={c.email}>{c.name || "?"} &lt;{c.email}&gt;{c.role ? ` · ${c.role}` : ""}</option>
              ))}
            </select>
            <select
              value={contactFilter}
              onChange={(e) => setContactFilter(e.target.value)}
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
</details>
        </aside></div>
      </main>
    </div>
  );
}
