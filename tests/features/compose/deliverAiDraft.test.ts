import { beforeEach, describe, expect, it } from 'vitest';
import { deliverAiDraft } from '../../../src/features/compose/deliverAiDraft';
import { useComposeStore } from '../../../src/stores/compose.store';
import { useUIStore } from '../../../src/stores/ui.store';

beforeEach(() => {
  useComposeStore.setState({ tabs: [], tabsById: {}, activeTabId: null, composeMode: null });
  useUIStore.setState({ activeView: 'inbox' });
});
describe('late AI draft delivery', () => {
  it('keeps the original tab as recipient even after switching to another draft', () => {
    const store = useComposeStore.getState();
    store.openCompose('new', null, { accountId: 'account-a' });
    const original = useComposeStore.getState().activeTabId!;
    store.openCompose('new', null, { accountId: 'account-b' });
    const other = useComposeStore.getState().activeTabId!;
    expect(deliverAiDraft({ tabId: original, accountId: 'account-a' }, { body: 'Generated body' })).toBe('queued');
    expect(useComposeStore.getState().tabsById[original].pendingAiBody).toBe('Generated body');
    expect(useComposeStore.getState().tabsById[other].pendingAiBody).toBeNull();
  });
  it('recovers a closed target into a separate correctly attributed draft', () => {
    expect(deliverAiDraft({ tabId: 'closed-tab', accountId: 'account-a', prefill: { to: ['buyer@example.test'] } }, { body: 'Saved late answer' })).toBe('opened');
    const state = useComposeStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].prefill).toMatchObject({ accountId: 'account-a', to: ['buyer@example.test'], body: 'Saved late answer' });
    expect(state.applyAiDraft({ body: 'Do not redirect' }, 'closed-tab')).toBe(false);
    expect(useComposeStore.getState().tabs[0].pendingAiBody).toBeNull();
  });
  it('does not overwrite a draft whose sending account changed during generation', () => {
    useComposeStore.getState().openCompose('new', null, { accountId: 'account-a' });
    const original = useComposeStore.getState().activeTabId!;
    useComposeStore.getState().setActiveDraftContext({ fromAccountId: 'account-b', to: [], cc: [], bcc: [], subject: '', body: '' }, original);
    expect(deliverAiDraft({ tabId: original, accountId: 'account-a' }, { body: 'Answer' })).toBe('opened');
    expect(useComposeStore.getState().tabsById[original].pendingAiBody).toBeNull();
    expect(useComposeStore.getState().tabs).toHaveLength(2);
  });
  it('rejects an empty answer without claiming delivery or opening a draft', () => {
    expect(() => deliverAiDraft({}, { body: '  ' })).toThrow('正文');
    expect(useComposeStore.getState().tabs).toHaveLength(0);
  });
});
