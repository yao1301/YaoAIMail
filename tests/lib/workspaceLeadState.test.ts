import { expect, it } from 'vitest';
import { leadSessionStateKey, receiveLeadState, wrapLeadState } from '@/lib/workspaceLeadState';
const prefix = 'src/features/lead-finder/LeadFinderView.tsx:LeadFinderView:';
it('does not replace another search session with late contact results', () => {
  const packet = wrapLeadState(prefix+'results', [{ website: 'https://a.example', emails: ['contact@a.example'] }], { [leadSessionStateKey]: 'old-session' });
  expect(receiveLeadState(prefix+'results', packet, { [leadSessionStateKey]: 'new-session' }).apply).toBe(false);
});
it('merges late contacts while retaining newer pages and other tasks', () => {
  const key = prefix+'searchSessions';
  const packet = wrapLeadState(key, [{ id: 'old', page: 1, results: [{ website: 'https://a.example', emails: ['contact@a.example'] }] }], { [leadSessionStateKey]: 'old' });
  const current = { [key]: [{ id: 'new', page: 1, results: [] }, { id: 'old', page: 2, results: [{ website: 'https://a.example' },{ website: 'https://b.example' }] }] };
  const result = receiveLeadState(key, packet, current).value as any[];
  expect(result).toHaveLength(2); expect(result[1].page).toBe(2); expect(result[1].results).toHaveLength(2);
  expect(result[1].results[0].emails).toEqual(['contact@a.example']);
});
