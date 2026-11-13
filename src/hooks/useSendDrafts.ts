import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sendDraftSelection } from '@/features/compose/sendDraftSelection';
import { useConfirmStore } from '@/stores/confirm.store';
import { useToastStore } from '@/stores/toast.store';
import { useMailStore } from '@/stores/mail.store';
import { extractErrorMessage } from '@/lib/extractErrorMessage';

export function useSendDrafts() {
  const [sending, setSending] = useState(false);
  const queryClient = useQueryClient();
  async function sendDrafts(ids: string[]) {
    setSending(true);
    try {
      const result = await sendDraftSelection(ids, options => useConfirmStore.getState().confirm(options));
      if (!result) return;
      for (const key of ['messages', 'message', 'threads', 'folders', 'folder-unread-counts', 'pendingMailOpsList', 'pendingMailOps']) void queryClient.invalidateQueries({ queryKey: [key] }).catch(() => {});
      const submitted = new Set(result.queuedIds);
      const state = useMailStore.getState();
      const remaining = new Set([...state.selectedMessageIds].filter(id => !submitted.has(id)));
      useMailStore.setState({ selectedMessageIds: remaining, ...(submitted.has(state.selectedMessageId ?? '') ? { selectedMessageId: null } : {}), ...(state.batchMode && remaining.size === 0 ? { batchMode: false } : {}) });
      useToastStore.getState().addToast({ message: `${result.queuedIds.length} 封草稿已提交发送队列，请查看发件箱或已发送。${result.failed.length ? `\n${result.failed.length} 封未提交：${result.failed.map(item => `${item.subject || '无主题'}：${item.error}`).join('；')}` : ''}`, type: result.failed.length ? 'error' : 'success', ...(result.failed.length ? { duration: 0 } : {}) });
    } catch (cause) { useToastStore.getState().addToast({ message: `发送草稿未完成：${extractErrorMessage(cause)}`, type: 'error', duration: 0 }); }
    finally { setSending(false); }
  }
  return { sendDrafts, sending };
}
