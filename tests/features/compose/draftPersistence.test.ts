import { beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmComposeLeave, registerDraftSaver } from '../../../src/features/compose/draftPersistence';
import { useComposeStore } from '../../../src/stores/compose.store';
import { useConfirmStore } from '../../../src/stores/confirm.store';
import { useToastStore } from '../../../src/stores/toast.store';

describe('unsaved draft exit choices', () => {
  beforeEach(() => {
    useComposeStore.setState({ tabs: [], tabsById: {}, activeTabId: null, composeMode: 'new', composeDirty: true });
    useConfirmStore.setState({ isOpen: false, busy: false, resolve: null });
    useToastStore.setState({ toasts: [] });
  });
  it('saves before allowing exit', async () => {
    const save = vi.fn(async () => { useComposeStore.getState().setComposeDirty(false); return 'draft'; });
    const cleanup = registerDraftSaver(undefined, save);
    try {
      const result = confirmComposeLeave();
      await useConfirmStore.getState().handleAlternate();
      expect(await result).toBe(true);
      expect(save).toHaveBeenCalledOnce();
      expect(useConfirmStore.getState().isOpen).toBe(false);
    } finally { cleanup(); }
  });
  it('retains the dialog and unsaved content after a failed save', async () => {
    const cleanup = registerDraftSaver(undefined, async () => { throw new Error('offline'); });
    try {
      const result = confirmComposeLeave();
      await useConfirmStore.getState().handleAlternate();
      expect(useConfirmStore.getState().isOpen).toBe(true);
      expect(useComposeStore.getState().composeDirty).toBe(true);
      expect(useToastStore.getState().toasts.some(toast => toast.type === 'error')).toBe(true);
      useConfirmStore.getState().handleCancel();
      expect(await result).toBe(false);
    } finally { cleanup(); }
  });
  it('does not save when continuing editing or discarding', async () => {
    const save = vi.fn();
    const cleanup = registerDraftSaver(undefined, save);
    try {
      const cancel = confirmComposeLeave();
      useConfirmStore.getState().handleCancel();
      expect(await cancel).toBe(false);
      const discard = confirmComposeLeave();
      useConfirmStore.getState().handleConfirm();
      expect(await discard).toBe(true);
      expect(save).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });
  it('does not exit if content changes while saving', async () => {
    const cleanup = registerDraftSaver(undefined, async () => 'draft');
    try {
      const result = confirmComposeLeave();
      await useConfirmStore.getState().handleAlternate();
      expect(useConfirmStore.getState().isOpen).toBe(true);
      useConfirmStore.getState().handleCancel();
      expect(await result).toBe(false);
    } finally { cleanup(); }
  });

  it('saves only the drafts included in a bulk close operation', async () => {
    useComposeStore.getState().openCompose('new');
    const first = useComposeStore.getState().activeTabId!;
    useComposeStore.getState().setComposeDirty(true, first);
    useComposeStore.getState().openCompose('new');
    const second = useComposeStore.getState().activeTabId!;
    useComposeStore.getState().setComposeDirty(true, second);
    const cleanupA = registerDraftSaver(first, async () => { useComposeStore.getState().setComposeDirty(false, first); return 'draft-a'; });
    const saveB = vi.fn();
    const cleanupB = registerDraftSaver(second, saveB);
    try {
      const result = confirmComposeLeave([first]);
      await useConfirmStore.getState().handleAlternate();
      expect(await result).toBe(true);
      expect(useComposeStore.getState().tabsById[second].dirty).toBe(true);
      expect(saveB).not.toHaveBeenCalled();
    } finally { cleanupA(); cleanupB(); }
  });
});
