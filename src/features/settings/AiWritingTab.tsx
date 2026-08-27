import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  listStyleProfiles,
  saveStyleProfile,
  deleteStyleProfile,
  getSentSamples,
  listCustomerMemories,
  listThreadMessages,
  searchKnowledgeBase,
  listKnowledgeItems,
  listAddressBookContacts,
  aiPrompt,
  getMessagesBatch,
  readAttachmentFile,
  type Message,
  type StyleProfile,
  type StyleSample,
  type CustomerMemory,
  type AddressBookContact,
} from "../../lib/api";
import { useToastStore } from "@/stores/toast.store";
import MarkdownView from "@/lib/renderMarkdown";
import { extractErrorMessage } from "../../lib/extractErrorMessage";
import { useMailStore } from "@/stores/mail.store";
import { useMessageQuery } from "@/hooks/queries";
import { useComposeStore } from "@/stores/compose.store";
import { useUIStore } from "@/stores/ui.store";
import { getSignature, listEmailSignatures, type EmailSignature } from "@/lib/signatures";
import { extractDocumentText } from "@/lib/documentText";
import { Maximize2, Undo2 } from "lucide-react";
import { getActiveWorkRole } from "./WorkRoleTab";
import { resizeAutoGrowTextarea } from "@/lib/autoGrowTextarea";
import { getWritingPreferences, saveWritingPreferences } from "@/lib/writingPreferences";
import KnowledgePicker from "@/components/KnowledgePicker";
import AccountScopePicker from "@/components/AccountScopePicker";
import AccountScopeSelect from "@/components/AccountScopeSelect";
import { useAccountsQuery } from "@/hooks/queries";
import { accountLabel } from "@/lib/accountLabel";

interface WritingTurn {
  id: string;
  instruction: string;
  answer: string;
}

interface SelectedAiFile {
  id: string;
  file: File;
}

const MAX_AI_FILE_BYTES = 20 * 1024 * 1024;
const MAX_AI_CONTEXT_CHARS = 48_000;

function compactMessageContext(message: Message): string {
  const recipients = message.to_list.map((item) => item.address).join(", ");
  return `主题：${message.subject || "（无主题）"}
日期：${new Date(message.date).toLocaleString()}
发件人：${message.from_name || message.from_address} <${message.from_address}>
收件人：${recipients || "（未提供）"}
正文：
${message.body_text.slice(0, 9_000)}`;
}

function appendContext(base: string, addition: string): string {
  const separator = "\n\n---\n\n";
  const remaining = MAX_AI_CONTEXT_CHARS - base.length - separator.length;
  if (remaining <= 0) return base;
  return `${base}${separator}${addition.slice(0, remaining)}`;
}

const LEARN_SYSTEM = `你是一位资深外贸业务写作风格分析师。下面是我（用户）过去发出的一些邮件样本。请分析并总结我的写作风格，输出一份简洁、可复用、用于指导 AI 代我写邮件的「风格档案」。
请包含：
1) 整体语气与职业人设（例如：专业但亲和、简洁直接等）；
2) 常用的开场白与结尾敬语；
3) 句子长度与结构特点；
4) 高频词汇/短语（如有）；
5) 应避免的表达；
6) 签名/落款习惯（如样本中有体现）。
用中文，条理清晰，300 字以内。`;

function buildGenerateSystem(profile: string, hasDefaultSignature: boolean): string {
  return `你现在扮演我（外贸业务人员），严格按照下面的「我的写作风格」来写邮件。

我的写作风格：
${profile}

要求：只输出邮件正文（含合适的称呼与正文），不要解释，不要使用方括号占位符以外的说明。
【硬性要求】每一轮都输出完整、可直接使用的邮件正文（称呼+正文+结尾），内容充分、表述专业；即使对话前文已有草稿，也不得省略、只输出修改片段或大幅精简成几句话。
【硬性要求语言】整封邮件必须使用单一语言（中文或英文，二选一），禁止中英混杂。回复邮件时使用与原文相同的语言（英文客户用英文，中文客户用中文）；即使风格档案/工作角色/客户背景里出现另一种语言片段，也只能用作参考语境，不能复制到正文（不能用 "Your礼品店" "灯饰" 这类中英混写）。指令要求英文就全文英文、要求中文就全文中文。
【硬性要求】${hasDefaultSignature
  ? "不要生成任何签名/落款/署名行（如 Best regards / Regards / Kind regards / Sincerely / Yours faithfully / 此致 / 敬礼 / 你的名字等）。正文在最后一句问候或内容后直接结束——账号的默认签名会由系统自动附加，重复落款会造成邮件出现两个签名。"
  : "你可以在正文结尾按你的写作风格写署名/落款（当前账号未设置默认签名，落款需要由正文自带）。"}`;
}

const LEARN_SYSTEM_V2 = `你是个人商务邮件写作风格分析器。输入是经过脱敏的用户本人邮件证据。
不要只输出“正式、友好、简洁”等空泛标签。请从多个样本反复出现的证据中提取可执行规则：长度与段落、句子节奏、项目符号、称呼、开场、结尾、I/we、语态、缩写、标点、大小写，以及询价、报价、确认、催促、付款、投诉和售后的表达方式。不同语言分别总结。
给出“避免X，因为多个样本更倾向于Y”形式的反面约束，并标明低置信度观察。历史样本只能用于模仿结构、节奏和措辞，严禁复制旧客户、价格、订单、日期、交期或承诺。输出结构化、可直接用于生成的中文风格档案。`;

function redactStyleEvidence(text: string): string {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]")
    .replace(/https?:\/\/\S+/gi, "[WEBSITE]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[PHONE_OR_NUMBER]")
    .replace(/\b(?:PO|PI|SO|INV|ORDER|CONTRACT)[-:#\s]*[A-Z0-9-]+\b/gi, "[DOCUMENT_ID]")
    .replace(/[$€£¥]\s?\d[\d,.]*/g, "[PRICE]")
    .replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, "[DATE]");
}

export default function AiWritingTab({ quick = false }: { quick?: boolean }) {
  const { t } = useTranslation();
  const { data: accounts = [] } = useAccountsQuery();
  const [profiles, setProfiles] = useState<StyleProfile[]>([]);
  const [activeId, setActiveId] = useState("");

  const [learnStatus, setLearnStatus] = useState("");
  const [learning, setLearning] = useState(false);
  const [allowStyleEvidenceUpload, setAllowStyleEvidenceUpload] = useState(false);
  const [learningAccountId, setLearningAccountId] = useState("");

  const [editing, setEditing] = useState<StyleProfile | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editProfile, setEditProfile] = useState("");
  const [editAccountIds, setEditAccountIds] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [scopeSavingId, setScopeSavingId] = useState<string | null>(null);

  const [instruction, setInstruction] = useState("");
  const [genStyleId, setGenStyleId] = useState("");
  const [styleAdjustText, setStyleAdjustText] = useState("");
  const [styleAdjusting, setStyleAdjusting] = useState(false);
  const [customerMemories, setCustomerMemories] = useState<CustomerMemory[]>([]);
  const [addressBook, setAddressBook] = useState<AddressBookContact[]>([]);
  const [genCustomerId, setGenCustomerId] = useState("");

  const [conversation, setConversation] = useState<WritingTurn[]>([]);
  const [generating, setGenerating] = useState(false);
  const [language, setLanguage] = useState("auto");
  const [includeCurrentEmail, setIncludeCurrentEmail] = useState(true);
  const [includeKnowledge, setIncludeKnowledge] = useState(false);
  const [selectedAiFiles, setSelectedAiFiles] = useState<SelectedAiFile[]>([]);
  const [selectedAiMessageIds, setSelectedAiMessageIds] = useState<string[]>([]);
  const [selectedAiMessageTitles, setSelectedAiMessageTitles] = useState<Record<string, string>>({});
  const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<string[]>([]);
  const [signatures, setSignatures] = useState<EmailSignature[]>([]);
  const [selectedSignatureId, setSelectedSignatureId] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [recipientTo, setRecipientTo] = useState("");
  const [recipientCc, setRecipientCc] = useState("");
  const [recipientBcc, setRecipientBcc] = useState("");
  const pendingAiWritingInstruction = useUIStore((s) => s.pendingAiWritingInstruction);
  const setPendingAiWritingInstruction = useUIStore((s) => s.setPendingAiWritingInstruction);
  const activeView = useUIStore((s) => s.activeView);
  const selectedMessageId = useMailStore((s) => s.selectedMessageId);
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const activeMessageId = activeView === "inbox" ? selectedMessageId : null;
  const { data: currentMessage } = useMessageQuery(activeMessageId);
  const activeDraftContext = useComposeStore((s) => s.activeDraftContext);
  const activeCompose = activeView === "compose" && activeDraftContext !== null;
  const currentWritingAccountId = activeDraftContext?.fromAccountId ?? currentMessage?.account_id ?? activeAccountId;
  const selectedLearningAccount = accounts.find((account) => account.id === learningAccountId);
  const availableProfiles = profiles.filter((profile) => Boolean(currentWritingAccountId && profile.accountIds?.includes(currentWritingAccountId)));
  const setAiWritingFloating = useUIStore((s) => s.setAiWritingFloating);
  const closeRightPanel = useUIStore((s) => s.closeRightPanel);
  const aiWritingFloating = useUIStore((s) => s.aiWritingFloating);
  const aiInputFocusOwner = useUIStore((s) => s.aiInputFocusOwner);
  const setAiInputFocusOwner = useUIStore((s) => s.setAiInputFocusOwner);
  const aiComposeLocked = aiInputFocusOwner === "compose";

  useEffect(() => {
    if (learningAccountId && accounts.some((account) => account.id === learningAccountId)) return;
    const preferred = currentWritingAccountId && accounts.some((account) => account.id === currentWritingAccountId)
      ? currentWritingAccountId
      : accounts[0]?.id ?? "";
    setLearningAccountId(preferred);
  }, [accounts, currentWritingAccountId, learningAccountId]);

  useEffect(() => {
    if (!pendingAiWritingInstruction?.trim()) return;
    setInstruction(pendingAiWritingInstruction);
    setPendingAiWritingInstruction(null);
  }, [pendingAiWritingInstruction, setPendingAiWritingInstruction]);

  useEffect(() => {
    if (!activeCompose || !activeDraftContext) return;
    setRecipientTo(activeDraftContext.to.join(", "));
    setRecipientCc(activeDraftContext.cc.join(", "));
    setRecipientBcc(activeDraftContext.bcc.join(", "));
  }, [activeCompose, activeDraftContext]);

  // 切换邮件时隔离上下文：不同邮件的 AI 写作结果/指令/拖入内容互不串扰。
  const lastContextKeyRef = useRef<string>("");
  useEffect(() => {
    const key = activeCompose && activeDraftContext
      ? `draft:${activeDraftContext.subject ?? ""}`
      : activeMessageId
        ? `mail:${activeMessageId}`
        : "none";
    if (lastContextKeyRef.current === "") {
      lastContextKeyRef.current = key;
      return;
    }
    if (lastContextKeyRef.current !== key) {
      lastContextKeyRef.current = key;

      setConversation([]);
      setInstruction("");
      setSelectedAiMessageIds([]);
      setSelectedAiMessageTitles({});
      setSelectedAiFiles([]);
      setSelectedKnowledgeIds([]);

      if (!activeCompose) {
        setRecipientTo("");
        setRecipientCc("");
        setRecipientBcc("");
      }
    }
  }, [activeMessageId, activeCompose, activeDraftContext]);

  function clearAllResult() {

    setConversation([]);
    setInstruction("");
    setSelectedAiMessageIds([]);
    setSelectedAiMessageTitles({});
    setSelectedAiFiles([]);

    flash("已清空本次 AI 写作内容。", "success");
  }

  /** 撤销到上一步：把上一轮 AI 草稿恢复到写信页草稿栏。 */
  function handlePanelUndo() {
    if (conversation.length < 2) return;
    const prev = conversation[conversation.length - 2].answer;
    useComposeStore.getState().applyAiBody(prev);
    flash("已恢复到上一版草稿。", "success");
  }

  // 消费右键菜单“发送到 AI 写作”进入的内容（邮件 / 附件）
  const aiContextQueue = useUIStore((s) => s.aiContextQueue);
  const aiContextAttachmentQueue = useUIStore((s) => s.aiContextAttachmentQueue);
  const clearAiContextQueue = useUIStore((s) => s.clearAiContextQueue);
  const knowledgeContextQueue = useUIStore((s) => s.knowledgeContextQueue);
  const clearKnowledgeContextQueue = useUIStore((s) => s.clearKnowledgeContextQueue);
  useEffect(() => {
    if (aiContextQueue.length === 0) return;
    setSelectedAiMessageIds((current) => {
      const next = [...current];
      for (const item of aiContextQueue) {
        if (!next.includes(item.messageId)) next.push(item.messageId);
      }
      return next;
    });
    setSelectedAiMessageTitles((current) => {
      const next = { ...current };
      for (const item of aiContextQueue) next[item.messageId] = item.title;
      return next;
    });
    clearAiContextQueue();
  }, [aiContextQueue, clearAiContextQueue]);
  useEffect(() => {
    if (aiContextAttachmentQueue.length === 0) return;
    clearAiContextQueue();
    for (const item of aiContextAttachmentQueue) {
      void (async () => {
        try {
          const att = await readAttachmentFile(item.attachmentId);
          const file = new File([new Uint8Array(att.bytes)], att.name, { type: att.mime_type || "" });
          addAiFiles([file]);
        } catch (err) {
          flash(`读取附件失败：${extractErrorMessage(err)}`, "error");
        }
      })();
    }
  }, [aiContextAttachmentQueue, clearAiContextQueue]);
  useEffect(() => {
    const pending = knowledgeContextQueue.filter((item) => item.target === "writing").map((item) => item.itemId);
    if (pending.length === 0) return;
    setSelectedKnowledgeIds((current) => [...new Set([...current, ...pending])]);
    clearKnowledgeContextQueue();
  }, [knowledgeContextQueue, clearKnowledgeContextQueue]);

  // 加载当前账号的签名列表（默认选中默认签名），供“其他选项”选择落款签名
  useEffect(() => {
    const accountId = currentWritingAccountId ?? activeAccountId;
    if (!accountId) {
      setSignatures([]);
      setSelectedSignatureId("");
      return;
    }
    let cancelled = false;
    listEmailSignatures(accountId)
      .then((list) => {
        if (cancelled) return;
        setSignatures(list);
        const def = list.find((s) => s.is_default);
        setSelectedSignatureId((cur) => (cur && list.some((s) => s.id === cur) ? cur : (def?.id ?? "")));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentWritingAccountId, activeAccountId]);

  // 语言、风格、资料库和签名是当前发件账号的默认写作设置；
  // 当前邮件/拖入文件仍然只属于本次任务，不写入这里。
  useEffect(() => {
    const accountId = currentWritingAccountId ?? activeAccountId;
    if (!accountId) return;
    const preferences = getWritingPreferences(accountId);
    setLanguage(preferences.language);
    setIncludeKnowledge(preferences.includeKnowledge);
    setGenStyleId(preferences.styleProfileId);
    setSelectedSignatureId(preferences.signatureId);
  }, [currentWritingAccountId, activeAccountId]);

  function updateWritingPreference(patch: Parameters<typeof saveWritingPreferences>[1]) {
    saveWritingPreferences(currentWritingAccountId ?? activeAccountId, patch);
  }

  const [statusMsg, setStatusMsg] = useState("");
  const [statusType, setStatusType] = useState<"success" | "error" | "">("");

  function flash(msg: string, type: "success" | "error") {
    setStatusMsg(msg);
    setStatusType(type);
  }

  async function refresh() {
    try {
      const list = await listStyleProfiles();
      setProfiles(list);
      const available = list.filter((p) => Boolean(currentWritingAccountId && p.accountIds?.includes(currentWritingAccountId)));
      const active = available.find((p) => p.isActive) ?? available[0] ?? list.find((p) => p.isActive) ?? list[0];
      setActiveId(active?.id ?? "");
      if (!genStyleId) setGenStyleId(active?.id ?? "");
    } catch (err) {
      console.error("Failed to load style profiles:", err);
    }
    try {
      setCustomerMemories(await listCustomerMemories());
    } catch (err) {
      console.error("Failed to load customer memories:", err);
    }
    try {
      setAddressBook(await listAddressBookContacts());
    } catch (err) {
      console.error("Failed to load address book:", err);
    }
  }

  useEffect(() => {
    refresh();
  }, [currentWritingAccountId]);

  async function handleLearn() {
    if (!allowStyleEvidenceUpload) {
      flash("请先确认允许将少量脱敏后的写作样本发送给你配置的 AI 服务商。", "error");
      return;
    }
    setLearning(true);
    setLearnStatus(t("aiWriting.learning"));
    try {
      const samples: StyleSample[] = await getSentSamples(20, learningAccountId || null);
      if (samples.length === 0) {
        flash(t("aiWriting.noSamples"), "error");
        setLearnStatus("");
        return;
      }
      const corpus = samples
        .map((s) => `【主题】${s.subject}\n${s.body}`)
        .join("\n\n---\n\n")
        .slice(0, 12000);
      void corpus; // Kept for backward-compatible parsing; only redactedCorpus is sent.
      const redactedCorpus = samples
        .map((s, index) => `【样本 ${index + 1}】\n主题：${redactStyleEvidence(s.subject)}\n${redactStyleEvidence(s.body)}`)
        .join("\n\n---\n\n")
        .slice(0, 12000);
      const profileText = await aiPrompt(`${LEARN_SYSTEM.slice(0, 0)}${LEARN_SYSTEM_V2}`, redactedCorpus);
      const name = `我的风格 ${profiles.length + 1}`;
      const description = `于 ${new Date().toLocaleDateString()} 从 ${samples.length} 封已发邮件学习`;
      const saved = await saveStyleProfile({
        name,
        description,
        profile: profileText,
        isActive: false,
        accountIds: learningAccountId ? [learningAccountId] : [],
      });
      await refresh();
      setGenStyleId(saved.id);
      saveWritingPreferences(learningAccountId || currentWritingAccountId, { styleProfileId: saved.id });
      flash(t("aiWriting.learnDone", { name }), "success");
      setLearnStatus("");
    } catch (err: unknown) {
      const e = extractErrorMessage(err);
      flash(t("aiWriting.learnFailed", { error: e }), "error");
      useToastStore.getState().addToast({
        message: t("aiWriting.learnFailed", { error: e }),
        type: "error",
      });
      setLearnStatus("");
    } finally {
      setLearning(false);
    }
  }

  /** 用一句指令调整当前写作风格：结合现有风格 + 用户调整要求，让 AI 生成新版风格描述并保存。 */
  async function handleStyleAdjust(targetId?: string) {
    const target = (targetId ? profiles.find((p) => p.id === targetId) : undefined)
      ?? availableProfiles.find((p) => p.id === (genStyleId || activeId));
    if (!styleAdjustText.trim() || styleAdjusting) return;
    setStyleAdjusting(true);
    try {
      const currentProfile = target?.profile ?? "（当前没有已保存的风格档案）";
      const system =
        "你是外贸业务员的写作风格顾问。用户会给你当前的风格描述和一条调整要求。请生成一份更新后的、精炼的中文写作风格描述（100-200 字），" +
        "保留原有优点，把用户要求融入其中。只输出风格描述本身，不要解释。";
      const user = `【当前风格描述】\n${currentProfile}\n\n【调整要求】\n${styleAdjustText.trim()}`;
      const updated = (await aiPrompt(system, user)).trim();
      if (target) {
        await saveStyleProfile({
          id: target.id,
          name: target.name,
          description: target.description,
          profile: updated,
          isActive: false,
        });
        if (editing?.id === target.id) setEditProfile(updated);
        flash("写作风格已更新。", "success");
      } else {
        const saved = await saveStyleProfile({
          name: `我的风格 ${profiles.length + 1}`,
          description: "由指令调整生成",
          profile: updated,
          isActive: false,
        });
        setGenStyleId(saved.id);
        saveWritingPreferences(currentWritingAccountId, { styleProfileId: saved.id });
        flash("已生成新的写作风格并设为当前账号默认。", "success");
      }
      await refresh();
      setStyleAdjustText("");
    } catch (err: unknown) {
      const e = extractErrorMessage(err);
      flash(`调整风格失败：${e}`, "error");
    } finally {
      setStyleAdjusting(false);
    }
  }

  function startEdit(p: StyleProfile) {
    setEditing(p);
    setEditName(p.name);
    setEditDesc(p.description);
    setEditProfile(p.profile);
    setEditAccountIds(defaultAccountsForStyle(p.id).map((account) => account.id));
  }

  function startCreate() {
    const now = Date.now();
    setEditing({ id: "__new__", name: "", description: "", profile: "", isActive: false, accountIds: null, createdAt: now, updatedAt: now });
    setEditName("");
    setEditDesc("");
    setEditProfile("");
    const preferredAccountId = currentWritingAccountId || learningAccountId || accounts[0]?.id;
    setEditAccountIds(preferredAccountId ? [preferredAccountId] : []);
  }

  function cancelEdit() {
    setEditing(null);
    setEditName("");
    setEditDesc("");
    setEditProfile("");
    setEditAccountIds(null);
  }

  async function handleSaveEdit() {
    if (!editing) return;
    setSaving(true);
    try {
      const isNew = editing.id === "__new__";
      const selectedIds = editAccountIds === null ? accounts.map((account) => account.id) : editAccountIds;
      const saved = await saveStyleProfile({
        id: isNew ? undefined : editing.id,
        name: editName,
        description: editDesc,
        profile: editProfile,
        isActive: false,
        accountIds: selectedIds,
      });
      const selected = new Set(selectedIds);
      for (const account of accounts) {
        if (selected.has(account.id)) {
          saveWritingPreferences(account.id, { styleProfileId: saved.id });
        } else if (getWritingPreferences(account.id).styleProfileId === saved.id) {
          saveWritingPreferences(account.id, { styleProfileId: "" });
        }
      }
      if (currentWritingAccountId && selected.has(currentWritingAccountId)) setGenStyleId(saved.id);
      cancelEdit();
      await refresh();
      flash(t("translate.configSaved"), "success");
    } catch (err: unknown) {
      const e = extractErrorMessage(err);
      flash(t("aiWriting.saveFailed", { error: e }), "error");
      useToastStore.getState().addToast({
        message: t("aiWriting.saveFailed", { error: e }),
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleScopeChange(profile: StyleProfile, accountIds: string[] | null) {
    setScopeSavingId(profile.id);
    try {
      const selectedIds = accountIds === null ? accounts.map((account) => account.id) : accountIds;
      await saveStyleProfile({
        id: profile.id,
        name: profile.name,
        description: profile.description,
        profile: profile.profile,
        isActive: false,
        accountIds: selectedIds,
      });
      const selected = new Set(selectedIds);
      for (const account of accounts) {
        if (selected.has(account.id)) {
          saveWritingPreferences(account.id, { styleProfileId: profile.id });
        } else if (getWritingPreferences(account.id).styleProfileId === profile.id) {
          saveWritingPreferences(account.id, { styleProfileId: "" });
        }
      }
      if (currentWritingAccountId && selected.has(currentWritingAccountId)) setGenStyleId(profile.id);
      await refresh();
      flash(`“${profile.name}”的适用账号已更新。`, "success");
    } catch (err: unknown) {
      flash(`保存适用账号失败：${extractErrorMessage(err)}`, "error");
    } finally {
      setScopeSavingId(null);
    }
  }

  async function handleDelete(p: StyleProfile) {
    try {
      const remaining = await deleteStyleProfile(p.id);
      setProfiles(remaining);
      const active = remaining.find((x) => x.isActive) ?? remaining[0];
      setActiveId(active?.id ?? "");
      flash(t("aiWriting.deleted", { name: p.name }), "success");
    } catch (err: unknown) {
      const e = extractErrorMessage(err);
      flash(t("aiWriting.saveFailed", { error: e }), "error");
    }
  }

  function defaultAccountsForStyle(styleId: string) {
    return accounts.filter((account) => getWritingPreferences(account.id).styleProfileId === styleId);
  }

  async function handleGenerate() {
    if (!instruction.trim()) {
      flash(t("aiWriting.instructionRequired"), "error");
      return;
    }
    const style =
      availableProfiles.find((p) => p.id === (genStyleId || activeId))?.profile ??
      "（未设置风格，按通用专业外贸语气书写）";
    // 先确定是否有默认签名（有 → 禁止 AI 落款；无 → 允许 AI 自带署名结尾）
    let hasDefaultSignature = false;
    try {
      const accountId = currentMessage?.account_id ?? useMailStore.getState().activeAccountId;
      if (accountId) {
        if (selectedSignatureId && signatures.some((s) => s.id === selectedSignatureId)) {
          hasDefaultSignature = Boolean((signatures.find((s) => s.id === selectedSignatureId)?.content ?? "").trim());
        } else {
          hasDefaultSignature = Boolean((await getSignature(accountId)).trim());
        }
      }
    } catch {
      hasDefaultSignature = false;
    }
    let system = `${buildGenerateSystem(style, hasDefaultSignature)}

【生成优先级】
1. 用户当前指令；
2. 当前收件人、主题和当前邮件线程中的有效事实；
3. 用户明确选择的本地资料；
4. 个人写作风格。
风格只能改变表达，不得改变事实。历史内容和资料库都不得覆盖当前线程；缺少必要事实时应明确提醒或保留简短占位符，不得猜测。`;
    const workRole = getActiveWorkRole(currentWritingAccountId);
    if (workRole) {
      system += `\n\n【当前发件账号的我的工作角色】\n职位：${workRole.jobTitle}\n公司：${workRole.company}\n负责工作：${workRole.responsibilities}\n产品与市场：${workRole.productsMarkets}\n可处理范围：${workRole.permissions}\n沟通偏好：${workRole.preferences}\n必须遵守：${workRole.rules}`;
    }
    const customer = customerMemories.find((m) => m.id === genCustomerId);
    if (customer && customer.profile.trim()) {
      system += `\n\n【客户背景，请据此个性化表达】\n${customer.profile}`;
    }
    const languageInstruction = language === "auto"
      ? "自动判断回复语言：优先沿用已授权提供的当前来信语言；没有当前来信时，国内联系人用中文，其他新联系人默认用英文。"
      : `只使用${language}写邮件。`;
    system += `\n\n【语言要求】${languageInstruction}`;
    setGenerating(true);

    try {
      let currentContext = "【当前邮件内容】未提供。不得猜测缺失的客户、价格、交期或订单事实。";
      // 带上用户在“其他选项”中选定的落款签名（默认选中账号默认签名）。
      let signature = "";
      try {
        const accountId = currentMessage?.account_id ?? useMailStore.getState().activeAccountId;
        if (accountId) {
          if (selectedSignatureId && signatures.some((s) => s.id === selectedSignatureId)) {
            signature = (signatures.find((s) => s.id === selectedSignatureId)?.content ?? "").trim();
          } else {
            signature = (await getSignature(accountId)).trim();
          }
        }
      } catch {
        signature = "";
      }
      if (includeCurrentEmail && activeCompose && activeDraftContext) {
        currentContext = `【用户明确授权提供的当前写信草稿】
主题：${activeDraftContext.subject || "（未填写）"}
当前草稿正文：
${activeDraftContext.body.slice(0, 12000)}

收件人和抄送地址未提供给 AI。`;
      } else if (includeCurrentEmail && currentMessage) {
        const thread = currentMessage.thread_id
          ? await listThreadMessages(currentMessage.thread_id)
          : [currentMessage];
        const recent = [...thread]
          .sort((a, b) => a.date - b.date)
          .slice(-6)
          .map((message, index) => {
            const recipients = message.to_list.map((item) => item.address).join(", ");
            return `邮件 ${index + 1}（${new Date(message.date).toLocaleString()}）
发件人：${message.from_name || message.from_address} <${message.from_address}>
收件人：${recipients}
主题：${message.subject}
正文：
${message.body_text.slice(0, 3500)}`;
          })
          .join("\n\n---\n\n")
          .slice(-14000);
        currentContext = `【用户明确授权提供的当前邮件线程；按时间顺序，最新事实优先】
${recent}`;
      }

      if (selectedAiMessageIds.length > 0) {
        const draggedMessages = await getMessagesBatch(selectedAiMessageIds);
        const draggedContext = draggedMessages
          .sort((a, b) => a.date - b.date)
          .map((message, index) => `【用户明确拖入的邮件 ${index + 1}】\n${compactMessageContext(message)}`)
          .join("\n\n---\n\n");
        if (draggedContext) {
          currentContext = appendContext(currentContext, draggedContext);
        }
      }

      if (selectedAiFiles.length > 0) {
        const fileSections: string[] = [];
        for (const selected of selectedAiFiles) {
          if (selected.file.size > MAX_AI_FILE_BYTES) {
            throw new Error(`文件 ${selected.file.name} 超过 20 MB，未发送。`);
          }
          const text = (await extractDocumentText(selected.file)).trim();
          fileSections.push(`【用户明确拖入的本地文件：${selected.file.name}】\n${text.slice(0, 12_000) || "（文件中没有可提取的文字）"}`);
        }
        if (fileSections.length > 0) {
          currentContext = appendContext(currentContext, fileSections.join("\n\n---\n\n"));
        }
      }

      let knowledgeContext = "【本地资料库】本次未引用。";
      if (selectedKnowledgeIds.length > 0) {
        const selectedItems = (await listKnowledgeItems(currentWritingAccountId)).filter((item) => selectedKnowledgeIds.includes(item.id));
        if (selectedItems.length > 0) {
          knowledgeContext = `【用户明确选择的资料中心文件】\n${selectedItems.map((item) => `资料：${item.name}\n${item.content.slice(0, 12000)}`).join("\n\n")}`;
        }
      }
      if (includeKnowledge && selectedKnowledgeIds.length === 0) {
        const snippets = await searchKnowledgeBase(
          `${activeDraftContext?.subject ?? currentMessage?.subject ?? ""}\n${instruction}`,
          3,
          currentWritingAccountId,
        );
        knowledgeContext = snippets.length
          ? `【用户明确选择引用的本地资料；只用于当前任务】
${snippets.map((item, index) => `资料 ${index + 1}：${item.name}\n${item.content}`).join("\n\n")}`
          : "【本地资料库】没有检索到相关内容。";
      }

      system += signature
        ? "\n\n请写完整回复正文和自然落款，但不要虚构或重复签名；客户端会在末尾附加用户已保存的账号签名。"
        : "\n\n请写完整回复正文，包含符合用户习惯的称呼、正文、结尾和落款。";
      // 与写信页共用同一条对话历史：前文优先取共享历史（右侧/写信页无论从
      // 哪边继续都能读到上一轮上下文），本面板自己的记录作为兜底。
      const sharedTurns = useUIStore.getState().aiWritingTurns;
      const sharedContext = sharedTurns.length > 0
        ? `【本次写作对话的前文（写信页与右侧共用的连续对话）】
${sharedTurns.slice(-6).map((turn, index) => `第${index + 1}轮${turn.role === "user" ? "用户要求" : "AI草稿"}：${turn.content}`).join("\n\n")}

请在前文基础上继续修改或回答，不要把对话解释混入最终邮件正文。
`
        : conversation.length > 0
          ? `【本次写作对话的前文】
${conversation.slice(-6).map((turn, index) => `第${index + 1}轮用户要求：${turn.instruction}\n第${index + 1}轮AI草稿：${turn.answer}`).join("\n\n")}

请在前文基础上继续修改或回答，不要把对话解释混入最终邮件正文。
`
          : "";
      const userRequest = `【用户当前指令——最高优先级】
${instruction}

${sharedContext}
${currentContext}

${knowledgeContext}`;
      // 全局任务标记：右侧/悬浮生成时切走也不中断、不丢。
      useUIStore.getState().setAiBgTask({ running: true, source: "panel", result: null });
      const result = await aiPrompt(system, userRequest);
      useUIStore.getState().setAiBgTask({ running: false, source: "panel", result: result.trim() });
      // ComposeView owns the account signature. Keeping generated content
      // signature-free prevents duplicate signatures and always applies the
      // correct identity for the sending account.
      const answer = result.trim();

      setConversation((turns) => [...turns, {
        id: `${Date.now()}-${turns.length}`,
        instruction: instruction.trim(),
        answer,
      }]);
      // 写回共享对话历史，写信页/右侧后续生成都能读到本次内容。
      {
        const ui = useUIStore.getState();
        ui.setAiWritingTurns([
          ...ui.aiWritingTurns,
          { role: "user" as const, content: instruction.trim() },
          { role: "assistant" as const, content: answer },
        ].slice(-16));
      }
      setInstruction("");
      // 生成结果直接写入草稿栏（整封邮件草稿），无需再点"放入当前草稿"。
      try {
        if (activeCompose) {
          useComposeStore.getState().applyAiBody(answer);
          flash("AI 草稿已写入正文，可继续编辑或再次输入指令调整。", "success");
        } else if (currentMessage) {
          useComposeStore.getState().openCompose("reply-all", currentMessage, { body: answer });
          flash("AI 已生成回复草稿，已打开回复窗口。", "success");
        } else {
          useComposeStore.getState().openCompose("new", null, {
            to: recipientTo.split(/[，,;；]/).map((value) => value.trim()).filter(Boolean),
            cc: recipientCc.split(/[，,;；]/).map((value) => value.trim()).filter(Boolean),
            bcc: recipientBcc.split(/[，,;；]/).map((value) => value.trim()).filter(Boolean),
            body: answer,
          });
          flash("AI 已生成邮件草稿，已打开写信窗口。", "success");
        }
      } catch {
        // fall through: output still rendered in the record below
      }
    } catch (err: unknown) {
      const e = extractErrorMessage(err);
      flash(t("aiWriting.generateFailed", { error: e }), "error");
      useToastStore.getState().addToast({
        message: t("aiWriting.generateFailed", { error: e }),
        type: "error",
      });
    } finally {
      setGenerating(false);
    }
  }

  function addAiFiles(files: FileList | File[]) {
    const next = Array.from(files)
      .filter((file) => file.size <= MAX_AI_FILE_BYTES)
      .filter((file) => !selectedAiFiles.some((item) => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified))
      .map((file) => ({ id: `${file.name}-${file.size}-${file.lastModified}`, file }));
    if (next.length > 0) {
      setSelectedAiFiles((current) => [...current, ...next]);
    }
    if (Array.from(files).some((file) => file.size > MAX_AI_FILE_BYTES)) {
      flash("超过 20 MB 的文件未加入 AI 上下文。", "error");
    }
  }

  function handleAiContextDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const messageId = event.dataTransfer.getData("application/x-pebble-message-id").trim();
    const attachmentId = event.dataTransfer.getData("application/x-pebble-attachment-id").trim();
    const files = Array.from(event.dataTransfer.files ?? []);
    if (messageId) {
      setSelectedAiMessageIds((current) => current.includes(messageId) ? current : [...current, messageId]);
      const label = event.dataTransfer.getData("text/plain").trim();
      setSelectedAiMessageTitles((current) => ({ ...current, [messageId]: label || `邮件 ${messageId.slice(0, 8)}` }));
    }
    if (files.length > 0) addAiFiles(files);
    if (attachmentId && !messageId && files.length === 0) {
      void (async () => {
        try {
          const att = await readAttachmentFile(attachmentId);
          const file = new File([new Uint8Array(att.bytes)], att.name, { type: att.mime_type || "" });
          addAiFiles([file]);
        } catch (err) {
          flash(`读取附件失败：${extractErrorMessage(err)}`, "error");
        }
      })();
    }
    if (!messageId && !attachmentId && files.length === 0) {
      flash("请从邮件列表拖入邮件，或拖入邮件附件 / 本地文件。", "error");
    }
  }

  function handleAiContextPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    addAiFiles(files);
  }

  function removeAiMessage(messageId: string) {
    setSelectedAiMessageIds((current) => current.filter((id) => id !== messageId));
    setSelectedAiMessageTitles((current) => {
      const next = { ...current };
      delete next[messageId];
      return next;
    });
  }

  function removeAiFile(fileId: string) {
    setSelectedAiFiles((current) => current.filter((item) => item.id !== fileId));
  }

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: "12px",
    fontWeight: 500,
    color: "var(--color-text-secondary)",
    marginBottom: "4px",
  };
  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 10px",
    fontSize: "13px",
    border: "1px solid var(--color-border)",
    borderRadius: "6px",
    background: "var(--color-bg-secondary)",
    color: "var(--color-text-primary)",
    boxSizing: "border-box",
  };
  const buttonStyle: React.CSSProperties = {
    padding: "8px 18px",
    fontSize: "13px",
    fontWeight: 500,
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
  };
  const sectionStyle: React.CSSProperties = {
    marginBottom: "28px",
    paddingBottom: "20px",
    borderBottom: "1px solid var(--color-border)",
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: "8px" }}>
        <h2
          style={{ fontSize: "18px", fontWeight: 600, color: "var(--color-text-primary)", margin: 0, cursor: quick ? "grab" : "default", userSelect: "none" }}
          title={quick ? "双击此处可弹出悬浮窗口" : undefined}
          onDoubleClick={() => {
            if (!quick || aiWritingFloating) return;
            setAiWritingFloating(true);
            closeRightPanel("aiWriting");
          }}
        >
          {t("aiWriting.engineTitle")}
        </h2>
        {quick && !aiWritingFloating && (
          <button
            type="button"
            title="弹出悬浮 AI 写作窗口（也可双击标题）"
            aria-label="弹出悬浮 AI 写作窗口"
            onClick={() => { setAiWritingFloating(true); closeRightPanel("aiWriting"); }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              width: 26,
              height: 26,
              padding: 0,
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              background: "var(--color-bg-secondary)",
              color: "var(--color-text-secondary)",
              cursor: "pointer",
            }}
          >
            <Maximize2 size={13} />
          </button>
        )}
      </div>
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: 0, marginBottom: "20px" }}>
        {t("aiWriting.intro")}
      </p>

      {!quick && (
      <>
      {/* Learn */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: "14px", fontWeight: 600, margin: "0 0 8px" }}>{t("aiWriting.learnTitle")}</h3>
        <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 12px" }}>
          {t("aiWriting.learnHint")}
        </p>
        <div style={{ marginBottom: 12 }}>
          <AccountScopePicker accountId={learningAccountId} onChange={setLearningAccountId} label="选择用于学习的已发送邮件账号" />
          <div style={{ marginTop: 5, fontSize: 11, color: "var(--color-text-secondary)" }}>
            将只读取并脱敏这个邮箱的已发送邮件；生成的风格默认只适用于 {selectedLearningAccount ? accountLabel(selectedLearningAccount) : "所选邮箱"}，之后可以编辑为多个账号共享。
          </div>
        </div>
        <label style={{ display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "12px" }}>
          <input type="checkbox" checked={allowStyleEvidenceUpload} onChange={(e) => setAllowStyleEvidenceUpload(e.target.checked)} />
          <span>允许把少量、已自动替换邮箱/网址/电话/价格/日期/订单号的样本发送给我配置的 AI 服务商，用于创建风格档案。原始邮箱不会整体上传。</span>
        </label>
        <button
          type="button"
          disabled={learning}
          onClick={handleLearn}
          style={{ ...buttonStyle, background: "var(--color-accent)", color: "#fff", opacity: learning ? 0.6 : 1 }}
        >
          {learning ? t("aiWriting.learning") : t("aiWriting.learnButton")}
        </button>
        {learnStatus && (
          <span style={{ marginLeft: "10px", fontSize: "12px", color: "var(--color-text-secondary)" }}>{learnStatus}</span>
        )}
      </div>

      {/* Profiles */}
      <div style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <h3 style={{ fontSize: "14px", fontWeight: 600, margin: 0 }}>风格模板</h3>
          <button type="button" style={{ ...buttonStyle, background: "var(--color-accent)", color: "#fff" }} onClick={startCreate}>新建风格模板</button>
        </div>
        <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 12px", lineHeight: 1.55 }}>
          先选择一个邮箱学习风格；下面的模板用一个账号复选框统一完成“给谁使用”和“设为谁的默认风格”。每个账号只能有一个默认风格。
        </p>
        {profiles.length === 0 && (
          <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("aiWriting.noProfiles")}</div>
        )}
        {profiles.map((p) => (
          <div
            key={p.id}
            style={{
              border: "1px solid var(--color-border)",
              borderRadius: "8px",
              padding: "12px",
              marginBottom: "12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
              <strong style={{ fontSize: "13px" }}>{p.name}</strong>
              {defaultAccountsForStyle(p.id).length > 0 && <span style={{ fontSize: "11px", fontWeight: 700, color: "#16803c", border: "1px solid #22c55e", borderRadius: "10px", padding: "2px 8px" }}>
                当前默认：{defaultAccountsForStyle(p.id).map(accountLabel).join("、")}
              </span>}
              {defaultAccountsForStyle(p.id).length === 0 && <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", borderRadius: "10px", padding: "1px 8px" }}>尚未指定默认账号</span>}
            </div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "5px" }}>{p.description}</div>
            <div style={{ marginBottom: "8px", opacity: scopeSavingId === p.id ? 0.65 : 1 }}>
              <AccountScopeSelect value={defaultAccountsForStyle(p.id).map((account) => account.id)} onChange={(value) => void handleScopeChange(p, value)} label="勾选后设为这些邮箱账号的默认风格" />
            </div>
            <div style={{
              background: "var(--color-bg-secondary)",
              padding: "10px",
              borderRadius: "6px",
              maxHeight: "160px",
              overflowY: "auto",
              margin: "0 0 10px",
            }}>
              <MarkdownView text={p.profile} />
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button type="button" style={{ ...buttonStyle, background: editing?.id === p.id ? "rgba(220,53,69,0.12)" : "var(--color-bg-hover)", color: editing?.id === p.id ? "#dc3545" : "var(--color-text-primary)" }} onClick={() => editing?.id === p.id ? cancelEdit() : startEdit(p)}>
                {editing?.id === p.id ? "取消编辑" : t("aiWriting.edit")}
              </button>
              <button type="button" style={{ ...buttonStyle, background: "rgba(220,53,69,0.12)", color: "#dc3545" }} onClick={() => handleDelete(p)}>
                {t("aiWriting.delete")}
              </button>
            </div>
            {editing?.id === p.id && <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--color-border)" }}>
              <h4 style={{ fontSize: 13, margin: "0 0 12px" }}>正在编辑：{p.name}</h4>
              <div style={{ display: "grid", gap: 10 }}>
                <div><label style={labelStyle}>{t("aiWriting.name")}</label><input style={inputStyle} value={editName} onChange={(e) => setEditName(e.target.value)} /></div>
                <div><label style={labelStyle}>{t("aiWriting.description")}</label><input style={inputStyle} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} /></div>
                <div><label style={labelStyle}>{t("aiWriting.profile")}</label><textarea style={{ ...inputStyle, minHeight: 150, resize: "vertical", fontFamily: "inherit" }} value={editProfile} onChange={(e) => setEditProfile(e.target.value)} /></div>
                <AccountScopeSelect value={editAccountIds} onChange={setEditAccountIds} label="这份风格可以给哪些邮箱账号使用？" />
                <div style={{ paddingTop: 10, borderTop: "1px solid var(--color-border)" }}>
                  <label style={{ ...labelStyle, display: "block", marginBottom: 5 }}>用一句话调整这份风格</label>
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 7 }}>例如：语气更简洁、少用寒暄、英文更自然。调整结果会写回当前正在编辑的风格。</div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input style={{ ...inputStyle, flex: 1 }} value={styleAdjustText} onChange={(e) => setStyleAdjustText(e.target.value)} placeholder="输入你想怎么调整" disabled={styleAdjusting} />
                    <button type="button" disabled={styleAdjusting || !styleAdjustText.trim()} onClick={() => void handleStyleAdjust(p.id)} style={{ ...buttonStyle, background: "var(--color-accent)", color: "#fff", opacity: styleAdjusting || !styleAdjustText.trim() ? 0.6 : 1 }}>{styleAdjusting ? "调整中…" : "调整这份风格"}</button>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" disabled={saving} style={{ ...buttonStyle, background: "var(--color-accent)", color: "#fff" }} onClick={handleSaveEdit}>{saving ? t("common.saving") : t("aiWriting.save")}</button>
                </div>
              </div>
            </div>}
          </div>
        ))}
        {editing?.id === "__new__" && <div style={{ marginTop: 12, marginBottom: 12, marginLeft: 14, padding: 14, borderLeft: "3px solid var(--color-accent)", borderRadius: 6, background: "var(--color-bg-secondary)" }}>
          <h4 style={{ fontSize: 13, margin: "0 0 12px" }}>新建风格模板</h4>
          <div style={{ display: "grid", gap: 10 }}>
            <div><label style={labelStyle}>{t("aiWriting.name")}</label><input style={inputStyle} value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="例如：老客户跟进风格" /></div>
            <div><label style={labelStyle}>{t("aiWriting.description")}</label><input style={inputStyle} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="适合什么场景" /></div>
            <div><label style={labelStyle}>{t("aiWriting.profile")}</label><textarea style={{ ...inputStyle, minHeight: 150, resize: "vertical", fontFamily: "inherit" }} value={editProfile} onChange={(e) => setEditProfile(e.target.value)} placeholder="描述语气、句式、开场、结尾和应避免的表达" /></div>
            <AccountScopeSelect value={editAccountIds} onChange={setEditAccountIds} label="这份风格可以给哪些邮箱账号使用？" />
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" disabled={saving || !editName.trim() || !editProfile.trim()} style={{ ...buttonStyle, background: "var(--color-accent)", color: "#fff", opacity: saving || !editName.trim() || !editProfile.trim() ? 0.6 : 1 }} onClick={handleSaveEdit}>{saving ? t("common.saving") : "创建模板"}</button>
              <button type="button" style={{ ...buttonStyle, background: "var(--color-bg-hover)", color: "var(--color-text-primary)" }} onClick={cancelEdit}>取消编辑</button>
            </div>
          </div>
        </div>}
      </div>

      </>
      )}

      {/* Generate — 仅右侧工作区 / 悬浮窗显示；设置页只保留设置（学习、风格档案） */}
      {quick && (
      <>
      <div style={sectionStyle}>
        <h3 style={{ fontSize: "14px", fontWeight: 600, margin: "0 0 8px" }}>
          {t("aiWriting.generateTitle")}（支持多轮对话，结果直接写入草稿栏）
        </h3>
        <div style={{ marginBottom: 10 }}><AccountScopePicker accountId={currentWritingAccountId} label="本次 AI 写作实际使用的邮箱账号" /></div>
        {/* 收件人/抄送/密送 —— 放在指令输入框上方 */}
        <div style={{ marginBottom: "10px" }}>
          <label style={labelStyle}>收件人（仅保存在本地写信草稿，不发送给 AI）</label>
          <input list="ai-writing-address-book" style={inputStyle} value={recipientTo} onChange={(event) => setRecipientTo(event.target.value)} placeholder={currentMessage ? currentMessage.from_address : "从地址本选择或输入邮箱"} />
          <datalist id="ai-writing-address-book">
            {addressBook.map((contact) => (
              <option key={contact.id} value={contact.email}>{contact.name || contact.company || contact.email}</option>
            ))}
          </datalist>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "12px" }}>
          <div>
            <label style={labelStyle}>抄送 CC</label>
            <input list="ai-writing-address-book" style={inputStyle} value={recipientCc} onChange={(event) => setRecipientCc(event.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>暗送 BCC</label>
            <input list="ai-writing-address-book" style={inputStyle} value={recipientBcc} onChange={(event) => setRecipientBcc(event.target.value)} />
          </div>
        </div>
        {/* 统一输入框：文字指令、邮件上下文和本地文件都从这里进入 */}
        <div
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleAiContextDrop}
          style={{ marginBottom: "10px", position: "relative" }}
        >
          <label style={labelStyle}>{t("aiWriting.instruction")}</label>
          <textarea
            style={{
              ...inputStyle,
              minHeight: "72px",
              maxHeight: "300px",
              resize: "none",
              fontFamily: "inherit",
              // 互斥但可切换：写信页激活时本处视觉变灰，仍可点击切回
              opacity: aiComposeLocked ? 0.5 : 1,
            }}
            value={instruction}
            placeholder={aiComposeLocked
              ? "写信页的 AI 写作当前激活中，点击此处切换为在本处输入"
              : t("aiWriting.instructionPlaceholder")}
            onFocus={() => setAiInputFocusOwner("panel")}
            onChange={(e) => setInstruction(e.target.value)}
            onInput={(e) => resizeAutoGrowTextarea(e.currentTarget, 300)}
            onPaste={handleAiContextPaste}
            disabled={generating}
          />
          <div style={{ marginTop: "-1px", padding: "8px 10px", border: "1px dashed var(--color-accent)", borderTop: 0, borderRadius: "0 0 7px 7px", background: "var(--color-bg-secondary)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
              <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>可直接粘贴或拖入邮件、附件和多个文件作为上下文</span>
              <KnowledgePicker accountId={currentWritingAccountId} selectedIds={selectedKnowledgeIds} onChange={setSelectedKnowledgeIds} />
              <button type="button" style={{ ...buttonStyle, padding: "4px 9px", background: "var(--color-bg-hover)", color: "var(--color-text-primary)", fontSize: "11px" }} onClick={() => fileInputRef.current?.click()}>
                添加文件
              </button>
              <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { if (event.target.files) addAiFiles(event.target.files); event.currentTarget.value = ""; }} />
            </div>
            {(selectedAiMessageIds.length > 0 || selectedAiFiles.length > 0) && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "8px" }}>
                {selectedAiMessageIds.map((messageId) => (
                  <span key={messageId} style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "4px 7px", borderRadius: "12px", background: "var(--color-bg-hover)", fontSize: "11px" }}>
                    {selectedAiMessageTitles[messageId] || `邮件 ${messageId.slice(0, 8)}`}
                    <button type="button" aria-label="移除邮件上下文" onClick={() => removeAiMessage(messageId)} style={{ border: 0, background: "transparent", cursor: "pointer", color: "var(--color-text-secondary)" }}>×</button>
                  </span>
                ))}
                {selectedAiFiles.map((selected) => (
                  <span key={selected.id} style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "4px 7px", borderRadius: "12px", background: "var(--color-bg-hover)", fontSize: "11px" }}>
                    文件：{selected.file.name}
                    <button type="button" aria-label="移除文件上下文" onClick={() => removeAiFile(selected.id)} style={{ border: 0, background: "transparent", cursor: "pointer", color: "var(--color-text-secondary)" }}>×</button>
                  </span>
                ))}
              </div>
            )}
            {(selectedAiMessageIds.length > 0 || selectedAiFiles.length > 0) && <div style={{ marginTop: 8, fontSize: 11, color: "var(--color-text-secondary)" }}>已添加 {selectedAiMessageIds.length + selectedAiFiles.length} 项上下文；点击生成后会使用这些内容发送给当前配置的 AI 服务商。</div>}
          </div>
        </div>
        {/* 快捷调整提示：第一轮生成之后出现，点一下按该要求调整 */}
        {conversation.length >= 1 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: "10px" }}>
          {["更简短一些", "语气更礼貌", "语气直接一点", "更正式", "用英文写", "不要占位符"].map((hint) => (
            <button
              key={hint}
              type="button"
              disabled={generating}
              onClick={() => {
                setAiInputFocusOwner("panel");
                setInstruction(hint);
                void handleGenerate();
              }}
              style={{
                padding: "3px 10px",
                fontSize: 11,
                border: "1px solid var(--color-border)",
                borderRadius: 12,
                background: "transparent",
                color: "var(--color-text-secondary)",
                cursor: generating ? "not-allowed" : "pointer",
                opacity: generating ? 0.5 : 1,
              }}
            >
              {hint}
            </button>
          ))}
        </div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={generating}
          onClick={() => {
            // 点击生成 = 激活本处输入并生成（支持互相切换）
            setAiInputFocusOwner("panel");
            void handleGenerate();
          }}
          style={{ ...buttonStyle, background: "var(--color-accent)", color: "#fff", opacity: generating ? 0.6 : 1 }}
        >
          {generating ? t("aiWriting.generating") : t("aiWriting.generateButton")}
        </button>
        {conversation.length > 0 && (
          <button
            type="button"
            title="回到上一版草稿（上一轮 AI 生成的内容）"
            onClick={handlePanelUndo}
            disabled={generating}
            style={{
              ...buttonStyle,
              background: "var(--color-bg-hover)",
              color: "var(--color-text-primary)",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: "12px",
            }}
          >
            <Undo2 size={13} /> 撤销到上一步
          </button>
        )}
        </div>
      </div>
        {conversation.length > 0 && (
          <div style={{ marginTop: "14px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "7px" }}>
              <strong style={{ fontSize: "12px" }}>多轮写作记录</strong>
              <button type="button" onClick={clearAllResult} style={{ border: 0, background: "transparent", color: "var(--color-accent)", cursor: "pointer", fontSize: "11px" }}>开始新对话</button>
            </div>
            <div style={{ maxHeight: "260px", overflow: "auto", display: "flex", flexDirection: "column", gap: "8px" }}>
              {conversation.map((turn) => (
                <div key={turn.id} style={{ border: "1px solid var(--color-border)", borderRadius: "7px", overflow: "hidden" }}>
                  <div style={{ padding: "7px 9px", background: "var(--color-bg-hover)", fontSize: "12px" }}>你：{turn.instruction}</div>
                  <div style={{ padding: "8px 9px", whiteSpace: "pre-wrap", fontSize: "12px", lineHeight: 1.55 }}>{turn.answer}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        <details
          open={quick ? !aiWritingFloating : true}
          style={{ marginTop: "14px", border: "1px solid var(--color-border)", borderRadius: "8px", padding: "10px 12px", background: "var(--color-bg-secondary)" }}
        >
          <summary style={{ cursor: "pointer", fontSize: "12px", fontWeight: 600, color: "var(--color-text-primary)", outline: "none" }}>
            其他选项（当前邮件 / 补充上下文 / 收件人 / 风格 / 语言）
          </summary>
        <div style={{ marginTop: "12px" }}>
        <div style={{ marginBottom: "14px", padding: "10px 12px", border: "1px solid var(--color-border)", borderRadius: "6px", background: "var(--color-bg-secondary)", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          {activeCompose && activeDraftContext ? (
            <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", cursor: "pointer" }}>
              <input type="checkbox" checked={includeCurrentEmail} onChange={(e) => setIncludeCurrentEmail(e.target.checked)} />
              <span>读取当前写信标签“{activeDraftContext.subject || "未命名邮件"}”。勾选后，仅主题和草稿正文会发送给你配置的 AI 服务商，邮箱地址仍留在本地。</span>
            </label>
          ) : currentMessage ? (
            <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", cursor: "pointer" }}>
              <input type="checkbox" checked={includeCurrentEmail} onChange={(e) => setIncludeCurrentEmail(e.target.checked)} />
              <span>读取当前邮件“{currentMessage.subject}”生成回复。勾选后，当前邮件正文会发送给你配置的 AI 服务商。</span>
            </label>
          ) : "当前没有打开邮件，将按“写新邮件”处理。"}
        </div>
        <div style={{ marginBottom: "14px" }}>
          <label style={labelStyle}>{t("aiWriting.styleSelect")}</label>
          <select style={inputStyle} value={genStyleId || activeId} onChange={(e) => { setGenStyleId(e.target.value); updateWritingPreference({ styleProfileId: e.target.value }); }}>
            {profiles.length === 0 && <option value="">{t("aiWriting.noStyle")}</option>}
            {availableProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.isActive ? `（${t("aiWriting.default")}）` : ""}
              </option>
            ))}
          </select>
        </div>
        <div style={{ marginBottom: "14px" }}>
          <label style={labelStyle}>落款签名</label>
          {signatures.length === 0 ? (
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>当前账号尚未设置签名，可在 设置 → 账号 → 邮件签名 中添加。</div>
          ) : (
            <select style={inputStyle} value={selectedSignatureId} onChange={(e) => { setSelectedSignatureId(e.target.value); updateWritingPreference({ signatureId: e.target.value }); }}>
              {signatures.map((sig) => (
                <option key={sig.id} value={sig.id}>
                  {sig.name}{sig.is_default ? "（默认）" : ""}
                </option>
              ))}
            </select>
          )}
        </div>
        <div style={{ marginBottom: "14px" }}>
          <label style={labelStyle}>生成语言</label>
          <select style={inputStyle} value={language} onChange={(e) => { setLanguage(e.target.value); updateWritingPreference({ language: e.target.value }); }}>
            <option value="auto">自动判断（来信语言 / 联系人习惯）</option>
            <option value="English">English</option>
            <option value="简体中文">简体中文</option>
            <option value="Español">Español</option>
            <option value="Français">Français</option>
            <option value="Deutsch">Deutsch</option>
            <option value="Português">Português</option>
            <option value="العربية">العربية</option>
            <option value="Русский">Русский</option>
            <option value="日本語">日本語</option>
            <option value="한국어">한국어</option>
          </select>
        </div>
        <div style={{ marginBottom: "14px" }}>
          <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "12px", color: "var(--color-text-secondary)", cursor: "pointer" }}>
            <input type="checkbox" checked={includeKnowledge} onChange={(e) => { setIncludeKnowledge(e.target.checked); updateWritingPreference({ includeKnowledge: e.target.checked }); }} />
            <span>引用本地资料库。只会把与本次指令最相关的少量片段发送给你配置的 AI 服务商。</span>
          </label>
        </div>
        <div style={{ marginBottom: "14px" }}>
          <label style={labelStyle}>{t("aiWriting.customerSelect")}</label>
          <select style={inputStyle} value={genCustomerId} onChange={(e) => setGenCustomerId(e.target.value)}>
            <option value="">{t("aiWriting.noCustomer")}</option>
            {customerMemories.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.company || m.email}{m.company && m.name ? `（${m.company}）` : ""}
              </option>
            ))}
          </select>
        </div>
        </div>
        </details>
      </>
      )}

      {statusMsg && (
        <div
          role={statusType === "error" ? "alert" : "status"}
          aria-live="polite"
          style={{
            marginTop: "14px",
            padding: "10px 14px",
            borderRadius: "6px",
            fontSize: "13px",
            background: statusType === "success" ? "var(--color-bg-hover)" : "rgba(220, 53, 69, 0.1)",
            color: statusType === "success" ? "var(--color-text-primary)" : "#dc3545",
            border: `1px solid ${statusType === "success" ? "var(--color-border)" : "rgba(220, 53, 69, 0.3)"}`,
          }}
        >
          {statusMsg}
        </div>
      )}
    </div>
  );
}
