import { beforeEach, describe, expect, it } from 'vitest';
import { initializeProfileStorageNamespace, resetProfileStorageNamespaceForTests } from '@/lib/profileStorage';
import { HISTORY_KEY, loadConversations, mergeEvidence, newConversation, saveConversations } from './workbenchSession';
beforeEach(() => { localStorage.clear(); resetProfileStorageNamespaceForTests(); });
describe('account and profile conversation scope', () => {
  it('persists account identity and evidence without deleting other accounts', () => {
    const a = newConversation('a'), b = newConversation('b');
    a.evidence = [{ kind: 'mail', id: 'm1', title: 'Example' }];
    saveConversations([a, b]); expect(loadConversations()).toEqual([a, b]);
  });
  it('archives unscoped legacy history without binding it to a guessed account', () => {
    const old = { id: 'legacy', title: 'Old example', messages: [], createdAt: 1, updatedAt: 1 };
    localStorage.setItem('yao-home-ai-conversations-v1', JSON.stringify([old]));
    expect(loadConversations()[0]).toMatchObject({ legacy: true, accountId: null });
    expect(localStorage.getItem('yao-home-ai-conversations-v1')).not.toBeNull();
  });
  it('uses profile namespaced storage', async () => {
    await initializeProfileStorageNamespace(async () => 'profile-a'); saveConversations([newConversation('a')]);
    expect(localStorage.getItem(`pebble:profile:profile-a:${HISTORY_KEY}`)).not.toBeNull();
    await initializeProfileStorageNamespace(async () => 'profile-b'); expect(loadConversations()).toEqual([]);
  });
  it('deduplicates stable evidence and rejects over-budget additions rather than dropping old evidence', () => {
    expect(mergeEvidence([{ kind: 'mail', id: 'm', title: 'Old' }], [{ kind: 'mail', id: 'm', title: 'New' }])).toEqual([{ kind: 'mail', id: 'm', title: 'New' }]);
    expect(() => mergeEvidence([], Array.from({ length: 25 }, (_, i) => ({ kind: 'mail', id: String(i), title: 'Example' })))).toThrow('过多');
  });
});
