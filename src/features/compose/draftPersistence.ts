import { isComposeDirty, useComposeStore } from '@/stores/compose.store';
import { useConfirmStore } from '@/stores/confirm.store';
import { useToastStore } from '@/stores/toast.store';
import i18n from '@/lib/i18n';

const savers = new Map<string, () => Promise<string>>();
export function registerDraftSaver(tabId: string | undefined, save: () => Promise<string>) {
  const key = tabId ?? 'embedded';
  savers.set(key, save);
  return () => { if (savers.get(key) === save) savers.delete(key); };
}

function dirtyDraftIds() {
  const state = useComposeStore.getState();
  const ids = state.tabs.filter(tab => tab.dirty).map(tab => tab.id);
  if (!state.tabs.length && state.composeDirty) ids.push('embedded');
  return ids;
}

export async function saveOpenDrafts(targetIds?: string[]) {
  const ids = dirtyDraftIds().filter(id => !targetIds || targetIds.includes(id));
  for (const id of ids) {
    const save = savers.get(id);
    if (!save) throw new Error(i18n.t('compose.saveUnavailable', '编辑器尚未准备好，请继续编辑后再保存。'));
    await save();
  }
  if (dirtyDraftIds().some(id => !targetIds || targetIds.includes(id))) throw new Error(i18n.t('compose.changedWhileSaving', '保存期间内容发生了变化，请再次保存。'));
}

export async function confirmComposeLeave(targetIds?: string[]) {
  if (!isComposeDirty() || !dirtyDraftIds().some(id => !targetIds || targetIds.includes(id))) return true;
  return useConfirmStore.getState().confirm({
    title: i18n.t('compose.unsavedTitle', '保存草稿？'),
    message: i18n.t('compose.unsavedMessage', '有尚未保存的修改。可以保存后退出，或丢弃本次修改；已保存的草稿会保留。'),
    confirmLabel: i18n.t('compose.discardChanges', '丢弃修改'),
    cancelLabel: i18n.t('compose.continueEditing', '继续编辑'),
    alternateLabel: i18n.t('compose.saveAndClose', '保存退出'),
    destructive: true,
    onAlternate: async () => {
      try { await saveOpenDrafts(targetIds); return true; }
      catch (error) {
        useToastStore.getState().addToast({ type: 'error', message: `${i18n.t('compose.saveFailed', '草稿保存失败，内容仍保留在编辑器中')}: ${String(error)}` });
        return false;
      }
    },
  });
}
