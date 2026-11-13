import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WorkspaceTabs from '../../src/components/WorkspaceTabs';
import { useComposeStore } from '../../src/stores/compose.store';
import { useMailStore } from '../../src/stores/mail.store';
import { useUIStore } from '../../src/stores/ui.store';
import { MAIL_REFERENCE_TYPE } from '../../src/lib/mailReferenceDrag';

vi.mock('../../src/hooks/queries', () => ({ useMessageQuery: () => ({ data: null }) }));
vi.mock('../../src/lib/api', () => ({ openMailWindow: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  useComposeStore.setState({ tabs: [], tabsById: {}, activeTabId: null });
  useMailStore.setState({ openMessageIds: [] });
  useUIStore.setState({ activeView: 'inbox', navTabs: [] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function setup() {
  useComposeStore.getState().openCompose('new', null, { subject: 'Draft A' });
  const first = useComposeStore.getState().activeTabId!;
  useComposeStore.getState().openCompose('new', null, { subject: 'Draft B' });
  const second = useComposeStore.getState().activeTabId!;
  useUIStore.setState({ activeView: 'inbox' });
  render(<WorkspaceTabs />);
  return { first, second, tab: screen.getByRole('button', { name: 'Draft A' }) };
}
function transfer(id = 'received-mail') {
  return { types: [MAIL_REFERENCE_TYPE, 'text/plain'], dropEffect: 'none',
    getData: (type: string) => type === MAIL_REFERENCE_TYPE ? id : '邮件：Invoice update' };
}

it('drops a mail on its exact draft tab without changing recipients, body, or another draft', () => {
  const { first, second, tab } = setup();
  fireEvent.drop(tab, { dataTransfer: transfer() });
  fireEvent.drop(tab, { dataTransfer: transfer() });
  const state = useComposeStore.getState();
  expect(state.activeTabId).toBe(first);
  expect(useUIStore.getState().activeView).toBe('compose');
  expect(state.tabsById[first].pendingAiReferences).toEqual([{ id: 'received-mail', title: 'Invoice update' }]);
  expect(state.tabsById[second].pendingAiReferences).toBeUndefined();
  expect(state.tabsById[first].prefill).toEqual({ subject: 'Draft A' });
});

it('switches after a short hover even when the protected drag payload cannot be read yet', () => {
  const { first, tab } = setup();
  fireEvent.dragOver(tab, { dataTransfer: { types: [MAIL_REFERENCE_TYPE], getData: () => '', dropEffect: 'none' } });
  act(() => { vi.advanceTimersByTime(449); });
  expect(useUIStore.getState().activeView).toBe('inbox');
  act(() => { vi.advanceTimersByTime(1); });
  expect(useComposeStore.getState().activeTabId).toBe(first);
  expect(useUIStore.getState().activeView).toBe('compose');
  expect(useComposeStore.getState().tabsById[first].pendingAiReferences).toBeUndefined();
});

it('cancels a hover on leaving, drag cancellation, or unmount and ignores file-only drags', () => {
  const { tab } = setup();
  const over = () => fireEvent.dragOver(tab, { dataTransfer: transfer() });
  over(); fireEvent.dragLeave(tab, { relatedTarget: document.body });
  act(() => { vi.advanceTimersByTime(500); });
  expect(useUIStore.getState().activeView).toBe('inbox');
  over(); fireEvent.dragEnd(window);
  act(() => { vi.advanceTimersByTime(500); });
  expect(useUIStore.getState().activeView).toBe('inbox');
  fireEvent.dragOver(tab, { dataTransfer: { types: ['Files'], getData: () => '' } });
  act(() => { vi.advanceTimersByTime(500); });
  expect(useUIStore.getState().activeView).toBe('inbox');
  over(); cleanup();
  act(() => { vi.advanceTimersByTime(500); });
  expect(useUIStore.getState().activeView).toBe('inbox');
});

it('removes queued references when a draft closes and cannot enqueue into a closed tab', () => {
  const { first, tab } = setup();
  fireEvent.drop(tab, { dataTransfer: transfer('sent-mail') });
  act(() => useComposeStore.getState().forceCloseCompose(first));
  useComposeStore.getState().queueAiReference(first, { id: 'sent-mail', title: 'Old mail' });
  expect(useComposeStore.getState().tabsById[first]).toBeUndefined();
});
