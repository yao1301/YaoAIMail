import { useEffect, useRef, useCallback, useState } from "react";
import { useComposeStore } from "@/stores/compose.store";
import { saveDraft } from "@/lib/api";
import { hasComposeDraft, type ComposeAttachment } from "@/features/compose/compose-draft";
import { registerDraftSaver } from '@/features/compose/draftPersistence';
import { useConfirmStore } from '@/stores/confirm.store';
import { useToastStore } from '@/stores/toast.store';
import i18n from '@/lib/i18n';

import type { EditorMode } from "./useComposeEditor";

const DRAFT_STORAGE_KEY = "pebble-compose-draft";

export interface DraftData {
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  rawSource: string;
  richTextHtml: string;
  editorMode: EditorMode;
  attachments: ComposeAttachment[];
  savedAt: number;
}

/**
 * LocalStorage drafts are no longer restored because they contain plaintext
 * message bodies and attachment paths. Backend drafts remain the persistence
 * mechanism; this only clears legacy plaintext data left by older builds.
 */
export function loadDraftFromStorage(validAccountIds?: string[]): DraftData | null {
  void validAccountIds;
  try {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch { /* ignore legacy cleanup failure */ }
  return null;
}

export function clearDraftStorage() {
  localStorage.removeItem(DRAFT_STORAGE_KEY);
}

interface UseComposeDraftArgs {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  rawSource: string;
  richTextHtml: string;
  editorMode: EditorMode;
  composeMode: string | null;
  fromAccountId: string | null;
  attachments: ComposeAttachment[];
  /** True once the TipTap editor has mounted and populated richTextHtml with
   * its initial content (signature, quoted reply, etc.). Until this flips to
   * true, the snapshot would compare user edits against an empty string and
   * falsely report the compose as dirty. */
  editorReady: boolean;
  existingDraftId?: string;
  initialDirty?: boolean;
  inReplyTo?: string;
  /** 写信标签 id（多标签模式）：dirty 标记只写回对应标签。 */
  tabId?: string;
  onSaved?: () => void;
}

function draftFingerprint(input: UseComposeDraftArgs) {
  return JSON.stringify([input.fromAccountId, input.to, input.cc, input.bcc, input.subject,
    input.editorMode, input.editorMode === 'rich' ? input.richTextHtml : input.rawSource,
    input.attachments, input.inReplyTo]);
}

export function useComposeDraft(args: UseComposeDraftArgs) {
  const { existingDraftId, fromAccountId, editorReady, tabId } = args;
  const latest = useRef(args);
  latest.current = args;
  const [isSaving, setIsSaving] = useState(false);
  const pendingCount = useRef(0);
  const stopped = useRef(false);
  const leaveDialogOpen = useComposeStore(s => s.showComposeLeaveConfirm);
  const confirmOpen = useConfirmStore(s => s.isOpen);
  const initial = useRef<{ account: string | null; fingerprint: string } | null>(null);
  const savedFingerprints = useRef<Record<string, string>>({});
  const pending = useRef<Record<string, Promise<string>>>({});
  const draftIdRef = useRef<string | null>(existingDraftId ?? null);
  const draftIdsByAccountRef = useRef<Record<string, string>>(
    existingDraftId && fromAccountId ? { [fromAccountId]: existingDraftId } : {},
  );
  draftIdRef.current = fromAccountId ? draftIdsByAccountRef.current[fromAccountId] ?? null : null;
  const fingerprint = draftFingerprint(args);
  const hasUnsavedChanges = useCallback(() => {
    const input = latest.current;
    const saved = input.fromAccountId ? savedFingerprints.current[input.fromAccountId] : undefined;
    const baseline = saved ?? (existingDraftId && !args.initialDirty && initial.current?.account === input.fromAccountId
      ? initial.current.fingerprint : undefined);
    return baseline !== undefined ? draftFingerprint(input) !== baseline : hasComposeDraft(input);
  }, [existingDraftId, args.initialDirty]);

  useEffect(() => {
    if (!editorReady) return;
    if (!initial.current) initial.current = { account: fromAccountId, fingerprint };
    useComposeStore.getState().setComposeDirty(hasUnsavedChanges(), tabId);
  }, [fingerprint, editorReady, existingDraftId, fromAccountId, tabId, hasUnsavedChanges]);

  const saveNow = useCallback((): Promise<string> => {
    const input = latest.current;
    const account = input.fromAccountId;
    if (!account || !input.editorReady) return Promise.reject(new Error(i18n.t('compose.saveUnavailable', '编辑器尚未准备好，请继续编辑后再保存。')));
    if (input.attachments.some(file => !file.path.trim())) return Promise.reject(new Error(i18n.t('compose.attachmentsPending', '附件尚未准备好，请稍后保存。')));
    const key = draftFingerprint(input);
    const run = async () => {
      if (stopped.current) throw new Error('Draft session has ended');
      const priorId = draftIdsByAccountRef.current[account];
      if (priorId && savedFingerprints.current[account] === key) return priorId;
      pendingCount.current++;
      setIsSaving(true);
      try {
        const id = await saveDraft({
          accountId: account, to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject,
          bodyText: input.editorMode === 'rich'
            ? input.richTextHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : input.rawSource,
          bodyHtml: (input.editorMode === 'rich' ? input.richTextHtml : input.editorMode === 'html' ? input.rawSource : undefined) || undefined,
          inReplyTo: input.inReplyTo,
          attachmentPaths: input.attachments.map(file => file.path).filter(Boolean),
          existingDraftId: priorId || undefined,
        });
        draftIdsByAccountRef.current[account] = id;
        savedFingerprints.current[account] = key;
        if (latest.current.fromAccountId === account) {
          draftIdRef.current = id;
          useComposeStore.getState().setComposeDirty(draftFingerprint(latest.current) !== key, tabId);
        }
        input.onSaved?.();
        return id;
      } finally {
        pendingCount.current--;
        setIsSaving(pendingCount.current > 0);
      }
    };
    // Serialize within each account, including manual saves during autosave.
    // Always retain the resulting ID before the next write starts.
    const previous = pending.current[account];
    const task = previous ? previous.catch(() => undefined).then(run) : run();
    pending.current[account] = task;
    return task;
  }, [tabId]);

  useEffect(() => registerDraftSaver(tabId, saveNow), [tabId, saveNow]);
  const stopSaving = useCallback(async () => {
    stopped.current = true;
    await Promise.allSettled(Object.values(pending.current));
  }, []);
  const resumeSaving = useCallback(() => { stopped.current = false; }, []);
  useEffect(() => {
    if (!args.composeMode || !editorReady || leaveDialogOpen || confirmOpen) return;
    const timer = setTimeout(() => {
      if (stopped.current || !latest.current.fromAccountId) return;
      if (!hasComposeDraft(latest.current) && !draftIdsByAccountRef.current[latest.current.fromAccountId]) return;
      void saveNow().catch(error => {
        if (stopped.current) return;
        useToastStore.getState().addToast({ type: 'error', message: `${i18n.t('compose.saveFailed', '草稿保存失败，内容仍保留在编辑器中')}: ${String(error)}` });
      });
    }, 3000);
    return () => clearTimeout(timer);
  }, [fingerprint, args.composeMode, editorReady, leaveDialogOpen, confirmOpen, saveNow]);

  return { draftIdRef, draftIdsByAccountRef, saveNow, isSaving, stopSaving, resumeSaving, hasUnsavedChanges };
}
