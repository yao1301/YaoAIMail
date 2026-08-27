import { useEffect, useMemo, useState } from "react";
import { X, PenLine, Trash2, Mail, Sparkles, Copy } from "lucide-react";
import ContextMenu from "@/components/ContextMenu";
import {
  autoClassifyContacts,
  deleteAddressBookContact,
  inferAllContactRoles,
  importMailContactsToAddressBook,
  listAccounts,
  listAddressBookContacts,
  listCompanyResearch,
  listCustomerMemories,
  saveAddressBookContact,
  saveCustomerMemory,
  type Account,
  type AddressBookContact,
  type CompanyResearchReport,
  type ContactRole,
  type ContactRoleEntry,
  type CustomerMemory,
} from "@/lib/api";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { useMailStore } from "@/stores/mail.store";
import { useComposeStore } from "@/stores/compose.store";
import { useToastStore } from "@/stores/toast.store";
import { useUIStore } from "@/stores/ui.store";
import { useBackgroundTasksStore } from "@/stores/backgroundTasks.store";

const ROLES: Array<{ value: ContactRole; label: string }> = [
  { value: "customer", label: "客户" },
  { value: "supplier", label: "工厂 / 供应商" },
  { value: "service", label: "物流 / 服务商" },
  { value: "neutral", label: "同事 / 内部" },
  { value: "unknown", label: "未分类" },
];

/** 标签栏的类型标签：与角色一一对应，按角色筛选联系人（发送防呆依赖角色）。 */
const TYPE_TAG_FILTERS: Array<{ label: string; role: ContactRole }> = [
  { label: "客户", role: "customer" },
  { label: "供应商", role: "supplier" },
  { label: "服务商", role: "service" },
  { label: "内部联系人", role: "neutral" },
  { label: "未分类", role: "unknown" },
];

const emptyForm = {
  id: "", email: "", name: "", company: "", jobTitle: "",
  role: "unknown" as ContactRole, notes: "", tags: "", accountId: "" as string | null,
};

const ROLE_TAG: Record<ContactRole, string> = {
  customer: "客户",
  supplier: "供应商",
  service: "服务商",
  neutral: "内部联系人",
  unknown: "未分类",
};

export default function AddressBookView() {
  const [contacts, setContacts] = useState<AddressBookContact[]>([]);
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState("");
  const [accountFilter, setAccountFilter] = useState("all");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [profiles, setProfiles] = useState<CustomerMemory[]>([]);
  const [researchReports, setResearchReports] = useState<CompanyResearchReport[]>([]);
  const [busy, setBusy] = useState(false);
  const taggingTask = useBackgroundTasksStore((state) => state.tasks.addressBookTagging);
  const startTask = useBackgroundTasksStore((state) => state.start);
  const clearTask = useBackgroundTasksStore((state) => state.clear);
  const taggingBusy = taggingTask?.status === "running";

  useEffect(() => {
    if (taggingTask?.status !== "success") return;
    void refresh().then(() => clearTask("addressBookTagging"));
  }, [taggingTask, clearTask]);

  async function refresh() {
    const [nextContacts, nextProfiles, nextResearch, nextAccounts] = await Promise.all([
      listAddressBookContacts(),
      listCustomerMemories(),
      listCompanyResearch(),
      listAccounts(),
    ]);
    setContacts(nextContacts);
    setProfiles(nextProfiles);
    setResearchReports(nextResearch);
    setAccounts(nextAccounts);
  }

  useEffect(() => { void refresh().catch(() => {}); }, []);

  // 新建联系人时默认关联当前激活账号（全部账号只是汇总，联系人必须归属具体账号）
  useEffect(() => {
    if (form.id || form.accountId || accounts.length === 0) return;
    const active = useMailStore.getState().activeAccountId;
    const defaultAccount = active && accounts.some((a) => a.id === active)
      ? active
      : accounts[0].id;
    setForm((old) => (old.accountId ? old : { ...old, accountId: defaultAccount }));
  }, [accounts, form.id, form.accountId]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // 账号筛选：多账号下按归属账号区分（"none" = 未关联账号，用于修正历史数据）
    let scoped: typeof contacts = contacts;
    if (accountFilter === "none") {
      scoped = contacts.filter((contact) => !contact.accountId);
    } else if (accountFilter !== "all") {
      scoped = contacts.filter((contact) => contact.accountId === accountFilter);
    }
    // 类型标签（客户/供应商/服务商/内部联系人/未分类）按角色筛选；
    // 自定义标签按 tags 筛选。两类标签在标签栏合并去重，避免重复。
    let tagged: typeof contacts;
    const typeFilter = TYPE_TAG_FILTERS.find((item) => item.label === activeTag);
    if (typeFilter) {
      tagged = scoped.filter((contact) => contact.role === typeFilter.role);
    } else if (activeTag) {
      tagged = scoped.filter((contact) => contact.tags.includes(activeTag));
    } else {
      tagged = scoped;
    }
    if (!needle) return tagged;
    return tagged.filter((contact) =>
      [contact.name, contact.email, contact.company, contact.jobTitle, contact.notes, ...contact.tags]
        .some((value) => value.toLowerCase().includes(needle)),
    );
  }, [contacts, query, activeTag, accountFilter]);

  const customTags = useMemo(() => {
    // 只取自定义标签：剔除与类型标签（防呆固定标签）相同或互相包含的。
    return [
      ...new Set(
        contacts
          .flatMap((contact) => contact.tags.map((tag) => tag.trim()))
          .filter(Boolean)
          .filter((tag) => !TYPE_TAG_FILTERS.some((item) => item.label === tag))
          .filter((tag) => !TYPE_TAG_FILTERS.some((item) => tag.includes(item.label) || item.label.includes(tag))),
      ),
    ].sort((a, b) => a.localeCompare(b, "zh"));
  }, [contacts]);

  const [tagMenu, setTagMenu] = useState<{ x: number; y: number; tag: string } | null>(null);
  const [contactMenu, setContactMenu] = useState<{ x: number; y: number; contact: AddressBookContact } | null>(null);
  // 批量操作
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [batchAccountId, setBatchAccountId] = useState("");
  const [batchRole, setBatchRole] = useState("");

  // 删除自定义标签：从所有联系人身上移除该标签并保存。
  async function handleDeleteCustomTag(tag: string) {
    const affected = contacts.filter((contact) => contact.tags.includes(tag));
    if (affected.length === 0) return;
    if (!window.confirm(`确定删除自定义标签「${tag}」吗？将同时从 ${affected.length} 位联系人的标签中移除。`)) return;
    setBusy(true);
    try {
      for (const contact of affected) {
        await saveAddressBookContact({
          id: contact.id,
          email: contact.email,
          name: contact.name,
          company: contact.company,
          jobTitle: contact.jobTitle,
          role: contact.role as ContactRole,
          notes: contact.notes,
          tags: contact.tags.filter((item) => item !== tag),
        });
      }
      await refresh();
      if (activeTag === tag) setActiveTag("");
      useToastStore.getState().addToast({ message: `已删除标签「${tag}」。`, type: "success" });
    } catch (error) {
      useToastStore.getState().addToast({ message: `删除标签失败：${extractErrorMessage(error)}`, type: "error" });
    } finally {
      setBusy(false);
    }
  }

  // 重命名自定义标签：所有含旧标签的联系人改为新标签。
  async function handleRenameCustomTag(oldTag: string, newTag: string) {
    const trimmed = newTag.trim();
    if (!trimmed || trimmed === oldTag) return;
    if (TYPE_TAG_FILTERS.some((item) => item.label === trimmed)) {
      useToastStore.getState().addToast({ message: "不能重命名为固定的类型标签（客户/供应商/服务商/内部联系人/未分类）。", type: "error" });
      return;
    }
    const affected = contacts.filter((contact) => contact.tags.includes(oldTag));
    setBusy(true);
    try {
      for (const contact of affected) {
        await saveAddressBookContact({
          id: contact.id,
          email: contact.email,
          name: contact.name,
          company: contact.company,
          jobTitle: contact.jobTitle,
          role: contact.role as ContactRole,
          notes: contact.notes,
          tags: contact.tags.map((item) => (item === oldTag ? trimmed : item)),
        });
      }
      await refresh();
      if (activeTag === oldTag) setActiveTag(trimmed);
      useToastStore.getState().addToast({ message: `标签「${oldTag}」已重命名为「${trimmed}」。`, type: "success" });
    } catch (error) {
      useToastStore.getState().addToast({ message: `重命名失败：${extractErrorMessage(error)}`, type: "error" });
    } finally {
      setBusy(false);
    }
  }


  // 数据清洗：历史数据里可能有重复/带空格的标签（如"客户"和"客户 "），
  // 加载后自动规范化并保存回，保证所有标签唯一，供发送防呆使用。
  useEffect(() => {
    const dirty = contacts.filter((contact) => {
      const normalized = [...new Set(contact.tags.map((tag) => tag.trim()).filter(Boolean))];
      return normalized.length !== contact.tags.length || contact.tags.some((tag) => tag !== tag.trim());
    });
    if (dirty.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const contact of dirty) {
        if (cancelled) return;
        try {
          await saveAddressBookContact({
            id: contact.id,
            email: contact.email,
            name: contact.name,
            company: contact.company,
            jobTitle: contact.jobTitle,
            role: contact.role as ContactRole,
            notes: contact.notes,
            tags: [...new Set(contact.tags.map((tag) => tag.trim()).filter(Boolean))],
          });
        } catch {
          // 单条失败不阻塞整体
        }
      }
      if (!cancelled) await refresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [contacts]);
  const selectedProfile = useMemo(() => {
    if (!form.id) return null;
    return profiles.find((profile) =>
      (form.company && profile.company.trim().toLowerCase() === form.company.trim().toLowerCase())
      || profile.email.toLowerCase() === form.email.toLowerCase()
      || profile.contacts.some((contact) => contact.email.toLowerCase() === form.email.toLowerCase()),
    ) ?? null;
  }, [form, profiles]);
  const selectedResearch = useMemo(() => {
    if (!form.id) return null;
    const emailDomain = form.email.split("@")[1]?.toLowerCase() ?? "";
    return researchReports.find((report) => {
      const websiteHost = report.website.replace(/^https?:\/\//i, "").split("/")[0].replace(/^www\./i, "").toLowerCase();
      return (form.company && report.companyName.trim().toLowerCase() === form.company.trim().toLowerCase())
        || (emailDomain && websiteHost && (emailDomain === websiteHost || emailDomain.endsWith(`.${websiteHost}`)));
    }) ?? null;
  }, [form, researchReports]);

  async function mergeResearchIntoProfile() {
    if (!selectedResearch || !form.email) return;
    const publicProfile = [
      selectedProfile?.profile ?? "",
      "【公开背景调研】",
      selectedResearch.websiteTitle && `官网：${selectedResearch.websiteTitle}`,
      selectedResearch.websiteDescription && `官网介绍：${selectedResearch.websiteDescription}`,
      selectedResearch.legalMatches[0] && `法人匹配：${selectedResearch.legalMatches[0].legalName}；国家 ${selectedResearch.legalMatches[0].country}；状态 ${selectedResearch.legalMatches[0].registrationStatus}；LEI ${selectedResearch.legalMatches[0].lei}`,
      selectedResearch.publicEmails.length && `官网公开邮箱：${selectedResearch.publicEmails.join("、")}`,
      `调研来源：${selectedResearch.sources.map((source) => source.title).join("、")}`,
    ].filter(Boolean).join("\n");
    setBusy(true);
    try {
      await saveCustomerMemory({
        id: selectedProfile?.id,
        email: form.email,
        name: form.name,
        company: form.company || selectedResearch.companyName,
        summary: selectedProfile?.summary || selectedResearch.websiteDescription || "已完成公开背景调研",
        profile: publicProfile,
      });
      await refresh();
      useToastStore.getState().addToast({ message: "公开调研结果已加入客户画像。", type: "success" });
    } catch (error) {
      useToastStore.getState().addToast({ message: `更新画像失败：${extractErrorMessage(error)}`, type: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!form.email.trim()) return;
    // 所有邮箱必须关联一个具体账号："全部账号"只是汇总，不是独立分类。
    let accountId = form.accountId;
    if (!accountId) {
      // 尝试按邮箱域名自动匹配账号（如 xx@alibaba.com → alibaba 账号）
      const domain = form.email.split("@")[1]?.toLowerCase();
      const matched = domain ? accounts.find((a) => a.email.split("@")[1]?.toLowerCase() === domain) : undefined;
      accountId = matched?.id ?? null;
    }
    if (!accountId) {
      useToastStore.getState().addToast({ message: "请选择该联系人关联的账号（发送防呆与客户管理需要按账号区分）。", type: "error" });
      return;
    }
    setBusy(true);
    try {
      await saveAddressBookContact({
        id: form.id || undefined,
        email: form.email,
        name: form.name,
        company: form.company,
        jobTitle: form.jobTitle,
        role: form.role,
        notes: form.notes,
        tags: [...new Set(form.tags.split(/[，,;；]/).map((tag) => tag.trim()).filter(Boolean))],
        accountId,
      });
      setForm(emptyForm);
      await refresh();
      useToastStore.getState().addToast({ message: "联系人已保存，发送防呆会直接使用这里的角色标签。", type: "success" });
    } catch (error) {
      useToastStore.getState().addToast({ message: `保存失败：${extractErrorMessage(error)}`, type: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function importFromMail() {
    setBusy(true);
    try {
      const accounts = await listAccounts();
      let count = 0;
      for (const account of accounts) count += await importMailContactsToAddressBook(account.id);
      await refresh();
      useToastStore.getState().addToast({ message: `已从往来邮件补充 ${count} 个联系人。`, type: "success" });
    } catch (error) {
      useToastStore.getState().addToast({ message: `导入失败：${extractErrorMessage(error)}`, type: "error" });
    } finally {
      setBusy(false);
    }
  }

  // ─── 批量操作 ──────────────────────────────────────────────────────────────
  function toggleBatchSelect(id: string, index: number, event?: React.MouseEvent) {
    setSelectedIds((prev) => {
      if (event?.shiftKey && lastSelectedIndex !== null) {
        const start = Math.min(index, lastSelectedIndex);
        const end = Math.max(index, lastSelectedIndex);
        return new Set(filtered.slice(start, end + 1).map((contact) => contact.id));
      }
      const next = event?.ctrlKey || event?.metaKey ? new Set(prev) : new Set<string>();
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setLastSelectedIndex(index);
  }
  function toggleSelectAll() {
    setSelectedIds((prev) => (prev.size === filtered.length ? new Set() : new Set(filtered.map((c) => c.id))));
    setLastSelectedIndex(null);
  }
  async function batchApplyAccount() {
    const target = contacts.filter((c) => selectedIds.has(c.id));
    if (!batchAccountId || target.length === 0) {
      useToastStore.getState().addToast({ message: "请先选择账号并勾选联系人", type: "error" });
      return;
    }
    setBusy(true);
    const failed: string[] = [];
    try {
      for (const c of target) {
        try {
          await saveAddressBookContact({
            id: c.id,
            email: c.email,
            name: c.name,
            company: c.company,
            jobTitle: c.jobTitle,
            role: c.role as ContactRole,
            notes: c.notes,
            tags: c.tags,
            accountId: batchAccountId,
          });
        } catch {
          failed.push(c.email);
        }
      }
      await refresh();
      const okCount = target.length - failed.length;
      if (failed.length === 0) {
        useToastStore.getState().addToast({ message: `已将 ${okCount} 个联系人关联到所选账号。`, type: "success" });
      } else {
        useToastStore.getState().addToast({
          message: `${okCount} 个成功，${failed.length} 个失败（${failed.slice(0, 5).join("、")}${failed.length > 5 ? ` 等 ${failed.length} 个` : ""}）`,
          type: "error",
        });
      }
      setSelectedIds(new Set());
    } catch (error) {
      useToastStore.getState().addToast({ message: `批量关联失败：${extractErrorMessage(error)}`, type: "error" });
    } finally {
      setBusy(false);
    }
  }
  async function batchApplyRole() {
    const target = contacts.filter((c) => selectedIds.has(c.id));
    if (!batchRole || target.length === 0) {
      useToastStore.getState().addToast({ message: "请先选择类型并勾选联系人", type: "error" });
      return;
    }
    setBusy(true);
    const failed: string[] = [];
    try {
      for (const c of target) {
        try {
          await saveAddressBookContact({
            id: c.id,
            email: c.email,
            name: c.name,
            company: c.company,
            jobTitle: c.jobTitle,
            role: batchRole as ContactRole,
            notes: c.notes,
            tags: c.tags,
            accountId: c.accountId ?? null,
          });
        } catch {
          failed.push(c.email);
        }
      }
      await refresh();
      const okCount = target.length - failed.length;
      if (failed.length === 0) {
        useToastStore.getState().addToast({ message: `已将 ${okCount} 个联系人的类型改为「${ROLES.find((r) => r.value === batchRole)?.label}」。`, type: "success" });
      } else {
        useToastStore.getState().addToast({
          message: `${okCount} 个成功，${failed.length} 个失败（${failed.slice(0, 5).join("、")}${failed.length > 5 ? ` 等 ${failed.length} 个` : ""}）`,
          type: "error",
        });
      }
      setSelectedIds(new Set());
    } catch (error) {
      useToastStore.getState().addToast({ message: `批量修改失败：${extractErrorMessage(error)}`, type: "error" });
    } finally {
      setBusy(false);
    }
  }
  async function batchDelete() {
    const target = contacts.filter((c) => selectedIds.has(c.id));
    if (target.length === 0) return;
    if (!window.confirm(`确定删除选中的 ${target.length} 个联系人吗？`)) return;
    setBusy(true);
    const failed: string[] = [];
    try {
      for (const c of target) {
        try {
          await deleteAddressBookContact(c.id);
        } catch {
          failed.push(c.email);
        }
      }
      await refresh();
      const okCount = target.length - failed.length;
      if (failed.length === 0) {
        useToastStore.getState().addToast({ message: `已删除 ${okCount} 个联系人。`, type: "success" });
      } else {
        useToastStore.getState().addToast({
          message: `${okCount} 个成功，${failed.length} 个失败（${failed.slice(0, 5).join("、")}${failed.length > 5 ? ` 等 ${failed.length} 个` : ""}）`,
          type: "error",
        });
      }
      setSelectedIds(new Set());
    } catch (error) {
      useToastStore.getState().addToast({ message: `批量删除失败：${extractErrorMessage(error)}`, type: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function autoTagContacts() {
    startTask("addressBookTagging", "联系人识别", async () => {
      const accounts = await listAccounts();
      const roles = new Map<string, ContactRoleEntry>();
      // 第一轮：快速规则识别（无需 AI），立即给大部分联系人打上标签。
      for (const account of accounts) {
        const cheap = await autoClassifyContacts(account.id);
        for (const entry of cheap) {
          if (entry.role !== "unknown") roles.set(entry.email.toLowerCase(), entry);
        }
      }
      // 第二轮：结合邮件内容的 AI 识别（未配置 AI 时自动退回规则）。
      for (const account of accounts) {
        const ai = await inferAllContactRoles(account.id);
        for (const entry of ai) {
          if (entry.role !== "unknown") roles.set(entry.email.toLowerCase(), entry);
        }
      }
      const current = await listAddressBookContacts();
      let updated = 0;
      for (const contact of current) {
        const entry = roles.get(contact.email.toLowerCase());
        if (!entry || entry.role === "unknown") continue;
        const tag = ROLE_TAG[entry.role];
        const tags = contact.tags.includes(tag) ? contact.tags : [...contact.tags, tag];
        if (contact.role === entry.role && tags.join("|") === contact.tags.join("|")) continue;
        await saveAddressBookContact({
          id: contact.id,
          email: contact.email,
          name: contact.name,
          company: contact.company,
          jobTitle: contact.jobTitle,
          role: entry.role,
          notes: contact.notes,
          tags,
        });
        updated += 1;
      }
      return updated;
    }, {
      successMessage: (result) => {
        const updated = typeof result === "number" ? result : 0;
        return updated > 0
          ? `识别完成，已更新 ${updated} 个联系人的标签。识别结合了往来邮件内容分析；无邮件记录的联系人仅按地址规则判断（邮件同步完成后重试可提升精度）。识别结果仅供辅助，建议核对。`
          : "识别完成，地址本联系人没有需要更新的标签。";
      },
    });
  }

  const fieldStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", padding: "8px 10px",
    border: "1px solid var(--color-border)", borderRadius: "6px",
    background: "var(--color-bg-secondary)", color: "var(--color-text-primary)", font: "inherit",
  };

  return (
    <div className="scroll-region" style={{ height: "100%", overflow: "auto", padding: "22px 28px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "18px" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "21px" }}>地址本</h1>
          <p style={{ margin: "5px 0 0", color: "var(--color-text-secondary)", fontSize: "13px" }}>
            统一管理联系人、公司、职位和角色标签；客户画像与发送防呆都以此为基础。
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" disabled={busy || taggingBusy} onClick={() => void autoTagContacts()} style={{ padding: "8px 14px", border: 0, borderRadius: "6px", background: "var(--color-accent)", color: "#fff" }}>
            {busy || taggingBusy ? "识别中（可切换到其他页面）…" : "一键识别联系人"}
          </button>
          <button type="button" disabled={busy} onClick={() => void importFromMail()} style={{ padding: "8px 14px", border: 0, borderRadius: "6px", background: "color-mix(in srgb, var(--color-accent) 15%, transparent)", color: "var(--color-accent)" }}>
            从往来邮件补充
          </button>
          <button
            type="button"
            onClick={() => { setBatchMode((v) => !v); setSelectedIds(new Set()); }}
            style={{ padding: "8px 14px", border: "1px solid var(--color-border)", borderRadius: "6px", background: batchMode ? "var(--color-sidebar-active)" : "transparent", color: "var(--color-text-primary)" }}
          >
            {batchMode ? "退出批量操作" : "批量操作"}
          </button>
        </div>
      </div>

      {/* 批量操作栏 */}
      {batchMode && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "8px 10px", border: "1px solid var(--color-accent)", borderRadius: 8, marginBottom: 10, background: "color-mix(in srgb, var(--color-accent) 6%, transparent)" }}>
          <strong style={{ fontSize: 12 }}>已选 {selectedIds.size} 人</strong>
          <button type="button" onClick={toggleSelectAll} style={{ fontSize: 12, padding: "4px 10px", border: "1px solid var(--color-border)", borderRadius: 6, background: "transparent", cursor: "pointer" }}>
            {selectedIds.size === filtered.length && filtered.length > 0 ? "取消全选" : "全选"}
          </button>
          <select value={batchAccountId} onChange={(e) => setBatchAccountId(e.target.value)} style={{ ...fieldStyle, width: "auto", fontSize: 12 }} title="批量关联账号">
            <option value="">批量关联账号…</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.display_name?.trim() || account.email.split("@")[0] || account.email}
              </option>
            ))}
          </select>
          <button type="button" disabled={busy} onClick={() => void batchApplyAccount()} style={{ fontSize: 12, padding: "4px 10px", border: 0, borderRadius: 6, background: "var(--color-accent)", color: "#fff", cursor: busy ? "not-allowed" : "pointer" }}>
            应用
          </button>
          <select value={batchRole} onChange={(e) => setBatchRole(e.target.value)} style={{ ...fieldStyle, width: "auto", fontSize: 12 }} title="批量修改联系人类型">
            <option value="">批量修改类型…</option>
            {ROLES.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
          </select>
          <button type="button" disabled={busy} onClick={() => void batchApplyRole()} style={{ fontSize: 12, padding: "4px 10px", border: 0, borderRadius: 6, background: "var(--color-accent)", color: "#fff", cursor: busy ? "not-allowed" : "pointer" }}>
            应用
          </button>
          <button type="button" disabled={busy} onClick={() => void batchDelete()} style={{ fontSize: 12, padding: "4px 10px", border: 0, borderRadius: 6, background: "rgba(220,53,69,0.15)", color: "#dc3545", cursor: busy ? "not-allowed" : "pointer" }}>
            删除选中
          </button>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(420px, 1.4fr) minmax(300px, 0.8fr)", gap: "18px" }}>
        <section>
          <div style={{ display: "flex", gap: "8px", marginBottom: "10px", alignItems: "center" }}>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索姓名、邮箱、公司、职位或标签" style={{ ...fieldStyle, flex: 1, marginBottom: 0 }} />
            {/* 多账号下按账号筛选，避免混在一起 */}
            <select
              value={accountFilter}
              onChange={(event) => setAccountFilter(event.target.value)}
              style={{ ...fieldStyle, width: "auto", minWidth: "130px", marginBottom: 0 }}
              title="按账号筛选联系人"
            >
              <option value="all">全部账号</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.display_name?.trim() || account.email.split("@")[0] || account.email}
                </option>
              ))}
              <option value="none">未关联账号（需修正）</option>
            </select>
          </div>
          {/* 固定类型标签（发送防呆用，不允许修改） */}
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "8px", alignItems: "center" }}>
            <button type="button" onClick={() => setActiveTag("")} style={tagButton(!activeTag)}>全部</button>
            {TYPE_TAG_FILTERS.map((item) => (
              <button key={item.label} type="button" onClick={() => setActiveTag(item.label)} style={tagButton(activeTag === item.label)} title={`按联系人类型筛选（发送防呆口径）`}>
                {item.label}
              </button>
            ))}
          </div>
          {/* 自定义标签（可删除 / 右键重命名） */}
          {customTags.length > 0 && (
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "10px", alignItems: "center" }}>
              <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginRight: "2px" }}>自定义标签：</span>
              {customTags.map((tag) => (
                <span key={tag} style={{ display: "inline-flex", alignItems: "center", gap: "3px" }}>
                  <button
                    type="button"
                    onClick={() => setActiveTag(tag)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setTagMenu({ x: event.clientX, y: event.clientY, tag });
                    }}
                    style={tagButton(activeTag === tag)}
                    title="右键可重命名 / 删除"
                  >
                    {tag}
                  </button>
                  <button
                    type="button"
                    title={`删除标签「${tag}」`}
                    onClick={() => void handleDeleteCustomTag(tag)}
                    style={{ border: "none", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", padding: "2px", display: "inline-flex", opacity: 0.7 }}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {tagMenu && (
            <ContextMenu
              x={tagMenu.x}
              y={tagMenu.y}
              items={[
                {
                  label: `重命名「${tagMenu.tag}」`,
                  icon: <PenLine size={14} />,
                  onClick: () => {
                    const next = window.prompt("输入新的标签名称：", tagMenu.tag);
                    if (next) void handleRenameCustomTag(tagMenu.tag, next);
                  },
                },
                { separator: true },
                {
                  label: `删除「${tagMenu.tag}」`,
                  icon: <Trash2 size={14} />,
                  danger: true,
                  onClick: () => void handleDeleteCustomTag(tagMenu.tag),
                },
              ]}
              onClose={() => setTagMenu(null)}
            />
          )}
          <div style={{ border: "1px solid var(--color-border)", borderRadius: "8px", overflow: "hidden" }}>
            {filtered.length === 0 && <div style={{ padding: "20px", color: "var(--color-text-secondary)" }}>暂无联系人</div>}
            {filtered.map((contact, index) => (
              <div
                key={contact.id}
                onClick={(event) => batchMode
                  ? toggleBatchSelect(contact.id, index, event)
                  : setForm({ ...contact, tags: contact.tags.join(", "), accountId: contact.accountId ?? null })}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContactMenu({ x: event.clientX, y: event.clientY, contact });
                }}
                style={{ display: "grid", gridTemplateColumns: batchMode ? "auto 1fr auto" : "1fr auto", gap: "10px", padding: "11px 12px", borderBottom: "1px solid var(--color-border)", cursor: "pointer", background: selectedIds.has(contact.id) ? "var(--color-sidebar-active)" : (form.id === contact.id ? "var(--color-sidebar-active)" : "transparent") }}
              >
                {batchMode && (
                  <input
                    type="checkbox"
                    checked={selectedIds.has(contact.id)}
                    onChange={(event) => toggleBatchSelect(contact.id, index, event as unknown as React.MouseEvent)}
                    onClick={(e) => e.stopPropagation()}
                    style={{ alignSelf: "center", width: 15, height: 15, cursor: "pointer" }}
                  />
                )}
                <div>
                  <div style={{ fontWeight: 600 }}>{contact.name || contact.email}</div>
                  <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px" }}>
                    {contact.email}{contact.company ? ` · ${contact.company}` : ""}{contact.jobTitle ? ` · ${contact.jobTitle}` : ""}
                  </div>
                  <div style={{ fontSize: "12px", marginTop: "5px" }}>
                    {ROLES.find((role) => role.value === contact.role)?.label ?? "未分类"}
                    {contact.tags.length > 0 ? ` · ${contact.tags.join(" / ")}` : ""}
                    {!contact.accountId ? <span style={{ color: "#dc3545" }}> · 未关联账号</span> : ""}
                  </div>
                </div>
                {!batchMode && (
                <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                  <button type="button" onClick={(event) => { event.stopPropagation(); setForm({ ...contact, tags: contact.tags.join(", "), accountId: contact.accountId ?? null }); }}>编辑</button>
                  <button type="button" onClick={(event) => { event.stopPropagation(); void deleteAddressBookContact(contact.id).then(refresh); }} style={{ color: "#dc3545" }}>删除</button>
                </div>
                )}
              </div>
            ))}
          </div>
          {contactMenu && (
            <ContextMenu
              x={contactMenu.x}
              y={contactMenu.y}
              items={[
                {
                  label: "编辑联系人",
                  icon: <PenLine size={14} />,
                  onClick: () => setForm({ ...contactMenu.contact, tags: contactMenu.contact.tags.join(", "), accountId: contactMenu.contact.accountId ?? null }),
                },
                {
                  label: "发送邮件",
                  icon: <Mail size={14} />,
                  onClick: () => useComposeStore.getState().openCompose("new", null, { to: [contactMenu.contact.email] }),
                },
                {
                  label: "生成客户画像（保存到客户管理）",
                  icon: <Sparkles size={14} />,
                  onClick: () => {
                    useUIStore.getState().setActiveView("customerProfile");
                    useUIStore.getState().setCustomerProfileEmail(contactMenu.contact.email);
                  },
                },
                {
                  label: "复制邮箱地址",
                  icon: <Copy size={14} />,
                  onClick: () => {
                    void navigator.clipboard.writeText(contactMenu.contact.email);
                    useToastStore.getState().addToast({ message: "邮箱地址已复制。", type: "success" });
                  },
                },
                { separator: true },
                {
                  label: "删除联系人",
                  icon: <Trash2 size={14} />,
                  danger: true,
                  onClick: async () => {
                    if (!window.confirm(`确定删除联系人 ${contactMenu.contact.email} 吗？`)) return;
                    try {
                      await deleteAddressBookContact(contactMenu.contact.id);
                      await refresh();
                      useToastStore.getState().addToast({ message: "联系人已删除。", type: "success" });
                    } catch (error) {
                      useToastStore.getState().addToast({ message: `删除失败：${extractErrorMessage(error)}`, type: "error" });
                    }
                  },
                },
              ]}
              onClose={() => setContactMenu(null)}
            />
          )}
        </section>

        <section style={{ border: "1px solid var(--color-border)", borderRadius: "8px", padding: "14px", alignSelf: "start", position: "sticky", top: "0px", background: "var(--color-bg-primary)", zIndex: 2, maxHeight: "calc(100vh - 80px)", overflowY: "auto" }}>
          <h2 style={{ fontSize: "15px", margin: "0 0 12px" }}>{form.id ? "编辑联系人" : "新增联系人"}</h2>
          {[
            ["邮箱地址", "email"], ["姓名", "name"], ["公司", "company"], ["职位 / 角色", "jobTitle"],
          ].map(([label, key]) => (
            <label key={key} style={{ display: "block", fontSize: "12px", marginBottom: "10px" }}>
              <span style={{ display: "block", marginBottom: "4px", color: "var(--color-text-secondary)" }}>{label}</span>
              <input value={form[key as keyof typeof form] as string} onChange={(event) => setForm((old) => ({ ...old, [key]: event.target.value }))} style={fieldStyle} />
            </label>
          ))}
          <label style={{ display: "block", fontSize: "12px", marginBottom: "10px" }}>
            <span style={{ display: "block", marginBottom: "4px", color: "var(--color-text-secondary)" }}>关联账号（必选；"全部账号"只是汇总，每个邮箱必须归属具体账号）</span>
            <select
              value={form.accountId ?? ""}
              onChange={(event) => setForm((old) => ({ ...old, accountId: event.target.value || null }))}
              style={fieldStyle}
            >
              <option value="">请选择账号…</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.display_name?.trim() || account.email.split("@")[0] || account.email}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "block", fontSize: "12px", marginBottom: "10px" }}>
            <span style={{ display: "block", marginBottom: "4px", color: "var(--color-text-secondary)" }}>联系人类型（发送防呆使用）</span>
            <select value={form.role} onChange={(event) => setForm((old) => ({ ...old, role: event.target.value as ContactRole }))} style={fieldStyle}>
              {ROLES.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
            </select>
          </label>
          <label style={{ display: "block", fontSize: "12px", marginBottom: "10px" }}>
            <span style={{ display: "block", marginBottom: "4px", color: "var(--color-text-secondary)" }}>标签（逗号分隔）</span>
            <input value={form.tags} onChange={(event) => setForm((old) => ({ ...old, tags: event.target.value }))} style={fieldStyle} />
          </label>
          <label style={{ display: "block", fontSize: "12px", marginBottom: "12px" }}>
            <span style={{ display: "block", marginBottom: "4px", color: "var(--color-text-secondary)" }}>备注</span>
            <textarea value={form.notes} onChange={(event) => setForm((old) => ({ ...old, notes: event.target.value }))} style={{ ...fieldStyle, minHeight: "90px", resize: "vertical" }} />
          </label>
          <div style={{ display: "flex", gap: "8px" }}>
            <button type="button" disabled={busy} onClick={() => void save()} style={{ padding: "8px 16px", border: 0, borderRadius: "6px", background: "var(--color-accent)", color: "#fff" }}>保存</button>
            {form.id && <button type="button" onClick={() => setForm(emptyForm)}>取消</button>}
          </div>
          {form.id && (
            <div style={{ borderTop: "1px solid var(--color-border)", marginTop: "16px", paddingTop: "14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <h3 style={{ fontSize: "14px", margin: 0 }}>客户画像</h3>
                <button
                  type="button"
                  onClick={() => {
                    useUIStore.getState().setActiveView("customerProfile");
                    useUIStore.getState().setCustomerProfileEmail(form.email);
                  }}
                  style={{ padding: "4px 10px", fontSize: 12, border: 0, borderRadius: 6, background: "var(--color-accent)", color: "#fff", cursor: "pointer" }}
                >
                  生成客户画像（AI + 联网调研）
                </button>
              </div>
              {selectedProfile ? (
                <>
                  <div style={{ fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}>{selectedProfile.summary}</div>
                  <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: "12px", lineHeight: 1.6, maxHeight: "260px", overflow: "auto", padding: "10px", borderRadius: "6px", background: "var(--color-bg-secondary)" }}>{selectedProfile.profile}</pre>
                </>
              ) : (
                <p style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
                  暂无客户画像。联网背景调研功能完成后可在这里生成并持续更新。
                </p>
              )}
              {selectedResearch && (
                <div style={{ marginTop: "10px", padding: "10px", borderRadius: "6px", background: "var(--color-bg-secondary)", fontSize: "12px" }}>
                  <strong>已匹配到公开背景调研</strong>
                  <div style={{ margin: "5px 0", color: "var(--color-text-secondary)" }}>
                    {selectedResearch.websiteTitle || selectedResearch.companyName} · {selectedResearch.legalMatches.length} 条法人匹配
                  </div>
                  <button type="button" disabled={busy} onClick={() => void mergeResearchIntoProfile()}>
                    加入客户画像
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function tagButton(active: boolean): React.CSSProperties {
  return {
    border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border)"}`,
    borderRadius: "14px",
    padding: "4px 9px",
    background: active ? "color-mix(in srgb, var(--color-accent) 14%, transparent)" : "transparent",
    color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
    fontSize: "11px",
    cursor: "pointer",
  };
}
