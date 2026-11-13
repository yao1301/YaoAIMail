import type { WorkbenchTask } from './workbenchTask';
import type { TradeSkillId } from './tradeSkills';
import { profileLocalStorage } from '@/lib/profileStorage';
import type { AssistantEvidenceReport, WorkbenchDraftReceipt } from '@/lib/api';

export type WorkbenchReference =
  | { kind: 'mail'; id: string; label: string; subtitle: string; accountId: string; folderId?: string }
  | { kind: 'customer'; id: string; label: string; subtitle: string; email: string }
  | { kind: 'knowledge'; id: string; label: string; subtitle: string; locator: string };
export type WorkbenchEvidence =
  | { kind: 'mail'; id: string; title: string }
  | { kind: 'file'; id: string; title: string; text: string };
export type WorkbenchMessage = {
  id: string; role: 'user' | 'assistant'; content: string; references?: WorkbenchReference[];
  skillId?: TradeSkillId; task?: WorkbenchTask; externalSources?: string[]; toolCalls?: number; evidenceReport?: AssistantEvidenceReport; createdAt: number;
  actionSources?: {id:string;title:string}[];
  draftReceipts?: WorkbenchDraftReceipt[];
  schedules?: {draftId:string;operationId:string;sendAt:number}[];
};
export type WorkbenchConversation = {
  id: string; accountId: string | null; legacy?: boolean; title: string; messages: WorkbenchMessage[];
  evidence: WorkbenchEvidence[]; knowledgeIds: string[]; createdAt: number; updatedAt: number;
};
export const HISTORY_KEY = 'yao-home-ai-conversations-v2';
const LEGACY_KEY = 'yao-home-ai-conversations-v1';
export function newConversation(accountId: string | null): WorkbenchConversation {
  const now = Date.now();
  return { id: `home-${now}-${Math.random().toString(36).slice(2, 8)}`, accountId, legacy: false, title: '新对话', messages: [], evidence: [], knowledgeIds: [], createdAt: now, updatedAt: now };
}
export function loadConversations(): WorkbenchConversation[] {
  try {
    const current = profileLocalStorage.getItem(HISTORY_KEY);
    const raw = current ?? localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(item => item && typeof item.id === 'string' && Array.isArray(item.messages)).map(item => ({
      ...item, accountId: typeof item.accountId === 'string' ? item.accountId : null,
      legacy: item.legacy === true || current === null,
      evidence: Array.isArray(item.evidence) ? item.evidence : [], knowledgeIds: Array.isArray(item.knowledgeIds) ? item.knowledgeIds : [],
    }));
  } catch { return []; }
}
export function saveConversations(conversations: WorkbenchConversation[]) {
  // Do not truncate other accounts or silently erase older user conversations.
  profileLocalStorage.setItem(HISTORY_KEY, JSON.stringify(conversations));
}
export function mergeEvidence(previous: WorkbenchEvidence[], incoming: WorkbenchEvidence[]): WorkbenchEvidence[] {
  const items = new Map(previous.map(item => [`${item.kind}:${item.id}`, item]));
  for (const item of incoming) items.set(`${item.kind}:${item.id}`, item);
  const all = [...items.values()];
  if (all.length > 24 || all.reduce((count, item) => count + (item.kind === 'file' ? item.text.length : 0), 0) > 60_000) {
    throw new Error('当前对话附加资料过多，请新建对话或移除本次附件后重试。原输入和附件已保留。');
  }
  return all;
}
