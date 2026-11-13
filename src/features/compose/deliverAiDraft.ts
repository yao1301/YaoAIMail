import { isComposeWindow, useComposeStore, type ComposePrefill, type ComposeMode } from '@/stores/compose.store';
import type { Message } from '@/lib/api';
import { deliverToDetachedDraft } from '@/lib/workspaceDraftDelivery';

export interface AiDraftTarget {
  tabId?: string;
  embedded?: boolean;
  accountId?: string;
  replyTo?: Message | null;
  prefill?: ComposePrefill;
}

/** Capture this target before awaiting a model. A closed/changed draft gets a
 * separate recovery draft; a late result must never overwrite the next tab. */
export function deliverAiDraft(target: AiDraftTarget, draft: { body: string; subject?: string; signature?: string }): 'queued' | 'opened' {
  if (!draft.body.trim()) throw new Error('AI 未返回邮件正文，请重新生成。');
  const store = useComposeStore.getState();
  if (target.tabId && deliverToDetachedDraft(target.tabId, draft)) return 'queued';
  const tab = target.tabId ? store.tabsById[target.tabId] : undefined;
  const owner = tab?.activeDraftContext?.fromAccountId ?? tab?.draftSnapshot?.accountId ?? tab?.prefill?.accountId ?? tab?.replyTo?.account_id;
  if (target.tabId && tab && (!owner || owner === target.accountId) && store.applyAiDraft(draft, target.tabId)) return 'queued';
  if (target.embedded && isComposeWindow() && store.activeDraftContext?.fromAccountId === target.accountId && store.applyAiDraft(draft)) return 'queued';
  const mode: ComposeMode = target.replyTo ? 'reply-all' : 'new';
  store.openCompose(mode, target.replyTo ?? null, { ...target.prefill, ...draft, accountId: target.accountId, aiGenerated: true });
  return 'opened';
}
