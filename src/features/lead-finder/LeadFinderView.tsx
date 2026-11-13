import { useWorkspaceState, useWorkspaceRestored, useWorkspaceIsTransferring, useWorkspaceInitEffect, useWorkspaceScope } from '@/lib/workspaceState';
import { useEffect, useRef } from "react";
import type { EmailResearchEvidence } from "@/lib/researchEvidence";
import { invoke } from "@tauri-apps/api/core";
import { Check, CheckSquare, ChevronRight, Globe2, Mail, Paperclip, Pause, Play, Plus, RefreshCw, Search, Send, Settings2, Tag, Trash2, UserPlus, Users, X } from "lucide-react";
import { discoverLeads, forgetLeadTask, aiPrompt, leadResearchPrompt, enrichLeadCandidate, saveCustomerMemory, getMessagesBatch, readAttachmentFile, listKnowledgeItems, listStyleProfiles, sendEmail, loadLeadFinderData, saveLeadFinderData, getSentSamples, type PublicCompanyMatch, type LeadQuality, type LeadDiscoveryResponse } from "@/lib/api";
import { useToastStore } from "@/stores/toast.store";
import { useUIStore } from "@/stores/ui.store";
import { useComposeStore } from "@/stores/compose.store";
import { useBackgroundTasksStore } from "@/stores/backgroundTasks.store";
import { useLeadDevRecords } from "./useLeadDevRecords";
import { extractDocumentText } from "@/lib/documentText";
import { resizeAutoGrowTextarea } from "@/lib/autoGrowTextarea";
import KnowledgePicker from "@/components/KnowledgePicker";
import { useMailStore } from "@/stores/mail.store";
import { useAccountsQuery } from "@/hooks/queries";
import { getSignature } from "@/lib/signatures";
import { useAutoDevStore, waitForAutoDevControl, type AutoDevReportItem } from "@/stores/autoDev.store";
import {
  contactRequestConstraintPrompt,
  normalizeOutreachEmailFormat,
  parseOutreachUserConstraints,
  violatesOutreachUserConstraints,
  type OutreachUserConstraints,
} from "./outreach-guard";
import { emailStrictlyMatchesCompany } from "./company-email-affinity";
import LeadDeliveryCard from './LeadDeliveryCard';
import { EmailVerificationScope } from '@/components/EmailVerificationPanel';
import LeadProfiles from './LeadProfiles';
import {orderByLeadSignals} from './leadSignalOrder';
import {useEmailChecks,emailCheckKey} from '@/stores/emailChecks.store';
import { checkResearchContactAllowed } from '@/lib/api';
import LeadTaskHistory from './LeadTaskHistory';
import LeadSearchStatus from './LeadSearchStatus';
import { phaseForLeadReport, useLeadTaskProgress } from './leadTaskProgress';
import { leadPage, leadTaskContext, leadFillStatus, leadPageDeficit, LEAD_PAGE_SIZE } from './leadDelivery';
import { buildLeadDiscoveryRequest, qualityScore, fallbackProductBrief, interpretProductBrief, emptyLeadResultMessage, describeReviewIssues, describeLeadFailure, PRODUCT_BRIEF_VERSION, PRODUCT_RESEARCH_PROMPT, type ProductSearchBrief } from "./leadDiscovery";
import { LeadContactQueue, mergeContactProgress, contactJobKey, shouldDiscoverContact } from "./leadContactQueue";
import { writingLanguageInstruction } from "@/lib/mailLanguages";

interface LeadCandidate {
  quality?: LeadQuality;
  companyName?: string;
  website?: string;
  sourceUrl?: string;
  websiteStatus?: "已核验" | "待核验" | "无法访问" | "身份不匹配";
  websiteStatusReason?: string;
  country?: string;
  city?: string;
  address?: string;
  customerType?: string;
  description?: string;
  reason?: string;
  fitScore?: number;
  fitSignals?: string[];
  unknowns?: string[];
  emails?: string[];
  emailEvidence?: Array<EmailResearchEvidence & {
    email: string;
    source: string;
    sourceUrl: string;
    confidence?: number;
    verification: string;
    emailType?: string;
    person?: string;
    suitability?: string;
  }>;
  emailDiscoverySummary?: string;
  emailDiscoveryStatus?: "pending" | "running" | "completed" | "failed";
  source?: string;
  background?: string;
  products?: string;
  fitSummary?: string;
  contactRoles?: string[];
  leadId?: string;
  tags?: string[];
  leadStatus?: "new" | "contacted" | "qualified" | "archived";
  savedAt?: number;
  priorityTier?: "T1" | "T2" | "T3";
  channelSources?: string[];
  scoreBreakdown?: string[];
  recommendationReason?: string;
  discoveryBasis?: string[];
  companyIntroduction?: string;
  contactStatus?: "可联系" | "待补全";
  contacts?: PublicCompanyMatch['contacts'];
  buyingSignals?: PublicCompanyMatch['buyingSignals'];
}

interface LeadProductBrief extends ProductSearchBrief {
  targetMarket?: string;
  buyerRole?: string;
  coreCategory: string;
  mandatoryQualifiers: string[];
  useCases: string[];
  adjacentBuyerChannels: string[];
  exclusionSignals: string[];
  searchAliases: string[];
  taskTitle?: string;
  taskSummary?: string;
}

interface LeadSearchSession {
  nativeResultRound?: number;
  accountId?: string;
  failure?: "product_interpretation_failed" | "execution_failed";
  failureDetail?: string;
  discoveryReport?: LeadDiscoveryResponse["report"];
  id: string;
  title: string;
  summary?: string;
  product: string;
  market: string;
  buyerType: string;
  query: string;
  page: number;
  resultCount: number;
  results: LeadCandidate[];
  productBrief?: LeadProductBrief;
  // 本次搜索所用的上下文快照（保证后续生成的开发信不脱离当时搜索用的资料/文件/资料库引用）
  contextText?: string;
  contextFiles?: string[];
  contextKnowledgeIds?: string[];
  contextFilesNote?: string;
  createdAt: number;
  updatedAt: number;
}

interface LeadFinderTaskResult {
  discoveryReport?: LeadDiscoveryResponse["report"];
  sessionId: string;
  page: number;
  items: LeadCandidate[];
  productBrief?: LeadProductBrief;
}

const SAVED_LEADS_KEY = "yaoaimail-saved-leads-v1";
const SEARCH_SESSIONS_KEY = "yaoaimail-lead-search-sessions-v1";
const normalizeLeadPart = (value: string) => value.toLowerCase().replace(/^mailto:/, "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[^a-z0-9@.]+/g, "").trim();

async function openLeadUrl(rawUrl: string): Promise<void> {
  const value = rawUrl.trim();
  if (!value) return;
  const url = /^(?:https?:\/\/|mailto:)/i.test(value) ? value : `https://${value.replace(/^\/\//, "")}`;
  try {
    await invoke("open_external_url", { url });
  } catch (error) {
    useToastStore.getState().addToast({ message: `网址无法打开：${String(error)}`, type: "error" });
  }
}

/** 毫秒时间戳 → datetime-local 输入框值（本地时间 YYYY-MM-DDTHH:mm）。 */
function toLocalDatetimeInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const isUsableLeadEmail = (value: string) => {
  const email = value.trim().replace(/^mailto:/i, "").toLowerCase();
  if (!email || /[\s*…]/.test(email)) return false;
  const parts = email.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1].includes(".")) return false;
  return !new Set(["first", "last", "firstname", "lastname", "first.last", "firstlast", "first_last", "first-last", "f.last", "flast", "name", "yourname", "email", "user", "username", "example", "test"]).has(parts[0]);
};
const leadKey = (item: LeadCandidate) => {
  if (item.quality && item.website) {
    try { return `site:${new URL(item.website).hostname.toLowerCase().replace(/^www\./, "")}`; } catch { /* legacy URL */ }
  }
  const email = normalizeLeadPart(item.emails?.[0] || "");
  const website = normalizeLeadPart(item.website || "");
  const company = normalizeLeadPart(item.companyName || "");
  return `${email || website || company}|${company}`;
};
function readSavedLeads(): LeadCandidate[] {
  try { return (JSON.parse(localStorage.getItem(SAVED_LEADS_KEY) || "[]") as LeadCandidate[]).map((item) => cleanLeadCandidate(item)); } catch { return []; }
}
function readSearchSessions(): LeadSearchSession[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEARCH_SESSIONS_KEY) || "[]") as LeadSearchSession[];
    return parsed.map(normalizeSearchSession);
  } catch { return []; }
}

function buildSearchSessionTitle(product: string, market: string, buyerType: string, query: string): string {
  const brief = (product.trim() || query.trim() || "客户开发任务")
    .split(/[。！？.!?\n]/)[0]
    .replace(/^(我们是|我想|请帮我|帮我|希望|需要|寻找|搜索|开发)/, "")
    .replace(/(寻找|搜索|开发).*(客户|买家|公司).*$/i, "")
    .trim();
  const core = [...brief].slice(0, 24).join("");
  return [market.trim(), core, buyerType.trim() || "客户开发"].filter(Boolean).join(" · ").slice(0, 48) || "客户开发任务";
}

function buildSearchSessionSummary(product: string, market: string, buyerType: string, query: string): string {
  return [`产品：${product.trim() || "按任务识别"}`, `市场：${market.trim() || "未指定"}`, `目标：${buyerType.trim() || "潜在采购客户"}`, query.trim() && `要求：${query.trim().slice(0, 60)}`].filter(Boolean).join("；").slice(0, 140);
}

function normalizeSearchSession(session: LeadSearchSession): LeadSearchSession {
  const legacyMeta = !session.summary;
  return {
    ...session,
    title: legacyMeta ? buildSearchSessionTitle(session.product, session.market, session.buyerType, session.query) : session.title,
    summary: session.summary || buildSearchSessionSummary(session.product, session.market, session.buyerType, session.query),
    results: (session.results || []).map((item) => cleanLeadCandidate(item, session.productBrief)),
    resultCount: session.resultCount || session.results?.length || 0,
  };
}

function plainTextSignature(value: string): string {
  return value.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function signatureFromSentBodies(bodies: string[]): string {
  const candidates = bodies.map((body) => {
    const lines = body.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
    let start = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (/^(best|kind|warm)?\s*(regards|wishes)|^(thanks|thank you|sincerely|cheers|此致|祝好|顺祝商祺)[,!，。]?$/i.test(lines[index])) { start = index; break; }
    }
    return start >= 0 ? lines.slice(start, start + 5).join("\n") : "";
  }).filter(Boolean);
  if (!candidates.length) return "";
  const counts = new Map<string, number>();
  for (const candidate of candidates) counts.set(candidate, (counts.get(candidate) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function parseOutreachDraft(raw: string): { subject: string; body: string } {
  const fenced = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI 没有返回可发送的结构化开发信，已拦截发送");
  const parsed = JSON.parse(fenced.slice(start, end + 1)) as { subject?: unknown; body?: unknown };
  const subject = cleanLeadText(parsed.subject, 90).replace(/^subject\s*:\s*/i, "");
  let body = typeof parsed.body === "string" ? parsed.body : "";
  body = normalizeOutreachEmailFormat(body.replace(/\*\*/g, "").replace(/^#{1,6}\s*/gm, ""));
  if (!subject || !body || /(分析客户需求|邮件撰写|检查清单|Draft Email|Hook:|Pain Point:|Value:|CTA:)/i.test(body)) throw new Error("AI 返回了分析过程而不是纯开发信，已拦截发送");
  if (!body.includes("\n\n")) {
    const sentences = body.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
    body = Array.from({ length: Math.ceil(sentences.length / 2) }, (_, index) => sentences.slice(index * 2, index * 2 + 2).join(" ")).join("\n\n");
  }
  return { subject, body };
}

interface OutreachAdjustment {
  instruction: string;
  lengthRule: string;
  maxEnglishWords: number;
  maxChineseChars: number;
  removeDashes: boolean;
  userConstraints: OutreachUserConstraints;
}

function normalizeOutreachAdjustment(raw: string): OutreachAdjustment {
  const instruction = raw.trim();
  const asksVeryShort = /(极简|非常短|尽量短|越短越好|一句话|两句话)/i.test(instruction);
  const asksShort = asksVeryShort || /(剪短|简短|简洁|精简|缩短|压缩|短一点|短一些|短些|不要太长|太长了|太长啦)/i.test(instruction);
  const asksLonger = !asksShort && /(更长|长一点|详细|展开|丰富|具体一点|多写一点)/i.test(instruction);
  const removeDashes = /(不要|不用|避免|去掉|别用).{0,8}(破折号|长横线|—|--)/i.test(instruction);
  // First-touch development emails must provide value directly. Asking a
  // stranger to find an email address/contact is disabled for both manual and
  // automatic generation; an explicit user ban is detected as an additional
  // hard constraint and reported by the guard tests.
  const userConstraints = {
    ...parseOutreachUserConstraints(instruction),
    forbidContactRequests: true,
  };

  if (asksVeryShort) {
    return { instruction, lengthRule: "正文必须控制在 35-60 个英文单词；若使用中文，控制在 60-100 个汉字", maxEnglishWords: 60, maxChineseChars: 100, removeDashes, userConstraints };
  }
  if (asksShort) {
    return { instruction, lengthRule: "正文必须控制在 50-80 个英文单词；若使用中文，控制在 80-130 个汉字", maxEnglishWords: 80, maxChineseChars: 130, removeDashes, userConstraints };
  }
  if (asksLonger) {
    return { instruction, lengthRule: "正文控制在 130-180 个英文单词；若使用中文，控制在 220-320 个汉字", maxEnglishWords: 180, maxChineseChars: 320, removeDashes, userConstraints };
  }
  return { instruction, lengthRule: "正文控制在 50-100 个英文单词；若使用中文，控制在 90-170 个汉字", maxEnglishWords: 100, maxChineseChars: 170, removeDashes, userConstraints };
}

function outreachDraftTooLong(body: string, adjustment: OutreachAdjustment): boolean {
  const chineseChars = body.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const englishWords = body.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0;
  return chineseChars > englishWords
    ? chineseChars > adjustment.maxChineseChars
    : englishWords > adjustment.maxEnglishWords;
}

function applyOutreachTextConstraints(draft: { subject: string; body: string }, adjustment: OutreachAdjustment): { subject: string; body: string } {
  const normalizedDraft = { ...draft, body: normalizeOutreachEmailFormat(draft.body) };
  if (!adjustment.removeDashes) return normalizedDraft;
  const removeDashes = (value: string) => value
    .replace(/\s*(?:—|–|--+)\s*/g, ", ")
    .replace(/,\s*,+/g, ", ")
    .replace(/\s+,/g, ",")
    .trim();
  return { subject: removeDashes(normalizedDraft.subject), body: normalizeOutreachEmailFormat(removeDashes(normalizedDraft.body)) };
}

type OutreachEvidenceLevel = "strong" | "medium" | "limited";

interface OutreachStrategy {
  key: "routing" | "trigger" | "role" | "assortment" | "offer" | "relevance";
  title: string;
  reason: string;
  evidenceLevel: OutreachEvidenceLevel;
  evidenceUsed: string[];
  warnings: string[];
  instruction: string;
}

interface OutreachContent {
  subject: string;
  body: string;
  strategy: OutreachStrategy;
}

function stableOutreachVariant(value: string): number {
  let hash = 0;
  for (const char of value) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 4;
}

function chooseOutreachStrategy(candidate: LeadCandidate, email: string, productContext: string): OutreachStrategy {
  const evidence = candidate.emailEvidence?.find((entry) => entry.email.toLowerCase() === email.toLowerCase());
  const localPart = email.split("@")[0]?.toLowerCase() || "";
  const isGenericMailbox = /^(info|sales|contact|hello|office|service|support|admin|enquiries?|inquiries?|commercial|export|marketing)([._-]|$)/i.test(localPart);
  const roleContext = [evidence?.person, evidence?.emailType, evidence?.suitability].filter(Boolean).join("；");
  const signalContext = [...(candidate.fitSignals || []), candidate.background, candidate.reason].filter(Boolean).join("；");
  const hasChangeSignal = /(launch|launched|new product|expand|expansion|opened|opening|hiring|recent|growth|进入|推出|新品|扩张|扩展|新增|开设|招聘|近期|增长)/i.test(signalContext);
  const hasRealProof = /(case study|customer case|客户案例|成功案例|已帮助|采购案例|合作客户|benchmark|测试报告|市场报告)/i.test(productContext);
  const evidenceUsed = [
    candidate.products && `客户产品：${cleanLeadText(candidate.products, 120)}`,
    candidate.fitSignals?.[0] && `匹配信号：${cleanLeadText(candidate.fitSignals[0], 120)}`,
    candidate.background && `客户背景：${cleanLeadText(candidate.background, 120)}`,
    evidence?.person && `联系人：${cleanLeadText(evidence.person, 80)}`,
    evidence?.sourceUrl && `邮箱来源：${cleanLeadText(evidence.sourceUrl, 160)}`,
  ].filter(Boolean) as string[];
  const factualDepth = Number(Boolean(candidate.website)) + Number(Boolean(candidate.products)) + Math.min(2, candidate.fitSignals?.length || 0) + Number(Boolean(evidence?.sourceUrl));
  const evidenceLevel: OutreachEvidenceLevel = factualDepth >= 4 ? "strong" : factualDepth >= 2 ? "medium" : "limited";
  const warnings = [
    evidenceLevel === "limited" && "客户公开信息较少：只确认相关性，不把推测写成事实。",
    ...(candidate.unknowns || []).slice(0, 2).map((item) => `待确认：${cleanLeadText(item, 100)}`),
  ].filter(Boolean) as string[];
  const variant = stableOutreachVariant(`${candidate.companyName}|${email}`);
  const presentation = [
    "可从一条具体观察直接切入，不必先介绍自己。",
    "可用一个容易回答、且无法从已有资料直接得到答案的具体问题开场。",
    "可先说明联系理由，再用一两句连接客户场景和我方产品。",
    "可用客户现有品类与我方互补品类的对照开场。",
  ][variant];

  if (isGenericMailbox && !evidence?.person) {
    return { key: "routing", title: "公共邮箱价值提供型", reason: "当前是公共邮箱，不把寻找联系人这项工作推给收件人；直接用具体品类相关性和一份低成本资料争取回复。", evidenceLevel, evidenceUsed, warnings, instruction: "这是发往公共邮箱的首封开发信。直接说明一条与对方经营品类相关的观察，再提供一个具体、低成本且可立即发送的内容，例如 4-6 张适配产品图、一页选品单或带价格区间的简表。不得询问谁负责、不得索要联系人或邮箱、不得请求转发；让内容本身值得内部转发。" };
  }
  if (hasChangeSignal && candidate.fitSignals?.length) {
    return { key: "trigger", title: "客户变化触发型", reason: "客户资料里存在近期变化或业务动作，可围绕其时机说明为什么现在联系。", evidenceLevel, evidenceUsed, warnings, instruction: `围绕资料中可核实的变化信号写作，先写变化及其业务含义，再提供与该变化匹配的一项价值或资料。不得把推测说成已确认事实。${presentation}` };
  }
  if (evidence?.person || roleContext) {
    return { key: "role", title: "联系人角色型", reason: "已有联系人或职能线索，邮件应匹配其职责，而不是对所有人使用相同卖点。", evidenceLevel, evidenceUsed, warnings, instruction: `根据联系人角色选择一个最相关角度：采购关注选品、MOQ、交付和供应稳定；经营者关注差异化和商业机会；产品/设计人员关注系列匹配和使用场景。资料没有的参数不得声称。${presentation}` };
  }
  if (candidate.products && (candidate.fitSummary || productContext)) {
    return { key: "assortment", title: "选品互补型", reason: "已知客户经营品类和我方产品，可从产品组合是否互补切入。", evidenceLevel, evidenceUsed, warnings, instruction: `比较客户已知品类与我方产品，只提出资料能支持的互补机会；不要空泛声称“更高利润”或“客户都在寻找”。CTA 优先提供少量图片、选品清单、报价范围或适配建议。${presentation}` };
  }
  if (hasRealProof) {
    return { key: "offer", title: "具体价值提供型", reason: "用户资料中存在可提供的案例、报告或证明材料，适合先给价值而不是索要会议。", evidenceLevel, evidenceUsed, warnings, instruction: `只引用产品资料中真实存在的案例、报告或证明，提出发送一个具体材料或简短建议。不得杜撰客户名称、数字或成果。${presentation}` };
  }
  return { key: "relevance", title: "相关性确认型", reason: "目前客户证据不足以支持深度个性化，采用诚实、简短的相关性确认更安全。", evidenceLevel, evidenceUsed, warnings, instruction: `坦率说明为什么认为双方可能相关，并用一个容易回答的问题确认该品类是否由对方负责。不要使用伪个性化、恭维或未经证实的客户痛点。${presentation}` };
}

function outreachSimilarity(left: string, right: string): number {
  const tokens = (value: string) => new Set((value.toLowerCase().match(/[a-z0-9]{3,}|[\u3400-\u9fff]{2,}/g) || []).filter((item) => !["regards", "thanks", "hello"].includes(item)));
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function cleanLeadText(value: unknown, max = 900): string {
  if (typeof value !== "string") return "";
  const decoded = typeof DOMParser === "undefined" ? value : new DOMParser().parseFromString(value, "text/html").documentElement.textContent || "";
  return decoded.replace(/```[\s\S]*?```/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanLeadResultField(value: unknown, max = 900): string {
  const cleaned = cleanLeadText(value, max);
  return /(这是第|不要重复|补充关键词|线索渠道|用户指令|参考邮件|上下文内容|查找跟|排除那些|给他们推销)/.test(cleaned) ? "" : cleaned;
}


async function createProductBrief(product: string, market: string, buyerType: string, query: string, context: string): Promise<LeadProductBrief> {
  return await interpretProductBrief({product,query,context},repair => leadResearchPrompt(
    PRODUCT_RESEARCH_PROMPT + (repair ? "\n上次英文检索规划无效。只修正英文searchProduct和英文searchChannels、目标市场当地语言localQueries，禁止输出公司或拼接中文检索词。" : ""),
    `产品/服务：${product}\n目标市场：${market}\n目标买家：${buyerType}\n用户要求：${query}\n用户本次选择的参考内容：${context.slice(0,6000)}`,
  )) as LeadProductBrief;
}

function cleanLeadCandidate(item: LeadCandidate, productBrief?: LeadProductBrief | string): LeadCandidate {
  const evidence = (item.emailEvidence || []).filter((entry) =>
    isUsableLeadEmail(entry.email)
    && Boolean(entry.sourceUrl?.trim())
    && Boolean(entry.source?.trim())
    && emailStrictlyMatchesCompany({
      email: entry.email,
      companyName: item.companyName || "",
      website: item.website || "",
      websiteStatus: item.websiteStatus,
      evidenceSource: entry.source,
      evidenceSourceUrl: entry.sourceUrl,
    })
  );
  const evidenceEmails = new Set(evidence.map((entry) => entry.email.toLowerCase()));
  const emails = [...new Set((item.emails || []).map((email) => email.trim().replace(/^mailto:/i, "").toLowerCase()).filter(isUsableLeadEmail))]
    .filter((email) => evidenceEmails.has(email));
  const verifiedEmail = evidence.some((entry) => entry.deliveryStatus === "valid");
  const rawWebLead = /公开搜索结果|公开公司网页线索/.test(item.source || "");
  const pendingAiLead = /AI.*待核验/.test(item.source || "");
  const unverifiedLead = rawWebLead || pendingAiLead;
  const initialScore = Math.max(0, Math.min(100,
    (Number.isFinite(item.fitScore) ? Number(item.fitScore) : 40)
    + (item.website && !unverifiedLead ? 8 : 0) + (emails.length ? 12 : 0) + (verifiedEmail ? 10 : 0)
    + Math.min(15, (item.fitSignals?.length || 0) * 3) - Math.min(15, (item.unknowns?.length || 0) * 2),
  ));
  const corpus = [item.description, item.background, item.products, item.reason, item.fitSummary, ...(item.fitSignals || [])].join(" ").toLowerCase();
  const effectiveBrief = typeof productBrief === "string" ? fallbackProductBrief(productBrief, "") : productBrief;
  const matches = (terms: string[]) => terms.filter((term) => term.trim().length >= 2 && corpus.includes(term.toLowerCase())).length;
  const directTerms = effectiveBrief ? [effectiveBrief.coreCategory, ...effectiveBrief.mandatoryQualifiers, ...effectiveBrief.searchAliases] : [];
  const directMatches = matches(directTerms);
  const useCaseMatches = matches(effectiveBrief?.useCases || []);
  const adjacentMatches = matches(effectiveBrief?.adjacentBuyerChannels || []);
  const exclusionMatches = matches(effectiveBrief?.exclusionSignals || []);
  const evidenceAdjustedScore = rawWebLead ? Math.min(initialScore, 29)
    : pendingAiLead ? Math.min(initialScore, 49)
    : initialScore;
  const score = item.quality ? qualityScore(item.quality) : !effectiveBrief ? evidenceAdjustedScore
    : exclusionMatches > 0 ? Math.min(evidenceAdjustedScore, 29)
    : directMatches > 0 || useCaseMatches > 0 ? evidenceAdjustedScore
    : adjacentMatches > 0 ? Math.min(evidenceAdjustedScore, 74)
    : Math.min(evidenceAdjustedScore, 39);
  return {
    ...item,
    emails,
    emailEvidence: evidence,
    companyName: cleanLeadText(item.companyName, 180),
    website: cleanLeadText(item.website, 300),
    sourceUrl: cleanLeadText(item.sourceUrl, 300),
    websiteStatus: item.websiteStatus || "待核验",
    websiteStatusReason: cleanLeadText(item.websiteStatusReason, 300),
    country: cleanLeadText(item.country, 80),
    city: cleanLeadText(item.city, 120),
    address: cleanLeadText(item.address, 350),
    customerType: cleanLeadResultField(item.customerType, 100),
    description: cleanLeadResultField(item.description),
    background: cleanLeadResultField(item.background),
    products: cleanLeadResultField(item.products),
    reason: cleanLeadResultField(item.reason),
    recommendationReason: cleanLeadResultField(item.recommendationReason || item.reason),
    discoveryBasis: (item.discoveryBasis || item.fitSignals || []).map((value) => cleanLeadText(value, 300)).filter(Boolean).slice(0, 5),
    companyIntroduction: cleanLeadResultField(item.companyIntroduction || item.background || item.description, 1200),
    contactStatus: emails.length > 0 && evidence.length > 0 ? "可联系" : "待补全",
    emailDiscoveryStatus: item.emailDiscoveryStatus || (evidence.length > 0 ? "completed" : "pending"),
    fitSummary: cleanLeadResultField(item.fitSummary),
    source: cleanLeadText(item.source, 300),
    fitSignals: (item.quality ? item.quality.evidence.map(proof => proof.quote) : item.fitSignals || []).map((value) => cleanLeadText(value, 240)).filter(Boolean).slice(0, 6),
    unknowns: (item.quality?.unknowns || item.unknowns || []).map((value) => cleanLeadText(value, 240)).filter(Boolean).slice(0, 6),
    contactRoles: (item.contactRoles || []).map((value) => cleanLeadText(value, 120)).filter(Boolean).slice(0, 6),
    fitScore: score,
    priorityTier: score >= 75 ? "T1" : score >= 50 ? "T2" : "T3",
    channelSources: [...new Set((item.channelSources || [item.source || "AI 联网搜索"]).map((value) => cleanLeadText(value, 100)).filter(Boolean))].slice(0, 8),
    scoreBreakdown: item.quality ? [`已读取 ${item.quality.checkedPages} 个网页`, "规则证据分，不是成交概率；邮箱数量不加分"] : [
      item.website ? (unverifiedLead ? "候选网址待核验，尚不能认定为官网" : "官网可核实") : "缺少官网",
      emails.length ? `发现 ${emails.length} 个有来源邮箱` : "暂未发现可确认邮箱",
      verifiedEmail ? "邮箱验证服务通过，送达不保证" : "邮箱仍需验证",
      ...(item.fitSignals || []).slice(0, 3),
    ],
  };
}


export default function LeadFinderView() {
  const transferring = useWorkspaceIsTransferring();
  const workspace = useWorkspaceScope();
  const leadDraft = useUIStore((s) => s.leadFinderDraft);
  const setLeadDraft = useUIStore((s) => s.setLeadFinderDraft);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const setSettingsTab = useUIStore((s) => s.setSettingsTab);
  const [product, setProduct] = useWorkspaceState("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:product", () => leadDraft?.product ?? "");
  const [market, setMarket] = useWorkspaceState("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:market", () => leadDraft?.market ?? "");
  const [buyerType, setBuyerType] = useWorkspaceState("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:buyerType", () => leadDraft?.buyerType ?? "");
  const [query, setQuery] = useWorkspaceState("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:query", () => leadDraft?.query ?? "");
  const [leadContextFiles, setLeadContextFiles] = useWorkspaceState<File[]>("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:leadContextFiles", []);
  const [leadContextMessages, setLeadContextMessages] = useWorkspaceState<Array<{ id: string; title: string }>>("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:leadContextMessages", []);
  const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useWorkspaceState<string[]>("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:selectedKnowledgeIds", []);
  const [leadContextBusy, setLeadContextBusy] = useWorkspaceState("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:leadContextBusy", false);
  const leadFileInputRef = useRef<HTMLInputElement>(null);
  const [results, setResults] = useWorkspaceState<LeadCandidate[]>("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:results", []);
  const [searchSessions, setSearchSessions] = useWorkspaceState<LeadSearchSession[]>("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:searchSessions", () => readSearchSessions());
  const [activeSessionId, setActiveSessionId] = useWorkspaceState<string | null>("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:activeSessionId", null);
  const activeSessionIdRef = useRef(activeSessionId);
  const resultsSectionRef = useRef<HTMLElement>(null);
  activeSessionIdRef.current = activeSessionId;
  const currentDiscoveryReport=searchSessions.find(session=>session.id===activeSessionId)?.discoveryReport;
  // 为什么这批结果少：后端一直统计着排除原因，之前没接到界面上。
  const reviewIssueSummary=describeReviewIssues(currentDiscoveryReport||{});
  const [searchPage, setSearchPage] = useWorkspaceState("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:searchPage", 0);
  const [resultPage, setResultPage] = useWorkspaceState("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:resultPage", 1);
  const [signalOrder,setSignalOrder]=useWorkspaceState("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:signalOrder", true);
  const [savedLeads, setSavedLeads] = useWorkspaceState<LeadCandidate[]>("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:savedLeads", () => readSavedLeads());
  const [selectedLeadKeys, setSelectedLeadKeys] = useWorkspaceState<Set<string>>("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:selectedLeadKeys", new Set());
  const [showSaved, setShowSaved] = useWorkspaceState("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:showSaved", false);
  const [filterText, setFilterText] = useWorkspaceState("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:filterText", "");
  const [tagText, setTagText] = useWorkspaceState("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:tagText", "");
  // 打开旧会话时恢复的"当时搜索所用资料"备注（只读提示，避免用户误以为文件丢了）
  const [restoredContextNote, setRestoredContextNote] = useWorkspaceState("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:restoredContextNote", "");
  // 生成开发信：邮箱勾选弹窗（点"生成开发信"先弹出复选框，用户勾选后再生成）
  const [outreachPicker, setOutreachPicker] = useWorkspaceState<{
    candidate: LeadCandidate;
    index: number;
    checked: Set<string>;
    // 生成模式：individual=每个邮箱独立个性化；unified=所有邮箱统一内容（分别单独发送）
    mode: "individual" | "unified";
    // 是否注入用户写作风格档案（true=用我的风格；false=系统默认开发信风格）
    useStyle: boolean;
    // 用户补充的调整指令（可选），随生成传给 AI
    instruction: string;
  } | null>("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:outreachPicker", null);
  const [showDevRecords, setShowDevRecords] = useWorkspaceState("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:showDevRecords", false);
  const { records: devRecords, append: appendDevRecord, remove: removeDevRecord } = useLeadDevRecords();
  const findTask = useBackgroundTasksStore((state) => state.tasks.leadFinder);
  const startTask = useBackgroundTasksStore((state) => state.start);
  const clearTask = useBackgroundTasksStore((state) => state.clear);
  const busy = findTask?.status === "running";
  const taskProgress = useLeadTaskProgress(state => state.active);
  const leadContextQueue = useUIStore((state) => state.leadContextQueue);
  const leadContextAttachmentQueue = useUIStore((state) => state.leadContextAttachmentQueue);
  const clearLeadContextQueue = useUIStore((state) => state.clearLeadContextQueue);
  const knowledgeContextQueue = useUIStore((state) => state.knowledgeContextQueue);
  const clearKnowledgeContextQueue = useUIStore((state) => state.clearKnowledgeContextQueue);
  const activeAccountId = useMailStore((state) => state.activeAccountId);
  const { data: mailAccounts = [] } = useAccountsQuery();
  const [autoDevSendAccountId, setAutoDevSendAccountId] = useWorkspaceState("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:autoDevSendAccountId", "");
  const restoredWorkspace = useWorkspaceRestored('src/features/lead-finder/LeadFinderView.tsx:');
  const persistenceReady = useRef(restoredWorkspace);
  const [historyLoaded, setHistoryLoaded] = useWorkspaceState("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:historyLoaded", false);
  const enrichingLeadKeysRef = useRef(new Set<string>());
  const contactQueueRef = useRef(new LeadContactQueue(3));

  useEffect(() => {
    if (restoredWorkspace) return;
    void loadLeadFinderData().then((stored) => {
      const localSessions = readSearchSessions();
      const localLeads = readSavedLeads();
      const sessions = ((stored ? stored.searchSessions : localSessions) as LeadSearchSession[]).map(normalizeSearchSession);
      const leads = ((stored ? stored.savedLeads : localLeads) as LeadCandidate[]).map((item) => cleanLeadCandidate(item));
      // 复位僵尸邮箱状态：上次会话中途离开/崩溃留下的 "running" 全部转为 "pending"，
      // 避免打开页面后永远显示"正在查找邮箱…"却无人真正在查。
      const revivedSessions = sessions.map((session) => ({
        ...session,
        results: (session.results || []).map((item) => item.emailDiscoveryStatus === "running" ? { ...item, emailDiscoveryStatus: "pending" as const } : item),
      }));
      setSearchSessions(revivedSessions.slice(0, 30));
      setSavedLeads(leads);
      persistenceReady.current = true;
      setHistoryLoaded(true);
      if (!stored && (sessions.length || leads.length)) void saveLeadFinderData({ searchSessions: revivedSessions.slice(0, 30), savedLeads: leads });
    }).catch(() => { persistenceReady.current = true; setHistoryLoaded(true); });
  }, []);

  useEffect(() => {
    if (leadContextQueue.length === 0) return;
    setLeadContextMessages((current) => {
      const next = [...current];
      for (const item of leadContextQueue) {
        if (!next.some((message) => message.id === item.messageId)) next.push({ id: item.messageId, title: item.title });
      }
      return next;
    });
    clearLeadContextQueue();
  }, [leadContextQueue, clearLeadContextQueue]);

  useEffect(() => {
    if (leadContextAttachmentQueue.length === 0) return;
    clearLeadContextQueue();
    for (const item of leadContextAttachmentQueue) {
      void readAttachmentFile(item.attachmentId).then((attachment) => {
        addLeadContextFiles([new File([new Uint8Array(attachment.bytes)], attachment.name, { type: attachment.mime_type || "" })]);
      }).catch(() => useToastStore.getState().addToast({ message: "读取发送到开发客户的附件失败", type: "error" }));
    }
  }, [leadContextAttachmentQueue, clearLeadContextQueue]);
  useEffect(() => {
    const pending = knowledgeContextQueue.filter((item) => item.target === "leadFinder").map((item) => item.itemId);
    if (pending.length === 0) return;
    setSelectedKnowledgeIds((current) => [...new Set([...current, ...pending])]);
    clearKnowledgeContextQueue();
  }, [knowledgeContextQueue, clearKnowledgeContextQueue]);

  function addLeadContextFiles(files: FileList | File[]) {
    const all = Array.from(files);
    const next = all.filter((file) => file.size <= 20 * 1024 * 1024 && !leadContextFiles.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified));
    if (next.length > 0) setLeadContextFiles((current) => [...current, ...next].slice(0, 12));
    if (all.some((file) => file.size > 20 * 1024 * 1024)) useToastStore.getState().addToast({ message: "单个上下文文件不能超过 20 MB", type: "error" });
  }

  function resetToNewTask() {
    setProduct("");
    setMarket("");
    setBuyerType("");
    setQuery("");
    setLeadContextFiles([]);
    setLeadContextMessages([]);
    setSelectedKnowledgeIds([]);
    setRestoredContextNote("");
    setResults([]);
    setActiveSessionId(null);
    setSearchPage(0);
    setSelectedLeadKeys(new Set());
    setShowSaved(false);
    setLeadDraft({ product: "", market: "", buyerType: "", query: "" });
  }

  function handleLeadContextDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const messageId = event.dataTransfer.getData("application/x-pebble-message-id").trim();
    const attachmentId = event.dataTransfer.getData("application/x-pebble-attachment-id").trim();
    const files = Array.from(event.dataTransfer.files ?? []);
    if (messageId) {
      const title = event.dataTransfer.getData("text/plain").trim() || `邮件 ${messageId.slice(0, 8)}`;
      setLeadContextMessages((current) => current.some((item) => item.id === messageId) ? current : [...current, { id: messageId, title }]);
    }
    if (files.length > 0) addLeadContextFiles(files);
    if (attachmentId && files.length === 0) {
      setLeadContextBusy(true);
      void readAttachmentFile(attachmentId).then((attachment) => {
        addLeadContextFiles([new File([new Uint8Array(attachment.bytes)], attachment.name, { type: attachment.mime_type || "" })]);
      }).catch(() => useToastStore.getState().addToast({ message: "读取拖入附件失败", type: "error" })).finally(() => setLeadContextBusy(false));
    }
  }

  function handleLeadContextPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    addLeadContextFiles(files);
  }

  /** 生成一段可读的"本次搜索所用资料"摘要，随会话快照保存，供打开旧会话时提示。 */
  function buildLeadContextNote(): string {
    const notes: string[] = [];
    if (leadContextFiles.length > 0) notes.push(`${leadContextFiles.length} 个文件（${leadContextFiles.map((file) => file.name).join("、").slice(0, 80)}）`);
    if (leadContextMessages.length > 0) notes.push(`${leadContextMessages.length} 封参考邮件`);
    if (selectedKnowledgeIds.length > 0) notes.push(`${selectedKnowledgeIds.length} 份资料库文件`);
    return notes.join("；");
  }

  async function buildLeadContext(allowed: boolean): Promise<string> {
    if (!allowed || (leadContextFiles.length === 0 && leadContextMessages.length === 0 && selectedKnowledgeIds.length === 0)) return "";
    const parts: string[] = [];
    if (selectedKnowledgeIds.length > 0) {
      try {
        const selectedItems = (await listKnowledgeItems(activeAccountId)).filter((item) => selectedKnowledgeIds.includes(item.id));
        parts.push(...selectedItems.map((item) => `【用户选择的资料中心文件：${item.name}】\n${item.content.slice(0, 12000)}`));
      } catch { /* 资料中心不可用时不阻断搜客 */ }
    }
    if (leadContextMessages.length > 0) {
      const messages = await getMessagesBatch(leadContextMessages.map((item) => item.id));
      parts.push(messages.map((message) => `【用户选中的参考邮件】\n主题：${message.subject}\n发件人：${message.from_name || ""} <${message.from_address}>\n正文：${message.body_text.slice(0, 9000)}`).join("\n\n"));
    }
    for (const file of leadContextFiles) {
      try {
        if (file.type.startsWith("image/")) {
          parts.push(`【用户选中的图片文件：${file.name}】\n这是用户明确选择的图片文件。当前搜客请求使用文本兼容接口，不能可靠读取图片像素；请不要根据图片文件名推断产品或公司事实，提示用户补充文字说明。`);
          continue;
        }
        const text = (await extractDocumentText(file)).trim();
        if (text) parts.push(`【用户选中的文件：${file.name}】\n${text.slice(0, 12000)}`);
        else parts.push(`【用户选中的文件：${file.name}】\n文件没有可提取的文字内容，请不要猜测其中的事实。`);
      } catch {
        parts.push(`【用户选中的文件：${file.name}】\n当前版本无法提取该文件的文字内容，请不要根据文件名猜测事实。`);
      }
    }
    return parts.join("\n\n").slice(0, 36000);
  }

  useEffect(() => {
    localStorage.setItem(SAVED_LEADS_KEY, JSON.stringify(savedLeads));
    if (persistenceReady.current) void saveLeadFinderData({ searchSessions: searchSessions.slice(0, 30), savedLeads });
  }, [savedLeads, searchSessions]);

  useEffect(() => {
    localStorage.setItem(SEARCH_SESSIONS_KEY, JSON.stringify(searchSessions.slice(0, 30)));
  }, [searchSessions]);

  // 输入变更 → 同步到 store，切页回来保留
  useEffect(() => {
    setLeadDraft({ product, market, buyerType, query });
  }, [product, market, buyerType, query, setLeadDraft]);

  useEffect(() => {
    if (transferring || !historyLoaded || findTask?.status !== "success") return;
    const payload = Array.isArray(findTask.result)
      ? { sessionId: activeSessionId || "", page: searchPage, items: findTask.result as LeadCandidate[] }
      : findTask.result as LeadFinderTaskResult;
    if (!payload || !Array.isArray(payload.items)) return;
    const targetSessionId = payload.sessionId || activeSessionId;
    const taskResult = payload.items;
    const session = targetSessionId ? searchSessions.find((item) => item.id === targetSessionId) : null;
    const effectiveBrief = payload.productBrief || session?.productBrief;
    const merged = mergeLeadResults(session?.results || results, taskResult, effectiveBrief);
    if (targetSessionId === activeSessionIdRef.current) setResults(merged);
    if (targetSessionId) {
      setSearchSessions((old) => old.map((item) => item.id === targetSessionId
        ? { ...item, page: payload.page || searchPage, nativeResultRound:payload.page || searchPage, resultCount: merged.length, results: merged, productBrief: effectiveBrief, discoveryReport: payload.discoveryReport || item.discoveryReport, updatedAt: Date.now() }
        : item));
    }
    setSelectedLeadKeys(new Set());
    clearTask("leadFinder");
    void enrichFirstVisibleLeads(taskResult, targetSessionId || "", effectiveBrief);
  }, [transferring, historyLoaded, findTask, clearTask, activeSessionId, searchPage, searchSessions, results]);

  useEffect(() => {
    if (transferring || findTask?.status !== "error") return;
    useToastStore.getState().addToast({
      message: `开发客户失败：${findTask.error || "AI 没有返回结果"}`,
      type: "error",
    });
    clearTask("leadFinder");
  }, [transferring, findTask, clearTask]);

  function mergeLeadResults(existing: LeadCandidate[], incoming: LeadCandidate[], productBrief?: LeadProductBrief): LeadCandidate[] {
    const map = new Map<string, LeadCandidate>();
    for (const item of [...existing, ...incoming]) {
      const key = leadKey(item);
      if (key === "|") continue;
      map.set(key, cleanLeadCandidate(mergeContactProgress(map.get(key), item), productBrief));
    }
    // Keep established row order while contacts complete, so pagination cannot
    // jump or move a company between pages as its score changes.
    return [...map.values()];
  }

  function enrichFirstVisibleLeads(items: LeadCandidate[], sessionId: string, productBrief?: LeadProductBrief, force = false) {
    const work = () => enrichVisibleContacts(items, sessionId, productBrief, force);
    return workspace ? workspace.run(work) : work();
  }
  async function enrichVisibleContacts(items: LeadCandidate[], sessionId: string, productBrief?: LeadProductBrief, force = false) {
    // force=true 时连已标 completed 的也重试（用户手动点"重新查找"）；否则只补未完成的
    const eligible = items
      .filter((item) => item.website && shouldDiscoverContact(item,force) && !enrichingLeadKeysRef.current.has(contactJobKey(sessionId, leadKey(item))));
    for (const item of eligible) enrichingLeadKeysRef.current.add(contactJobKey(sessionId, leadKey(item)));
    for (let index = 0; index < eligible.length; index += 3) {
      const batch = eligible.slice(index, index + 3);
      const running = batch.map((item) => ({ ...item, emailDiscoveryStatus: "running" as const }));
      setResults((old) => sessionId === activeSessionIdRef.current ? mergeLeadResults(old, running, productBrief) : old);
      if (sessionId) {
        setSearchSessions((old) => old.map((session) => session.id === sessionId
          ? { ...session, results: mergeLeadResults(session.results, running, productBrief), updatedAt: Date.now() }
          : session));
      }
      const enriched = await Promise.all(batch.map((item) => contactQueueRef.current.run(async () => {
        const candidate: PublicCompanyMatch = {
          legalName: item.companyName || "",
          country: item.country || "",
          city: item.city || "",
          address: item.address || "",
          registrationStatus: "",
          lei: "",
          sourceUrl: item.sourceUrl || item.website || "",
          website: item.website || "",
          description: item.description || "",
          sourceName: item.source || "AI 模型",
          publicEmails: item.emails || [],
          recommendationReason: item.recommendationReason || item.reason,
          discoveryBasis: item.discoveryBasis || item.fitSignals,
          companyIntroduction: item.companyIntroduction || item.background,
          emailEvidence: item.emailEvidence,
          contactStatus: item.contactStatus,
        };
        try {
          const result = await enrichLeadCandidate(candidate);
          return cleanLeadCandidate({
            ...item,
            website: result.website || item.website,
            sourceUrl: result.sourceUrl || item.sourceUrl,
            websiteStatus: result.websiteStatus as LeadCandidate["websiteStatus"],
            websiteStatusReason: result.websiteStatusReason,
            country: result.country || item.country,
            city: result.city || item.city,
            address: result.address || item.address,
            description: result.description || item.description,
            emails: result.publicEmails || [],
            emailEvidence: result.emailEvidence || [],
            contacts: result.contacts || [],
            buyingSignals: result.buyingSignals || [],
            source: result.sourceName || item.source,
            recommendationReason: result.recommendationReason || item.recommendationReason,
            discoveryBasis: result.discoveryBasis?.length ? result.discoveryBasis : item.discoveryBasis,
            companyIntroduction: result.companyIntroduction || item.companyIntroduction,
            contactStatus: result.contactStatus === "可联系" ? "可联系" : "待补全",
            emailDiscoveryStatus: "completed",
          }, productBrief);
        } catch {
          return cleanLeadCandidate({ ...item, emailDiscoveryStatus: "failed" }, productBrief);
        }
      })));
      setResults((old) => sessionId === activeSessionIdRef.current ? mergeLeadResults(old, enriched, productBrief) : old);
      if (sessionId) {
        setSearchSessions((old) => old.map((session) => session.id === sessionId
          ? { ...session, results: mergeLeadResults(session.results, enriched, productBrief), updatedAt: Date.now() }
          : session));
      }
      for (const item of batch) enrichingLeadKeysRef.current.delete(contactJobKey(sessionId, leadKey(item)));
    }
  }

  function createSearchSession(): LeadSearchSession {
    const now = Date.now();
    const session: LeadSearchSession = {
      id: crypto.randomUUID(),
      accountId: activeAccountId || undefined,
      title: buildSearchSessionTitle(product, market, buyerType, query),
      summary: buildSearchSessionSummary(product, market, buyerType, query),
      product: product.trim(),
      market: market.trim(),
      buyerType: buyerType.trim(),
      query: query.trim(),
      page: 0,
      nativeResultRound: 0,
      resultCount: 0,
      results: [],
      createdAt: now,
      updatedAt: now,
    };
    setSearchSessions((old) => [session, ...old.filter((item) => item.id !== session.id)].slice(0, 30));
    setActiveSessionId(session.id);
    setSearchPage(1);
    setResults([]);
    return session;
  }

  async function run(page = 1, sessionOverride?: LeadSearchSession) {
    if (!product.trim() && !query.trim() && !market.trim()) return;
    const session = sessionOverride || (page === 1 ? createSearchSession() : searchSessions.find((item) => item.id === activeSessionId));
    const sessionResults = session?.results || results;
    const seenWebsites = sessionResults.map(item => item.website || "").filter(Boolean).slice(0, 100);
    if (!session) return;
    setActiveSessionId(session.id);
    setSearchPage(page);
    useLeadTaskProgress.getState().update(session.id,'context');
    startTask("leadFinder", page > 1 ? "继续查找客户" : "查找客户", async () => {
      try {
      const contextSnapshot = await leadTaskContext(page,session,async()=>({
        contextText:(await buildLeadContext(true)).slice(0,36000),
        contextFiles:leadContextFiles.map(file=>file.name),contextKnowledgeIds:[...selectedKnowledgeIds],contextFilesNote:buildLeadContextNote(),
      }));
      const cachedBrief = session.productBrief?.searchProduct && (page>1 || session.productBrief.version === PRODUCT_BRIEF_VERSION);
      if (!cachedBrief) useLeadTaskProgress.getState().update(session.id,'understanding');
      const productBrief = cachedBrief ? session.productBrief!
        : await createProductBrief(session.product, session.market, session.buyerType, session.query, contextSnapshot.contextText);
      if (productBrief.taskTitle || productBrief.taskSummary) {
        setSearchSessions((old) => old.map((item) => item.id === session.id ? { ...item, title: productBrief.taskTitle || item.title, summary: productBrief.taskSummary || item.summary, productBrief, ...contextSnapshot, updatedAt: Date.now() } : item));
      } else {
        setSearchSessions((old) => old.map((item) => item.id === session.id ? { ...item, ...contextSnapshot, updatedAt: Date.now() } : item));
      }
      const discoveryRequest = buildLeadDiscoveryRequest({
        product: session.product, query: session.query, market: session.market, buyerType: session.buyerType,
        brief: productBrief, websites: seenWebsites, page, batchMode:true, sessionId:session.id, scopeId:session.accountId || '',
      });
      const toRecords = (found: Array<{ company: PublicCompanyMatch; quality: LeadQuality }>) => found.map(({ company: item, quality }) => cleanLeadCandidate({
          quality,
          companyName: item.legalName, website: item.website || item.sourceUrl, sourceUrl: item.sourceUrl,
          websiteStatus: (item.websiteStatus || "待核验") as LeadCandidate["websiteStatus"],
          websiteStatusReason: item.websiteStatusReason, country: item.country, city: item.city, address: item.address, customerType: session.buyerType,
          description: item.description, reason: item.recommendationReason,
          emails: item.publicEmails, emailEvidence: item.emailEvidence, source: item.sourceName,
          recommendationReason: item.recommendationReason, discoveryBasis: item.discoveryBasis,
          companyIntroduction: item.companyIntroduction,
          contactStatus: item.contactStatus === "可联系" ? "可联系" : "待补全",
          channelSources: [item.sourceName || "公开来源"],
        }, productBrief) as unknown as Record<string, unknown>);
      discoveryRequest.pageSize=page>1 ? leadPageDeficit(session.results.length) : LEAD_PAGE_SIZE;
      const byKey = new Map<string, Record<string, unknown>>();
      const append = (items: Array<Record<string, unknown>>, discoveryReport?: LeadDiscoveryResponse["report"]) => {
        // Native messages are full snapshots. A rejected provisional company
        // must disappear, not remain in an append-only map forever.
        byKey.clear();
        for (const item of items) {
          const key = normalizeLeadPart(String(item.website || item.companyName || ""))
            || normalizeLeadPart(String((item.emails as string[] | undefined)?.[0] || ""));
          if (key) byKey.set(key, item);
        }
        const partial = [...byKey.values()] as unknown as LeadCandidate[];
        if (session.id === activeSessionIdRef.current) setResults(old => mergeLeadResults(old, partial, productBrief));
        setSearchSessions((old) => old.map((item) => item.id === session.id
          ? { ...item, page, resultCount: mergeLeadResults(item.results, partial, productBrief).length, results: mergeLeadResults(item.results, partial, productBrief), productBrief, discoveryReport: discoveryReport || item.discoveryReport, updatedAt: Date.now() }
          : item));
        // Only evidence-admitted companies are published. Keep contacting each
        // as soon as it arrives; mergeContactProgress protects late snapshots.
        void enrichFirstVisibleLeads(partial, session.id, productBrief);
      };

      useLeadTaskProgress.getState().update(session.id,'searching');
      const discovery = await discoverLeads(discoveryRequest, partial => {
        useLeadTaskProgress.getState().update(session.id,phaseForLeadReport(partial.report));
        append(toRecords(partial.items),partial.report);
      });
      useLeadTaskProgress.getState().update(session.id,'finishing');
      append(toRecords(discovery.items),discovery.report);
      const report = discovery.report;
      const next = [...byKey.values()];
      if (next.length === 0) {
        useToastStore.getState().addToast({
          message: emptyLeadResultMessage(report),
          type: page > 1 ? "info" : "error",
        });
      }
      return { sessionId: session.id, page, items: next, productBrief, discoveryReport: report } satisfies LeadFinderTaskResult;
      } catch(error) {
        const failure=String(error).includes("识别产品名称") ? "product_interpretation_failed" : "execution_failed";
        const failureDetail=describeLeadFailure(error);
        setSearchSessions(old=>old.map(item=>item.id===session.id ? {...item,failure,failureDetail,updatedAt:Date.now()} : item));
        throw new Error(failureDetail);
      } finally {
        useLeadTaskProgress.getState().finish(session.id);
      }
    }, { successMessage: result => {
      const found=(result as LeadFinderTaskResult).items.length;
      return found ? `找到 ${found} 条公司候选，请结合来源及待核实项判断。` : null;
    } });
    // “本次”授权只对这一次点击有效；下一次搜索必须重新确认。
  }

  function startNewSearch() {
    const session = createSearchSession();
    void run(1, session);
  }

  function openSearchSession(session: LeadSearchSession) {
    setActiveSessionId(session.id);
    setProduct(session.product);
    setMarket(session.market);
    setBuyerType(session.buyerType);
    setQuery(session.query);
    setSearchPage(session.page || 1);
    // 恢复该会话搜索时引用的资料库文件与上下文备注（保证后续开发信不脱离当时的资料）
    setSelectedKnowledgeIds(session.contextKnowledgeIds || []);
    setLeadContextFiles([]);
    setLeadContextMessages([]);
    setRestoredContextNote(session.contextFilesNote || "");
    setResults((session.results || []).map((item) => item.emailDiscoveryStatus === "running" ? { ...item, emailDiscoveryStatus: "pending" } : item));
    setShowSaved(false);
    setSelectedLeadKeys(new Set());
    requestAnimationFrame(() => resultsSectionRef.current?.scrollIntoView?.({ block:'start', behavior:'instant' }));
  }

  async function deleteSearchSession(id: string) {
    if (!window.confirm("删除这条搜索会话及其结果快照？已保存的线索不会被删除。")) return;
    try {await forgetLeadTask(id,searchSessions.find(s=>s.id===id)?.accountId || '');}
    catch {useToastStore.getState().addToast({message:'未能删除搜索记录，请重试。',type:'error'});return;}
    setSearchSessions((old) => old.filter((item) => item.id !== id));
    if (activeSessionId === id) {
      setActiveSessionId(null);
      setSearchPage(0);
      setResults([]);
    }
  }

  function saveLeads(items: LeadCandidate[]) {
    if (!items.length) return;
    setSavedLeads((old) => {
      const map = new Map(old.map((item) => [leadKey(item), item]));
      for (const item of items) {
        const key = leadKey(item);
        if (key === "|") continue;
        map.set(key, { ...map.get(key), ...item, leadId: map.get(key)?.leadId || crypto.randomUUID(), tags: map.get(key)?.tags || [], leadStatus: map.get(key)?.leadStatus || "new", savedAt: map.get(key)?.savedAt || Date.now() });
      }
      return [...map.values()];
    });
    useToastStore.getState().addToast({ message: `已保存 ${items.length} 个客户线索`, type: "success" });
  }

  function toggleLead(item: LeadCandidate) {
    const key = leadKey(item);
    setSelectedLeadKeys((old) => { const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }

  function deleteSavedLead(item: LeadCandidate) {
    if (!window.confirm(`删除已保存线索“${item.companyName || "未命名公司"}”？`)) return;
    const key = leadKey(item);
    setSavedLeads((old) => old.filter((lead) => leadKey(lead) !== key));
    setSelectedLeadKeys((old) => { const next = new Set(old); next.delete(key); return next; });
  }

  function deleteCurrentResult(item: LeadCandidate) {
    const key = leadKey(item);
    setResults((old) => old.filter((candidate) => leadKey(candidate) !== key));
    if (activeSessionId) {
      setSearchSessions((old) => old.map((session) => session.id === activeSessionId
        ? { ...session, results: session.results.filter((candidate) => leadKey(candidate) !== key), resultCount: session.results.filter((candidate) => leadKey(candidate) !== key).length, updatedAt: Date.now() }
        : session));
    }
  }

  function deleteSelectedSavedLeads() {
    if (!selectedLeadKeys.size) return;
    if (!window.confirm(`删除选中的 ${selectedLeadKeys.size} 条已保存线索？`)) return;
    setSavedLeads((old) => old.filter((lead) => !selectedLeadKeys.has(leadKey(lead))));
    setSelectedLeadKeys(new Set());
  }

  async function addSelectedToCustomers() {
    const selected = savedLeads.filter((item) => selectedLeadKeys.has(leadKey(item)));
    for (const item of selected) await addToCustomers(item);
    if (selected.length) setSelectedLeadKeys(new Set());
  }

  const filteredMatches = (showSaved ? savedLeads : results).filter((item) => {
    const text = [item.companyName, item.country, item.customerType, item.description, ...(item.tags || [])].join(" ").toLowerCase();
    return !filterText.trim() || text.includes(filterText.trim().toLowerCase());
  });
  const feedbackRecords=useEmailChecks(s=>s.records);
  const filteredResults=signalOrder ? orderByLeadSignals(filteredMatches,e=>feedbackRecords[emailCheckKey(e)]?.feedback?.kind) : filteredMatches;
  const deliveryPage=leadPage(filteredResults,resultPage);
  const visibleResults=deliveryPage.items;
  useWorkspaceInitEffect('src/features/lead-finder/LeadFinderView.tsx:', ()=>{setResultPage(1);},[activeSessionId,showSaved,filterText]);
  function nextResultPage() {
    if(deliveryPage.page<deliveryPage.pages) {setResultPage(deliveryPage.page+1);return;}
    if(!showSaved && activeSessionId && !busy) {
      if(filteredResults.length>0 && filteredResults.length%LEAD_PAGE_SIZE===0) setResultPage(deliveryPage.page+1);
      void run(searchPage+1);
    }
  }

  async function addToCustomers(candidate: LeadCandidate) {    const email = candidate.emails?.[0];
    if (!email) {
      useToastStore.getState().addToast({
        message: "该客户没有公开邮箱，可稍后在客户管理手动添加",
        type: "error",
      });
      return;
    }
    try {
      const saved = await saveCustomerMemory({
        email,
        name: candidate.companyName || "",
        company: candidate.companyName || "",
        summary: candidate.description?.slice(0, 90) || "",
        source: "谷歌开发",
        stage: "待开发",
        profile: [
          candidate.description && `业务简介：${candidate.description}`,
          candidate.reason && `推荐理由：${candidate.reason}`,
          candidate.website && `官网：${candidate.website}`,
          candidate.source && `线索来源：${candidate.source}`,
          candidate.customerType && `客户类型：${candidate.customerType}`,
        ].filter(Boolean).join("\n"),
      });
      useUIStore.getState().setCustomerProfileEmail(saved.email);
      appendDevRecord({
        email: saved.email,
        companyName: candidate.companyName || saved.email,
        action: "加入客户管理",
        note: candidate.reason?.slice(0, 80),
      });
      useToastStore.getState().addToast({
        message: "已加入客户管理，可在客户管理中继续跟进",
        type: "success",
      });
    } catch (err) {
      useToastStore.getState().addToast({
        message: `加入客户管理失败：${String(err)}`,
        type: "error",
      });
    }
  }

  // 点击"生成开发信"：先弹出邮箱勾选弹窗，用户确认后再逐邮箱生成。
  function openOutreachPicker(candidate: LeadCandidate, index: number) {
    const emails = (candidate.emails ?? []).filter(isUsableLeadEmail);
    if (emails.length === 0) {
      useToastStore.getState().addToast({ message: "该客户没有公开邮箱，无法生成开发信", type: "error" });
      return;
    }
    // 明确属于人事/招聘/媒体/法务的地址默认不勾选，避免开发信发错部门。
    const recommended = emails.filter((email) => {
      const evidence = candidate.emailEvidence?.find((entry) => entry.email === email);
      return !evidence?.suitability?.startsWith("不建议开发");
    });
    setOutreachPicker({ candidate, index, checked: new Set(recommended), mode: "individual", useStyle: true, instruction: "" });
  }

  /**
   * 为单个客户+邮箱生成一封开发信（公共逻辑：手动生成与自动开发共用）。
   * 返回 { subject, body }，主题**不带序号**（序号是群发垃圾邮件的典型特征，
   * 收件人会看到，统一去掉）。
   */
  async function resolveAutoSignature(accountId: string): Promise<string> {
    const configured = plainTextSignature(await getSignature(accountId).catch(() => ""));
    if (configured) return configured;
    const samples = await getSentSamples(10, accountId).catch(() => []);
    const learned = signatureFromSentBodies(samples.map((sample) => sample.body));
    if (learned) return learned;
    const account = mailAccounts.find((item) => item.id === accountId);
    return account?.display_name?.trim() || account?.email?.split("@")[0] || "";
  }

  async function generateOutreachContent(candidate: LeadCandidate, email: string, useStyle: boolean, signatureAccountId?: string, adjustmentInstruction = "", recentDrafts: string[] = [], contextOverride = ""): Promise<OutreachContent> {
    await checkResearchContactAllowed(email);
    // 生成前收集产品资料上下文：
    // 1. 优先带"本次搜索会话"保存的快照（保证不脱离当时搜索用的资料，切页/重启后依然有效）；
    // 2. 再追加当前输入框里实时拖入/勾选的补充资料（两者合并，取前 36000 字符）。
    const liveContext = await buildLeadContext(true).catch(() => "");
    const snapshotContext = contextOverride || searchSessions.find((item) => item.id === activeSessionId)?.contextText || "";
    const leadContext = [snapshotContext, liveContext].filter(Boolean).join("\n\n").slice(0, 36000);
    // 读取用户写作风格档案（默认/激活），开发信同样遵循用户风格；用户可选择不用
    let styleProfile = "";
    if (useStyle) {
      try {
        const profiles = await listStyleProfiles();
        styleProfile = profiles.find((p) => p.isActive)?.profile ?? "";
      } catch { /* 风格档案不可用时不阻断 */ }
    }
    // 该邮箱的线索来源证据（用于个性化开头：在哪个渠道/场景发现这个地址）
    const evidence = candidate.emailEvidence?.find((ev) => ev.email === email);
    const adjustment = normalizeOutreachAdjustment(adjustmentInstruction);
    const strategy = chooseOutreachStrategy(candidate, email, leadContext);
    const system = `你是一位资深外贸 B2B 开发信撰写专家，精通针对特定公司的冷邮件（cold outreach）策略。请严格遵循 2026 年经数据验证的高回复率写法：
0. 【优先级】用户在“调整指令”中明确写出的要求或禁令优先于写作风格档案和默认策略。不得忽略“不问联系人/邮箱”“不要某种说法”等否定指令，保持真实性和安全限制。
1. ${adjustment.lengthRule}。用户对长短的要求优先于默认长度。根据内容自然使用 3-4 个核心句子、2-4 个短段落，不得机械套用固定三段式或固定“观察→痛点→产品→问题”顺序；纯文本风格（不要 HTML 格式）。
2. 主题行控制在 1-4 个词，使用客户自己的品类/经营语境，具体、口语化、像真人随手写的；不要固定套用 quick question，不要问句、数字、夸张词、营销词或感叹号。
3. 本封采用【${strategy.title}】：${strategy.instruction}
4. 个性化必须贯穿联系理由、价值角度和 CTA，而不只是第一句替换公司名。使用客户经营品类、网站措辞或可核实动作，说明“为什么是这家公司、为什么这项产品相关”。只使用下方已有事实；合理推断必须用 may/might/possibly/看起来可能 等审慎措辞。严禁编造“many wholesalers tell us / 很多客户都说”、虚构案例、利润、市场需求、参数、客户痛点或社会证明。
5. 全文只围绕一个角度。CTA 只放一个低门槛动作，优先提供具体价值（例如 4-6 张适配产品图片、一页选品单、真实案例或报价范围），让对方容易回复“可以/感兴趣”。不要把寻找联系人这项工作推给收件人；绝不要直接索要会议、demo 或电话。
6. 语气专业但不生硬，使用客户能理解的普通语言。不要堆产品功能、公司历史、ROI 承诺、行业黑话或模板腔；不要用 "I am writing to"、"just wanted to"、"hope you're well" 等陈词滥调。
7. 只输出严格 JSON 对象：{"subject":"主题","body":"正文"}。body 必须只含收件人真正会看到的开发信，不得输出分析、思路、标签、检查清单、Markdown 标题或代码块。
8. ${writingLanguageInstruction("auto")} 新客户可参考有证据的官网语言或已有沟通语言。
9. 【硬性要求格式】使用常规邮件格式：称呼必须单独占第一段，称呼后空一行；正文每个短段落之间空一行；落款与姓名分行。段落数量由内容决定，不得为了凑结构重复信息。
10. 【硬性要求破折号】避免过度使用破折号（—/--），同一封邮件中最多出现一次；多用句号和逗号自然断句。
11. 不要自行生成落款或签名，程序会在正文后附加用户的真实签名。
${contactRequestConstraintPrompt(adjustment.userConstraints)}
${styleProfile ? `【我的写作风格档案】（在不违反用户本次调整指令、真实性和格式硬规则的前提下遵守）\n${styleProfile}` : ""}`;
    const user = [
      `我的产品：${product || "（未填写，请用通用措辞）"}`,
      `目标市场：${market || "（未填写）"}`,
      leadContext ? `【产品资料】以下是用户提供的产品说明/资料库文件/参考邮件（用于准确介绍产品，严禁编造资料里没有的规格）：\n${leadContext.slice(0, 12000)}` : "",
      `客户公司：${candidate.companyName || ""}`,
      `客户所在国家：${candidate.country || ""}`,
      candidate.customerType && `客户类型：${candidate.customerType}`,
      candidate.description && `客户简介：${candidate.description}`,
      candidate.background && `客户背景：${candidate.background}`,
      candidate.products && `客户主营产品：${candidate.products}`,
      candidate.fitSummary && `与我司产品匹配点：${candidate.fitSummary}`,
      (candidate.fitSignals && candidate.fitSignals.length > 0) && `匹配信号：${candidate.fitSignals.join("；")}`,
      candidate.reason && `入选原因：${candidate.reason}`,
      candidate.contactRoles && candidate.contactRoles.length > 0 && `目标联系人角色：${candidate.contactRoles.join("、")}`,
      `本封收件邮箱：${email}${evidence?.person ? `（该邮箱对应的人：${evidence.person}，可在称呼处个性化）` : ""}${evidence ? `（该邮箱来自 ${evidence.source}${evidence.sourceUrl ? `，${evidence.sourceUrl}` : ""}）` : ""}`,
      `【本封写作决策】${strategy.title}；原因：${strategy.reason}；证据强度：${strategy.evidenceLevel}`,
      strategy.evidenceUsed.length > 0 && `【允许使用的客户依据】${strategy.evidenceUsed.join("；")}`,
      strategy.warnings.length > 0 && `【事实风险提示】${strategy.warnings.join("；")}`,
      adjustment.instruction && `【用户对本批开发信的调整要求】${adjustment.instruction}。这是硬性要求，在不违反真实性和纯正文要求的前提下优先执行。`,
    ].filter(Boolean).join("\n");

    let draft = parseOutreachDraft(await aiPrompt(system, user));
    if (outreachDraftTooLong(draft.body, adjustment)) {
      const compactSystem = `你是开发信压缩编辑。把已有开发信改到指定长度以内，同时保留具体客户钩子、产品价值和一个低门槛 CTA。${adjustment.lengthRule}。不得添加不存在的事实，不得改变邮件语言，不得添加签名。只输出严格 JSON：{"subject":"主题","body":"正文"}。正文段落之间空一行。`;
      const compactUser = [
        adjustment.instruction && `用户原始要求：${adjustment.instruction}`,
        `待压缩邮件：${JSON.stringify(draft)}`,
      ].filter(Boolean).join("\n");
      draft = parseOutreachDraft(await aiPrompt(compactSystem, compactUser));
    }
    draft = applyOutreachTextConstraints(draft, adjustment);
    if (recentDrafts.some((previous) => outreachSimilarity(previous, draft.body) >= 0.58)) {
      const diversifySystem = `你是开发信差异化编辑。保持客户事实、${strategy.title}及单一核心价值不变，但明显改变开场方式、信息顺序、句式和段落数量，避免批量模板痕迹。${adjustment.lengthRule}。只保留一个低门槛 CTA，不得虚构事实，不得添加签名。只输出严格 JSON：{"subject":"主题","body":"正文"}。`;
      const diversifyUser = [
        `当前邮件：${JSON.stringify(draft)}`,
        `需要避开的近期邮件表达：${recentDrafts.slice(-3).map((body) => body.slice(0, 500)).join("\n---\n")}`,
      ].join("\n");
      draft = applyOutreachTextConstraints(parseOutreachDraft(await aiPrompt(diversifySystem, diversifyUser)), adjustment);
    }
    if (violatesOutreachUserConstraints(draft.body, adjustment.userConstraints)) {
      const repairSystem = `你是开发信合规编辑。首封开发信禁止询问或索要邮箱、联系人、负责人、采购、买手或经理，也禁止请求转发/转交。删除所有 who handles、right person、could you direct/point me 等转介表达，改成直接提供一份具体且低成本的价值内容。保持原有事实和语言，不得添加签名。称呼单独一段且后面空一行，正文短段落之间空一行。只输出严格 JSON：{"subject":"主题","body":"正文"}。`;
      const repaired = await aiPrompt(repairSystem, `用户指令：${adjustment.instruction}\n待修复邮件：${JSON.stringify(draft)}`);
      draft = applyOutreachTextConstraints(parseOutreachDraft(repaired), adjustment);
      if (violatesOutreachUserConstraints(draft.body, adjustment.userConstraints)) {
        throw new Error("生成内容仍违反了“不询问邮箱/联系人”的明确要求，已拦截发送");
      }
    }
    const signature = signatureAccountId ? await resolveAutoSignature(signatureAccountId) : "";
    return {
      subject: draft.subject,
      body: normalizeOutreachEmailFormat(signature ? `${draft.body}\n\n${signature}` : draft.body),
      strategy,
    };
  }

  async function writeOutreach(candidate: LeadCandidate, selectedEmails: string[], mode: "individual" | "unified" = "individual", useStyle = true, instruction = "") {
    // 防御性清洗：剥掉 mailto: 前缀（旧数据/部分渠道可能残留），否则发送会失败
    const emails = selectedEmails
      .map((e) => e.trim().replace(/^mailto:/i, ""))
      .filter(Boolean);
    if (emails.length === 0) {
      useToastStore.getState().addToast({ message: "请至少勾选一个邮箱", type: "error" });
      return;
    }
    try {
      // individual：每个邮箱独立生成一封（内容按角色/来源个性化）；
      // unified：只生成一封统一内容，其余邮箱复用同一 subject/body（仍分别单独发送，收件人互不可见）。
      // 主题统一不带序号（序号是群发特征，收件人会看到）。
      // 预取本次搜索会话的快照上下文：手动生成同样不脱离当时搜索用的资料。
      const snapshotOverride = searchSessions.find((item) => item.id === activeSessionId)?.contextText || "";
      let generated = 0;
      let unifiedSubject = "";
      let unifiedBody = "";
      for (let i = 0; i < emails.length; i++) {
        const email = emails[i];
        let subject = "";
        let body = "";
        if (mode === "unified" && i > 0 && unifiedBody) {
          // 统一模式：复用第一封生成的内容（subject/body），只换收件人
          subject = unifiedSubject;
          body = unifiedBody;
        } else {
          const content = await generateOutreachContent(candidate, email, useStyle, undefined, instruction, [], snapshotOverride);
          subject = content.subject;
          body = content.body;
          if (mode === "unified") {
            unifiedSubject = subject;
            unifiedBody = body;
          }
        }

        // 每封在主窗口打开一个独立的写信标签（可同时多封，逐封检查后发送）。
        useComposeStore.getState().openCompose("new", null, {
          to: [email],
          subject,
          body,
        });
        generated += 1;
      }
      useToastStore.getState().addToast({
        message: emails.length > 1
          ? `已为 ${generated} 个邮箱各打开一个写信标签，可逐封检查后发送`
          : "开发信已生成，可在写信标签中检查修改后发送",
        type: "success",
      });
    } catch (err) {
      useToastStore.getState().addToast({ message: `开发信生成失败：${String(err)}`, type: "error" });
    }
  }

  // ─── 自动开发：Zustand 全局队列，切换页面后任务与控制状态仍保留 ───
  const autoDev = useAutoDevStore();
  const [autoDevConfirmOpen, setAutoDevConfirmOpen] = useWorkspaceState("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:autoDevConfirmOpen", false);
  const [autoDevPreview, setAutoDevPreview] = useWorkspaceState<(OutreachContent & { candidate: LeadCandidate; email: string }) | null>("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:autoDevPreview", null);
  const [autoDevPreviewBusy, setAutoDevPreviewBusy] = useWorkspaceState("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:autoDevPreviewBusy", false);
  const [autoDevInstruction, setAutoDevInstruction] = useWorkspaceState("src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:autoDevInstruction", "");

  useEffect(() => {
    if (!autoDevConfirmOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAutoDevConfirmOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [autoDevConfirmOpen]);

  useEffect(() => {
    if (autoDev.running) return;
    setAutoDevSendAccountId((current) => {
      if (mailAccounts.some((account) => account.id === current)) return current;
      if (activeAccountId && mailAccounts.some((account) => account.id === activeAccountId)) {
        return activeAccountId;
      }
      return mailAccounts[0]?.id ?? "";
    });
  }, [activeAccountId, mailAccounts, autoDev.running]);

  function firstAutoDevTarget() {
    for (const candidate of visibleResults) {
      const emails = (candidate.emails ?? []).filter(isUsableLeadEmail);
      const email = emails.find((value) => !candidate.emailEvidence?.find((entry) => entry.email === value)?.suitability?.startsWith("不建议开发")) ?? emails[0];
      if (email) return { candidate, email };
    }
    return null;
  }

  async function generateAutoDevPreview() {
    const target = firstAutoDevTarget();
    if (!target || !autoDevSendAccountId) return;
    setAutoDevPreviewBusy(true);
    try {
      // 预取本次搜索会话的快照上下文，保证自动开发不脱离当时搜索用的资料
      const snapshotOverride = searchSessions.find((item) => item.id === activeSessionId)?.contextText || "";
      const content = await generateOutreachContent(target.candidate, target.email, autoDev.useStyle, autoDevSendAccountId, autoDevInstruction, [], snapshotOverride);
      setAutoDevPreview({ ...target, ...content });
    } catch (error) {
      useToastStore.getState().addToast({ message: `预览生成失败：${String(error)}`, type: "error" });
    } finally {
      setAutoDevPreviewBusy(false);
    }
  }

  async function runAutoDev() {
    const useStyle = autoDev.useStyle;
    const startTime = autoDev.startTime;
    const endTime = autoDev.endTime;
    const sendAccountId = autoDevSendAccountId;
    if (!sendAccountId || !mailAccounts.some((account) => account.id === sendAccountId)) {
      useToastStore.getState().addToast({ message: "请选择用于自动开发的发件账号", type: "error" });
      return;
    }
    if (visibleResults.length === 0) {
      useToastStore.getState().addToast({ message: "当前没有可开发的客户结果", type: "error" });
      return;
    }
    if (!autoDevPreview) {
      useToastStore.getState().addToast({ message: "请先生成并检查第一封开发信预览", type: "error" });
      return;
    }
    const candidates = [...visibleResults];
    // 预取本次搜索会话的快照上下文：自动开发循环可能持续很久，提前固定住当时的资料，
    // 即使运行期间用户切换会话/页面，开发信依然基于最初搜索时的资料生成。
    const snapshotOverride = searchSessions.find((item) => item.id === activeSessionId)?.contextText || "";
    const queue = candidates.flatMap((candidate) => {
      const emails = (candidate.emails ?? []).filter(isUsableLeadEmail).filter((email) => {
        const evidence = candidate.emailEvidence?.find((entry) => entry.email === email);
        return !evidence?.suitability?.startsWith("不建议开发");
      });
      return emails.length > 0 ? emails.map((email) => ({ candidate, email })) : [{ candidate, email: "" }];
    });
    const report: AutoDevReportItem[] = [];
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let doneTotal = 0;
    const recentDrafts: string[] = [];
    useAutoDevStore.getState().begin({ useStyle, startTime, endTime, autoNext: false, sendAccountId, total: queue.length, current: "准备中…" });
    setAutoDevConfirmOpen(false);
    const patch = (done: number, current: string) => {
      useAutoDevStore.getState().updateProgress({ done, current, sent, failed, skipped, report: [...report] });
    };

    // 等待设定的开始时间（可随时终止）
    if (startTime && Date.now() < startTime) {
      patch(0, "等待设定的开始时间…");
      if (await waitForAutoDevControl(startTime - Date.now()) === "stop") {
        useAutoDevStore.getState().finish({ current: "已停止（未开始发送）", report, sent, failed, skipped });
        return;
      }
    }

    let cancelledByEndTime = false;
    const addedCompanies = new Set<string>();
    for (let i = 0; i < queue.length; i++) {
        if (await waitForAutoDevControl() === "stop") break;
        if (endTime && Date.now() >= endTime) {
          cancelledByEndTime = true;
          break;
        }
        const { candidate, email: target } = queue[i];
        const company = candidate.companyName || `客户${i + 1}`;
        patch(doneTotal, target ? `${company} · ${target}` : company);
        if (!target) {
          skipped += 1;
          report.push({ company, email: "（无可用邮箱）", status: "skipped", error: "没有未被明确排除的有效邮箱", timestamp: Date.now() });
          doneTotal += 1;
          patch(doneTotal, company);
          continue;
        }
        const evidence = candidate.emailEvidence?.find((entry) => entry.email === target);
        try {
          const content = autoDevPreview.email === target && leadKey(autoDevPreview.candidate) === leadKey(candidate)
            ? { subject: autoDevPreview.subject, body: autoDevPreview.body, strategy: autoDevPreview.strategy }
            : await generateOutreachContent(candidate, target, useStyle, sendAccountId, autoDevInstruction, recentDrafts, snapshotOverride);
          recentDrafts.push(content.body);
          if (recentDrafts.length > 5) recentDrafts.shift();
          // Freeze the chosen account for the whole run. Sidebar account
          // changes must never redirect a running campaign mid-queue.
          await checkResearchContactAllowed(target);
          const result = await sendEmail(sendAccountId, [target], [], [], content.subject, content.body);
          if (result.status !== "sent") throw new Error(result.warning || "发送未完成，邮件保留在发件箱，自动重试已暂停");
          if (result.warning) useToastStore.getState().addToast({ type: "error", duration: 0, message: result.warning });
          sent += 1;
          report.push({ company, email: target, person: evidence?.person, status: "sent", subject: content.subject, timestamp: Date.now() });
          appendDevRecord({ email: target, companyName: company, action: "自动开发已提交", note: `主题：${content.subject}` });
          const companyKey = leadKey(candidate);
          if (!addedCompanies.has(companyKey)) {
            addedCompanies.add(companyKey);
            void saveCustomerMemory({
              email: target,
              name: company,
              company,
              summary: candidate.description?.slice(0, 90) || "自动开发客户",
              source: "AI 开发客户",
              stage: "已开发",
              profile: [`最近开发：${new Date().toLocaleString()}`, `收件邮箱：${target}`, `邮件主题：${content.subject}`, candidate.website && `官网：${candidate.website}`, candidate.description && `业务简介：${candidate.description}`].filter(Boolean).join("\n"),
            }).catch(() => undefined);
          }
        } catch (err) {
          failed += 1;
          report.push({ company, email: target, person: evidence?.person, status: "failed", error: String(err), timestamp: Date.now() });
          appendDevRecord({ email: target, companyName: company, action: "自动开发发送失败", note: String(err).slice(0, 160) });
        }
        doneTotal += 1;
        patch(doneTotal, company);

        // 随机间隔 60-180 秒（像真人，规避群发特征）；最后一封或即将到结束时间时不再等待
        if (i < queue.length - 1 && !(endTime && Date.now() >= endTime)) {
          const delay = 60000 + Math.random() * 120000;
          if (await waitForAutoDevControl(delay) === "stop") break;
        }
    }

    const stopped = useAutoDevStore.getState().stopRequested;
    useAutoDevStore.getState().finish({ current: stopped ? "已停止" : (cancelledByEndTime ? "已到设定的结束时间" : "已完成"), report, sent, failed, skipped });
  }

  function stopAutoDev() {
    useAutoDevStore.getState().requestStop();
  }

  function leadContactSummary(candidate: LeadCandidate): { count: number; lastAt: number } | null {
    const emails = new Set((candidate.emails ?? []).map((email) => email.toLowerCase()));
    const sentRecords = devRecords.filter((record) => emails.has(record.email.toLowerCase()) && record.action === "自动开发已提交");
    if (sentRecords.length === 0) return null;
    return { count: sentRecords.length, lastAt: Math.max(...sentRecords.map((record) => record.timestamp)) };
  }

  return (
    <div className="scroll-region" style={{ height: "100%", overflow: "auto", padding: "24px 28px" }}>
      <div style={{ maxWidth: 1020, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap:12, flexWrap:'wrap', marginBottom: 4 }}>
          <h1 style={{ margin: 0, fontSize: 22 }}>开发客户</h1>
          <div style={{ display: "flex", gap: 8, flexWrap:'wrap' }}>
          <LeadTaskHistory tasks={searchSessions} activeId={activeSessionId} onSelect={openSearchSession} onDelete={id=>void deleteSearchSession(id)} />
          <button type="button" onClick={() => { setSettingsTab("externalServices"); setActiveView("settings"); }} style={{ ...secondaryButton, marginTop: 0 }}>
            <Settings2 size={13} />搜索服务设置
          </button>
          <button type="button" onClick={resetToNewTask} style={{ ...secondaryButton, marginTop: 0, display: "inline-flex", alignItems: "center", gap: 5 }}>
            <Plus size={13} />新建任务
          </button>
          <button
            type="button"
            onClick={() => setShowDevRecords((v) => !v)}
            style={{
              padding: "5px 12px",
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              background: showDevRecords ? "color-mix(in srgb, var(--color-accent) 12%, transparent)" : "transparent",
              color: showDevRecords ? "var(--color-accent)" : "var(--color-text-primary)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Users size={13} />
            开发记录（{devRecords.length}）
          </button>
          </div>
        </div>
        <p style={{ ...hint, margin: "6px 0 14px" }}>提供公司介绍、匹配情况、公开邮箱及联系建议。支持中文、English 和混合产品词。</p>
        <LeadSearchStatus phase={busy ? taskProgress?.phase || 'searching' : undefined}
          contactsRunning={showSaved ? 0 : results.filter(item=>item.emailDiscoveryStatus==='running').length}
          background={busy && !!taskProgress && taskProgress.sessionId!==activeSessionId}
          onShowTask={()=>{const session=searchSessions.find(s=>s.id===taskProgress?.sessionId);if(session)openSearchSession(session);}} />
        {showDevRecords && (
          <section style={card}>
            <h2 style={title}><Users size={16} />开发记录（最近 50 条）</h2>
            {devRecords.length === 0 ? (
              <p style={hint}>还没有开发记录。把候选客户「加入客户管理」会自动写一条到这里；点击右侧垃圾桶可删除单条。</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {devRecords.slice(0, 50).map((rec) => (
                  <div
                    key={rec.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px",
                      border: "1px solid var(--color-border)",
                      borderRadius: 6,
                      background: "var(--color-bg-secondary)",
                      fontSize: 12,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <strong>{rec.companyName || rec.email}</strong>
                        <span style={{ color: "var(--color-text-secondary)", marginLeft: 6 }}>{rec.action}</span>
                      </div>
                      <div style={{ color: "var(--color-text-secondary)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {new Date(rec.timestamp).toLocaleString()} · {rec.email}
                        {rec.note ? ` · ${rec.note}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeDevRecord(rec.id)}
                      title="删除这条开发记录"
                      aria-label="删除记录"
                      style={{ background: "transparent", border: 0, color: "var(--color-text-secondary)", cursor: "pointer", padding: 4 }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
        <section style={card}>
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 9, marginBottom: 10 }}>
            <input style={input} value={product} onChange={(e) => setProduct(e.target.value)} placeholder="产品或服务（支持中文 / English，可选）" />
            <input style={input} value={market} onChange={(e) => setMarket(e.target.value)} placeholder="目标市场（可选）" />
            <select style={input} value={buyerType} onChange={(e) => setBuyerType(e.target.value)}>
              <option value="">不限（所有客户类型）</option>
              <option value="distributor">经销商 / 批发商</option>
              <option value="importer">进口商</option>
              <option value="retailer">零售商</option>
              <option value="contractor">工程商 / 承包商</option>
              <option value="brand">品牌商</option>
            </select>
          </div>
          <div style={{ marginBottom: 8 }}><KnowledgePicker accountId={activeAccountId} selectedIds={selectedKnowledgeIds} onChange={setSelectedKnowledgeIds} label="引用产品资料（可选）" /></div>
          {restoredContextNote && (
            <div style={{ marginBottom: 8, padding: "6px 9px", borderRadius: 6, border: "1px solid color-mix(in srgb, var(--color-accent) 30%, var(--color-border))", background: "color-mix(in srgb, var(--color-accent) 6%, transparent)", fontSize: 11.5, color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: 6 }}>
              <Paperclip size={12} />
              <span>该会话搜索时使用过：{restoredContextNote}。生成开发信时会自动继承，无需重新上传。</span>
              <button type="button" onClick={() => setRestoredContextNote("")} style={{ marginLeft: "auto", background: "transparent", border: 0, color: "var(--color-text-secondary)", cursor: "pointer", padding: 2 }} aria-label="关闭提示" title="关闭提示">✕</button>
            </div>
          )}
          <div style={leadComposer} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }} onDrop={handleLeadContextDrop}>
            {(leadContextFiles.length > 0 || leadContextMessages.length > 0) && <div style={leadAttachedRow}>
              {leadContextMessages.map((item) => <button key={item.id} type="button" onClick={() => setLeadContextMessages((current) => current.filter((x) => x.id !== item.id))} style={leadAttachedChip} title="点击移除邮件"><Mail size={12} />{item.title}<span>×</span></button>)}
              {leadContextFiles.map((file) => <button key={`${file.name}-${file.size}-${file.lastModified}`} type="button" onClick={() => setLeadContextFiles((current) => current.filter((x) => x !== file))} style={leadAttachedChip} title="点击移除文件"><Paperclip size={12} />{file.name}<span>×</span></button>)}
            </div>}
            <textarea
              style={leadTextarea}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onInput={(e) => resizeAutoGrowTextarea(e.currentTarget, 300)}
              onPaste={handleLeadContextPaste}
              placeholder="描述产品、目标市场、理想客户和排除条件；也可以拖入邮件、附件、文件，或直接粘贴图片和文件"
              rows={4}
            />
            <input ref={leadFileInputRef} type="file" multiple hidden onChange={(event) => { if (event.target.files) addLeadContextFiles(event.target.files); event.currentTarget.value = ""; }} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexBasis: "100%" }}>
              <button type="button" onClick={() => leadFileInputRef.current?.click()} disabled={busy} style={leadFileButton}>{leadContextBusy ? <RefreshCw size={14} className="spinner" /> : <Paperclip size={14} />}{leadContextBusy ? "正在读取…" : "添加文件"}</button>
              <span style={{ flex: 1, color: "var(--color-text-secondary)", fontSize: 11 }}>拖入或粘贴的内容仅用于本次搜索</span>
              <button type="button" disabled={busy} onClick={() => startNewSearch()} style={{ ...primary, marginTop: 0 }}>
                {busy ? <RefreshCw size={15} className="spinner" /> : <Search size={15} />}{busy ? '正在查找客户…' : "开始搜索"}
              </button>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
            <LeadProfiles scopeId={activeAccountId||''} current={{product,market,buyerType,requirements:query}} apply={p=>{resetToNewTask();setProduct(p.product);setMarket(p.market);setBuyerType(p.buyerType);setQuery(p.requirements);}}/>
            {activeSessionId && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(searchPage + 1)}
                title="沿用当前任务的搜索条件，继续查找尚未展示的客户。需要更改产品、市场或要求时，请新建任务。"
                style={{ ...secondaryButton, opacity: busy ? 0.6 : 1 }}
              >
                <ChevronRight size={15} />继续查找客户
              </button>
            )}
          </div>
        </section>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr)", gap: 14, marginTop: 14 }}>
          <section ref={resultsSectionRef} style={{scrollMarginTop:64}} aria-label="当前客户结果">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <h2 style={title}><Users size={16} />{showSaved ? "已保存线索" : "客户公司"}（{filteredResults.length} 家）</h2>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                <label style={hint}>排序 <select aria-label="客户结果排序" value={signalOrder?'signals':'discovery'} onChange={e=>setSignalOrder(e.target.value==='signals')}><option value="signals">匹配优先，再看公开业务信号</option><option value="discovery">发现顺序</option></select></label>
                <button type="button" onClick={() => setShowSaved(false)} style={{ ...linkButton, fontWeight: !showSaved ? 700 : 400 }}>本次结果</button>
                <button type="button" onClick={() => setShowSaved(true)} style={{ ...linkButton, fontWeight: showSaved ? 700 : 400 }}>已保存（{savedLeads.length}）</button>
                {!showSaved && results.length > 0 && (
                  <button
                    type="button"
                    onClick={() => { setAutoDevPreview(null); setAutoDevConfirmOpen(true); }}
                    style={{ ...linkButton, color: "var(--color-accent)", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}
                    title="给本页客户逐封生成并发送开发信（需确认，可随时终止）"
                  >
                    <Send size={13} />自动开发本页
                  </button>
                )}
                {!showSaved && results.some((item) => item.website && item.emailDiscoveryStatus !== "completed") && (
                  <button
                    type="button"
                    onClick={() => void enrichFirstVisibleLeads(results.filter(item=>item.emailDiscoveryStatus!=="completed"), activeSessionId || "", searchSessions.find((session) => session.id === activeSessionId)?.productBrief, true)}
                    style={{ ...linkButton, display: "inline-flex", alignItems: "center", gap: 4 }}
                    title="对尚未完成邮箱补全的客户（含失败/中断的）重新查找公开邮箱"
                  >
                    <RefreshCw size={13} />补全邮箱（{results.filter((item) => item.website && item.emailDiscoveryStatus !== "completed").length}）
                  </button>
                )}
              </div>
            </div>
            {!showSaved && activeSessionId && <p className="lead-current-task" title={searchSessions.find(s=>s.id===activeSessionId)?.title}>当前任务 · {searchSessions.find(s=>s.id===activeSessionId)?.title}</p>}
            {(autoDev.running || autoDev.report.length > 0) && (
              <div style={{ margin: "0 0 10px", padding: "10px 12px", borderRadius: 8, border: "1px solid color-mix(in srgb, var(--color-accent) 35%, var(--color-border))", background: "color-mix(in srgb, var(--color-accent) 6%, transparent)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 13 }}>
                    {autoDev.running
                      ? <><RefreshCw size={12} className="app-spin" style={{ verticalAlign: -2, marginRight: 5 }} />自动开发中… {autoDev.current}</>
                      : "自动开发已结束"}
                  </strong>
                  {autoDev.running && <div style={{ display: "flex", gap: 6 }}>
                    <button type="button" onClick={() => autoDev.paused ? autoDev.resume() : autoDev.pause()} style={{ ...linkButton, fontWeight: 700 }}>
                      {autoDev.paused ? <><Play size={12} />继续</> : <><Pause size={12} />暂停</>}
                    </button>
                    <button type="button" onClick={stopAutoDev} style={{ ...linkButton, color: "#b42318", fontWeight: 700 }}>停止任务</button>
                  </div>}
                </div>
                <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--color-bg-hover)", overflow: "hidden" }}>
                    <div style={{ width: `${autoDev.total ? Math.round((autoDev.done / autoDev.total) * 100) : 0}%`, height: "100%", background: "var(--color-accent)", transition: "width .3s" }} />
                  </div>
                  <span style={{ fontSize: 11, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
                    {autoDev.done}/{autoDev.total} · 服务器已接受 <strong style={{ color: "#2f855a" }}>{autoDev.sent}</strong> · 当场失败 <strong style={{ color: "#b42318" }}>{autoDev.failed}</strong> · 跳过 <strong style={{ color: "#9a6700" }}>{autoDev.skipped}</strong>
                  </span>
                </div>
                {!autoDev.running && autoDev.report.length > 0 && (
                  <div style={{ marginTop: 8, maxHeight: 320, overflow: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                    {autoDev.report.map((item, idx) => (
                      <div key={idx} style={{ fontSize: 11.5, display: "flex", alignItems: "baseline", gap: 6 }}>
                        <span style={{ color: item.status === "sent" ? "#2f855a" : item.status === "failed" ? "#b42318" : "#9a6700", fontWeight: 700, flexShrink: 0 }}>
                          {item.status === "sent" ? "✓ 已接受" : item.status === "failed" ? "✗ 发送失败" : "– 跳过"}
                        </span>
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {item.company}{item.person ? `（${item.person}）` : ""} · {item.email}{item.subject ? ` · ${item.subject}` : ""}{item.timestamp ? ` · ${new Date(item.timestamp).toLocaleString()}` : ""}
                        </span>
                        {item.error && <span style={{ color: "var(--color-text-secondary)", fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{item.error}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {!showSaved && searchSessions.find(s=>s.id===activeSessionId)?.failure && <p role="alert" style={hint}>{searchSessions.find(s=>s.id===activeSessionId)?.failureDetail || '此任务执行未完成，不能把空列表当作没有目标客户。'}</p>}
            {!showSaved && results.length===0 && currentDiscoveryReport?.outcome==='research_incomplete' && <p style={hint}>{emptyLeadResultMessage(currentDiscoveryReport)}</p>}
            {!showSaved && reviewIssueSummary && <p style={{ ...hint, marginTop: 2 }}>{reviewIssueSummary}</p>}
            {(results.length === 0 && !showSaved && !busy && !searchSessions.find(s=>s.id===activeSessionId)?.failure) && <p style={hint}>{activeSessionId?'暂未找到可交付的客户公司，可继续查找。':'开始搜索，或从右上角历史任务查看已有结果。'}</p>}
            {showSaved && savedLeads.length > 0 && (
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
                <input value={filterText} onChange={(e) => setFilterText(e.target.value)} placeholder="筛选公司、国家、标签…" style={{ ...input, flex: 1, minWidth: 160, padding: "6px 8px" }} />
                <input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="给选中线索加标签" style={{ ...input, width: 160, padding: "6px 8px" }} />
                <button type="button" disabled={!selectedLeadKeys.size || !tagText.trim()} onClick={() => { const tag = tagText.trim(); setSavedLeads((old) => old.map((lead) => selectedLeadKeys.has(leadKey(lead)) ? { ...lead, tags: [...new Set([...(lead.tags || []), tag])] } : lead)); setTagText(""); }} style={linkButton}><Tag size={13} />加标签</button>
                <button type="button" disabled={!selectedLeadKeys.size} onClick={() => void addSelectedToCustomers()} style={linkButton}><UserPlus size={13} />批量加入客户管理</button>
                <button type="button" disabled={!selectedLeadKeys.size} onClick={deleteSelectedSavedLeads} style={{ ...linkButton, color: "#b42318" }}><Trash2 size={13} />删除选中</button>
              </div>
            )}
            {showSaved && savedLeads.length === 0 && <p style={hint}>还没有保存的线索。搜索后可以一键保存本次结果。</p>}
            {!showSaved && results.length > 0 && (
              <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                <button type="button" onClick={() => saveLeads(results)} style={linkButton}><CheckSquare size={13} />保存本次全部结果</button>
                <span style={hint}>已自动去重 · 结果可在“已保存”中继续筛选、打标签和跟进</span>
              </div>
            )}
            {filteredResults.length>0 && <nav aria-label="客户结果分页" style={{display:'flex',gap:12,alignItems:'center',margin:'10px 0',flexWrap:'wrap'}}>
              <button type="button" disabled={deliveryPage.page<=1} onClick={()=>setResultPage(deliveryPage.page-1)} style={linkButton}>上一页</button>
              <span style={hint}>第 {deliveryPage.page} / {deliveryPage.pages} 页 · 每页目标 {LEAD_PAGE_SIZE} 家 · 共 {deliveryPage.total} 家</span>
              <button type="button" disabled={deliveryPage.page===deliveryPage.pages && (showSaved || busy || !activeSessionId)} onClick={nextResultPage} style={linkButton}>{deliveryPage.page<deliveryPage.pages?'下一页':showSaved?'下一页':filteredResults.length%LEAD_PAGE_SIZE===0?'查找下一页':'继续补充客户'}</button>
            </nav>}
            {!showSaved && (activeSessionId || busy) && <p aria-label="本页交付数量" style={hint}>{leadFillStatus(filteredResults.length,busy,currentDiscoveryReport?.stopReason)}</p>}
            <EmailVerificationScope emails={visibleResults.flatMap(item=>item.emails||[])}>
            <div className="lead-company-list">{visibleResults.map((item, index) => (
                <LeadDeliveryCard key={leadKey(item)} item={item} openUrl={url=>void openLeadUrl(url)} retryContact={item.website ? ()=>void enrichFirstVisibleLeads([item],activeSessionId || '',searchSessions.find(s=>s.id===activeSessionId)?.productBrief,true) : undefined}
                  selection={showSaved && <input type="checkbox" checked={selectedLeadKeys.has(leadKey(item))} onChange={() => toggleLead(item)} aria-label={`选择 ${item.companyName || "客户"}`} />}
                  statusExtra={(() => {
                    const contacted = leadContactSummary(item);
                    return contacted ? <span title="仅作重复联系提醒，不限制再次发送" style={{ fontSize: 10.5, padding: "2px 7px", borderRadius: 999, background: "color-mix(in srgb, #2f855a 13%, transparent)", color: "#2f855a", whiteSpace: "nowrap" }}>已联系 {contacted.count} 次 · {new Date(contacted.lastAt).toLocaleDateString()}</span> : null;
                  })()}
                  actions={<>
                  {item.website && (
                    <button type="button" onClick={() => void openLeadUrl(item.website || "")} style={linkButton}>
                      <Globe2 size={12} />{item.websiteStatus === "已核验" ? "已核验官网" : item.websiteStatus === "无法访问" ? "网址无法访问" : item.websiteStatus === "身份不匹配" ? "网址身份不匹配" : "候选网址"}
                    </button>
                  )}
                  {item.websiteStatusReason && <span title={item.websiteStatusReason} style={{ ...hint, color: item.websiteStatus === "已核验" ? "#2f855a" : item.websiteStatus === "待核验" ? "#9a6700" : "#b42318" }}>{item.websiteStatus}</span>}
                  <button type="button" onClick={() => void addToCustomers(item)} style={{ ...linkButton, color: "var(--color-accent)" }}>
                    <UserPlus size={12} />加入客户管理
                  </button>
                  {!showSaved && <button type="button" onClick={() => saveLeads([item])} style={linkButton}><Check size={12} />保存</button>}
                  <button type="button" onClick={() => showSaved ? deleteSavedLead(item) : deleteCurrentResult(item)} style={{ ...linkButton, color: "#b42318" }}><Trash2 size={12} />删除</button>
                  {item.emails?.length ? (
                    <button type="button" onClick={() => openOutreachPicker(item, index)} style={linkButton}>
                      <Mail size={12} />生成开发信
                    </button>
                  ) : null}
                </>} />
            ))}</div>
            </EmailVerificationScope>
          </section>
        </div>
      </div>

      {/* 自动开发：确认面板（风格选择 + 数量预览 + 说明） */}
      {autoDevConfirmOpen && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(0,0,0,0.45)",
          }}>
          <div style={{
            width: 780, height: "80vh", minWidth: 520, minHeight: 420, maxWidth: "96vw", maxHeight: "94vh", overflow: "auto", resize: "both",
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            borderRadius: 10, padding: 16,
            boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
          }} onClick={(event) => event.stopPropagation()}>
            <h3 style={{ position: "sticky", top: -16, zIndex: 3, margin: "-16px -4px 10px", padding: "14px 4px 10px", fontSize: 15, display: "flex", alignItems: "center", gap: 6, background: "var(--color-bg)", borderBottom: "1px solid var(--color-border)" }}>
              <Send size={15} />自动开发 · 确认发送
              <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 400, color: "var(--color-text-secondary)" }}>右下角可缩放 · Esc 关闭</span>
              <button
                type="button"
                onClick={() => setAutoDevConfirmOpen(false)}
                aria-label="关闭自动开发预览"
                title="关闭"
                style={{ width: 28, height: 28, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--color-border)", borderRadius: 6, background: "var(--color-bg-secondary)", color: "var(--color-text-primary)", cursor: "pointer" }}
              >
                <X size={15} />
              </button>
            </h3>
            <p style={{ fontSize: 12.5, lineHeight: 1.6, color: "var(--color-text-secondary)", margin: "0 0 12px" }}>
              将给本页 <strong>{visibleResults.length}</strong> 家客户的可用邮箱分别生成开发信并发送。
              <br />· 同一公司会发送到所有未被明确标记为“不建议开发”的邮箱；人事、招聘、媒体、法务等明显无关邮箱会排除
              <br />· 每封之间随机间隔 60-180 秒，模拟真人节奏；可随时终止，结束后显示完成报告
              <br />· “服务器已接受”不等于最终送达；延迟退信需等待邮箱同步后确认
            </p>
            <label style={{ display: "block", fontSize: 12, marginBottom: 12 }}>
              <span style={{ display: "block", marginBottom: 4, color: "var(--color-text-secondary)" }}>发件账号</span>
              <select
                value={autoDevSendAccountId}
                onChange={(event) => { setAutoDevSendAccountId(event.target.value); setAutoDevPreview(null); }}
                aria-label="自动开发发件账号"
                style={{ width: "100%", padding: "7px 9px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)" }}
              >
                {mailAccounts.length === 0 && <option value="">没有可用邮箱账号</option>}
                {mailAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.display_name ? `${account.display_name} · ${account.email}` : account.email}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "block", fontSize: 12, marginBottom: 12 }}>
              <span style={{ display: "block", marginBottom: 4, color: "var(--color-text-secondary)" }}>开发信风格</span>
              <select
                value={autoDev.useStyle ? "style" : "default"}
                onChange={(event) => { autoDev.configure({ useStyle: event.target.value === "style" }); setAutoDevPreview(null); }}
                style={{ width: "100%", padding: "7px 9px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)" }}
              >
                <option value="style">用我的写作风格</option>
                <option value="default">系统推荐的开发信写法</option>
              </select>
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
              <label style={{ display: "block", fontSize: 12 }}>
                <span style={{ display: "block", marginBottom: 4, color: "var(--color-text-secondary)" }}>开始时间（可选）</span>
                <input
                  type="datetime-local"
                  value={autoDev.startTime ? toLocalDatetimeInput(autoDev.startTime) : ""}
                  onChange={(event) => {
                    const ms = event.target.value ? new Date(event.target.value).getTime() : null;
                    autoDev.configure({ startTime: ms });
                  }}
                  style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)", fontSize: 12 }}
                />
              </label>
              <label style={{ display: "block", fontSize: 12 }}>
                <span style={{ display: "block", marginBottom: 4, color: "var(--color-text-secondary)" }}>结束时间（可选）</span>
                <input
                  type="datetime-local"
                  value={autoDev.endTime ? toLocalDatetimeInput(autoDev.endTime) : ""}
                  onChange={(event) => {
                    const ms = event.target.value ? new Date(event.target.value).getTime() : null;
                    autoDev.configure({ endTime: ms });
                  }}
                  style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)", fontSize: 12 }}
                />
              </label>
            </div>
            {!autoDevSendAccountId && (
              <p style={{ fontSize: 12, color: "#b42318", margin: "0 0 10px" }}>⚠ 没有可用的发件账号，请先添加邮箱账号。</p>
            )}
            <label style={{ display: "block", fontSize: 12, marginBottom: 12 }}>
              <span style={{ display: "block", marginBottom: 4, color: "var(--color-text-secondary)" }}>AI 调整指令（可选）</span>
              <div
                onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }}
                onDrop={handleLeadContextDrop}
                style={{ position: "relative" }}
              >
                <textarea
                  value={autoDevInstruction}
                  onChange={(event) => setAutoDevInstruction(event.target.value)}
                  rows={3}
                  placeholder="例如：写得更详细一些；控制在 90 词以内；语气更简洁自然；突出交期和小批量定制；也可以直接拖入文件、邮件或图片作为补充资料"
                  style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 7, border: "1px solid var(--color-border)", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)", lineHeight: 1.55, resize: "vertical" }}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                <button type="button" onClick={() => leadFileInputRef.current?.click()} style={{ ...linkButton, display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <Paperclip size={12} />添加文件{leadContextFiles.length > 0 ? `（${leadContextFiles.length}）` : ""}
                </button>
                <KnowledgePicker accountId={activeAccountId} selectedIds={selectedKnowledgeIds} onChange={setSelectedKnowledgeIds} label="引用资料库" />
                {(restoredContextNote || leadContextFiles.length > 0 || leadContextMessages.length > 0 || selectedKnowledgeIds.length > 0) && (
                  <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                    {restoredContextNote
                      ? `本次开发信将继承搜索时所用资料（${restoredContextNote}${leadContextFiles.length > 0 ? `，另加当前 ${leadContextFiles.length} 个文件` : ""}）`
                      : `已附加 ${leadContextFiles.length} 个文件${leadContextMessages.length > 0 ? `、${leadContextMessages.length} 封邮件` : ""}${selectedKnowledgeIds.length > 0 ? `、${selectedKnowledgeIds.length} 份资料库` : ""}`}
                  </span>
                )}
              </div>
            </label>
            <div style={{ padding: 10, marginBottom: 12, border: "1px solid var(--color-border)", borderRadius: 8, background: "var(--color-bg-secondary)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: autoDevPreview ? 8 : 0 }}>
                <div style={{ fontSize: 12 }}><strong>发送前预览</strong><br /><span style={{ color: "var(--color-text-secondary)" }}>先生成第一封样稿，确认格式、内容和落款后才允许启动。</span></div>
                <button type="button" disabled={autoDevPreviewBusy || !autoDevSendAccountId} onClick={() => void generateAutoDevPreview()} style={secondaryButton}>
                  {autoDevPreviewBusy ? "正在生成…" : autoDevPreview ? "按指令重新生成" : "生成预览"}
                </button>
              </div>
              {autoDevPreview && <div style={{ display: "grid", gap: 7 }}>
                <div style={{ display: "grid", gap: 5, padding: "8px 9px", border: "1px solid color-mix(in srgb, var(--color-accent) 28%, var(--color-border))", borderRadius: 7, background: "color-mix(in srgb, var(--color-accent) 7%, var(--color-bg-primary))", fontSize: 11.5, lineHeight: 1.5 }}>
                  <div><strong>本封角度：</strong>{autoDevPreview.strategy.title}<span style={{ marginLeft: 6, color: "var(--color-text-secondary)" }}>证据：{autoDevPreview.strategy.evidenceLevel === "strong" ? "较充分" : autoDevPreview.strategy.evidenceLevel === "medium" ? "一般" : "有限"}</span></div>
                  <div style={{ color: "var(--color-text-secondary)" }}>{autoDevPreview.strategy.reason}</div>
                  {autoDevPreview.strategy.evidenceUsed.length > 0 && <div><strong>采用依据：</strong>{autoDevPreview.strategy.evidenceUsed.join("；")}</div>}
                  {autoDevPreview.strategy.warnings.length > 0 && <div style={{ color: "#a15c00" }}><strong>注意：</strong>{autoDevPreview.strategy.warnings.join("；")}</div>}
                </div>
                <input value={autoDevPreview.subject} onChange={(event) => setAutoDevPreview((value) => value ? { ...value, subject: event.target.value } : value)} style={{ padding: "7px 9px", border: "1px solid var(--color-border)", borderRadius: 6, background: "var(--color-bg-primary)", color: "var(--color-text-primary)" }} aria-label="开发信预览主题" />
                <textarea value={autoDevPreview.body} onChange={(event) => setAutoDevPreview((value) => value ? { ...value, body: event.target.value } : value)} rows={12} style={{ minHeight: 260, padding: "8px 10px", border: "1px solid var(--color-border)", borderRadius: 6, background: "var(--color-bg-primary)", color: "var(--color-text-primary)", lineHeight: 1.6, resize: "vertical" }} aria-label="开发信预览正文" />
              </div>}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={() => setAutoDevConfirmOpen(false)}>取消</button>
              <button
                type="button"
                disabled={!autoDevSendAccountId || visibleResults.length === 0 || !autoDevPreview}
                onClick={() => void runAutoDev()}
                style={{ padding: "6px 14px", border: 0, borderRadius: 6, background: "var(--color-accent)", color: "#fff", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}
              >
                <Send size={13} />开始自动开发
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 生成开发信：邮箱勾选弹窗 */}
      {outreachPicker && (() => {
        const emails = (outreachPicker.candidate.emails ?? []).filter(Boolean);
        const toggleEmail = (email: string) => {
          setOutreachPicker((prev) => {
            if (!prev) return prev;
            const next = new Set(prev.checked);
            if (next.has(email)) next.delete(email); else next.add(email);
            return { ...prev, checked: next };
          });
        };
        const toggleAll = () => {
          setOutreachPicker((prev) => {
            if (!prev) return prev;
            const allSelected = emails.every((e) => prev.checked.has(e));
            return { ...prev, checked: allSelected ? new Set() : new Set(emails) };
          });
        };
        return (
          <div style={{
            position: "fixed", inset: 0, zIndex: 1000,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.45)",
          }} onClick={() => setOutreachPicker(null)}>
            <div style={{
              width: 520, maxWidth: "92vw", maxHeight: "80vh", overflow: "auto",
              background: "var(--color-bg-primary)", borderRadius: 12, padding: 16,
              boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
            }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <strong style={{ fontSize: 14 }}>生成开发信 · 选择收件邮箱</strong>
                <button type="button" onClick={() => setOutreachPicker(null)} style={iconButton} aria-label="关闭">
                  ✕
                </button>
              </div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 }}>
                {outreachPicker.candidate.companyName || "该客户"} · 共 {emails.length} 个邮箱，勾选你要发送的。
              </div>
              {/* 生成模式：独立个性化 / 统一内容 */}
              <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => setOutreachPicker((prev) => (prev ? { ...prev, mode: "individual" } : prev))}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer",
                    padding: "6px 10px", borderRadius: 8,
                    border: `1px solid ${outreachPicker.mode === "individual" ? "var(--color-accent)" : "var(--color-border)"}`,
                    background: outreachPicker.mode === "individual" ? "color-mix(in srgb, var(--color-accent) 8%, transparent)" : "transparent",
                    color: "var(--color-text-primary)",
                  }}
                >
                  <input type="radio" checked={outreachPicker.mode === "individual"} readOnly style={{ margin: 0 }} />
                  <div style={{ textAlign: "left", lineHeight: 1.35 }}>
                    <div style={{ fontWeight: 600 }}>每封独立个性化</div>
                    <div style={{ fontSize: 10.5, color: "var(--color-text-secondary)" }}>针对每个收件人（职位/角色）单独写，内容不同</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setOutreachPicker((prev) => (prev ? { ...prev, mode: "unified" } : prev))}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer",
                    padding: "6px 10px", borderRadius: 8,
                    border: `1px solid ${outreachPicker.mode === "unified" ? "var(--color-accent)" : "var(--color-border)"}`,
                    background: outreachPicker.mode === "unified" ? "color-mix(in srgb, var(--color-accent) 8%, transparent)" : "transparent",
                    color: "var(--color-text-primary)",
                  }}
                >
                  <input type="radio" checked={outreachPicker.mode === "unified"} readOnly style={{ margin: 0 }} />
                  <div style={{ textAlign: "left", lineHeight: 1.35 }}>
                    <div style={{ fontWeight: 600 }}>统一内容分别发送</div>
                    <div style={{ fontSize: 10.5, color: "var(--color-text-secondary)" }}>所有邮箱同一封信，仍单独发送、互不可见</div>
                  </div>
                </button>
              </div>
              {/* 风格选项：用户风格 / 系统默认 */}
              <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => setOutreachPicker((prev) => (prev ? { ...prev, useStyle: true } : prev))}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer",
                    padding: "6px 10px", borderRadius: 8,
                    border: `1px solid ${outreachPicker.useStyle ? "var(--color-accent)" : "var(--color-border)"}`,
                    background: outreachPicker.useStyle ? "color-mix(in srgb, var(--color-accent) 8%, transparent)" : "transparent",
                    color: "var(--color-text-primary)",
                  }}
                >
                  <input type="radio" checked={outreachPicker.useStyle} readOnly style={{ margin: 0 }} />
                  <div style={{ textAlign: "left", lineHeight: 1.35 }}>
                    <div style={{ fontWeight: 600 }}>用我的写作风格</div>
                    <div style={{ fontSize: 10.5, color: "var(--color-text-secondary)" }}>按你的风格档案写（简短/称呼/落款等）</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setOutreachPicker((prev) => (prev ? { ...prev, useStyle: false } : prev))}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer",
                    padding: "6px 10px", borderRadius: 8,
                    border: `1px solid ${!outreachPicker.useStyle ? "var(--color-accent)" : "var(--color-border)"}`,
                    background: !outreachPicker.useStyle ? "color-mix(in srgb, var(--color-accent) 8%, transparent)" : "transparent",
                    color: "var(--color-text-primary)",
                  }}
                >
                  <input type="radio" checked={!outreachPicker.useStyle} readOnly style={{ margin: 0 }} />
                  <div style={{ textAlign: "left", lineHeight: 1.35 }}>
                    <div style={{ fontWeight: 600 }}>系统默认风格</div>
                    <div style={{ fontSize: 10.5, color: "var(--color-text-secondary)" }}>用系统推荐的开发信写法（不套用我的档案）</div>
                  </div>
                </button>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={emails.length > 0 && emails.every((e) => outreachPicker.checked.has(e))}
                  onChange={toggleAll}
                />
                全选 / 全不选
              </label>
              <div style={{ display: "grid", gap: 6, marginBottom: 12 }}>
                {emails.map((email) => {
                  const ev = outreachPicker.candidate.emailEvidence?.find((e) => e.email === email);
                  const checked = outreachPicker.checked.has(email);
                  return (
                    <label key={email} style={{
                      display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px",
                      borderRadius: 8, border: `1px solid ${checked ? "var(--color-accent)" : "var(--color-border)"}`,
                      background: checked ? "color-mix(in srgb, var(--color-accent) 6%, transparent)" : "transparent",
                      cursor: "pointer",
                    }}>
                      <input type="checkbox" checked={checked} onChange={() => toggleEmail(email)} style={{ marginTop: 2 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, wordBreak: "break-all" }}>{email}</div>
                        {ev?.person && (
                          <div style={{ fontSize: 11, color: "var(--color-text-primary)", marginTop: 1 }}>
                            👤 {ev.person}
                          </div>
                        )}
                        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>
                          {ev?.emailType && <span style={{ color: "var(--color-accent)" }}>{ev.emailType} · </span>}
                          {ev?.source || "公开渠道发现"}
                          {ev?.verification && <span> · {ev.verification}</span>}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
              <label style={{ display: "block", fontSize: 12, marginBottom: 12 }}>
                <span style={{ display: "block", marginBottom: 4, color: "var(--color-text-secondary)" }}>AI 调整指令（可选）</span>
                <div onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }} onDrop={handleLeadContextDrop}>
                  <textarea
                    value={outreachPicker.instruction}
                    onChange={(event) => setOutreachPicker((prev) => (prev ? { ...prev, instruction: event.target.value } : prev))}
                    rows={3}
                    placeholder="例如：写得更详细一些；控制在 90 词以内；语气更简洁自然；也可以直接拖入文件、邮件或图片作为补充资料"
                    style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 7, border: "1px solid var(--color-border)", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)", lineHeight: 1.55, resize: "vertical" }}
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                  <button type="button" onClick={() => leadFileInputRef.current?.click()} style={{ ...linkButton, display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <Paperclip size={12} />添加文件{leadContextFiles.length > 0 ? `（${leadContextFiles.length}）` : ""}
                  </button>
                  <KnowledgePicker accountId={activeAccountId} selectedIds={selectedKnowledgeIds} onChange={setSelectedKnowledgeIds} label="引用资料库" />
                  {(restoredContextNote || leadContextFiles.length > 0 || leadContextMessages.length > 0 || selectedKnowledgeIds.length > 0) && (
                    <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                      {restoredContextNote
                        ? `将继承搜索时所用资料（${restoredContextNote}${leadContextFiles.length > 0 ? `，另加当前 ${leadContextFiles.length} 个文件` : ""}）`
                        : `已附加 ${leadContextFiles.length} 个文件${leadContextMessages.length > 0 ? `、${leadContextMessages.length} 封邮件` : ""}${selectedKnowledgeIds.length > 0 ? `、${selectedKnowledgeIds.length} 份资料库` : ""}`}
                    </span>
                  )}
                </div>
              </label>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" onClick={() => setOutreachPicker(null)} style={secondaryButton}>
                  取消
                </button>
                <button
                  type="button"
                  disabled={outreachPicker.checked.size === 0}
                  onClick={() => {
                    const selected = Array.from(outreachPicker.checked);
                    const candidate = outreachPicker.candidate;
                    const mode = outreachPicker.mode;
                    const useStyle = outreachPicker.useStyle;
                    const instruction = outreachPicker.instruction;
                    setOutreachPicker(null);
                    void writeOutreach(candidate, selected, mode, useStyle, instruction);
                  }}
                  style={{ ...primary, marginTop: 0, opacity: outreachPicker.checked.size === 0 ? 0.5 : 1 }}
                >
                  <Mail size={14} />为 {outreachPicker.checked.size} 个邮箱生成开发信
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

const card: React.CSSProperties = { border: "1px solid var(--color-border)", borderRadius: 10, padding: 15, background: "var(--color-bg-primary)" };
const input: React.CSSProperties = { width: "100%", boxSizing: "border-box", border: "1px solid var(--color-border)", borderRadius: 7, padding: "9px 10px", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)" };
const primary: React.CSSProperties = { marginTop: 10, display: "flex", alignItems: "center", gap: 6, border: 0, borderRadius: 7, padding: "9px 15px", background: "var(--color-accent)", color: "#fff", cursor: "pointer" };
const secondaryButton: React.CSSProperties = { marginTop: 10, display: "flex", alignItems: "center", gap: 5, border: "1px solid var(--color-border)", borderRadius: 7, padding: "8px 12px", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)", cursor: "pointer" };
const hint: React.CSSProperties = { color: "var(--color-text-secondary)", fontSize: 12, lineHeight: 1.6 };
const title: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, margin: "0 0 8px", fontSize: 14 };
const linkButton: React.CSSProperties = { display: "flex", gap: 4, alignItems: "center", border: 0, padding: "4px 0", background: "transparent", color: "var(--color-accent)", cursor: "pointer", fontSize: 12 };
const iconButton: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", border: 0, padding: 5, borderRadius: 5, background: "transparent", color: "#b42318", cursor: "pointer" };
const leadComposer: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", border: "2px solid var(--color-accent)", borderRadius: 12, padding: 10, background: "color-mix(in srgb, var(--color-accent) 4%, var(--color-bg-primary))", boxShadow: "0 5px 18px color-mix(in srgb, var(--color-accent) 10%, transparent)" };
const leadAttachedRow: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6, flexBasis: "100%", width: 0, paddingBottom: 7, borderBottom: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)" };
const leadAttachedChip: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, maxWidth: 240, border: "1px solid color-mix(in srgb, var(--color-accent) 32%, var(--color-border))", borderRadius: 999, background: "color-mix(in srgb, var(--color-accent) 8%, transparent)", color: "var(--color-text-primary)", padding: "4px 8px", fontSize: 11, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const leadTextarea: React.CSSProperties = { flex: 1, minWidth: 0, minHeight: 92, maxHeight: 300, overflowY: "auto", resize: "none", border: 0, outline: 0, background: "transparent", color: "var(--color-text-primary)", fontSize: 14, lineHeight: 1.7 };
const leadFileButton: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--color-border)", borderRadius: 7, background: "var(--color-bg-primary)", color: "var(--color-text-primary)", padding: "8px 10px", fontSize: 12, cursor: "pointer" };
