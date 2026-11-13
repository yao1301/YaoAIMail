import { beforeEach, expect, it, vi } from 'vitest';
import { mailAssistantRun, getAccountOverview, generateAccountOverview, setAccountOverviewFeedback, setAccountOverviewSettings, autoRefreshAccountOverview, openMailWindow } from '../../src/lib/api';
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => h);
beforeEach(() => { vi.resetAllMocks(); h.invoke.mockResolvedValue(undefined); });
it('passes caller-bound scope and grants separately from the model text', async () => {
  const request = { accountId: 'a', system: 'Example system', user: 'Example task', allowMail: true, allowKnowledge: false, allowWeb: false, explicitMessageIds: ['explicit'], relatedMessageIds: ['related'], knowledgeIds: [] };
  h.invoke.mockResolvedValue({ content: 'Example result' });
  await mailAssistantRun(request);
  expect(h.invoke).toHaveBeenCalledWith('mail_assistant_run', { request });
});
it('keeps per-account settings, guarded automatic refresh and native mail windows explicit', async () => {
  const settings = {autoGenerate:false,windowDays:7};
  await setAccountOverviewSettings('a',settings); await autoRefreshAccountOverview('a'); await openMailWindow('mail-1');
  expect(h.invoke.mock.calls).toEqual([
    ['account_overview_settings',{accountId:'a',settings}],['account_overview_auto_refresh',{accountId:'a'}],['open_mail_window',{messageId:'mail-1'}],
  ]);
});
it('keeps overview cache reads, paid generation and local feedback as separate commands', async () => {
  await getAccountOverview('a'); await generateAccountOverview('a',30); await setAccountOverviewFeedback('a','thread:example','ignore');
  expect(h.invoke.mock.calls).toEqual([
    ['account_overview_get',{accountId:'a'}],['account_overview_generate',{accountId:'a',windowDays:30}],
    ['account_overview_feedback',{accountId:'a',itemId:'thread:example',action:'ignore'}],
  ]);
});
