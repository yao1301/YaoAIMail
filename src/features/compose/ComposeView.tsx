import { useWorkspaceState, useWorkspacePrepare } from '@/lib/workspaceState';
import { useEffect, useRef, useCallback } from "react";
import { deliverAiDraft } from './deliverAiDraft';
import { aiInstructionPreview } from './aiInstructionPreview';
import { invoke } from "@tauri-apps/api/core";
import { EditorContent } from "@tiptap/react";
import {
  ArrowLeft, Send, Save, X, AlertCircle,
  Type, FileCode2, Hash, Eye, EyeOff,
  Paperclip, FileText, Trash2, BookTemplate, Library,
  ChevronDown, ChevronRight, Sparkles, Undo2, Redo2,
  FolderOpen, Copy, Scaling,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import ContextMenu, { type ContextMenuItem } from "@/components/ContextMenu";
import { useMailStore } from "@/stores/mail.store";
import { useUIStore } from "@/stores/ui.store";
import { useComposeStore } from "@/stores/compose.store";
import { useAccountsQuery } from "@/hooks/queries";
import { useSendEmailMutation } from "@/hooks/mutations";
import type { SendEmailParams } from "@/hooks/mutations/useSendEmailMutation";
import { safeErrorMessage } from "@/lib/appErrors";
import ContactAutocomplete from "@/components/ContactAutocomplete";
import { listTemplates, saveTemplate, deleteTemplate } from "@/lib/templates";
import type { EmailTemplate } from "@/lib/templates";
import { listKnowledgeItems, listStyleProfiles, searchKnowledgeBase, getMessagesBatch, type KnowledgeItem, type StyleProfile, aiChat } from "@/lib/api";
import { AI_REVISION_RULES, currentDraftForAi, readRevisionText } from "./aiRevisionContext";
import { useComposeRecipients } from "@/hooks/useComposeRecipients";
import { useClickOutside } from "@/hooks/useClickOutside";
import { useComposeDraft, loadDraftFromStorage, clearDraftStorage } from "@/hooks/useComposeDraft";
import { deleteDraft, stageComposeAttachment, getSendGuardConfig, checkSendGuard, scheduleEmail } from "@/lib/api";
import { listEmailSignatures, type EmailSignature } from "@/lib/signatures";
import { appendReplyQuoteHtml, useComposeEditor } from "@/hooks/useComposeEditor";
import { useConfirmStore } from "@/stores/confirm.store";
import { useToastStore } from "@/stores/toast.store";
import type { Account } from "@/lib/ipc-types";
import type { ComposeAttachment, ComposeDraftSnapshot } from "./compose-draft";
import { ModeButton, EditorToolbar, MarkdownToolbar, composeStyles } from "./ComposeToolbar";
import { isValidEmailAddress, mergePendingRecipient } from "./recipient-utils";
import KnowledgePicker from "@/components/KnowledgePicker";
import { DOCUMENT_DRAFT_RULES, documentSectionsText, readReplyDraftText, DRAFT_FILE_ACCEPT } from './documentDraft';
import { useAiFileContext, filesFromTransfer } from '@/hooks/useAiFileContext';
import { getActiveWorkRole } from "@/features/settings/WorkRoleTab";
import { resizeAutoGrowTextarea } from "@/lib/autoGrowTextarea";
import { useWritingPreferences } from "@/lib/writingPreferences";
import { findMailLanguage, MAIL_LANGUAGES, writingLanguageInstruction } from "@/lib/mailLanguages";
import {
  clipboardContainsHtmlTable,
  prepareSpreadsheetTableHtml,
  normalizeImageWidthPercent,
  scaledImageWidthPx,
} from "./composeClipboard";
import {
  getUndoSendRemainingSeconds,
  readUndoSendDelay,
} from "./undoSend";
import { normalizeAiEmailDraft } from "./aiEmailDraft";
import { appendDefaultSignatureHtml, appendExactAiSignatureText } from "./aiSignature";
import { readMailReference } from "@/lib/mailReferenceDrag";
import { readMailReferenceContext } from "./mailReferenceContext";
import { reportMailFailure } from '@/lib/mailErrorNotifications';
import ConfirmDialog from '@/components/ConfirmDialog';
import { queryClient } from '@/lib/query-client';

function escapePastedTextHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default function ComposeView({ tabId }: { tabId?: string }) {
  const composeMode = useComposeStore((s) => s.composeMode);
  const myTab = useComposeStore((s) => (tabId ? s.tabsById[tabId] : undefined));
  const { data: accounts = [], isLoading } = useAccountsQuery();

  if (tabId) {
    // 多标签模式：只渲染自己的标签。
    if (!myTab) return null;
    if (myTab.mode === "new" && isLoading) {
      return <div style={{ height: "100%" }} />;
    }
  } else if (composeMode === "new" && isLoading) {
    return <div style={{ height: "100%" }} />;
  }

  return <ComposeViewInner accounts={accounts} tabId={tabId} />;
}

function ComposeViewInner({ accounts, tabId }: { accounts: Account[]; tabId?: string }) {
  const { t } = useTranslation();
  // 多标签模式：读自己标签的数据；独立窗口（无 tabId）读投影字段。
  const myTab = useComposeStore((s) => (tabId ? s.tabsById[tabId] : undefined));
  const activeTabId = useComposeStore((s) => s.activeTabId);
  const isActive = !tabId || activeTabId === tabId;
  const composeMode = myTab ? myTab.mode : useComposeStore((s) => s.composeMode);
  const composeReplyTo = myTab ? myTab.replyTo : useComposeStore((s) => s.composeReplyTo);
  const composePrefill = myTab ? myTab.prefill : useComposeStore((s) => s.composePrefill);
  const draftSnapshot = myTab ? myTab.draftSnapshot : useComposeStore((s) => s.draftSnapshot);
  const pendingAiBody = myTab ? myTab.pendingAiBody : useComposeStore((s) => s.pendingAiBody);
  const pendingAiSubject = myTab ? myTab.pendingAiSubject : useComposeStore((s) => s.pendingAiSubject);
  const pendingAiSignature = myTab ? myTab.pendingAiSignature : useComposeStore((s) => s.pendingAiSignature);
  const setDraftSnapshot = useComposeStore((s) => s.setDraftSnapshot);
  const setActiveDraftContext =
    useComposeStore((s) => s.setActiveDraftContext) ?? (() => undefined);
  const clearPendingAiBody =
    useComposeStore((s) => s.clearPendingAiBody) ?? (() => undefined);
  const closeCompose = useComposeStore((s) => s.closeCompose);
  const showComposeLeaveConfirm = useComposeStore((s) => s.showComposeLeaveConfirm);
  const confirmCloseCompose = useComposeStore((s) => s.confirmCloseCompose);
  const cancelCloseCompose = useComposeStore((s) => s.cancelCloseCompose);
  const activeAccountId = useMailStore((s) => s.activeAccountId);

  const isReply = composeMode === "reply" || composeMode === "reply-all";
  const restoredDraft = useRef<ComposeDraftSnapshot | null>(
    draftSnapshot ?? (composeMode === "new" ? loadDraftFromStorage(accounts.map((account) => account.id)) : null),
  );

  // ─── Recipients ──────────────────────────────────────────────────────────────
  const {
    fromAccountId, setFromAccountId,
    to, setTo, cc, setCc, bcc, setBcc,
    showCc, setShowCc, showBcc, setShowBcc,
  } = useComposeRecipients({
    composeMode, composeReplyTo, accounts, activeAccountId,
    restoredDraft: restoredDraft.current,
    composePrefill,
  });
  const [toInputValue, setToInputValue] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:toInputValue", "");
  const [ccInputValue, setCcInputValue] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:ccInputValue", "");
  const [bccInputValue, setBccInputValue] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:bccInputValue", "");

  // ─── Subject ─────────────────────────────────────────────────────────────────
  const [subject, setSubject] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:subject", () => {
    if (restoredDraft.current) return restoredDraft.current.subject;
    if (composePrefill?.subject) return composePrefill.subject;
    if (!composeReplyTo) return "";
    if (isReply) return `Re: ${composeReplyTo.subject.replace(/^(Re:\s*|Fwd:\s*)+/i, "")}`;
    if (composeMode === "forward") return `Fwd: ${composeReplyTo.subject.replace(/^(Re:\s*|Fwd:\s*)+/i, "")}`;
    return "";
  });
  const [sendError, setSendError] = useWorkspaceState<string | null>("src/features/compose/ComposeView.tsx:ComposeViewInner:sendError", null);
  const sendMutation = useSendEmailMutation();
  const [queuedSend, setQueuedSend] = useWorkspaceState<{
    payload: SendEmailParams;
    deadlineMs: number;
    durationSeconds: number;
  } | null>("src/features/compose/ComposeView.tsx:ComposeViewInner:queuedSend", null);
  const [undoSendRemaining, setUndoSendRemaining] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:undoSendRemaining", 0);
  const [schedulePickerOpen, setSchedulePickerOpen] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:schedulePickerOpen", false);
  const [scheduleLocalValue, setScheduleLocalValue] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:scheduleLocalValue", "");
  const [isScheduling, setIsScheduling] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:isScheduling", false);
  const writingAccountId = fromAccountId ?? activeAccountId;
  const writingDefaults = useWritingPreferences(writingAccountId);

  // ─── Editor ──────────────────────────────────────────────────────────────────
  const {
    editor, editorMode, rawSource, setRawSource,
    richTextHtml, htmlPreview, setHtmlPreview,
    switchMode, textareaRef, quotedReplyHtml,
    editorContentReady, signature: defaultSignature, signatureHtml: defaultSignatureHtml,
  } = useComposeEditor({
    fromAccountId, composeMode, composeReplyTo, isReply, t,
    restoredDraft: restoredDraft.current,
    prefillBody: composePrefill?.body,
    aiGenerated: composePrefill?.aiGenerated,
    preferredSignatureId: writingDefaults.signatureId || undefined,
  });

  // ─── Draft persistence ───────────────────────────────────────────────────────
  // Delay the dirty-snapshot until the editor has run its initial setContent
  // cycle — otherwise the snapshot captures an empty richTextHtml and then
  // flips dirty when signature/quoted-reply text populates.
  // For "new" composes with no signature the editor stays empty but is still
  // "ready" once mounted, so we gate on editor presence plus one effect tick.
  // Attachments are part of the draft snapshot and must be declared before
  // the draft persistence hook.
  const attachInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useWorkspaceState<ComposeAttachment[]>("src/features/compose/ComposeView.tsx:ComposeViewInner:attachments", () =>
    composePrefill?.attachments ?? restoredDraft.current?.attachments ?? [],
  );
  const [isAttachmentDragging, setIsAttachmentDragging] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:isAttachmentDragging", false);
  const [isAiContextDragging, setIsAiContextDragging] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:isAiContextDragging", false);

  const [editorReady, setEditorReady] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:editorReady", false);
  useEffect(() => {
    if (editor && editorContentReady && !editorReady) setEditorReady(true);
  }, [editor, editorContentReady, editorReady]);
  const { draftIdRef, draftIdsByAccountRef, saveNow, isSaving, stopSaving, resumeSaving, hasUnsavedChanges } = useComposeDraft({
    to: mergePendingRecipient(to, toInputValue),
    cc: mergePendingRecipient(cc, ccInputValue),
    bcc: mergePendingRecipient(bcc, bccInputValue),
    subject, rawSource, richTextHtml, editorMode, composeMode, fromAccountId,
    attachments,
    editorReady,
    existingDraftId: restoredDraft.current?.sourceDraftId,
    initialDirty: restoredDraft.current?.unsavedChanges,
    inReplyTo: isReply ? composeReplyTo?.message_id_header ?? undefined : restoredDraft.current?.inReplyTo,
    tabId,
    onSaved: () => {
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
      void queryClient.invalidateQueries({ queryKey: ['folders'] });
    },
  });

  useWorkspacePrepare(async () => {
    if (!editorReady || !fromAccountId) throw new Error('草稿尚未加载完成，请稍后再移动。');
    if (sendMutation.isPending || queuedSend || isScheduling) throw new Error('邮件正在提交或等待撤销发送，请完成后再移动标签。');
    await saveNow();
    await stopSaving();
    try {
      setDraftSnapshot({
        accountId: fromAccountId,
        to: mergePendingRecipient(to, toInputValue), cc: mergePendingRecipient(cc, ccInputValue), bcc: mergePendingRecipient(bcc, bccInputValue),
        subject, rawSource, richTextHtml, editorMode,
        attachments: attachments.map(attachment => ({ ...attachment })),
        quotedReplyHtml: quotedReplyHtml || undefined,
        inReplyTo: (isReply ? composeReplyTo?.message_id_header : restoredDraft.current?.inReplyTo) ?? undefined,
        sourceDraftId: draftIdsByAccountRef.current[fromAccountId] ?? undefined,
        unsavedChanges: hasUnsavedChanges(), savedAt: Date.now(),
      }, tabId);
    } catch (error) { resumeSaving(); throw error; }
    return resumeSaving;
  });

  const [isSavingToClose, setIsSavingToClose] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:isSavingToClose", false);
  async function handleSave(closeAfter = false) {
    if (closeAfter) setIsSavingToClose(true);
    try {
      await saveNow();
      if (closeAfter) {
        const state = useComposeStore.getState();
        const dirty = tabId ? state.tabsById[tabId]?.dirty : state.composeDirty;
        if (dirty) throw new Error(t('compose.changedWhileSaving', '保存期间内容发生了变化，请再次保存。'));
        cancelCloseCompose();
        closeCompose(tabId);
      } else {
        useToastStore.getState().addToast({ type: 'success', message: t('compose.draftSaved', '草稿已保存') });
      }
    } catch (error) {
      useToastStore.getState().addToast({ type: 'error', message: `${t('compose.saveFailed', '草稿保存失败，内容仍保留在编辑器中')}: ${safeErrorMessage(error)}` });
    } finally { setIsSavingToClose(false); }
  }

  // Navigation unmounts this view. Keep the current editor state in memory so
  // returning to the compose tab restores it without putting plaintext in
  // localStorage. Closing/discarding the compose removes the tab first, so
  // this cleanup does not resurrect an intentionally discarded draft.
  useEffect(() => () => {
    // 标签已关闭 / 独立窗口会话已重置 → 不保存。
    if (tabId) {
      if (!useComposeStore.getState().tabsById[tabId]) return;
    } else if (useComposeStore.getState().composeMode === null) {
      return;
    }
    if (!fromAccountId) return;
    setDraftSnapshot({
      accountId: fromAccountId,
      to: [...to], cc: [...cc], bcc: [...bcc], subject,
      rawSource, richTextHtml, editorMode,
      attachments: attachments.map((attachment) => ({ ...attachment })),
      quotedReplyHtml: quotedReplyHtml || undefined,
      inReplyTo: (isReply ? composeReplyTo?.message_id_header : restoredDraft.current?.inReplyTo) ?? undefined,
      sourceDraftId: draftIdsByAccountRef.current[fromAccountId] ?? undefined,
      unsavedChanges: hasUnsavedChanges(),
      savedAt: Date.now(),
    }, tabId);
  }, [attachments, bcc, cc, editorMode, fromAccountId, quotedReplyHtml, rawSource, richTextHtml, setDraftSnapshot, subject, to, tabId]);

  // ─── Templates ───────────────────────────────────────────────────────────────
  const [showTemplates, setShowTemplates] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:showTemplates", false);
  const [templates, setTemplates] = useWorkspaceState<EmailTemplate[]>("src/features/compose/ComposeView.tsx:ComposeViewInner:templates", []);
  const [showSaveTemplate, setShowSaveTemplate] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:showSaveTemplate", false);
  // 附件右键菜单
  const [attachmentMenu, setAttachmentMenu] = useWorkspaceState<{ x: number; y: number; index: number } | null>("src/features/compose/ComposeView.tsx:ComposeViewInner:attachmentMenu", null);
  // 正文图片右键菜单
  const [inlineImageMenu, setInlineImageMenu] = useWorkspaceState<{ x: number; y: number; items: ContextMenuItem[] } | null>("src/features/compose/ComposeView.tsx:ComposeViewInner:inlineImageMenu", null);
  const [templateName, setTemplateName] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:templateName", "");
  const [showQuotedReply, setShowQuotedReply] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:showQuotedReply", true);
  const [signaturePickerOpen, setSignaturePickerOpen] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:signaturePickerOpen", false);
  const [signatures, setSignatures] = useWorkspaceState<EmailSignature[]>("src/features/compose/ComposeView.tsx:ComposeViewInner:signatures", []);

  useEffect(() => {
    if (!fromAccountId) {
      setSignatures([]);
      return;
    }
    void listEmailSignatures(fromAccountId).then(setSignatures).catch(() => setSignatures([]));
  }, [fromAccountId]);

  // 草稿区与右侧 AI 写作共用当前发件账号的写作默认值；本次草稿的临时调整只保存在本组件。
  const [writingProfiles, setWritingProfiles] = useWorkspaceState<StyleProfile[]>("src/features/compose/ComposeView.tsx:ComposeViewInner:writingProfiles", []);
  const [writingOptionsOpen, setWritingOptionsOpen] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:writingOptionsOpen", false);
  const [languageOverride, setLanguageOverride] = useWorkspaceState<string | null>("src/features/compose/ComposeView.tsx:ComposeViewInner:languageOverride", null);
  const [styleOverride, setStyleOverride] = useWorkspaceState<string | null>("src/features/compose/ComposeView.tsx:ComposeViewInner:styleOverride", null);
  const [knowledgeOverride, setKnowledgeOverride] = useWorkspaceState<boolean | null>("src/features/compose/ComposeView.tsx:ComposeViewInner:knowledgeOverride", null);
  const [signatureOverride, setSignatureOverride] = useWorkspaceState<string | null>("src/features/compose/ComposeView.tsx:ComposeViewInner:signatureOverride", null);
  const selectedLanguage = findMailLanguage(languageOverride ?? writingDefaults.language);
  const effectiveLanguage = selectedLanguage?.value ?? "auto";
  const effectiveStyleId = styleOverride ?? (writingDefaults.styleProfileId || writingProfiles.find((profile) => profile.isActive)?.id || "");
  const effectiveIncludeKnowledge = knowledgeOverride ?? writingDefaults.includeKnowledge;
  const effectiveSignatureId = signatureOverride ?? (writingDefaults.signatureId || signatures.find((signature) => signature.is_default)?.id || "");

  useEffect(() => {
    let cancelled = false;
    setLanguageOverride(null);
    setStyleOverride(null);
    setKnowledgeOverride(null);
    setSignatureOverride(null);
    void listStyleProfiles().then((list) => {
      if (!cancelled) setWritingProfiles(list);
    }).catch(() => {
      if (!cancelled) setWritingProfiles([]);
    });
    return () => { cancelled = true; };
  }, [writingAccountId]);

  // Reply mode: draggable splitter between editor and original quoted reply.
  const [draftEditorHeight, setDraftEditorHeight] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:draftEditorHeight", 90);
  const beginDraftResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = draftEditorHeight;
    const onMove = (moveEvent: MouseEvent) => {
      const next = startHeight + (moveEvent.clientY - startY);
      setDraftEditorHeight(Math.max(100, Math.min(window.innerHeight - 200, next)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [draftEditorHeight]);

  // ─── AI 写作助手（写信页内集成） ────────────────────────────────────
  const aiInputFocusOwner = useUIStore((s) => s.aiInputFocusOwner);
  const setAiInputFocusOwner = useUIStore((s) => s.setAiInputFocusOwner);
  const aiPanelLocked = aiInputFocusOwner === "panel";
  const [aiInstruction, setAiInstruction] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:aiInstruction", "");
  const [appliedAiInstruction, setAppliedAiInstruction] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:appliedAiInstruction", '');
  const aiFiles = useAiFileContext(`${fromAccountId}:${tabId ?? 'embedded'}`);
  const aiContextFiles = aiFiles.files.map(item => item.file);
  const aiFileInputRef = useRef<HTMLInputElement>(null);
  const [aiContextMessages, setAiContextMessages] = useWorkspaceState<Array<{ id: string; title: string }>>("src/features/compose/ComposeView.tsx:ComposeViewInner:aiContextMessages", []);
  const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useWorkspaceState<string[]>("src/features/compose/ComposeView.tsx:ComposeViewInner:selectedKnowledgeIds", []);
  const [aiGenerating, setAiGenerating] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:aiGenerating", false);
  const aiRunLock = useRef(false);
  const aiDropZoneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const references = myTab?.pendingAiReferences;
    if (!tabId || !references?.length || aiGenerating) return;
    setAiContextMessages(current => {
      const next = [...current];
      for (const item of references) if (!next.some(existing => existing.id === item.id)) next.push(item);
      return next;
    });
    useComposeStore.getState().clearAiReferences(tabId);
    if (isActive) aiDropZoneRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [tabId, myTab?.pendingAiReferences, aiGenerating, isActive]);
  const fileReadsPending = aiFiles.pending;
  const aiDocumentStatus = aiFiles.status;
  const aiFileError = aiFiles.error;
  const aiContextRef = useRef(`${fromAccountId}:${tabId ?? 'embedded'}`);
  aiContextRef.current = `${fromAccountId}:${tabId ?? 'embedded'}`;
  type AiRevision = { body: string; instruction: string; subject: string; history: { role: 'user' | 'assistant'; content: string }[] };
  const [aiSnapshots, setAiSnapshots] = useWorkspaceState<AiRevision[]>("src/features/compose/ComposeView.tsx:ComposeViewInner:aiSnapshots", []);
  const [aiRedoSnapshots, setAiRedoSnapshots] = useWorkspaceState<AiRevision[]>("src/features/compose/ComposeView.tsx:ComposeViewInner:aiRedoSnapshots", []);
  // Local generation history only. Previous bodies live in undo snapshots;
  // neither old instructions nor old AI replies are sent back to the model.
  const [aiHistory, setAiHistory] = useWorkspaceState<{ role: "user" | "assistant"; content: string }[]>("src/features/compose/ComposeView.tsx:ComposeViewInner:aiHistory", []);
  const knowledgeContextQueue = useUIStore((s) => s.knowledgeContextQueue);
  const clearKnowledgeContextQueue = useUIStore((s) => s.clearKnowledgeContextQueue);
  useEffect(() => {
    if (!isActive) return;
    const pending = knowledgeContextQueue.filter((item) => item.target === "compose").map((item) => item.itemId);
    if (pending.length === 0) return;
    setSelectedKnowledgeIds((current) => [...new Set([...current, ...pending])]);
    clearKnowledgeContextQueue();
  }, [isActive, knowledgeContextQueue, clearKnowledgeContextQueue]);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** 把 AI 生成的邮件草稿写入草稿栏。富文本模式必须走 tiptap setContent
   *  （只改 rawSource 不会刷新编辑器），其他模式直接写 rawSource。 */
  const writeAiReplyToDraft = useCallback((text: string, keepDefaultSignature = false) => {
    const trimmed = text.trim();
    if (!trimmed || !editorContentReady) return false;
    if (editorMode === "rich") {
      if (!editor || editor.isDestroyed) return false;
      const html = appendDefaultSignatureHtml(trimmed, keepDefaultSignature ? defaultSignatureHtml : "");
      if (editor.commands.setContent(html) === false) return false;
      setRawSource(html);
    } else if (editorMode === "html") {
      setRawSource(appendDefaultSignatureHtml(trimmed, keepDefaultSignature ? defaultSignatureHtml : ""));
    } else {
      setRawSource(appendExactAiSignatureText(trimmed, keepDefaultSignature ? defaultSignature : ""));
    }
    return true;
  }, [editorMode, editor, editorContentReady, setRawSource, defaultSignature, defaultSignatureHtml]);

  /** 读取草稿栏当前内容（快照用）。 */
  const readDraftContent = useCallback(() => {
    if (editorMode === "rich" && editor) {
      return editor.getHTML();
    }
    return rawSource || "";
  }, [editorMode, editor, rawSource]);
  const liveDraft = useRef({ readDraftContent, subject, editorMode, writeAiReplyToDraft });
  liveDraft.current = { readDraftContent, subject, editorMode, writeAiReplyToDraft };

  /** 恢复某份快照到草稿栏。 */
  const restoreDraftContent = useCallback((snapshot: string) => {
    if (!editorContentReady) return false;
    if (editorMode === "rich") {
      if (!editor || editor.isDestroyed || editor.commands.setContent(snapshot) === false) return false;
      setRawSource(snapshot);
    } else {
      setRawSource(snapshot);
    }
    return true;
  }, [editorMode, editor, editorContentReady, setRawSource]);

  function addComposeAiFiles(files: FileList | File[]) {
    if (aiGenerating) return;
    aiFiles.add(files);
  }

  function handleComposeAiDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsAiContextDragging(false);
    setIsAttachmentDragging(false);
    if (aiGenerating) return;
    const reference = readMailReference(event.dataTransfer);
    const messageId = reference?.id;
    const attachmentId = event.dataTransfer.getData("application/x-pebble-attachment-id").trim();
    const files = filesFromTransfer(event.dataTransfer);
    if (messageId) {
      setAiContextMessages((current) => current.some((item) => item.id === messageId) ? current : [...current, reference!]);
    }
    if (files.length > 0) addComposeAiFiles(files);
    if (attachmentId && files.length === 0) {
      aiFiles.loadAttachment(attachmentId);
    } else if (!messageId && files.length === 0) {
      aiFiles.fail("没有接收到文件，请重新拖入，或点击“添加参考文件”选择文件。");
      useToastStore.getState().addToast({ message: "没有接收到文件，请重新拖入，或点击“添加参考文件”选择文件。", type: "error" });
    }
  }

  function handleComposeAiPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = filesFromTransfer(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    addComposeAiFiles(files);
  }

  async function handleAiGenerate(instruction = aiInstruction) {
    instruction = instruction.trim();
    if (aiRunLock.current || !instruction || !editorContentReady) return;
    if (aiFileError) {
      useToastStore.getState().addToast({ message: aiFileError, type: "error" });
      return;
    }
    if (fileReadsPending) {
      useToastStore.getState().addToast({ message: "文件正在加载，请稍后再生成草稿。", type: "info" });
      return;
    }
    aiRunLock.current = true;
    const contextAtStart = aiContextRef.current;
    const target = { tabId, embedded: !tabId, accountId: fromAccountId, replyTo: composeReplyTo,
      prefill: { to: [...to], cc: [...cc], bcc: [...bcc], subject } };
    // Commit the revision only after generation succeeds. Keep the exact HTML,
    // matching instruction and conversation together, including an empty draft.
    const previousRevision: AiRevision = { body: readDraftContent(), instruction: appliedAiInstruction || instruction, subject, history: aiHistory };
    setAiGenerating(true);
    try {
      const base = currentDraftForAi(readRevisionText(previousRevision.body, editorMode !== "markdown", editorMode === "markdown" ? defaultSignature : defaultSignatureHtml), subject);
      const documentSections = await aiFiles.read();
      // 与右侧 AI 写作保持一致：带 system 提示词，要求只输出邮件正文。
      let styleProfile = "";
      try {
        const profiles = await listStyleProfiles();
        const selected = profiles.find((p) => p.id === effectiveStyleId) ?? profiles.find((p) => p.isActive);
        styleProfile = selected?.profile ?? "";
      } catch {
        styleProfile = "";
      }
      const system = [writingLanguageInstruction(effectiveLanguage),
        DOCUMENT_DRAFT_RULES,
        AI_REVISION_RULES,
        "你现在扮演我（外贸业务人员），根据我的写作风格写一封商务邮件。",
        (() => { const role = getActiveWorkRole(fromAccountId); return role ? `【我的当前工作角色（用户已允许用于 AI 写作）】\n职位：${role.jobTitle}\n公司：${role.company}\n负责工作：${role.responsibilities}\n产品与市场：${role.productsMarkets}\n可处理范围：${role.permissions}\n沟通偏好：${role.preferences}\n必须遵守：${role.rules}` : ""; })(),
        styleProfile ? `【我的写作风格】\n${styleProfile}` : "（未设置风格档案，按通用专业外贸语气书写）",
        "【硬性要求】",
        "1. 只输出邮件正文本身（含合适的称呼与正文），使用普通邮件排版，绝对不要使用 Markdown 标记（如 **、*、#、- 列表）；绝对不要输出主题/标题/Subject 行；绝对不要输出任何解释、说明、前言、选项列表，不要出现\"以下是\"\"好的\"\"你可以\"等引导语。",
        "2. 每一轮都输出完整、可直接使用的邮件正文（称呼+正文+结尾），内容充分、表述专业；即使对话前文已有草稿，也不得省略、只输出修改片段或大幅精简成几句话。",
        // 有默认签名 → 禁止落款（避免双重签名）；没有 → 允许 AI 按风格写署名结尾。
        (effectiveSignatureId && signatures.some((s) => s.id === effectiveSignatureId && (s.content ?? "").trim())
          ? "3. 不要生成任何签名/落款/署名行（如 Best regards / Regards / Kind regards / Sincerely / Yours faithfully / 此致 / 敬礼 / 你的名字等）。正文在最后一句问候或内容后直接结束——账号的默认签名会由系统自动附加，重复落款会造成邮件出现两个签名。"
          : "3. 你可以在正文结尾按你的写作风格写署名/落款（当前账号未设置默认签名，落款需要由正文自带）。"),
        "4. 不要使用占位符（如 [Your Name]），不确定的内容用自然、稳妥的表达带过。",
        composeReplyTo?.subject ? `【原邮件主题】${composeReplyTo.subject}` : "",
        isReply && composeReplyTo ? `【正在回复的原邮件全文】\n${readReplyDraftText(composeReplyTo)}` : "",
      ].filter(Boolean).join("\n\n");
      const contextParts: string[] = [];
      if (aiContextMessages.length > 0) {
        const messages = await getMessagesBatch(aiContextMessages.map((item) => item.id));
        contextParts.push(readMailReferenceContext(aiContextMessages, messages));
      }
      const documentText = documentSectionsText(documentSections);
      if (documentText) contextParts.push(documentText);
      if (selectedKnowledgeIds.length > 0) {
        try {
          const selectedItems = (await listKnowledgeItems(writingAccountId)).filter((item) => selectedKnowledgeIds.includes(item.id));
          if (selectedItems.length > 0) contextParts.push(`【用户明确选择的资料中心文件】\n${selectedItems.map((item) => `资料：${item.name}\n${item.content.slice(0, 12000)}`).join("\n\n")}`);
        } catch { /* 资料不可用时不阻断草稿生成 */ }
      } else if (effectiveIncludeKnowledge) {
        try {
          const snippets = await searchKnowledgeBase(`${subject}\n${instruction}`, 3, writingAccountId);
          if (snippets.length > 0) {
            contextParts.push(`【本次参考资料库】\n${snippets.map((item) => `${item.name}（${item.locator || item.section || "资料"}）：${item.content}`).join("\n\n")}`);
          }
        } catch {
          // 资料库不可用时仍允许邮件生成，不阻断草稿。
        }
      }
      const userMessage = [documentSections.length ? `【本轮用户指令；若要求根据文件，句式示例只供表达参考，事实以本轮文件为准】\n${instruction}` : `【本轮用户指令】\n${instruction}`, base, contextParts.join("\n\n")]
        .filter(Boolean)
        .join("\n\n");
      // 全局任务标记：即使切到其他页面也不中断、不丢（组件卸载不影响 store）。
      if (aiContextRef.current !== contextAtStart) return;
      useUIStore.getState().setAiBgTask({ running: true, source: "compose", result: null, targetTabId: tabId });
      const reply = await aiChat([{ role: "system", content: system }, { role: "user", content: userMessage }]);
      const selectedSignature = signatures.find((signature) => signature.id === effectiveSignatureId);
      const signatureContent = selectedSignature?.content ?? "";
      const normalized = normalizeAiEmailDraft(reply, isReply);
      const draftReply = normalized.body;
      const sameDraft = mountedRef.current && aiContextRef.current === contextAtStart;
      const latest = liveDraft.current;
      if (sameDraft && (latest.readDraftContent() !== previousRevision.body || latest.subject !== subject || latest.editorMode !== editorMode)) {
        deliverAiDraft({ ...target, tabId: undefined, embedded: false }, { body: draftReply, signature: signatureContent, subject: normalized.subject ?? subject });
        useUIStore.getState().setAiBgTask({ running: false, source: "compose", result: null });
        useToastStore.getState().addToast({ message: "生成期间草稿有改动，AI 结果已放到新草稿，原稿保持不变。", type: "info" });
        return;
      }
      if (sameDraft && latest.writeAiReplyToDraft(draftReply, Boolean(signatureContent))) {
        if (!isReply && normalized.subject) setSubject(normalized.subject);
        useToastStore.getState().addToast({ message: "AI 草稿已写入正文，可继续编辑或再次输入指令调整。", type: "success" });
      } else {
        const delivery = deliverAiDraft(target, { body: draftReply, signature: signatureContent, subject: normalized.subject });
        useToastStore.getState().addToast({ message: delivery === 'queued' ? "AI 草稿已生成，原草稿准备好后将自动填入。" : "AI 草稿已生成，已打开独立草稿供您查看。", type: "info" });
      }
      useUIStore.getState().setAiBgTask({ running: false, source: "compose", result: draftReply, signature: signatureContent, subject: normalized.subject, targetTabId: tabId });
      if (sameDraft) {
        setAiHistory([...aiHistory, { role: "user" as const, content: instruction }].slice(-8));
        setAiSnapshots(previous => [...previous, previousRevision].slice(-8));
        setAiRedoSnapshots([]);
        setAppliedAiInstruction(instruction);
        setAiInstruction("");
      }
    } catch (error) {
      useUIStore.getState().setAiBgTask({ running: false, source: 'compose', result: null });
      useToastStore.getState().addToast({ message: `AI 生成失败：${String(error)}`, type: "error" });
    } finally {
      aiRunLock.current = false;
      setAiGenerating(false);
    }
  }

  /** 撤销到上一步：回到自己修改过的上一版草稿。 */
  function handleAiUndo() {
    const snapshot = aiSnapshots[aiSnapshots.length - 1];
    if (!snapshot) return;
    const current: AiRevision = { body: readDraftContent(), instruction: appliedAiInstruction || aiInstruction, subject, history: aiHistory };
    if (!restoreDraftContent(snapshot.body)) return;
    setAiRedoSnapshots(prev => [...prev, current].slice(-8));
    setAiInstruction(snapshot.instruction);
    setAppliedAiInstruction(snapshot.instruction);
    setSubject(snapshot.subject);
    setAiHistory(snapshot.history);
    setAiSnapshots((prev) => prev.slice(0, -1));
    useToastStore.getState().addToast({ message: "已恢复到上一版草稿。", type: "success" });
  }

  /** 恢复到撤销前的下一版草稿。 */
  function handleAiRedo() {
    const snapshot = aiRedoSnapshots[aiRedoSnapshots.length - 1];
    if (!snapshot) return;
    const current: AiRevision = { body: readDraftContent(), instruction: appliedAiInstruction || aiInstruction, subject, history: aiHistory };
    if (!restoreDraftContent(snapshot.body)) return;
    setAiSnapshots(prev => [...prev, current].slice(-8));
    setAiInstruction(snapshot.instruction);
    setAppliedAiInstruction(snapshot.instruction);
    setSubject(snapshot.subject);
    setAiHistory(snapshot.history);
    setAiRedoSnapshots((prev) => prev.slice(0, -1));
    useToastStore.getState().addToast({ message: "已恢复到下一版草稿。", type: "success" });
  }

  /** 工具栏“插入签名”：先选择该账号的签名，再插入到光标处。 */
  function handleInsertSignature(signature: EmailSignature) {
    try {
      const content = signature.content.trim();
      if (!content) {
        useToastStore.getState().addToast({ message: "当前账号尚未设置签名，可在 设置 → 账号 → 邮件签名 中添加。", type: "error" });
        return;
      }
      if (editorMode === "rich" && editor) {
        const isHtml = /<[a-z][\s\S]*>/i.test(content);
        const safeContent = isHtml
          ? content
          : content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br>");
        // 与自动带出的签名格式统一：`<br/><br/>` 间距 + `--` 分隔线 + 签名。
        // 之前手动插入是裸签名（无分隔线），和写新邮件自动带出的签名不一致。
        editor.chain().focus().insertContent(`<br/><br/><div style="color:var(--color-text-secondary);font-size:13px">--<br/>${safeContent}</div>`).run();
      } else {
        setRawSource((previous) => `${(previous || "").trimEnd()}\n\n${content}`.trimStart());
      }
      setSignaturePickerOpen(false);
    } catch (error) {
      useToastStore.getState().addToast({ message: `插入签名失败：${String(error)}`, type: "error" });
    }
  }

  function openSignaturePicker() {
    if (signatures.length === 0) {
      useToastStore.getState().addToast({ message: "当前账号没有可用签名，请先在账号设置中添加。", type: "error" });
      return;
    }
    setSignaturePickerOpen((open) => !open);
  }

  // Background results are consumed only from the bound ComposeTab below.
  function handleAiClear() {
    setAiHistory([]);
    setAppliedAiInstruction('');
    setAiSnapshots([]);
    setAiRedoSnapshots([]);
    setAiInstruction("");
    aiFiles.clear();
    setAiContextMessages([]);
  }
  // ─── Knowledge base insertion ────────────────────────────────────────────────
  const [showKnowledgePicker, setShowKnowledgePicker] = useWorkspaceState("src/features/compose/ComposeView.tsx:ComposeViewInner:showKnowledgePicker", false);
  const [knowledgeItems, setKnowledgeItems] = useWorkspaceState<KnowledgeItem[]>("src/features/compose/ComposeView.tsx:ComposeViewInner:knowledgeItems", []);
  // 资料库与签名都是临时浮层：点到编辑区、收件人或别处就应收起，不必先点关闭。
  const knowledgeMenuRef = useRef<HTMLDivElement>(null);
  const signatureMenuRef = useRef<HTMLDivElement>(null);
  useClickOutside(knowledgeMenuRef, showKnowledgePicker, () => setShowKnowledgePicker(false));
  useClickOutside(signatureMenuRef, signaturePickerOpen, () => setSignaturePickerOpen(false));

  async function toggleKnowledgePicker() {
    if (knowledgeItems.length === 0) {
      try {
        setKnowledgeItems(await listKnowledgeItems(writingAccountId));
      } catch {
        /* ignore */
      }
    }
    setShowKnowledgePicker((v) => !v);
  }

  // 把资料库条目作为附件加入邮件（资料库存的是文本内容，生成同名的 .txt 文件）
  async function insertKnowledge(item: KnowledgeItem) {
    setShowKnowledgePicker(false);
    const fileName = /\.\w+$/.test(item.name) ? item.name : `${item.name}.txt`;
    const file = new File([item.content], fileName, { type: "text/plain" });
    try {
      await stageAttachmentFiles([file]);
    } catch (err) {
      setSendError(typeof err === "string" ? err : "加入资料库附件失败，请重试");
    }
  }

  useEffect(() => {
    const body = editorMode === "rich" && editor ? editor.getHTML() : rawSource;
    const bodyText = readRevisionText(body, editorMode !== "markdown", editorMode === "markdown" ? defaultSignature : defaultSignatureHtml);
    setActiveDraftContext({ fromAccountId, to, cc, bcc, subject, body, bodyText }, tabId);
    return () => setActiveDraftContext(null, tabId);
  }, [fromAccountId, to, cc, bcc, subject, rawSource, richTextHtml, editorMode, editor, defaultSignature, defaultSignatureHtml, setActiveDraftContext, tabId]);

  useEffect(() => {
    if (!isActive || !editorContentReady || pendingAiBody == null) return;
    if (!writeAiReplyToDraft(pendingAiBody, pendingAiSignature !== null)) return;
    if (!isReply && pendingAiSubject) setSubject(pendingAiSubject);
    clearPendingAiBody(tabId);
    useToastStore.getState().addToast({ message: "AI 草稿已写入正文，可继续编辑。", type: "success" });
  }, [isActive, editorContentReady, pendingAiBody, pendingAiSubject, pendingAiSignature, isReply, writeAiReplyToDraft, clearPendingAiBody, tabId]);

  async function refreshTemplates() {
    try {
      const next = await listTemplates();
      setTemplates(next);
      return next;
    } catch (err) {
      console.warn("Failed to load templates:", err);
      return [];
    }
  }

  async function stageAttachmentFiles(files: FileList | File[]) {
    const staged: ComposeAttachment[] = [];
    for (const file of Array.from(files)) {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const path = await stageComposeAttachment(file.name, bytes);
      staged.push({ name: file.name, path, size: file.size });
    }
    setAttachments((prev) => [...prev, ...staged]);
  }

  /** 把图片文件转成 base64 data URL（用于插入正文）。 */
  function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  /** 判断文件名是否为常见图片格式。 */
  function isImageFileName(name: string): boolean {
    return /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(name);
  }

  /** 把本地附件（图片）插入到正文光标处，并从附件栏移除。 */
  async function insertAttachmentAsInlineImage(att: ComposeAttachment) {
    if (!editor) return;
    try {
      const b64 = await invoke<string>("read_file_as_base64", { path: att.path });
      const mime = att.name.toLowerCase().endsWith(".png") ? "image/png"
        : att.name.toLowerCase().endsWith(".gif") ? "image/gif"
        : att.name.toLowerCase().endsWith(".webp") ? "image/webp"
        : att.name.toLowerCase().endsWith(".bmp") ? "image/bmp"
        : att.name.toLowerCase().endsWith(".svg") ? "image/svg+xml"
        : "image/jpeg";
      editor.chain().focus().setImage({ src: `data:${mime};base64,${b64}` }).run();
      setAttachments((prev) => prev.filter((a) => a.path !== att.path));
    } catch (err) {
      console.warn("Failed to insert attachment as inline image:", err);
      useToastStore.getState().addToast({ message: t("compose.insertInlineFailed", "插入正文失败，请重试"), type: "error" });
    }
  }

  async function handleSaveTemplate() {
    if (!templateName.trim()) return;
    const bodyContent = editorMode === "rich" && editor ? editor.getHTML() : rawSource;
    await saveTemplate({ name: templateName.trim(), subject, body: bodyContent });
    setTemplateName("");
    setShowSaveTemplate(false);
    void refreshTemplates();
  }

  // Sending errors remain visible until a new attempt or explicit dismissal.

  async function finishAcceptedSend(accountId: string) {
    await stopSaving();
    const draftIdsToDelete = { ...draftIdsByAccountRef.current };
    if (draftIdRef.current) {
      draftIdsToDelete[accountId] = draftIdRef.current;
    }
    for (const [draftAccountId, draftId] of Object.entries(draftIdsToDelete)) {
      deleteDraft(draftAccountId, draftId).catch((err) => {
        console.warn("Failed to delete draft after send:", err);
        useToastStore.getState().addToast({
          type: "error",
          message: t(
            "compose.savedDraftCleanupFailed",
            "内容已保留，但旧草稿清理失败，可稍后在草稿箱处理。不要因此重复发送。",
          ),
        });
      });
    }
    draftIdsByAccountRef.current = {};
    draftIdRef.current = null;
    clearDraftStorage();
    useComposeStore.getState().setComposeDirty(false, tabId);
    closeCompose(tabId);
  }

  function sendNow(payload: SendEmailParams) {
    sendMutation.mutate(payload, {
      onSuccess: (result) => {
        if (result.warning || result.status === "queued") {
          reportMailFailure({ account_id: payload.accountId, operation_id: result.operationId, op_type: 'send',
            message: result.warning || "邮件未发送，已保存在发件箱，自动重试已暂停。请核对后在待处理操作中重试。" }, accounts);
        } else {
          useToastStore.getState().addToast({ type: "success", message: "邮件已提交给发送服务器" });
        }
        finishAcceptedSend(payload.accountId);
      },
      onError: (e) => {
        const msg = safeErrorMessage(e);
        setSendError(msg || t("compose.sendError", "Failed to send"));
      },
    });
  }

  useEffect(() => {
    if (!queuedSend) return;

    const updateRemaining = () => {
      setUndoSendRemaining(getUndoSendRemainingSeconds(queuedSend.deadlineMs));
    };
    updateRemaining();
    const intervalId = window.setInterval(updateRemaining, 100);
    const timeoutId = window.setTimeout(() => {
      const payload = queuedSend.payload;
      setQueuedSend(null);
      setUndoSendRemaining(0);
      sendNow(payload);
    }, Math.max(0, queuedSend.deadlineMs - Date.now()));

    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
    };
  }, [queuedSend]);

  function cancelQueuedSend() {
    if (!queuedSend) return;
    setQueuedSend(null);
    setUndoSendRemaining(0);
    useToastStore.getState().addToast({
      type: "success",
      message: t("compose.sendCancelled", "已取消发送，邮件仍保留在草稿中"),
    });
  }

  async function handleSend(sendAt?: number) {
    if (queuedSend || sendMutation.isPending || isScheduling) return;
    const finalTo = mergePendingRecipient(to, toInputValue).filter(Boolean);
    const finalCc = mergePendingRecipient(cc, ccInputValue).filter(Boolean);
    const finalBcc = mergePendingRecipient(bcc, bccInputValue).filter(Boolean);

    if (!fromAccountId || finalTo.length === 0) return;

    setTo(finalTo);
    setCc(finalCc);
    setBcc(finalBcc);
    if (isValidEmailAddress(toInputValue)) setToInputValue("");
    if (isValidEmailAddress(ccInputValue)) setCcInputValue("");
    if (isValidEmailAddress(bccInputValue)) setBccInputValue("");

    if (!subject.trim()) {
      const confirmed = await useConfirmStore.getState().confirm({
        title: t("compose.noSubjectTitle", "No subject"),
        message: t("compose.noSubjectConfirm", "Send without a subject?"),
        confirmLabel: t("common.send", "Send"),
      });
      if (!confirmed) return;
    }

    setSendError(null);

    let bodyHtml = "";
    let bodyText = "";

    if (editorMode === "rich" && editor) {
      bodyHtml = editor.getHTML();
      bodyText = editor.getText();
    } else if (editorMode === "html") {
      bodyHtml = rawSource;
      const tmp = document.createElement("div");
      tmp.innerHTML = rawSource;
      bodyText = tmp.textContent || tmp.innerText || "";
    } else {
      if (editor) {
        editor.commands.setContent(rawSource);
        bodyHtml = editor.getHTML();
        bodyText = rawSource;
      }
    }
    const outgoingBodyHtml = appendReplyQuoteHtml(bodyHtml, quotedReplyHtml);

    const inReplyTo =
      isReply && composeReplyTo?.message_id_header
        ? composeReplyTo.message_id_header
        : restoredDraft.current?.inReplyTo;

    // ─── Send Guard: soft warning before the email actually goes out ───────────
    if (fromAccountId) {
      try {
        const guardCfg = await getSendGuardConfig();
        if (guardCfg.enabled) {
          const verdict = await checkSendGuard({
            accountId: fromAccountId,
            to: finalTo,
            cc: finalCc,
            bcc: finalBcc,
            subject,
            bodyText,
          });
          if (verdict.level === "warn" || verdict.level === "block") {
            const message = verdict.reasons.length
              ? verdict.reasons.join("\n")
              : t("sendGuard.warnGeneric");
            if (verdict.level === "block") {
              // Strict mode: default is to return and fix; override via "still send".
              const override = !(await useConfirmStore.getState().confirm({
                title: t("sendGuard.warnTitle"),
                message: `${message}\n\n${t("sendGuard.blockHint")}`,
                confirmLabel: t("sendGuard.editAndReturn"),
                cancelLabel: t("sendGuard.forceSend"),
              }));
              if (!override) return;
            } else {
              const ok = await useConfirmStore.getState().confirm({
                title: t("sendGuard.warnTitle"),
                message,
                confirmLabel: t("sendGuard.sendAnyway"),
                cancelLabel: t("common.cancel", "Cancel"),
              });
              if (!ok) return;
            }
          }
        }
      } catch (err) {
        // Guard failures must never block a legitimate send.
        console.warn("Send guard check failed, proceeding to send:", err);
      }
    }

    const payload: SendEmailParams = {
      accountId: fromAccountId,
      to: finalTo,
      cc: finalCc,
      bcc: finalBcc,
      subject,
      bodyText,
      bodyHtml: outgoingBodyHtml || undefined,
      inReplyTo: inReplyTo || undefined,
      attachmentPaths: attachments.length > 0 ? attachments.map((a) => a.path) : undefined,
    };
    if (typeof sendAt === "number") {
      setIsScheduling(true);
      setSchedulePickerOpen(false);
      try {
        await scheduleEmail(
          payload.accountId,
          payload.to,
          payload.cc,
          payload.bcc,
          payload.subject,
          payload.bodyText,
          payload.bodyHtml,
          payload.inReplyTo,
          payload.attachmentPaths,
          sendAt,
        );
        useToastStore.getState().addToast({
          type: "success",
          duration: 8000,
          message: t("compose.scheduledSuccess", "邮件已加入发件箱，将在设定时间自动发送"),
        });
        finishAcceptedSend(payload.accountId);
      } catch (error) {
        setSendError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsScheduling(false);
      }
      return;
    }
    const delaySeconds = readUndoSendDelay();
    if (delaySeconds === 0) {
      sendNow(payload);
      return;
    }
    setUndoSendRemaining(delaySeconds);
    setQueuedSend({
      payload,
      durationSeconds: delaySeconds,
      deadlineMs: Date.now() + delaySeconds * 1000,
    });
  }

  const title =
    composeMode === "reply"
      ? t("compose.reply", "Reply")
      : composeMode === "reply-all"
        ? t("compose.replyAll", "Reply All")
        : composeMode === "forward"
          ? t("compose.forward", "Forward")
          : t("compose.newMessage", "New Message");
  const hasToRecipient = to.some(Boolean) || isValidEmailAddress(toInputValue);
  const sendDisabled = sendMutation.isPending || isScheduling || Boolean(queuedSend) || !fromAccountId || !hasToRecipient;

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          e.stopPropagation();
          if (!isSaving && !sendMutation.isPending && !isScheduling && !queuedSend) void handleSave();
          return;
        }
        // Ctrl+Enter（Mac 为 Cmd+Enter）直接发送：与发送按钮同一套校验（sendDisabled）。
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.shiftKey && !e.altKey) {
          if (sendDisabled) return;
          e.preventDefault();
          void handleSend();
        }
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex", alignItems: "center", justifyContent: "flex-start",
          padding: "10px 20px",
          borderBottom: "1px solid var(--color-border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button
            onClick={() => closeCompose(tabId)}
            style={composeStyles.backBtn}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--color-bg-hover, rgba(0,0,0,0.04))"; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
          >
            <ArrowLeft size={16} />
            {t("compose.back", "Back")}
          </button>
          <span style={{ fontWeight: 600, fontSize: "15px", color: "var(--color-text-primary)" }}>
            {title}
          </span>
        </div>
        <button type="button" className="compose-toolbar-icon-button"
          style={{ marginLeft: '16px' }}
          title={t('compose.saveDraft', '保存草稿') + ' (Ctrl+S)'}
          aria-label={t('compose.saveDraft', '保存草稿')}
          disabled={isSaving || !editorReady || sendMutation.isPending || isScheduling || Boolean(queuedSend)}
          onClick={() => void handleSave()}><Save size={16} /></button>
        <div style={{ position: "relative", display: "flex", marginLeft: "8px" }}>
          <button
            onClick={() => void handleSend()}
            disabled={sendDisabled}
            style={{
              display: "flex", alignItems: "center", gap: "6px",
              padding: "7px 16px",
              backgroundColor: sendMutation.isPending || queuedSend || isScheduling ? "var(--color-text-secondary)" : "var(--color-accent, #2563eb)",
              color: "#fff", border: "none", borderRadius: "6px 0 0 6px",
              cursor: sendDisabled ? "default" : "pointer",
              opacity: hasToRecipient ? 1 : 0.5,
              fontSize: "13px", fontWeight: 500,
            }}
          >
            <Send size={14} />
            {sendMutation.isPending
              ? t("compose.sending", "正在连接邮箱服务器…")
              : isScheduling
                ? t("compose.scheduling", "正在安排…")
                : queuedSend
                  ? t("compose.waitingToSend", "等待发送…")
                  : t("compose.send", "Send")}
          </button>
          <button
            type="button"
            aria-label={t("compose.scheduleSend", "定时发送")}
            title="设置这份邮件的发送时间。到期后需要软件运行并联网，邮件才会进入发送流程。"
            disabled={sendDisabled}
            onClick={() => {
              if (!scheduleLocalValue) {
                const next = new Date(Date.now() + 60 * 60 * 1000);
                next.setMinutes(0, 0, 0);
                const local = new Date(next.getTime() - next.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
                setScheduleLocalValue(local);
              }
              setSchedulePickerOpen((open) => !open);
            }}
            style={{ padding: "7px 8px", border: "none", borderLeft: "1px solid rgba(255,255,255,.35)", borderRadius: "0 6px 6px 0", background: "var(--color-accent, #2563eb)", color: "#fff", cursor: sendDisabled ? "default" : "pointer", opacity: hasToRecipient ? 1 : 0.5 }}
          ><ChevronDown size={14} /></button>
          {schedulePickerOpen && (
            <div style={{ position: "absolute", zIndex: 50, right: 0, top: "calc(100% + 7px)", width: "285px", padding: "12px", border: "1px solid var(--color-border)", borderRadius: "8px", background: "var(--color-bg)", boxShadow: "0 8px 24px rgba(0,0,0,.16)" }}>
              <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>{t("compose.scheduleSend", "定时发送")}</div>
              <input type="datetime-local" value={scheduleLocalValue} min={new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)} onChange={(event) => setScheduleLocalValue(event.target.value)} style={{ width: "100%", boxSizing: "border-box", padding: "8px", border: "1px solid var(--color-border)", borderRadius: "6px", background: "var(--color-bg)", color: "var(--color-text-primary)" }} />
              <p style={{ margin: "7px 0 10px", color: "var(--color-text-secondary)", fontSize: "11px", lineHeight: 1.45 }}>{t("compose.scheduleHint", "软件关闭后计划仍会保留；到达时间后，下次软件运行并联网时会自动发送。")}</p>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "7px" }}>
                <button type="button" onClick={() => setSchedulePickerOpen(false)} style={{ padding: "6px 10px", border: "1px solid var(--color-border)", borderRadius: "6px", background: "transparent", color: "var(--color-text-primary)" }}>{t("common.cancel", "取消")}</button>
                <button type="button" onClick={() => { const value = new Date(scheduleLocalValue).getTime(); if (Number.isFinite(value)) void handleSend(Math.floor(value / 1000)); }} disabled={!scheduleLocalValue || new Date(scheduleLocalValue).getTime() <= Date.now() + 5000} style={{ padding: "6px 12px", border: "none", borderRadius: "6px", background: "var(--color-accent)", color: "#fff", opacity: !scheduleLocalValue || new Date(scheduleLocalValue).getTime() <= Date.now() + 5000 ? .5 : 1 }}>{t("compose.confirmSchedule", "确认定时发送")}</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {queuedSend && (
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: "10px 20px 12px",
            borderBottom: "1px solid var(--color-border)",
            background: "var(--color-bg-secondary)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <button
              type="button"
              onClick={cancelQueuedSend}
              style={{
                padding: "7px 16px",
                borderRadius: "6px",
                border: "1px solid var(--color-accent)",
                background: "var(--color-bg)",
                color: "var(--color-accent)",
                cursor: "pointer",
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              {t("compose.cancelSend", "取消发送")}
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>
                {t("compose.undoSendCountdown", "将在 {{seconds}} 秒后发送", { seconds: undoSendRemaining })}
              </div>
              <div style={{ height: "5px", marginTop: "7px", borderRadius: "999px", overflow: "hidden", background: "var(--color-border)" }}>
                <div style={{
                  width: `${Math.max(0, Math.min(100, (undoSendRemaining / queuedSend.durationSeconds) * 100))}%`,
                  height: "100%",
                  borderRadius: "inherit",
                  background: "var(--color-accent)",
                  transition: "width 100ms linear",
                }} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Error banner */}
      {sendError && (
        <div role="alert" aria-live="assertive" style={{
          display: "flex", alignItems: "center", gap: "8px",
          padding: "8px 20px",
          backgroundColor: "var(--color-error-bg, #fef2f2)",
          color: "var(--color-error, #dc2626)",
          fontSize: "13px",
          borderBottom: "1px solid var(--color-border)",
        }}>
          <AlertCircle size={14} />
          <span style={{ flex: 1 }}>{sendError}</span>
          <button
            onClick={() => setSendError(null)}
            aria-label={t("common.close", "Close")}
            style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", display: "flex" }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Fields + Editor */}
      <div className="scroll-region compose-scroll" data-email-translation-scope style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "auto" }}>
        <div className="compose-form-shell">
          {/* From */}
          {accounts.length > 1 && (
            <div style={composeStyles.fieldRow}>
              <label htmlFor="compose-from-account" style={composeStyles.fieldLabel}>
                {t("compose.from", "From")}
              </label>
              <select
                id="compose-from-account"
                name="from"
                value={fromAccountId}
                onChange={(e) => setFromAccountId(e.target.value)}
                style={{
                  flex: 1, padding: "6px 0", border: "none",
                  backgroundColor: "transparent", fontSize: "13px",
                  color: "var(--color-text-primary)", cursor: "pointer",
                }}
              >
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.display_name ? `${acc.display_name} <${acc.email}>` : acc.email}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* To */}
          <div style={composeStyles.fieldRow}>
            <label id="compose-to-label" htmlFor="compose-to-input" style={composeStyles.fieldLabel}>
              {t("compose.to", "To")}
            </label>
            <ContactAutocomplete
              id="compose-to-input"
              name="to"
              ariaLabelledBy="compose-to-label"
              value={to}
              onChange={setTo}
              accountId={fromAccountId}
              inputValue={toInputValue}
              onInputValueChange={setToInputValue}
              placeholder="recipient@example.com"
            />
            <div style={{ display: "flex", gap: "4px", padding: "0 8px", flexShrink: 0 }}>
              {!showCc && <button onClick={() => setShowCc(true)} style={composeStyles.toggleBtn}>{t("compose.cc", "Cc")}</button>}
              {!showBcc && <button onClick={() => setShowBcc(true)} style={composeStyles.toggleBtn}>{t("compose.bcc", "Bcc")}</button>}
            </div>
          </div>

          {showCc && (
            <div style={composeStyles.fieldRow}>
              <label id="compose-cc-label" htmlFor="compose-cc-input" style={composeStyles.fieldLabel}>
                {t("compose.cc", "Cc")}
              </label>
              <ContactAutocomplete
                id="compose-cc-input"
                name="cc"
                ariaLabelledBy="compose-cc-label"
                value={cc}
                onChange={setCc}
                accountId={fromAccountId}
                inputValue={ccInputValue}
                onInputValueChange={setCcInputValue}
                placeholder="cc@example.com"
              />
            </div>
          )}

          {showBcc && (
            <div style={composeStyles.fieldRow}>
              <label id="compose-bcc-label" htmlFor="compose-bcc-input" style={composeStyles.fieldLabel}>
                {t("compose.bcc", "Bcc")}
              </label>
              <ContactAutocomplete
                id="compose-bcc-input"
                name="bcc"
                ariaLabelledBy="compose-bcc-label"
                value={bcc}
                onChange={setBcc}
                accountId={fromAccountId}
                inputValue={bccInputValue}
                onInputValueChange={setBccInputValue}
                placeholder="bcc@example.com"
              />
            </div>
          )}

          {/* Subject */}
          <div style={composeStyles.fieldRow}>
            <label htmlFor="compose-subject" style={composeStyles.fieldLabel}>
              {t("compose.subject", "Subject")}
            </label>
              <input
                id="compose-subject"
                name="subject"
                type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
                placeholder=""
                autoComplete="off"
                style={{ flex: 1, padding: "8px 0", border: "none", backgroundColor: "transparent", fontSize: "13px", color: "var(--color-text-primary)" }}
              />
          </div>

          {/* Toolbar */}
          <div className="compose-editor-toolbar-row">
            <div className="compose-toolbar-tools">
              <div className="compose-toolbar-actions">
                <button
                  type="button"
                  onClick={() => attachInputRef.current?.click()}
                  title={t("compose.attach", "Attach file")}
                  aria-label={t("compose.attach", "Attach file")}
                  className="compose-toolbar-icon-button"
                >
                  <Paperclip size={13} />
                </button>
                <input
                  ref={attachInputRef}
                  type="file"
                  multiple
                  style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0,0,0,0)", border: 0 }}
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(e) => {
                    const files = e.target.files;
                    if (!files) return;
                    void stageAttachmentFiles(files).catch((err) => {
                      console.warn("Failed to stage attachment:", err);
                      setSendError(t("compose.attachmentStageError", "Failed to attach file"));
                    });
                    e.target.value = "";
                  }}
                />
                <div style={{ position: "relative" }}>
                  <button
                    type="button"
                    onClick={() => { void refreshTemplates(); setShowTemplates((v) => !v); }}
                    aria-haspopup="listbox"
                    aria-expanded={showTemplates}
                    aria-label={t("compose.templates", "Templates")}
                    title={t("compose.templates", "Templates")}
                    className={`compose-toolbar-icon-button${showTemplates ? " is-active" : ""}`}
                  >
                    <BookTemplate size={13} />
                  </button>
                  {showTemplates && (
                    <div className="scroll-region compose-template-scroll" style={{
                      position: "absolute", top: "100%", left: 0, zIndex: 100,
                      backgroundColor: "var(--color-bg)", border: "1px solid var(--color-border)",
                      borderRadius: "8px", boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
                      minWidth: "220px", maxHeight: "300px", overflowY: "auto",
                    }}>
                      <div style={{ padding: "8px", borderBottom: "1px solid var(--color-border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span id="compose-templates-label" style={{ fontSize: "12px", fontWeight: 600 }}>{t("compose.templates", "Templates")}</span>
                        <button
                          type="button"
                          onClick={() => { setShowSaveTemplate(true); setShowTemplates(false); }}
                          style={{ fontSize: "11px", border: "none", background: "none", cursor: "pointer", color: "var(--color-accent)" }}
                        >
                          {t("compose.saveAsTemplate", "Save current")}
                        </button>
                      </div>
                      {templates.length === 0 ? (
                        <div style={{ padding: "16px", textAlign: "center", fontSize: "12px", color: "var(--color-text-secondary)" }}>
                          {t("compose.noTemplates", "No templates saved")}
                        </div>
                      ) : (
                        <ul
                          role="listbox"
                          aria-labelledby="compose-templates-label"
                          style={{ listStyle: "none", margin: 0, padding: 0 }}
                        >
                          {templates.map((tpl) => {
                            const applyTemplate = () => {
                              setSubject(tpl.subject);
                              setRawSource(tpl.body);
                              if (editor) editor.commands.setContent(tpl.body);
                              setShowTemplates(false);
                            };
                            return (
                              <li
                                key={tpl.id}
                                role="option"
                                aria-selected={false}
                                tabIndex={0}
                                onClick={applyTemplate}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    applyTemplate();
                                  }
                                }}
                                style={{
                                  display: "flex", alignItems: "center", padding: "8px",
                                  borderBottom: "1px solid var(--color-border)", cursor: "pointer",
                                  fontSize: "12px",
                                }}
                              >
                                <div style={{ flex: 1, overflow: "hidden" }}>
                                  <div style={{ fontWeight: 500 }}>{tpl.name}</div>
                                  <div style={{ color: "var(--color-text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{tpl.subject}</div>
                                </div>
                                <button
                                  type="button"
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    const confirmed = await useConfirmStore.getState().confirm({
                                      title: t("compose.deleteTemplate", "Delete template"),
                                      message: t("compose.deleteTemplate", "Delete template") + ` "${tpl.name}"?`,
                                      destructive: true,
                                    });
                                    if (confirmed) {
                                      await deleteTemplate(tpl.id);
                                      void refreshTemplates();
                                    }
                                  }}
                                  aria-label={t("compose.deleteTemplate", "Delete template")}
                                  title={t("compose.deleteTemplate", "Delete template")}
                                  style={{ border: "none", background: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: "2px" }}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="compose-toolbar-divider" />

              {/* Formatting toolbar */}
              <div className="compose-format-toolbar-slot">
                <div ref={knowledgeMenuRef} style={{ position: "relative", display: "inline-block", marginRight: "8px" }}>
                  <button
                    type="button"
                    onClick={() => void toggleKnowledgePicker()}
                    title="把资料库文件作为附件加入邮件"
                    className={`compose-toolbar-text-button${showKnowledgePicker ? " is-active" : ""}`}
                  >
                    <Library size={14} /> 资料库
                  </button>
                  {showKnowledgePicker && (
                    <div style={{ position: "absolute", top: "28px", left: 0, zIndex: 50, width: "280px", maxHeight: "300px", overflowY: "auto", border: "1px solid var(--color-border)", borderRadius: "8px", background: "#fff", boxShadow: "0 6px 20px rgba(0,0,0,0.18)" }}>
                      {knowledgeItems.length === 0 ? (
                        <div style={{ padding: "10px 12px", fontSize: "12px", color: "var(--color-text-secondary)" }}>本地资料库为空，请先在设置中添加资料。</div>
                      ) : (
                        knowledgeItems.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => insertKnowledge(item)}
                            style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 12px", border: 0, borderBottom: "1px solid var(--color-border)", background: "transparent", cursor: "pointer", fontSize: "12px", color: "var(--color-text-primary)" }}
                          >
                            <strong>{item.name}</strong>
                            <span style={{ display: "block", fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "2px" }}>{item.content.slice(0, 60)}…</span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
                {editorMode === "rich" && editor && (
                  <div ref={signatureMenuRef} style={{ position: "relative" }}>
                    <EditorToolbar editor={editor} onInsertSignature={openSignaturePicker} />
                    {signaturePickerOpen && (
                      <div style={{ position: "absolute", left: 0, top: "30px", zIndex: 1000, minWidth: 220, maxWidth: 320, padding: 6, border: "1px solid var(--color-border)", borderRadius: 7, background: "var(--color-bg-primary)", boxShadow: "0 8px 24px rgba(0,0,0,0.28)" }}>
                        <div style={{ padding: "4px 8px", fontSize: 11, color: "var(--color-text-secondary)" }}>选择要插入的签名</div>
                        {signatures.map((signature) => (
                          <button key={signature.id} type="button" onClick={() => handleInsertSignature(signature)} style={{ display: "block", width: "100%", padding: "7px 8px", border: 0, borderRadius: 5, textAlign: "left", background: "transparent", color: "var(--color-text-primary)", cursor: "pointer" }}>
                            <strong style={{ fontSize: 12 }}>{signature.name}{signature.is_default ? "（默认）" : ""}</strong>
                            <span style={{ display: "block", marginTop: 2, fontSize: 11, color: "var(--color-text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{signature.content.replace(/\s+/g, " ").slice(0, 70)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {editorMode === "markdown" && (
                  <MarkdownToolbar textareaRef={textareaRef} onInsert={setRawSource} source={rawSource} />
                )}
                {editorMode === "html" && (
                  <button
                    type="button"
                    onClick={() => setHtmlPreview((v) => !v)}
                    title={htmlPreview ? t("compose.mode.hidePreview", "Hide preview") : t("compose.mode.showPreview", "Show preview")}
                    className={`compose-toolbar-text-button${htmlPreview ? " is-active" : ""}`}
                  >
                    {htmlPreview ? <EyeOff size={13} /> : <Eye size={13} />}
                    {htmlPreview ? t("compose.mode.hidePreview", "Hide preview") : t("compose.mode.showPreview", "Show preview")}
                  </button>
                )}
              </div>
            </div>

            {/* Mode tabs */}
            <div className="compose-mode-tabs" role="group" aria-label={t("compose.mode.label", "Editor mode")}>
              <ModeButton icon={Type} label={t("compose.mode.rich", "Rich Text")} active={editorMode === "rich"} onClick={() => switchMode("rich")} />
              <ModeButton icon={Hash} label={t("compose.mode.markdown", "Markdown")} active={editorMode === "markdown"} onClick={() => switchMode("markdown")} />
              <ModeButton icon={FileCode2} label={t("compose.mode.html", "HTML")} active={editorMode === "html"} onClick={() => switchMode("html")} />
            </div>
          </div>

          {/* Attachment list */}
          {attachments.length > 0 && (
            <div className="compose-inline-panel">
              {attachments.map((att, i) => (
                <div
                  key={i}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setAttachmentMenu({ x: event.clientX, y: event.clientY, index: i });
                  }}
                  style={{
                    display: "flex", alignItems: "center", gap: "4px",
                    padding: "4px 8px", borderRadius: "4px",
                    backgroundColor: "var(--color-bg-hover)", fontSize: "12px",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => void invoke("open_local_file", { path: att.path })}
                    title="打开附件查看"
                    style={{ display: "flex", alignItems: "center", gap: "4px", border: "none", background: "none", cursor: "pointer", padding: 0, color: "var(--color-text-primary)" }}
                  >
                    <FileText size={12} />
                    <span style={{ maxWidth: "150px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: "underline dotted" }}>{att.name}</span>
                  </button>
                  <span style={{ color: "var(--color-text-secondary)", fontSize: "11px" }}>
                    {att.size < 1024 * 1024 ? `${(att.size / 1024).toFixed(0)} KB` : `${(att.size / (1024 * 1024)).toFixed(1)} MB`}
                  </span>
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={t("compose.removeAttachment", "Remove attachment {{name}}", { name: att.name })}
                    title={t("compose.removeAttachment", "Remove attachment {{name}}", { name: att.name })}
                    style={{ border: "none", background: "none", cursor: "pointer", padding: "0 2px", color: "var(--color-text-secondary)" }}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {attachmentMenu && (() => {
            const att = attachments[attachmentMenu.index];
            if (!att) return null;
            const items: ContextMenuItem[] = [
              { label: t("compose.openAttachment", "打开附件"), icon: <FileText size={14} />, onClick: () => void invoke("open_local_file", { path: att.path }) },
              { label: t("compose.showInFolder", "在文件夹中显示"), icon: <FolderOpen size={14} />, onClick: () => void invoke("show_in_folder", { path: att.path }) },
              { separator: true },
              { label: t("compose.insertInlineImage", "插入到正文"), icon: <FileText size={14} />, disabled: !isImageFileName(att.name), onClick: () => void insertAttachmentAsInlineImage(att) },
              { separator: true },
              { label: t("compose.copyFilename", "复制文件名"), icon: <Copy size={14} />, onClick: () => { void navigator.clipboard.writeText(att.name).then(() => useToastStore.getState().addToast({ message: t("compose.copied", "已复制"), type: "success" })); } },
              { label: t("compose.copyPath", "复制完整路径"), icon: <Copy size={14} />, onClick: () => { void navigator.clipboard.writeText(att.path).then(() => useToastStore.getState().addToast({ message: t("compose.copied", "已复制"), type: "success" })); } },
              { separator: true },
              { label: t("compose.removeAttachment", "删除附件"), icon: <Trash2 size={14} />, danger: true, onClick: () => setAttachments((prev) => prev.filter((_, j) => j !== attachmentMenu.index)) },
            ];
            return <ContextMenu x={attachmentMenu.x} y={attachmentMenu.y} items={items} onClose={() => setAttachmentMenu(null)} />;
          })()}

          {inlineImageMenu && (
            <ContextMenu x={inlineImageMenu.x} y={inlineImageMenu.y} items={inlineImageMenu.items} onClose={() => setInlineImageMenu(null)} />
          )}

          {/* Save template dialog */}
          {showSaveTemplate && (
            <div className="compose-inline-panel">
              <input
                type="text" value={templateName} onChange={(e) => setTemplateName(e.target.value)}
                placeholder={t("compose.templateName", "Template name")}
                autoFocus
                style={{
                  flex: 1, padding: "6px 8px", fontSize: "12px",
                  border: "1px solid var(--color-border)", borderRadius: "4px",
                  backgroundColor: "var(--color-bg)", color: "var(--color-text-primary)",
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && templateName.trim()) {
                    void handleSaveTemplate();
                  }
                  if (e.key === "Escape") setShowSaveTemplate(false);
                }}
              />
              <button
                type="button"
                onClick={() => {
                  if (!templateName.trim()) return;
                  void handleSaveTemplate();
                }}
                style={{
                  padding: "5px 12px", fontSize: "12px", border: "none",
                  borderRadius: "4px", backgroundColor: "var(--color-accent)",
                  color: "#fff", cursor: "pointer",
                }}
              >
                {t("common.save")}
              </button>
              <button
                type="button"
                onClick={() => setShowSaveTemplate(false)}
                style={{
                  padding: "5px 8px", fontSize: "12px", border: "1px solid var(--color-border)",
                  borderRadius: "4px", backgroundColor: "transparent",
                  color: "var(--color-text-secondary)", cursor: "pointer",
                }}
              >
                {t("common.cancel")}
              </button>
            </div>
          )}

          {/* Editor area */}
          <div
            className={`compose-editor-area${isReply ? " compose-editor-area--reply" : ""}`}
            onPasteCapture={async (e) => {
              const items = e.clipboardData?.items;
              if (!items) return;
              // Excel/WPS exposes editable HTML and may also expose a rendered
              // image at the same time. Keep the table as styled HTML so the
              // outgoing email contains a real table instead of a local-only
              // data URL image.
              if (clipboardContainsHtmlTable(e.clipboardData)) {
                const pastedHtml = e.clipboardData.getData("text/html");
                const pastedText = e.clipboardData.getData("text/plain");
                let tableHtml: string | null = null;
                try {
                  tableHtml = prepareSpreadsheetTableHtml(pastedHtml);
                } catch (err) {
                  // Do not cancel the browser/Tiptap paste when preparation
                  // fails. The default handler can still preserve the basic
                  // table or, at minimum, its text.
                  console.warn("Failed to prepare spreadsheet HTML for paste:", err);
                  return;
                }
                if (!tableHtml || !editor) return;

                e.preventDefault();
                e.stopPropagation();
                try {
                  const inserted = editor.chain().focus().insertContent(tableHtml).run();
                  if (!inserted) throw new Error("Tiptap rejected the prepared spreadsheet table");
                } catch (err) {
                  console.warn("Failed to paste prepared spreadsheet HTML into body:", err);
                  try {
                    const insertedBasicTable = editor.chain().focus().insertContent(pastedHtml).run();
                    if (!insertedBasicTable) throw new Error("Tiptap rejected the original spreadsheet table");
                  } catch (fallbackErr) {
                    console.warn("Failed to paste original spreadsheet HTML; falling back to text:", fallbackErr);
                    const safeText = escapePastedTextHtml(pastedText).replace(/\r?\n/g, "<br>");
                    editor.chain().focus().insertContent(`<p>${safeText}</p>`).run();
                  }
                }
                return;
              }
              const pastedFiles: File[] = [];
              for (const item of Array.from(items)) {
                if (item.kind === "file") {
                  const file = item.getAsFile();
                  if (file) pastedFiles.push(file);
                }
              }
              if (!pastedFiles.length) return;
              e.preventDefault();
              // 图片 → 默认插入正文（方案 C）；其他文件 → 附件
              const images = pastedFiles.filter((f) => f.type.startsWith("image/"));
              const others = pastedFiles.filter((f) => !f.type.startsWith("image/"));
              for (const img of images) {
                try {
                  const dataUrl = await fileToDataUrl(img);
                  editor?.chain().focus().setImage({ src: dataUrl }).run();
                } catch (err) {
                  console.warn("Failed to paste image into body:", err);
                }
              }
              if (others.length > 0) {
                try {
                  await stageAttachmentFiles(others);
                } catch (err) {
                  console.warn("Failed to stage pasted files:", err);
                  setSendError(t("compose.attachmentStageError", "Failed to attach file"));
                }
              }
            }}
          >
            <div
              className={`compose-editor-surface${isReply ? " compose-editor-surface--reply" : ""}${isAttachmentDragging ? " is-attachment-drop-target" : ""}`}
              onDragOver={(event) => {
                if (!Array.from(event.dataTransfer.types).includes("Files")) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "copy";
                setIsAiContextDragging(false);
                setIsAttachmentDragging(true);
              }}
              onDragLeave={(event) => {
                const nextTarget = event.relatedTarget;
                if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                  setIsAttachmentDragging(false);
                }
              }}
              onDrop={async (event) => {
                event.preventDefault();
                event.stopPropagation();
                setIsAttachmentDragging(false);
                const files = event.dataTransfer.files;
                if (!files.length) return;
                try {
                  await stageAttachmentFiles(files);
                } catch (err) {
                  console.warn("Failed to stage dropped attachment:", err);
                  setSendError(t("compose.attachmentStageError", "Failed to attach file"));
                }
              }}
              onContextMenu={(event) => {
                const target = event.target as HTMLElement | null;
                const img = target?.closest("img");
                if (!img || !editor) return;
                event.preventDefault();
                const src = img.getAttribute("src") ?? "";
                const isInlineData = src.startsWith("data:image/");
                let imagePos: number | null = null;
                try {
                  const domPos = editor.view.posAtDOM(img, 0);
                  imagePos = editor.state.doc.nodeAt(domPos)?.type.name === "image"
                    ? domPos
                    : domPos > 0 && editor.state.doc.nodeAt(domPos - 1)?.type.name === "image"
                      ? domPos - 1
                      : null;
                } catch {
                  imagePos = null;
                }
                const originalWidth = img.naturalWidth;
                const resizeImage = (percent: number | null) => {
                  if (imagePos === null) return;
                  const width = percent === null ? null : scaledImageWidthPx(originalWidth, percent);
                  if (percent !== null && width === null) {
                    useToastStore.getState().addToast({ message: t("compose.imageOriginalSizeUnavailable", "暂时无法读取图片原始尺寸，请等待图片加载后重试"), type: "error" });
                    return;
                  }
                  editor.chain().focus().setNodeSelection(imagePos).updateAttributes("image", {
                    width,
                    height: null,
                  }).run();
                };
                const items: ContextMenuItem[] = [
                  { label: t("compose.imageSize", "图片大小"), icon: <Scaling size={14} />, disabled: true, onClick: () => undefined },
                  ...[20, 50, 80].map((percent) => ({
                    label: t("compose.imageScalePercent", "缩小到原图 {{percent}}%", { percent }),
                    icon: <Scaling size={14} />,
                    disabled: imagePos === null || originalWidth <= 0,
                    onClick: () => resizeImage(percent),
                  })),
                  { label: t("compose.imageOriginalSize", "恢复原始大小"), icon: <Scaling size={14} />, disabled: imagePos === null, onClick: () => resizeImage(null) },
                  {
                    label: t("compose.imageCustomSize", "自定义大小…"), icon: <Scaling size={14} />, disabled: imagePos === null,
                    onClick: () => {
                      const input = window.prompt(t("compose.imageCustomSizePrompt", "请输入相对原图的缩放比例（1–99）"), "50");
                      if (input === null) return;
                      const percent = normalizeImageWidthPercent(input);
                      if (percent === null || percent >= 100) {
                        useToastStore.getState().addToast({ message: t("compose.imageCustomSizeInvalid", "请输入 1 到 99 之间的百分比；原始大小请使用“恢复原始大小”"), type: "error" });
                        return;
                      }
                      resizeImage(percent);
                    },
                  },
                  { separator: true },
                  { label: t("compose.imgToAttachment", "转为附件"), icon: <Paperclip size={14} />, disabled: !isInlineData, onClick: () => {
                    if (!isInlineData) return;
                    try {
                      const [meta, b64] = src.split(",");
                      const mime = meta.match(/^data:(.*?);/)?.[1] ?? "image/png";
                      const bin = atob(b64);
                      const bytes = new Uint8Array(bin.length);
                      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                      const ext = (mime.split("/")[1] || "png").replace("+xml", "").replace("jpeg", "jpg");
                      const file = new File([bytes], `pasted-${Date.now()}.${ext}`, { type: mime });
                      void stageAttachmentFiles([file]);
                      // 从正文移除该图片（改为附件）
                      if (imagePos !== null) editor.chain().focus().deleteRange({ from: imagePos, to: imagePos + 1 }).run();
                    } catch (err) {
                      console.warn("Failed to convert image to attachment:", err);
                      useToastStore.getState().addToast({ message: t("compose.imgToAttachmentFailed", "转换失败，请重试"), type: "error" });
                    }
                  } },
                  { label: t("compose.copyImage", "复制图片"), icon: <Copy size={14} />, onClick: () => {
                    if (src.startsWith("data:")) {
                      fetch(src).then((r) => r.blob()).then((blob) => navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])).catch(() => {});
                    }
                  } },
                  { separator: true },
                  { label: t("compose.deleteImage", "删除图片"), icon: <Trash2 size={14} />, danger: true, onClick: () => {
                    if (imagePos !== null) editor.chain().focus().deleteRange({ from: imagePos, to: imagePos + 1 }).run();
                  } },
                ];
                setInlineImageMenu({ x: event.clientX, y: event.clientY, items });
              }}
              style={{
                // 新邮件和回复统一从较矮的草稿区开始；内容超过可用高度时，
                // 草稿区内部滚动，不再把 AI 指令框和原文引用挤出窗口。
                minHeight: `${Math.max(90, draftEditorHeight)}px`,
                maxHeight: "38vh",
                overflowY: "auto",
                flex: "0 0 auto",
              }}
            >
              {editorMode === "rich" ? (
                <EditorContent
                  editor={editor}
                  className="compose-editor-content"
                />
              ) : editorMode === "html" && htmlPreview ? (
                <div className="compose-preview-split">
                  <textarea
                    ref={textareaRef}
                    value={rawSource}
                    onChange={(e) => setRawSource(e.target.value)}
                    placeholder={t("compose.mode.htmlPlaceholder", "Write HTML source...")}
                    spellCheck={false}
                    className="compose-source-input compose-source-input--split is-code"
                  />
                  <iframe
                    sandbox="allow-same-origin"
                    srcDoc={rawSource}
                    title={t("compose.mode.preview", "Preview")}
                    className="compose-html-preview"
                  />
                </div>
              ) : (
                <textarea
                  ref={textareaRef}
                  value={rawSource}
                  onChange={(e) => setRawSource(e.target.value)}
                  placeholder={editorMode === "markdown"
                    ? t("compose.mode.markdownPlaceholder", "Write in Markdown...")
                    : t("compose.mode.htmlPlaceholder", "Write HTML source...")}
                  spellCheck={editorMode === "markdown"}
                  className={`compose-source-input${editorMode === "html" ? " is-code" : ""}`}
                />
              )}
              {isAttachmentDragging && (
                <div className="compose-drop-overlay compose-drop-overlay--attachment" role="status">
                  <Paperclip size={22} />
                  <span>
                    <strong>{t("compose.dropAsAttachment", "松开，添加为邮件附件")}</strong>
                    <small>{t("compose.dropAsAttachmentHint", "文件将随邮件一起发送")}</small>
                  </span>
                </div>
              )}
            </div>
            {/* AI 写作助手 —— 草稿栏下方：生成结果直接写入草稿栏 */}
            <div style={{
              margin: "10px 0",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              padding: 10,
              background: "color-mix(in srgb, var(--color-accent) 4%, var(--color-bg-secondary))",
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--color-text-primary)" }}>
                  <Sparkles size={13} /> AI 写作助手（支持多轮对话，结果直接写入草稿）
                </div>
                {aiHistory.length > 0 && (
                  <button
                    type="button"
                    onClick={handleAiClear}
                    disabled={aiGenerating}
                    style={{ background: "none", border: 0, color: "var(--color-text-secondary)", cursor: "pointer", fontSize: 11 }}
                    title="清空对话"
                  >
                    清空
                  </button>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}>再次生成会以当前正文为底稿，保留未要求修改的内容。AI 指令不会随邮件发送。</div>
              <div
                ref={aiDropZoneRef}
                data-compose-ai-tab={tabId ?? "embedded"}
                className={`compose-ai-dropzone${isAiContextDragging ? " is-ai-context-drop-target" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = "copy";
                  setIsAttachmentDragging(false);
                  setIsAiContextDragging(true);
                }}
                onDragLeave={(event) => {
                  const nextTarget = event.relatedTarget;
                  if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                    setIsAiContextDragging(false);
                  }
                }}
                onDrop={handleComposeAiDrop}
              >
                <textarea
                  value={aiInstruction}
                  onChange={(e) => setAiInstruction(e.target.value)}
                  onInput={(e) => resizeAutoGrowTextarea(e.currentTarget, 260)}
                  onPaste={handleComposeAiPaste}
                  onFocus={() => setAiInputFocusOwner("compose")}
                  placeholder={aiPanelLocked
                    ? "右侧 AI 写作当前激活中，点击此处切换为在本处输入"
                    : "输入指令，也可以直接粘贴或拖入邮件、附件和多个文件。生成结果会直接写入正文草稿。"}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    minHeight: 72,
                    maxHeight: 260,
                    padding: 8,
                    border: "1px solid var(--color-border)",
                    borderRadius: "6px 6px 0 0",
                    background: aiPanelLocked ? "var(--color-bg-secondary)" : "var(--color-bg-primary)",
                    color: "var(--color-text-primary)",
                    fontSize: 13,
                    resize: "none",
                    fontFamily: "inherit",
                    opacity: aiPanelLocked ? 0.5 : 1,
                  }}
                  disabled={aiGenerating}
                />
                <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                  <KnowledgePicker accountId={writingAccountId} selectedIds={selectedKnowledgeIds} onChange={setSelectedKnowledgeIds} />
                  <button
                    type="button"
                    disabled={aiGenerating}
                    onClick={() => aiFileInputRef.current?.click()}
                    title="读取文件内容供 AI 写作参考。需要随邮件发送的文件，请另加到邮件附件栏。"
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 9px", border: "1px solid var(--color-border)", borderRadius: 6, background: "var(--color-bg-primary)", color: "var(--color-text-primary)", fontSize: 12, cursor: aiGenerating ? "not-allowed" : "pointer", opacity: aiGenerating ? 0.5 : 1 }}
                  >
                    <Paperclip size={13} aria-hidden="true" />添加参考文件
                  </button>
                  <input ref={aiFileInputRef} type="file" accept={DRAFT_FILE_ACCEPT} multiple hidden onChange={event => { if (event.target.files) addComposeAiFiles(event.target.files); event.currentTarget.value = ''; }} />
                </div>
                {(aiContextFiles.length > 0 || aiContextMessages.length > 0) && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "7px 8px", border: "1px dashed var(--color-accent)", borderTop: 0, borderRadius: "0 0 6px 6px" }}>
                    {aiContextMessages.map((item) => <span key={item.id} style={{ fontSize: 11, padding: "3px 7px", borderRadius: 10, background: "var(--color-bg-hover)" }}>邮件：{item.title} <button type="button" disabled={aiGenerating} aria-label={`移除参考邮件：${item.title}`} onClick={() => setAiContextMessages((current) => current.filter((x) => x.id !== item.id))} style={{ border: 0, background: "transparent", cursor: "pointer" }}>×</button></span>)}
                    {aiFiles.files.map(({ id, file }) => <span key={id} style={{ fontSize: 11, padding: "3px 7px", borderRadius: 10, background: "var(--color-bg-hover)" }}>文件：{file.name} <button type="button" disabled={aiGenerating} onClick={() => aiFiles.remove(id)} style={{ border: 0, background: "transparent", cursor: "pointer" }}>×</button></span>)}
                  </div>
                )}
                {isAiContextDragging && (
                  <div className="compose-ai-drop-overlay" role="status">
                    <Sparkles size={22} />
                    <span>
                      <strong>{t("compose.dropAsAiContext", "松开，作为 AI 输入上下文")}</strong>
                      <small>{t("compose.dropAsAiContextHint", "只用于生成草稿，不会作为邮件附件发送")}</small>
                    </span>
                  </div>
                )}
                {(aiContextFiles.length > 0 || aiContextMessages.length > 0) && <div style={{ marginTop: 7, fontSize: 11, color: "var(--color-text-secondary)" }}>已添加 {aiContextMessages.length + aiContextFiles.length} 项上下文；点击生成后会使用这些内容发送给当前配置的 AI 服务商。</div>}
                {(fileReadsPending || aiDocumentStatus) && <div role="status" style={{ marginTop: 7, fontSize: 11, color: "var(--color-text-secondary)" }}>{fileReadsPending ? "正在加载文件…" : aiDocumentStatus}</div>}
                {aiFileError && <div role="alert" style={{ marginTop: 7, fontSize: 11, color: "var(--color-error, #d33)" }}>{aiFileError}</div>}
              </div>
              {/* 快捷调整提示：第一轮生成之后出现，点一下按该要求调整（不必打字） */}
              <div style={{ marginTop: 8, borderTop: "1px solid var(--color-border)", paddingTop: 7 }}>
                <button
                  type="button"
                  onClick={() => setWritingOptionsOpen((open) => !open)}
                  style={{ border: 0, background: "transparent", padding: 0, color: "var(--color-text-secondary)", cursor: "pointer", fontSize: 11 }}
                >
                  {writingOptionsOpen ? "收起写作设置" : "写作设置"} · {selectedLanguage?.label ?? "自动判断语言"} · {writingProfiles.find((profile) => profile.id === effectiveStyleId)?.name ?? "通用商务风"}
                </button>
                {writingOptionsOpen && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 7, marginTop: 7, padding: 8, borderRadius: 6, background: "var(--color-bg-secondary)" }}>
                    <label style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>生成语言
                      <select value={effectiveLanguage} onChange={(event) => setLanguageOverride(event.target.value)} style={{ width: "100%", marginTop: 3, padding: "4px 5px", fontSize: 11 }}>
                        <option value="auto">自动判断</option>
                        {MAIL_LANGUAGES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </label>
                    <label style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>写作风格
                      <select value={effectiveStyleId} onChange={(event) => setStyleOverride(event.target.value)} style={{ width: "100%", marginTop: 3, padding: "4px 5px", fontSize: 11 }}>
                        {writingProfiles.length === 0 && <option value="">通用商务风</option>}
                        {writingProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                      </select>
                    </label>
                    <label style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>签名
                      <select value={effectiveSignatureId} onChange={(event) => setSignatureOverride(event.target.value)} style={{ width: "100%", marginTop: 3, padding: "4px 5px", fontSize: 11 }}>
                        <option value="">不自动选择</option>
                        {signatures.map((signature) => <option key={signature.id} value={signature.id}>{signature.name}{signature.is_default ? "（默认）" : ""}</option>)}
                      </select>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--color-text-secondary)" }}>
                      <input type="checkbox" checked={effectiveIncludeKnowledge} onChange={(event) => setKnowledgeOverride(event.target.checked)} /> 生成时参考相关资料库内容
                    </label>
                    <button type="button" onClick={() => { setLanguageOverride(null); setStyleOverride(null); setKnowledgeOverride(null); setSignatureOverride(null); }} style={{ justifySelf: "start", alignSelf: "end", border: "1px solid var(--color-border)", background: "transparent", borderRadius: 5, padding: "4px 7px", fontSize: 11, cursor: "pointer" }}>恢复账号默认</button>
                    <div style={{ gridColumn: "1 / -1", fontSize: 10, color: "var(--color-text-tertiary, var(--color-text-secondary))" }}>这里的调整只影响本次草稿；要修改长期默认值，请在右侧 AI 写作的“其他选项”中调整。</div>
                  </div>
                )}
              </div>
              {aiHistory.length >= 1 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                {["更简短一些", "语气更礼貌", "语气直接一点", "更正式", "用英文写", "不要占位符"].map((hint) => (
                  <button
                    key={hint}
                    type="button"
                    disabled={aiGenerating}
                    onClick={() => {
                      setAiInputFocusOwner("compose");
                      setAiInstruction(hint);
                      void handleAiGenerate(hint);
                    }}
                    style={{
                      padding: "3px 10px",
                      fontSize: 11,
                      border: "1px solid var(--color-border)",
                      borderRadius: 12,
                      background: "transparent",
                      color: "var(--color-text-secondary)",
                      cursor: aiGenerating ? "not-allowed" : "pointer",
                      opacity: aiGenerating ? 0.5 : 1,
                    }}
                  >
                    {hint}
                  </button>
                ))}
              </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  type="button"
                  disabled={!editorContentReady || aiGenerating || fileReadsPending || !aiInstruction.trim()}
                  title="根据指令和参考内容生成邮件正文，并替换当前草稿正文；不会直接发送邮件。"
                  onClick={() => {
                    // 点击生成 = 激活本处输入并生成（支持互相切换）
                    setAiInputFocusOwner("compose");
                    void handleAiGenerate();
                  }}
                  style={{
                    padding: "5px 14px",
                    border: 0,
                    background: "var(--color-accent)",
                    color: "#fff",
                    borderRadius: 6,
                    cursor: !aiGenerating && aiInstruction.trim() ? "pointer" : "not-allowed",
                    opacity: !aiGenerating && aiInstruction.trim() ? 1 : 0.6,
                    fontSize: 12,
                    fontWeight: 600,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <Sparkles size={12} className={aiGenerating ? "spinner" : ""} />
                  {aiGenerating ? "生成中…" : aiHistory.length > 0 ? "继续对话（覆盖草稿）" : "生成草稿"}
                </button>
                {aiSnapshots.length > 0 && (
                  <button
                    type="button"
                    onClick={handleAiUndo}
                    title={`撤销并带回指令：${aiSnapshots[aiSnapshots.length - 1]?.instruction ?? ''}`}
                    disabled={aiGenerating || !editorContentReady}
                    style={{
                      padding: "5px 12px",
                      border: "1px solid var(--color-border)",
                      background: "transparent",
                      color: "var(--color-text-primary)",
                      borderRadius: 6,
                      cursor: "pointer",
                      fontSize: 12,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                    }}
                  >
                    <Undo2 size={12} /> 撤销到上一步
                    <span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text-secondary)' }}>{aiInstructionPreview(aiSnapshots[aiSnapshots.length - 1]?.instruction ?? '')}</span>
                  </button>
                )}
                {aiRedoSnapshots.length > 0 && (
                  <button
                    type="button"
                    onClick={handleAiRedo}
                    title={`恢复并带回指令：${aiRedoSnapshots[aiRedoSnapshots.length - 1]?.instruction ?? ''}`}
                    disabled={aiGenerating || !editorContentReady}
                    style={{
                      padding: "5px 12px",
                      border: "1px solid var(--color-border)",
                      background: "transparent",
                      color: "var(--color-text-primary)",
                      borderRadius: 6,
                      cursor: "pointer",
                      fontSize: 12,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                    }}
                  >
                    <Redo2 size={12} /> 恢复到下一步
                    <span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text-secondary)' }}>{aiInstructionPreview(aiRedoSnapshots[aiRedoSnapshots.length - 1]?.instruction ?? '')}</span>
                  </button>
                )}
              </div>
            </div>
            {/* 回复模式下，编辑器与原邮件之间的可拖动分界 */}
            {isReply && (
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="拖动调整草稿栏高度"
                onMouseDown={beginDraftResize}
                title="拖动调整草稿栏与原邮件之间的分界；原邮件默认显示到底部"
                style={{
                  cursor: "row-resize",
                  height: 6,
                  margin: "4px 0",
                  background:
                    "linear-gradient(to right, transparent, color-mix(in srgb, var(--color-accent) 40%, transparent) 50%, transparent)",
                  borderRadius: 3,
                }}
              />
            )}
            {quotedReplyHtml && (
              <div className="compose-quoted-reply compose-quoted-reply--page-scroll" style={isReply ? { flex: "0 0 auto", minHeight: 0, overflow: "visible", display: "block" } : undefined}>
                <button
                  type="button"
                  className="compose-quoted-reply-toggle"
                  aria-expanded={showQuotedReply}
                  onClick={() => setShowQuotedReply((value) => !value)}
                >
                  {showQuotedReply ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  {showQuotedReply
                    ? t("compose.hideQuotedReply", "Hide quoted message")
                    : t("compose.showQuotedReply", "Show quoted message")}
                </button>
                {showQuotedReply && (
                  <div
                    className="scroll-region compose-quoted-reply-content"
                    dangerouslySetInnerHTML={{ __html: quotedReplyHtml }}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {isActive && showComposeLeaveConfirm && <ConfirmDialog
        title={t('compose.unsavedTitle', '保存草稿？')}
        message={t('compose.unsavedMessage', '有尚未保存的修改。可以保存后退出，或丢弃未保存的修改；已保存的草稿会保留。')}
        destructive
        confirmLabel={t('compose.discardChanges', '丢弃修改')}
        cancelLabel={t('compose.continueEditing', '继续编辑')}
        alternateLabel={t('compose.saveAndClose', '保存退出')}
        busy={isSavingToClose}
        onConfirm={confirmCloseCompose}
        onCancel={cancelCloseCompose}
        onAlternate={() => void handleSave(true)}
      />}
    </div>
  );
}
