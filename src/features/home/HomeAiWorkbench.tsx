import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, FileText, Globe2, Mail, MessageCircle, Paperclip, Plus, Send, ShieldCheck, Sparkles, Trash2, UserRound, X } from "lucide-react";
import {
  agentRun,
  aiChat,
  aiPrompt,
  getMessagesBatch,
  listAccounts,
  listCustomerMemories,
  listFolders,
  listMessages,
  searchKnowledgeBase,
  listKnowledgeItems,
  searchMessages,
  readAttachmentFile,
  type ChatTurn,
  type CustomerMemory,
  type KnowledgeSnippet,
  type Message,
  type SearchHit,
} from "@/lib/api";
import { extractDocumentText } from "@/lib/documentText";
import { useMailStore } from "@/stores/mail.store";
import { useUIStore } from "@/stores/ui.store";
import MarkdownView from "@/lib/renderMarkdown";
import { resizeAutoGrowTextarea } from "@/lib/autoGrowTextarea";
import KnowledgePicker from "@/components/KnowledgePicker";
import { buildTradeSkillSystemPrompt, detectTradeSkill, extractOutreachDraft, getTradeSkill, TRADE_SKILLS, type TradeSkill, type TradeSkillId } from "./tradeSkills";
import { parseOutreachUserConstraints, violatesOutreachUserConstraints } from "@/features/lead-finder/outreach-guard";

type WorkbenchReference =
  | { kind: "mail"; id: string; label: string; subtitle: string; accountId: string; folderId?: string }
  | { kind: "customer"; id: string; label: string; subtitle: string; email: string }
  | { kind: "knowledge"; id: string; label: string; subtitle: string; locator: string };

type WorkbenchMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  references?: WorkbenchReference[];
  skillId?: TradeSkillId;
  externalSources?: string[];
  toolCalls?: number;
  createdAt: number;
};

type WorkbenchConversation = {
  id: string;
  title: string;
  messages: WorkbenchMessage[];
  createdAt: number;
  updatedAt: number;
};

type RetrievedContext = {
  text: string;
  references: WorkbenchReference[];
};

type Intent = "writing" | "leadFinder" | "companyResearch" | null;
type HomeAttachedFile = { id: string; file: File };
type HomeAttachedMail = { id: string; title: string };

const HISTORY_KEY = "yao-home-ai-conversations-v1";
const MAX_HISTORY = 30;
const MAX_CONTEXT_CHARS = 22_000;

const SYSTEM_PROMPT = `你是 YaoAIMail 首页 AI 工作台。你帮助用户理解和处理自己的外贸工作资料。
回答优先使用用户当前问题和下面提供的本地检索上下文。邮件、客户和资料中的事实只能引用上下文中明确出现的内容；没有证据时要明确说“当前资料中没有找到”，不能猜测。
请用用户问题的主要语言回答。回答要先给结论，再用简洁条目说明依据。涉及邮件、客户或资料时，指出对应的主题、联系人、公司或资料名称，方便用户点击下方引用打开原文。
不要声称已经发送邮件、修改数据或完成后台操作；本工作台只负责问答、总结和导航。`;

function detectIntent(prompt: string): Intent {
  if (/(开发客户|找客户|找买家|潜在客户|客户开发|搜客户|开发潜客)/i.test(prompt)) return "leadFinder";
  if (/(资信|背景调查|背景研究|调查客户|调研公司|客户尽调|尽调)/i.test(prompt)) return "companyResearch";
  if (/(写邮件|写一封|起草邮件|回复邮件|回信|开发信|改写邮件|润色邮件)/i.test(prompt)) return "writing";
  return null;
}

async function classifyIntent(prompt: string): Promise<Intent> {
  const fallback = detectIntent(prompt);
  try {
    const raw = await aiPrompt(
      "你是邮件工作台的意图判断器。只输出 JSON，不要解释。判断用户是否明确要求打开专项操作：writing=写/回复/改写邮件，leadFinder=开发客户/找买家，companyResearch=资信或背景调研，chat=普通问答、总结、分析、查询资料或讨论建议。仅当用户明确要求执行专项操作时才返回专项类型；“这个客户/这个主题/这个产品”等没有明确身份的泛称不能作为客户或主题选择，也不能因此自动跳转。格式：{\"intent\":\"chat|writing|leadFinder|companyResearch\"}",
      prompt,
    );
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as { intent?: string };
    if (parsed.intent === "writing" || parsed.intent === "leadFinder" || parsed.intent === "companyResearch") return parsed.intent;
    return null;
  } catch {
    return fallback;
  }
}

function newConversation(): WorkbenchConversation {
  const now = Date.now();
  return { id: `home-${now}-${Math.random().toString(36).slice(2, 8)}`, title: "新对话", messages: [], createdAt: now, updatedAt: now };
}

function loadConversations(): WorkbenchConversation[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WorkbenchConversation[];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === "string" && Array.isArray(item.messages)).slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function saveConversations(conversations: WorkbenchConversation[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(conversations.slice(0, MAX_HISTORY))); } catch { /* convenience history only */ }
}

function shorten(value: string, max: number) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function autoTitle(prompt: string) {
  const text = shorten(prompt, 28);
  if (/邮件|回复/.test(prompt)) return `邮件：${text}`;
  if (/客户|公司|联系人|跟进/.test(prompt)) return `客户：${text}`;
  if (/资料|文档|文件|产品/.test(prompt)) return `资料：${text}`;
  return text ? `AI 工作台：${text}` : "AI 工作台对话";
}

function uniqueReferences(references: WorkbenchReference[]) {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.kind}:${reference.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const GENERIC_CUSTOMER_TERMS = new Set([
  "帮我", "请帮", "一下", "最近", "这个", "这个客户", "客户", "客户画像", "客户情况", "该客户", "某个客户", "邮件", "往来邮件", "总结", "分析", "结合", "告诉我", "下一步", "应该", "做什么", "情况", "跟进", "看看", "请", "和", "并", "当前", "账号", "重要",
]);

function customerMatchesPrompt(customer: CustomerMemory, prompt: string) {
  const haystack = [customer.name, customer.email, customer.company, customer.summary, customer.profile, customer.tags.join(" ")].join(" ").toLowerCase();
  const terms = prompt.toLowerCase().split(/[\s,，。！？!?、:：;；()（）]+/).map((term) => term.trim()).filter((term) => term.length >= 2 && !GENERIC_CUSTOMER_TERMS.has(term));
  // “这个客户/某个客户”没有可验证的身份，不能为了回答而随机挑一条客户画像。
  return terms.length > 0 && terms.some((term) => haystack.includes(term));
}

async function collectContext(prompt: string, accountId: string | null, selectedKnowledgeIds: string[] = []): Promise<RetrievedContext> {
  const references: WorkbenchReference[] = [];
  const sections: string[] = [];
  let hits: SearchHit[] = [];
  let messages: Message[] = [];
  const folderNameById = new Map<string, string>();
  const broadMailboxQuestion = /(总结|最新|重要|待回复|待处理|概览|进展|跟进|全部|所有)/i.test(prompt);
  let locallyRankedMessages: Message[] = [];

  try { hits = prompt.trim() ? await searchMessages(prompt.trim(), 24, accountId || undefined) : []; } catch { hits = []; }

  // Natural-language mailbox questions often do not match the index literally. Inspect
  // every folder locally, then send only a small set of ranked list summaries.
  if (broadMailboxQuestion || hits.length === 0) {
    try {
      const accounts = await listAccounts();
      const targetAccounts = accountId ? accounts.filter((account) => account.id === accountId) : accounts;
      const recent: Array<{ summary: Awaited<ReturnType<typeof listMessages>>[number]; folderId: string; score: number }> = [];
      for (const account of targetAccounts.slice(0, 8)) {
        const folders = await listFolders(account.id);
        for (const folder of folders) {
          folderNameById.set(folder.id, folder.name);
          const summaries = await listMessages(folder.id, broadMailboxQuestion ? 8 : 5, 0);
          recent.push(...summaries.map((summary) => {
            const text = `${summary.subject} ${summary.snippet}`.toLowerCase();
            const terms = prompt.toLowerCase().split(/[\s,，。！？!?、:：;；()（）]+/).filter((term) => term.length >= 3);
            const keywordScore = terms.reduce((score, term) => score + (text.includes(term) ? 5 : 0), 0);
            const ageScore = Math.max(0, 3 - Math.floor((Date.now() / 1000 - summary.date) / 86_400));
            return { summary, folderId: folder.id, score: keywordScore + ageScore + (summary.is_read ? 0 : 2) };
          }));
        }
      }
      const selected = recent.sort((left, right) => right.score - left.score || right.summary.date - left.summary.date).slice(0, broadMailboxQuestion ? 8 : 6);
      hits = selected.map((item) => ({ message_id: item.summary.id, score: item.score, snippet: item.summary.snippet, folder_ids: [item.folderId] }));
      locallyRankedMessages = selected.map((item) => ({ ...item.summary, body_text: item.summary.snippet, body_html_raw: "" }));
    } catch { hits = []; }
  }

  if (hits.length > 0 && locallyRankedMessages.length === 0) {
    try { messages = await getMessagesBatch(hits.map((hit) => hit.message_id)); } catch { messages = []; }
  }
  if (locallyRankedMessages.length > 0) messages = locallyRankedMessages;
  const hitById = new Map(hits.map((hit) => [hit.message_id, hit]));
  if (messages.length > 0) {
    const lines = messages.slice(0, broadMailboxQuestion ? 8 : 16).map((message) => {
      const hit = hitById.get(message.id);
      const folderNames = hit?.folder_ids?.map((id) => folderNameById.get(id)).filter(Boolean).join("、") || "当前账号邮件";
      references.push({ kind: "mail", id: message.id, label: message.subject || "无主题邮件", subtitle: `${folderNames} · ${message.from_name || message.from_address} · ${new Date(message.date * 1000).toLocaleString()}`, accountId: message.account_id, folderId: hit?.folder_ids?.[0] });
      return `【邮件 ${message.id}】\n来源文件夹：${folderNames}\n主题：${message.subject || "无主题"}\n发件人：${message.from_name || ""} <${message.from_address}>\n日期：${new Date(message.date * 1000).toLocaleString()}\n邮件摘要：${shorten(message.body_text || message.snippet || "", 1200)}`;
    });
    sections.push(`邮件上下文（${lines.length} 封）：\n${lines.join("\n\n")}`);
  }

  let customers: CustomerMemory[] = [];
  try { customers = (await listCustomerMemories()).filter((customer) => customerMatchesPrompt(customer, prompt)).slice(0, 8); } catch { customers = []; }
  const vagueCustomerReference = /(这个客户|该客户|某个客户|客户情况|客户画像)/i.test(prompt);
  const hasSpecificCustomerHint = prompt.toLowerCase().split(/[\s,，。！？!?、:：;；()（）]+/).some((term) => term.length >= 2 && !GENERIC_CUSTOMER_TERMS.has(term));
  if (vagueCustomerReference && !hasSpecificCustomerHint) {
    sections.push("客户选择提示：用户还没有指定公司名称、联系人姓名、邮箱或客户画像。不要自行选择某个客户；先请用户补充要分析的客户。\n");
  }
  if (customers.length > 0) {
    const lines = customers.map((customer) => {
      references.push({ kind: "customer", id: customer.id, label: customer.company || customer.name || customer.email, subtitle: `${customer.name || "联系人未知"} · ${customer.email}`, email: customer.email });
      return `【客户 ${customer.id}】\n公司：${customer.company || "未知"}\n联系人：${customer.name || "未知"}\n邮箱：${customer.email}\n摘要：${shorten(customer.summary || customer.profile || "", 1800)}\n标签：${customer.tags.join("、")}`;
    });
    sections.push(`客户画像（${lines.length} 条）：\n${lines.join("\n\n")}`);
  }

  let knowledge: KnowledgeSnippet[] = [];
  try { knowledge = prompt.trim() ? await searchKnowledgeBase(prompt.trim(), 6, accountId) : []; } catch { knowledge = []; }
  if (knowledge.length > 0) {
    const lines = knowledge.map((item) => {
      references.push({ kind: "knowledge", id: item.id, label: item.name, subtitle: `${item.section || "资料"} · ${item.locator || ""}`, locator: item.locator || item.section || "资料库" });
      return `【资料 ${item.id}】\n名称：${item.name}\n位置：${item.locator || item.section || "未标注"}\n内容：${shorten(item.content, 2000)}`;
    });
    sections.push(`产品与资料中心（${lines.length} 条）：\n${lines.join("\n\n")}`);
  }

  if (selectedKnowledgeIds.length > 0) {
    try {
      const selectedItems = (await listKnowledgeItems(accountId)).filter((item) => selectedKnowledgeIds.includes(item.id));
      if (selectedItems.length > 0) {
        sections.push(`用户明确选择的资料中心文件：\n${selectedItems.map((item) => {
          references.push({ kind: "knowledge", id: item.id, label: item.name, subtitle: "用户明确选择", locator: "资料中心" });
          return `资料：${item.name}\n${shorten(item.content, 12000)}`;
        }).join("\n\n")}`);
      }
    } catch { /* 资料中心不可用时仍可回答邮件和客户问题 */ }
  }

  return {
    text: shorten(sections.join("\n\n") || "当前没有检索到可用的邮件、客户画像或资料库内容。请根据这一点回答，不要编造事实。", MAX_CONTEXT_CHARS),
    references: uniqueReferences(references),
  };
}

export default function HomeAiWorkbench() {
  const activeAccountId = useMailStore((state) => state.activeAccountId);
  const setActiveAccountId = useMailStore((state) => state.setActiveAccountId);
  const setActiveFolderId = useMailStore((state) => state.setActiveFolderId);
  const openMessageInInbox = useUIStore((state) => state.openMessageInInbox);
  const setActiveView = useUIStore((state) => state.setActiveView);
  const openRightPanel = useUIStore((state) => state.openRightPanel);
  const setSettingsTab = useUIStore((state) => state.setSettingsTab);
  const setCustomerProfileEmail = useUIStore((state) => state.setCustomerProfileEmail);
  const setLeadFinderDraft = useUIStore((state) => state.setLeadFinderDraft);
  const setCompanyResearchDraft = useUIStore((state) => state.setCompanyResearchDraft);
  const setAiWritingTurns = useUIStore((state) => state.setAiWritingTurns);
  const setPendingAiWritingInstruction = useUIStore((state) => state.setPendingAiWritingInstruction);
  const knowledgeContextQueue = useUIStore((state) => state.knowledgeContextQueue);
  const clearKnowledgeContextQueue = useUIStore((state) => state.clearKnowledgeContextQueue);
  const homeContextQueue = useUIStore((state) => state.homeContextQueue);
  const homeContextAttachmentQueue = useUIStore((state) => state.homeContextAttachmentQueue);
  const clearHomeContextQueue = useUIStore((state) => state.clearHomeContextQueue);
  const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<string[]>([]);
  const [conversations, setConversations] = useState<WorkbenchConversation[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<HomeAttachedFile[]>([]);
  const [attachedMails, setAttachedMails] = useState<HomeAttachedMail[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<"auto" | TradeSkillId>("auto");
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [runningSkillName, setRunningSkillName] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    resizeAutoGrowTextarea(inputRef.current, 300);
  }, [input]);

  useEffect(() => {
    const pending = knowledgeContextQueue.filter((item) => item.target === "home").map((item) => item.itemId);
    if (pending.length === 0) return;
    setSelectedKnowledgeIds((current) => [...new Set([...current, ...pending])]);
    clearKnowledgeContextQueue();
  }, [knowledgeContextQueue, clearKnowledgeContextQueue]);

  // 消费邮件/附件右键菜单“发送到首页 AI 工作台”的全局队列。
  useEffect(() => {
    if (homeContextQueue.length > 0) {
      setAttachedMails((current) => {
        const next = [...current];
        for (const item of homeContextQueue) if (!next.some((mail) => mail.id === item.messageId)) next.push({ id: item.messageId, title: item.title });
        return next;
      });
    }
    if (homeContextAttachmentQueue.length > 0) {
      for (const item of homeContextAttachmentQueue) {
        void readAttachmentFile(item.attachmentId).then((attachment) => {
          addFiles([new File([new Uint8Array(attachment.bytes)], attachment.name, { type: attachment.mime_type || "" })]);
        }).catch(() => setError("读取发送到首页的邮件附件失败。"));
      }
    }
    if (homeContextQueue.length > 0 || homeContextAttachmentQueue.length > 0) clearHomeContextQueue();
  }, [homeContextQueue, homeContextAttachmentQueue, clearHomeContextQueue]);

  useEffect(() => {
    const saved = loadConversations();
    const initial = saved.length > 0 ? saved : [newConversation()];
    setConversations(initial);
    setCurrentId(initial[0].id);
  }, []);

  const current = useMemo(() => conversations.find((item) => item.id === currentId) ?? conversations[0] ?? null, [conversations, currentId]);

  function persist(next: WorkbenchConversation[]) {
    const sorted = [...next].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_HISTORY);
    setConversations(sorted);
    saveConversations(sorted);
  }

  function createConversation() {
    const conversation = newConversation();
    persist([conversation, ...conversations]);
    setCurrentId(conversation.id);
    setError("");
  }

  function deleteConversation(id: string) {
    const next = conversations.filter((item) => item.id !== id);
    const fallback = next.length > 0 ? next : [newConversation()];
    persist(fallback);
    if (currentId === id) setCurrentId(fallback[0].id);
  }

  function addFiles(files: FileList | File[]) {
    const all = Array.from(files);
    const next = all
      .filter((file) => file.size <= 20 * 1024 * 1024)
      .filter((file) => !attachedFiles.some((item) => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified))
      .map((file) => ({ id: `${file.name}-${file.size}-${file.lastModified}`, file }));
    if (next.length > 0) setAttachedFiles((current) => [...current, ...next].slice(0, 12));
    if (all.some((file) => file.size > 20 * 1024 * 1024)) setError("单个拖入文件不能超过 20 MB。" );
  }

  function handleWorkbenchDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const messageId = event.dataTransfer.getData("application/x-pebble-message-id").trim();
    const attachmentId = event.dataTransfer.getData("application/x-pebble-attachment-id").trim();
    const files = Array.from(event.dataTransfer.files ?? []);
    if (messageId) {
      const title = event.dataTransfer.getData("text/plain").trim() || `邮件 ${messageId.slice(0, 8)}`;
      setAttachedMails((current) => current.some((item) => item.id === messageId) ? current : [...current, { id: messageId, title }]);
    }
    if (files.length > 0) addFiles(files);
    if (attachmentId && files.length === 0) {
      void readAttachmentFile(attachmentId).then((attachment) => {
        addFiles([new File([new Uint8Array(attachment.bytes)], attachment.name, { type: attachment.mime_type || "" })]);
      }).catch(() => setError("读取拖入的邮件附件失败。"));
    }
  }

  function handleWorkbenchPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  }

  async function buildAttachedContext(): Promise<string> {
    const parts: string[] = [];
    if (attachedMails.length > 0) {
      const messages = await getMessagesBatch(attachedMails.map((item) => item.id));
      parts.push(messages.map((message) => `【用户拖入的邮件】\n主题：${message.subject || "无主题"}\n发件人：${message.from_name || ""} <${message.from_address}>\n正文：${message.body_text.slice(0, 9000)}`).join("\n\n"));
    }
    for (const item of attachedFiles) {
      if (item.file.type.startsWith("image/")) {
        parts.push(`【用户粘贴或拖入的图片：${item.file.name}】\n用户已明确提供图片，但当前 AI 接口按文本传递；请根据用户文字描述回答，不要从文件名猜测图片内容。`);
        continue;
      }
      try {
        const text = (await extractDocumentText(item.file)).trim();
        parts.push(`【用户拖入的文件：${item.file.name}】\n${text ? text.slice(0, 12000) : "文件没有可提取的文字内容。"}`);
      } catch {
        parts.push(`【用户拖入的文件：${item.file.name}】\n文件格式暂不支持文字提取，请不要猜测其中的事实。`);
      }
    }
    return parts.join("\n\n");
  }

  function routeIntent(intent: Exclude<Intent, null>, prompt: string) {
    if (intent === "writing") {
      setPendingAiWritingInstruction(prompt);
      setAiWritingTurns([{ role: "user", content: prompt }]);
      openRightPanel("aiWriting");
      return "已识别为写邮件指令，AI 写作面板已打开。你可以继续补充收件人、语言和语气。";
    }
    if (intent === "leadFinder") {
      setLeadFinderDraft({ product: prompt, market: "", buyerType: "", query: prompt });
      setActiveView("leadFinder");
      return "已识别为开发客户指令，已打开开发客户并保留这条指令。";
    }
    const website = prompt.match(/(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+/i)?.[0] || "";
    setCompanyResearchDraft({ company: website || prompt.slice(0, 80), website, country: "" });
    setActiveView("companyResearch");
    return "已识别为资信调研指令，已打开资信调研并填入目标信息。";
  }

  function openSkillDraft(message: WorkbenchMessage) {
    const skill = getTradeSkill(message.skillId);
    if (!skill?.draftCapable) return;
    const instruction = `请基于首页外贸 Skill「${skill.name}」的分析继续完善邮件草稿。保留已核实事实，不得补造公司、联系人、价格、交期、认证或合作经历；先让我确认草稿，不要发送。\n\n用户原始任务与 Skill 结果：\n${message.content}`;
    setPendingAiWritingInstruction(instruction);
    setAiWritingTurns([{ role: "user", content: instruction }]);
    openRightPanel("aiWriting");
  }

  async function runTradeSkill(skill: TradeSkill, prompt: string, conversation: WorkbenchConversation) {
    setRunningSkillName(skill.name);
    const context = await collectContext(prompt, activeAccountId, selectedKnowledgeIds);
    const attachedContext = await buildAttachedContext();
    const evidence = `${context.text}${attachedContext ? `\n\n用户本次明确附加的内容：\n${attachedContext}` : ""}`;
    const userTask = `用户任务：\n${prompt}\n\n可用本地证据：\n${evidence}`;
    if (skill.online) {
      const result = await agentRun(buildTradeSkillSystemPrompt(skill), userTask);
      let content = result.content.trim();
      if (skill.id === "research-first-outreach") {
        const draft = extractOutreachDraft(content);
        const constraints = parseOutreachUserConstraints("不要询问邮箱、联系人或采购负责人，不要请求转发或转交。");
        if (!draft || violatesOutreachUserConstraints(draft, constraints)) {
          content = (await aiPrompt(
            `${buildTradeSkillSystemPrompt(skill)}\n这是发送前硬约束复核。重写完整结果，必须使用 Markdown 标题“## 邮件正文”，并保证该段不询问邮箱、联系人、负责人，不要求转发或转交。`,
            `原始任务：\n${prompt}\n\n需要纠正的结果：\n${content}`,
          )).trim();
        }
      }
      return { content, references: context.references, externalSources: [...new Set(result.sources)], toolCalls: result.toolCalls };
    }
    const content = await aiChat([
      { role: "system", content: buildTradeSkillSystemPrompt(skill) },
      ...conversation.messages.slice(-8).map((message) => ({ role: message.role, content: message.content } as ChatTurn)),
      { role: "user", content: userTask },
    ]);
    return { content: content.trim(), references: context.references, externalSources: [], toolCalls: 0 };
  }

  async function send(quickPrompt?: string) {
    const prompt = (quickPrompt ?? input).trim();
    if (!prompt || busy) return;
    const conversation = current ?? newConversation();
    const firstTurn = conversation.messages.length === 0;
    const userMessage: WorkbenchMessage = { id: `turn-${Date.now()}`, role: "user", content: prompt, createdAt: Date.now() };
    const optimistic: WorkbenchConversation = { ...conversation, title: firstTurn ? autoTitle(prompt) : conversation.title, messages: [...conversation.messages, userMessage], updatedAt: Date.now() };
    persist([optimistic, ...conversations.filter((item) => item.id !== conversation.id)]);
    setCurrentId(optimistic.id);
    setInput("");
    setAttachedFiles([]);
    setAttachedMails([]);
    setError("");
    setBusy(true);
    try {
      const selectedSkill = selectedSkillId === "auto" ? detectTradeSkill(prompt) : getTradeSkill(selectedSkillId);
      if (selectedSkill) {
        const result = await runTradeSkill(selectedSkill, prompt, conversation);
        const assistantMessage: WorkbenchMessage = {
          id: `turn-${Date.now()}-skill`, role: "assistant", content: result.content || "模型没有返回内容，请重试。",
          references: result.references, skillId: selectedSkill.id, externalSources: result.externalSources, toolCalls: result.toolCalls, createdAt: Date.now(),
        };
        const finished = { ...optimistic, title: firstTurn ? `${selectedSkill.name}：${shorten(prompt, 18)}` : optimistic.title, messages: [...optimistic.messages, assistantMessage], updatedAt: Date.now() };
        persist([finished, ...conversations.filter((item) => item.id !== conversation.id)]);
        setSelectedSkillId("auto");
        setSkillsOpen(false);
        return;
      }
      const intent = await classifyIntent(prompt);
      if (intent) {
        const assistantMessage: WorkbenchMessage = { id: `turn-${Date.now()}-route`, role: "assistant", content: routeIntent(intent, prompt), createdAt: Date.now() };
        persist([{ ...optimistic, messages: [...optimistic.messages, assistantMessage], updatedAt: Date.now() }, ...conversations.filter((item) => item.id !== conversation.id)]);
        return;
      }
      const context = await collectContext(prompt, activeAccountId, selectedKnowledgeIds);
      const attachedContext = await buildAttachedContext();
      const turns: ChatTurn[] = [
        { role: "system", content: `${SYSTEM_PROMPT}\n\n如果用户要求查询最新外部信息，且当前配置的模型或服务支持联网搜索，可以联网检索并说明来源；如果不支持联网，必须明确告知用户，不要假装已经搜索。普通问题可以直接回答，不必强行联网。` },
        { role: "system", content: "当用户要求总结账号邮件、最新邮件、待回复或待处理事项时，必须综合当前账号已经检索到的所有文件夹，包括收件箱、已发送、草稿、归档、垃圾邮件和自定义文件夹。请区分已回复与未解决事项，按重要性和紧急程度排序，说明判断依据、风险和建议的下一步行动；不要只依据收件箱。" },
        ...conversation.messages.map((message) => ({ role: message.role, content: message.content } as ChatTurn)),
        { role: "user", content: `用户当前问题：\n${prompt}\n\n本地检索上下文（只用于回答，不要把内部 ID 原样展示给用户）：\n${context.text}${attachedContext ? `\n\n用户本次拖入或粘贴的内容（只用于本次问题）：\n${attachedContext}` : ""}` },
      ];
      const answer = (await aiChat(turns)).trim() || "模型没有返回内容，请重试。";
      const assistantMessage: WorkbenchMessage = { id: `turn-${Date.now()}-answer`, role: "assistant", content: answer, references: context.references, createdAt: Date.now() };
      const finished = { ...optimistic, messages: [...optimistic.messages, assistantMessage], updatedAt: Date.now() };
      persist([finished, ...conversations.filter((item) => item.id !== conversation.id)]);
      if (firstTurn) {
        void aiPrompt("请把用户的问题和回答概括成一个简短的中文对话标题。只输出 8 到 18 个字，不要引号、序号或解释。", `${prompt}\n${answer.slice(0, 700)}`).then((title) => {
          const clean = title.replace(/[\r\n"“”「」]/g, "").trim();
          if (!clean) return;
          setConversations((items) => { const updated = items.map((item) => item.id === finished.id ? { ...item, title: clean } : item); saveConversations(updated); return updated; });
        }).catch(() => undefined);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunningSkillName("");
      setBusy(false);
    }
  }

  function openReference(reference: WorkbenchReference) {
    if (reference.kind === "mail") {
      setActiveAccountId(reference.accountId);
      if (reference.folderId) setActiveFolderId(reference.folderId);
      openMessageInInbox(reference.id);
    } else if (reference.kind === "customer") {
      setCustomerProfileEmail(reference.email);
      setActiveView("customerProfile");
    } else {
      setActiveView("settings");
      setSettingsTab("knowledgeBase");
    }
  }

  const selectedSkill = selectedSkillId === "auto" ? null : getTradeSkill(selectedSkillId);
  const suggestions = selectedSkill ? [
    selectedSkill.example,
    `请结合我拖入的邮件、附件和资料执行“${selectedSkill.name}”，资料不足的地方不要猜测。`,
  ] : [
    "整理当前邮箱最重要的待办，并告诉我下一步怎么做",
    "结合客户画像和往来邮件，分析这个客户的下一步",
    "从产品资料中查找依据，回答客户可能关心的问题",
  ];

  return (
    <section style={{ ...card, marginTop: 14, padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "14px 18px 10px", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 34, height: 34, display: "grid", placeItems: "center", borderRadius: 10, background: "var(--color-accent)", color: "#fff" }}><Bot size={19} /></div>
        <div style={{ flex: 1, minWidth: 0 }}><strong style={{ display: "block", fontSize: 16 }}>AI 工作台</strong><span style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>围绕当前邮箱的邮件、客户和资料直接提问</span></div>
        <button type="button" onClick={createConversation} style={smallButton}><Plus size={15} /> 新对话</button>
        {conversations.length > 1 && <details style={{ position: "relative" }}><summary style={{ ...smallButton, listStyle: "none", cursor: "pointer" }}><MessageCircle size={15} /> 历史</summary><div style={historyPopover}>{conversations.map((item) => <div key={item.id} style={{ display: "flex", gap: 4, padding: "3px 0" }}><button type="button" onClick={() => setCurrentId(item.id)} style={{ ...historyButton, background: item.id === current?.id ? "color-mix(in srgb, var(--color-accent) 12%, transparent)" : "transparent" }}>{item.title}</button><button type="button" onClick={() => deleteConversation(item.id)} title="删除对话" style={iconButton}><Trash2 size={13} /></button></div>)}</div></details>}
      </div>
      <div style={{ padding: "12px 18px 0" }}>
        {current?.messages.length ? <div style={{ display: "flex", flexDirection: "column", gap: 12, maxHeight: 520, overflowY: "auto", paddingBottom: 12 }}>{current.messages.map((message) => {
          const messageSkill = getTradeSkill(message.skillId);
          return <div key={message.id} style={{ display: "flex", justifyContent: message.role === "user" ? "flex-end" : "flex-start" }}><div style={{ maxWidth: "92%", padding: "10px 12px", borderRadius: 10, background: message.role === "user" ? "var(--color-accent)" : "var(--color-bg-secondary)", color: message.role === "user" ? "#fff" : "var(--color-text-primary)", whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.65 }}>
            {messageSkill && <div style={skillResultHeader}><Sparkles size={13} /><strong>{messageSkill.name}</strong><span>{messageSkill.permission}</span>{messageSkill.online && <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><Globe2 size={11} /> 已启用联网核验{typeof message.toolCalls === "number" ? ` · ${message.toolCalls} 个核验步骤` : ""}</span>}</div>}
            {message.role === "assistant" ? <MarkdownView text={message.content} /> : message.content}
            {message.role === "assistant" && message.externalSources && message.externalSources.length > 0 && <div style={sourceList}><strong>外部来源</strong>{message.externalSources.map((source, index) => <a key={source} href={source} target="_blank" rel="noreferrer">{index + 1}. {source}</a>)}</div>}
            {message.role === "assistant" && message.references && message.references.length > 0 && <div style={referenceList}>{message.references.map((reference) => <button key={`${reference.kind}-${reference.id}`} type="button" onClick={() => openReference(reference)} title={reference.subtitle} style={referenceButton}>{reference.kind === "mail" ? <Mail size={12} /> : reference.kind === "customer" ? <UserRound size={12} /> : <FileText size={12} />}<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 210 }}>{reference.label}</span></button>)}</div>}
            {messageSkill?.draftCapable && <button type="button" onClick={() => openSkillDraft(message)} style={draftButton}><Mail size={13} /> 送到 AI 写作继续修改</button>}
          </div></div>;
        })}{busy && <div style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>◌ {runningSkillName ? `正在执行「${runningSkillName}」，核对依据并生成结果…` : "正在检索邮件、客户和资料并生成回答…"}</div>}</div> : null}
        {error && <div style={{ color: "#c0392b", fontSize: 12, padding: "8px 0" }}>{error}</div>}
      </div>
      <div style={{ padding: "10px 18px 16px" }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 8 }}>你想处理什么？</div>
        <div style={skillPanel}>
          <div style={skillToolbar}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--color-text-secondary)", fontSize: 11 }}><Sparkles size={14} /> 专业能力</span>
            <button type="button" aria-expanded={skillsOpen} onClick={() => setSkillsOpen((open) => !open)} style={skillPickerButton}><strong>{selectedSkill?.name || "自动选择"}</strong><span>{selectedSkill ? "本次指定" : "按指令自动调用"}</span><ChevronDown size={14} style={{ transform: skillsOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }} /></button>
            <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, color: "var(--color-text-secondary)", fontSize: 11 }}><ShieldCheck size={13} /> 只读；邮件仅生成草稿</span>
          </div>
          {skillsOpen && <div style={skillGrid}>
            <button type="button" onClick={() => { setSelectedSkillId("auto"); setSkillsOpen(false); }} style={{ ...skillButton, ...(selectedSkillId === "auto" ? activeSkillButton : {}) }}><strong>自动选择</strong><span>根据你的自然语言按需调用</span></button>
            {TRADE_SKILLS.map((skill) => <button key={skill.id} type="button" onClick={() => { setSelectedSkillId(skill.id); setSkillsOpen(false); setInput(skill.example); inputRef.current?.focus(); }} title={skill.description} style={{ ...skillButton, ...(selectedSkillId === skill.id ? activeSkillButton : {}) }}><strong>{skill.name}</strong><span>{skill.online ? "联网核验" : "本地资料"} · {skill.permission}</span></button>)}
          </div>}
          {selectedSkill && <div style={selectedSkillHint}>{selectedSkill.description} · 执行完成后自动恢复“自动选择”。</div>}
        </div>
        <div style={{ marginBottom: 8 }}><KnowledgePicker accountId={activeAccountId} selectedIds={selectedKnowledgeIds} onChange={setSelectedKnowledgeIds} label="引用资料（可选）" /></div>
        <div style={composer} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }} onDrop={handleWorkbenchDrop}>
          {(attachedMails.length > 0 || attachedFiles.length > 0) && <div style={attachedRow}>
            {attachedMails.map((item) => <button key={`mail-${item.id}`} type="button" onClick={() => setAttachedMails((current) => current.filter((mail) => mail.id !== item.id))} style={attachedChip} title="点击移除拖入的邮件"><Mail size={13} />{item.title}<X size={12} /></button>)}
            {attachedFiles.map((item) => <button key={item.id} type="button" onClick={() => setAttachedFiles((current) => current.filter((file) => file.id !== item.id))} style={attachedChip} title="点击移除文件"><Paperclip size={13} />{item.file.name}<X size={12} /></button>)}
          </div>}
          <textarea ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} onPaste={handleWorkbenchPaste} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="输入问题；也可以直接拖入邮件、附件、文件，或粘贴图片" rows={4} style={textarea} />
          <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.currentTarget.value = ""; }} />
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy} style={fileButton}><Paperclip size={15} /> 添加文件</button>
          <button type="button" onClick={() => void send()} disabled={busy || !input.trim()} style={{ ...sendButton, opacity: busy || !input.trim() ? 0.55 : 1 }}><Send size={15} /> {busy ? "处理中" : "发送"}</button>
        </div>
        {current?.messages.length === 0 && <div style={{ marginTop: 12 }}><div style={{ color: "var(--color-text-secondary)", fontSize: 12, marginBottom: 7 }}>{selectedSkill ? `${selectedSkill.name}示例` : "可以这样问"}</div><div style={suggestionGrid}>{suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => { setInput(suggestion); inputRef.current?.focus(); }} disabled={busy} style={{ ...suggestionButton, opacity: busy ? 0.55 : 1 }}>{suggestion}</button>)}</div></div>}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 6, color: "var(--color-text-secondary)", fontSize: 11 }}><span>Enter 发送 · Shift + Enter 换行 · 当前范围：{activeAccountId ? "当前邮箱账号的全部邮件" : "全部邮箱账号"}</span>{current && current.messages.length > 0 && <button type="button" onClick={() => persist([{ ...current, messages: [], title: "新对话", updatedAt: Date.now() }, ...conversations.filter((item) => item.id !== current.id)])} style={clearButton}><X size={12} /> 清空当前对话</button>}</div>
      </div>
    </section>
  );
}

const card: React.CSSProperties = { border: "1px solid var(--color-border)", borderRadius: 10, background: "var(--color-bg-primary)", minWidth: 0 };
const smallButton: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--color-border)", borderRadius: 7, background: "var(--color-bg-primary)", color: "var(--color-text-primary)", padding: "6px 9px", fontSize: 12, cursor: "pointer" };
const historyPopover: React.CSSProperties = { position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 10, width: 260, maxHeight: 300, overflow: "auto", padding: 6, border: "1px solid var(--color-border)", borderRadius: 8, background: "var(--color-bg-primary)", boxShadow: "0 8px 24px rgba(0,0,0,.14)" };
const historyButton: React.CSSProperties = { flex: 1, minWidth: 0, border: 0, borderRadius: 5, padding: "7px 8px", textAlign: "left", color: "var(--color-text-primary)", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const iconButton: React.CSSProperties = { border: 0, background: "transparent", color: "var(--color-text-secondary)", padding: 5, cursor: "pointer" };
const suggestionButton: React.CSSProperties = { border: "1px solid var(--color-border)", borderRadius: 8, background: "var(--color-bg-primary)", color: "var(--color-text-primary)", padding: "9px 10px", fontSize: 12, lineHeight: 1.45, textAlign: "left", cursor: "pointer" };
const referenceList: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10, paddingTop: 8, borderTop: "1px solid color-mix(in srgb, var(--color-border) 75%, transparent)" };
const referenceButton: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, border: "1px solid color-mix(in srgb, var(--color-accent) 32%, var(--color-border))", borderRadius: 999, background: "color-mix(in srgb, var(--color-accent) 8%, transparent)", color: "var(--color-accent)", padding: "4px 8px", fontSize: 11, cursor: "pointer" };
const composer: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", border: "2px solid var(--color-accent)", borderRadius: 12, padding: 10, background: "color-mix(in srgb, var(--color-accent) 4%, var(--color-bg-primary))", boxShadow: "0 5px 18px color-mix(in srgb, var(--color-accent) 12%, transparent)" };
const attachedRow: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6, flexBasis: "100%", width: "0", paddingBottom: 7, borderBottom: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)" };
const attachedChip: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, maxWidth: 240, border: "1px solid color-mix(in srgb, var(--color-accent) 32%, var(--color-border))", borderRadius: 999, background: "color-mix(in srgb, var(--color-accent) 8%, transparent)", color: "var(--color-text-primary)", padding: "4px 8px", fontSize: 11, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const fileButton: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--color-border)", borderRadius: 7, background: "var(--color-bg-primary)", color: "var(--color-text-primary)", padding: "8px 10px", fontSize: 12, cursor: "pointer" };
const textarea: React.CSSProperties = { flex: 1, minWidth: 0, minHeight: 92, maxHeight: 300, overflowY: "auto", resize: "none", border: 0, outline: 0, background: "transparent", color: "var(--color-text-primary)", fontSize: 14, lineHeight: 1.7 };
const suggestionGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 7 };
const sendButton: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, border: 0, borderRadius: 7, background: "var(--color-accent)", color: "#fff", padding: "8px 12px", fontSize: 12, cursor: "pointer" };
const clearButton: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 3, border: 0, background: "transparent", color: "var(--color-text-secondary)", fontSize: 11, cursor: "pointer" };
const skillPanel: React.CSSProperties = { position: "relative", marginBottom: 9, padding: "7px 9px", border: "1px solid var(--color-border)", borderRadius: 9, background: "var(--color-bg-secondary)" };
const skillToolbar: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };
const skillPickerButton: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid var(--color-border)", borderRadius: 7, background: "var(--color-bg-primary)", color: "var(--color-text-primary)", padding: "5px 8px", cursor: "pointer", fontSize: 11 };
const skillGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 6, marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--color-border)" };
const skillButton: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0, border: "1px solid var(--color-border)", borderRadius: 8, background: "var(--color-bg-primary)", color: "var(--color-text-primary)", padding: "7px 9px", textAlign: "left", cursor: "pointer", fontSize: 11 };
const activeSkillButton: React.CSSProperties = { borderColor: "var(--color-accent)", background: "color-mix(in srgb, var(--color-accent) 9%, var(--color-bg-primary))", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 30%, transparent)" };
const selectedSkillHint: React.CSSProperties = { marginTop: 7, color: "var(--color-text-secondary)", fontSize: 11 };
const skillResultHeader: React.CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 8, paddingBottom: 7, borderBottom: "1px solid var(--color-border)", color: "var(--color-accent)", fontSize: 11 };
const sourceList: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 3, marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--color-border)", fontSize: 11, wordBreak: "break-all" };
const draftButton: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, marginTop: 10, border: 0, borderRadius: 7, background: "var(--color-accent)", color: "#fff", padding: "7px 10px", fontSize: 11, cursor: "pointer" };
