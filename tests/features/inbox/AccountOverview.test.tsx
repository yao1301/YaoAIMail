import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import AccountOverview from '../../../src/features/inbox/AccountOverview';
import type { AccountOverviewData, AccountOverviewItem } from '../../../src/lib/api';
import { clearAccountOverviewMemoryCache } from '../../../src/features/inbox/accountOverviewCache';

const h = vi.hoisted(() => ({ get: vi.fn(), generate: vi.fn(), feedback: vi.fn(), settings: vi.fn(), auto: vi.fn(),
  listeners: new Map<string, (event: any) => void>(),
  mail: { setActiveAccountId: vi.fn(), setActiveFolderId: vi.fn(), setSearchScope: vi.fn() },
  ui: { setActiveView: vi.fn(), setMessageDetailId: vi.fn(), openMessageInInbox: vi.fn() } }));
vi.mock('../../../src/lib/api', () => ({ getAccountOverview: h.get, generateAccountOverview: h.generate, setAccountOverviewFeedback: h.feedback, setAccountOverviewSettings:h.settings, autoRefreshAccountOverview:h.auto }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, fn: (event: any) => void) => { h.listeners.set(name,fn); return () => { if (h.listeners.get(name) === fn) h.listeners.delete(name); }; }) }));
vi.mock('../../../src/stores/mail.store', () => ({ useMailStore: { getState: () => h.mail } }));
vi.mock('../../../src/stores/ui.store', () => ({ useUIStore: (select: any) => select(h.ui) }));
const item = (id = 'task', overrides: Partial<AccountOverviewItem> = {}): AccountOverviewItem => ({
  id: `thread:${id}`, revision: 'r1', bucket: 'needs_action', title: `Task ${id}`, summary: `Business request ${id}`, nextAction: 'Verify and prepare a response for review.',
  dueText: 'Friday', needsVerification: false, latestDate: 100,
  proofs: [{ messageId: id, label: `Source ${id}`, sender: 'buyer@example.com', date: 100, quote: 'Please confirm shipment by Friday.', folderId: 'inbox-a' }], ...overrides,
});
const data = (accountId = 'a', items = [item()]): AccountOverviewData => ({ accountId, stale: false, feedback: [], settings:{autoGenerate:false,windowDays:7},nextAutoAt:null,snapshot: {
  accountId, generatedAt: 101, revision: 'r1', scope: { windowDays: 7, from: 1, to: 101, scanned: 12, filteredBulk: 3, ignored: 1, selected: 4, pinnedOutsideWindow: 0, scanLimited: false, selectionLimited: true },
  items, evidenceReport: { discoveredMailCount: 4, readMailCount: 3, completeMailCount: 2, resources: [], warnings: ['部分正文未读完'], trace: [{ tool: 'mail_read', status: 'ok' }], budgetExhausted: false, toolFallback: false }, warnings: ['有限范围；空列表不代表没有待办。'],
} });
beforeEach(() => { clearAccountOverviewMemoryCache(); vi.clearAllMocks(); h.listeners.clear(); h.get.mockReset().mockResolvedValue(data()); h.generate.mockReset().mockResolvedValue(data()); h.feedback.mockReset().mockResolvedValue(data());
  h.settings.mockReset().mockImplementation(async (accountId,settings)=>{const result={...data(accountId),settings};h.get.mockResolvedValue(result);return result;});
  h.auto.mockReset().mockImplementation(async()=>{const result={...data(),settings:{autoGenerate:true,windowDays:7},nextAutoAt:Math.floor(Date.now()/1000)+21600};h.get.mockResolvedValue(result);return result;});
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function loaded() { await waitFor(() => expect(screen.queryByRole('status')).toBeNull()); }

it('lets users dismiss both notices; polling and returning do not resurrect the same warnings', async () => {
  h.get.mockResolvedValue({...data(),stale:true,autoError:'Example model failed',lastAttempt:123});
  const view=render(<AccountOverview accountId="a"/>);await loaded();
  fireEvent.click(screen.getByRole('button',{name:'关闭分析失败提示'}));
  fireEvent.click(screen.getByRole('button',{name:'关闭缓存变更提示'}));
  expect(screen.queryByRole('alert')).toBeNull();expect(screen.queryByText(/本地邮件数据已有变化/)).toBeNull();
  expect(screen.getByText(/缓存结果（待更新）/)).toBeTruthy();expect(screen.getByText('Task task')).toBeTruthy();
  view.unmount();render(<AccountOverview accountId="a"/>);await loaded();
  expect(screen.queryByRole('alert')).toBeNull();expect(screen.queryByText(/本地邮件数据已有变化/)).toBeNull();
  expect(h.generate).not.toHaveBeenCalled();expect(h.auto).not.toHaveBeenCalled();
});
it('dismissal is scoped to the account and a new failed attempt is visible', async () => {
  h.get.mockImplementation(async(id:string)=>({...data(id),autoError:'Example model failed',lastAttempt:123}));
  const view=render(<AccountOverview accountId="a"/>);await loaded();
  fireEvent.click(screen.getByRole('button',{name:'关闭分析失败提示'}));
  view.rerender(<AccountOverview accountId="b"/>);await loaded();expect(screen.getByRole('alert')).toBeTruthy();
  view.rerender(<AccountOverview accountId="a"/>);await loaded();expect(screen.queryByRole('alert')).toBeNull();
  h.get.mockResolvedValue({...data(),autoError:'Example model failed',lastAttempt:124});
  view.unmount();render(<AccountOverview accountId="a"/>);await loaded();expect(screen.getByRole('alert')).toBeTruthy();
});
it('auto-collapses stale information after twelve seconds without hiding freshness status or changing retry eligibility', async () => {
  vi.useFakeTimers();h.get.mockResolvedValue({...data(),stale:true});
  const view=render(<AccountOverview accountId="a"/>);await act(async()=>{});
  expect(screen.getByText(/本地邮件数据已有变化/)).toBeTruthy();
  await act(async()=>{await vi.advanceTimersByTimeAsync(12_000);});
  expect(screen.queryByText(/本地邮件数据已有变化/)).toBeNull();expect(screen.getByText(/缓存结果（待更新）/)).toBeTruthy();
  view.unmount();render(<AccountOverview accountId="a"/>);await act(async()=>{});
  expect(screen.queryByText(/本地邮件数据已有变化/)).toBeNull();expect(h.auto).not.toHaveBeenCalled();
});

it('reads only local cache on opening and shows grounded cards in three groups', async () => {
  h.get.mockResolvedValue(data('a',[item(),item('waiting',{bucket:'waiting'}),item('risk',{bucket:'risk',needsVerification:true})]));
  render(<AccountOverview accountId="a" />); await loaded();
  expect(h.get).toHaveBeenCalledWith('a'); expect(h.generate).not.toHaveBeenCalled();
  expect(within(screen.getByRole('region',{name:'需我处理'})).getByText('Task task')).toBeTruthy();
  expect(within(screen.getByRole('region',{name:'等待对方'})).getByText('Task waiting')).toBeTruthy();
  expect(screen.getByText('证据不完整／需核验')).toBeTruthy(); expect(screen.getByText(/正文 3 封，完整读取 2 封/)).toBeTruthy();
});
it('auto-collapses a repeated failure banner but keeps the stale-result warning and original cards',async()=>{
  vi.useFakeTimers();h.get.mockResolvedValue({...data(),stale:true,autoError:'schema error',lastAttempt:123});
  render(<AccountOverview accountId="a"/>);await act(async()=>{});
  expect(screen.getByRole('alert')).toBeTruthy();
  await act(async()=>{await vi.advanceTimersByTimeAsync(15_000);});
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText(/以上是上次成功结果/)).toBeTruthy();
  expect(screen.getByText('Task task')).toBeTruthy();expect(h.auto).not.toHaveBeenCalled();
});
it('generates only on explicit click with the chosen account and window', async () => {
  h.get.mockResolvedValue({accountId:'a',snapshot:null,feedback:[],stale:false});
  render(<AccountOverview accountId="a" />); await loaded();
  expect(h.generate).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'7'}});
  fireEvent.click(screen.getByRole('button',{name:'生成事项总览'}));
  await waitFor(() => expect(h.generate).toHaveBeenCalledWith('a',7));
  await screen.findByText('Task task');
});
it('clears search scope and opens the exact cited original message', async () => {
  render(<AccountOverview accountId="a" />); await loaded();
  fireEvent.click(screen.getByRole('button',{name:'Source task'}));
  expect(h.mail.setActiveAccountId).toHaveBeenCalledWith('a'); expect(h.mail.setSearchScope).toHaveBeenCalledWith(null);
  expect(h.ui.openMessageInInbox).toHaveBeenCalledWith('task'); expect(h.ui.setMessageDetailId).toHaveBeenCalledWith('task');
  expect(h.ui.setActiveView).toHaveBeenCalledWith('messageDetail');
});
it('preserves last good cards and shows an actionable failure if refresh fails', async () => {
  h.generate.mockRejectedValue(new Error('Example model unavailable'));
  render(<AccountOverview accountId="a" />); await loaded();
  fireEvent.click(screen.getByRole('button',{name:'刷新事项'}));
  expect((await screen.findByRole('alert')).textContent).toContain('上次结果仍保留');
  expect(screen.getByText('Task task')).toBeTruthy();
});
it('does not apply a late generation to a newly selected account', async () => {
  let finish!: (value: AccountOverviewData) => void;
  h.generate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  h.get.mockImplementation((id: string) => Promise.resolve(data(id,[item(id)])));
  const view = render(<AccountOverview accountId="a" />); await loaded();
  fireEvent.click(screen.getByRole('button',{name:'刷新事项'}));
  view.rerender(<AccountOverview accountId="b" />); await loaded();
  await act(async () => { finish(data('a',[item('late-a')])); });
  expect(screen.getByText('Task b')).toBeTruthy(); expect(screen.queryByText('Task late-a')).toBeNull(); expect(screen.queryByText('Task a')).toBeNull();
});
it('does not display a late cache load from the previous account', async () => {
  let finish!: (value: AccountOverviewData) => void;
  h.get.mockImplementation((id: string) => id === 'a' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(data('b',[item('b')])));
  const view = render(<AccountOverview accountId="a" />); view.rerender(<AccountOverview accountId="b" />); await loaded();
  await act(async () => { finish(data('a',[item('late-a')])); });
  expect(screen.getByText('Task b')).toBeTruthy(); expect(screen.queryByText('Task late-a')).toBeNull();
});
it('rejects a mismatched cache account rather than showing its business contents', async () => {
  h.get.mockResolvedValue(data('foreign',[item('foreign')]));
  render(<AccountOverview accountId="a" />); await loaded();
  expect(screen.getByRole('alert').textContent).toContain('账户不匹配'); expect(screen.queryByText('Task foreign')).toBeNull();
});
it('persists ignore through the backend and offers restore without deleting mail', async () => {
  const ignored = data(); ignored.feedback = [{id:'thread:task',label:'Task task',sourceMessageId:'task',pinned:false,ignoredThrough:100,updatedAt:101}];
  h.feedback.mockResolvedValueOnce(ignored).mockResolvedValueOnce(data());
  render(<AccountOverview accountId="a" />); await loaded();
  fireEvent.click(screen.getByRole('button',{name:'忽略此事项'}));
  await waitFor(() => expect(h.feedback).toHaveBeenCalledWith('a','thread:task','ignore'));
  await screen.findByRole('button',{name:'恢复此事项'});
  expect(screen.queryByText('Business request task')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'恢复此事项'}));
  await waitFor(() => expect(h.feedback).toHaveBeenLastCalledWith('a','thread:task','restore'));
  expect(await screen.findByText('Business request task')).toBeTruthy(); expect(h.generate).not.toHaveBeenCalled();
});
it('allows newer mail to reappear despite an ignore record for an old snapshot', async () => {
  const newer = data('a',[item('task',{latestDate:200})]);
  newer.feedback = [{id:'thread:task',label:'Task task',sourceMessageId:'task',pinned:false,ignoredThrough:100,updatedAt:101}];
  h.get.mockResolvedValue(newer); render(<AccountOverview accountId="a" />); await loaded();
  expect(screen.getByText('Business request task')).toBeTruthy();
});
it('places user-pinned cards first and reports a stale snapshot without an automatic AI refresh', async () => {
  const pinned = data('a',[item('newer',{latestDate:300}),item('pinned')]); pinned.stale = true;
  pinned.feedback = [{id:'thread:pinned',label:'Task pinned',sourceMessageId:'pinned',pinned:true,ignoredThrough:null,updatedAt:101}];
  h.get.mockResolvedValue(pinned); render(<AccountOverview accountId="a" />); await loaded();
  expect(screen.getAllByRole('article')[0].textContent).toContain('Task pinned');
  expect(screen.getByText(/本地邮件数据已有变化/)).toBeTruthy(); expect(h.generate).not.toHaveBeenCalled();
});
it('renders model summaries as text, not executable HTML', async () => {
  h.get.mockResolvedValue(data('a',[item('safe',{summary:'<img src=x onerror=alert(1)>'})]));
  const view = render(<AccountOverview accountId="a" />); await loaded();
  expect(view.container.querySelector('img')).toBeNull(); expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
});
it('flags new account mail as stale without spending AI calls or mixing other account events', async () => {
  render(<AccountOverview accountId="a" />); await loaded();
  act(() => h.listeners.get('mail:new')?.({payload:{account_id:'b'}}));
  expect(screen.queryByText(/本地邮件数据已有变化/)).toBeNull();
  act(() => h.listeners.get('mail:new')?.({payload:{account_id:'a'}}));
  expect(screen.getByText(/本地邮件数据已有变化/)).toBeTruthy(); expect(h.generate).not.toHaveBeenCalled();
});
it('does not clear a new-mail stale flag when an older refresh response arrives', async () => {
  let finish!: (value: AccountOverviewData) => void;
  h.generate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<AccountOverview accountId="a" />); await loaded();
  fireEvent.click(screen.getByRole('button',{name:'刷新事项'}));
  act(() => h.listeners.get('mail:new')?.({payload:{account_id:'a'}}));
  await act(async () => { finish(data()); });
  expect(screen.getByText(/本地邮件数据已有变化/)).toBeTruthy();
});
it('uses thread revisions rather than dates to restore a backfilled business item', async () => {
  const changed = data('a',[item('task',{revision:'r2'})]);
  changed.feedback = [{id:'thread:task',label:'Task task',sourceMessageId:'task',pinned:false,ignoredThrough:100,ignoredRevision:'r1',updatedAt:101}];
  h.get.mockResolvedValue(changed); render(<AccountOverview accountId="a" />); await loaded();
  expect(screen.getByText('Business request task')).toBeTruthy();
});
it('does not claim new business mail merely because a sync worker finished', async () => {
  render(<AccountOverview accountId="a" />); await loaded();
  act(() => h.listeners.get('mail:sync-complete')?.({payload:{account_id:'a'}}));
  expect(screen.queryByText(/本地邮件数据已有变化/)).toBeNull(); expect(h.generate).not.toHaveBeenCalled();
});

async function autoPage(initial: AccountOverviewData) {
  vi.useFakeTimers();
  vi.spyOn(document,'hidden','get').mockReturnValue(false);
  h.get.mockResolvedValue(initial);
  const view = render(<AccountOverview accountId="a" />);
  await act(async () => {});
  return view;
}
const automatic = (overrides: Partial<AccountOverviewData> = {}): AccountOverviewData => ({...data(),settings:{autoGenerate:true,windowDays:7},nextAutoAt:0,...overrides});
it('leaves automatic generation off for a new account and persists explicit opt-in', async () => {
  await autoPage(automatic({snapshot:null,settings:{autoGenerate:false,windowDays:7},nextAutoAt:null}));
  expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false);
  await act(async()=>{fireEvent.click(screen.getByRole('switch'));});
  expect(h.settings).toHaveBeenCalledWith('a',{autoGenerate:true,windowDays:7});
  expect(h.auto).not.toHaveBeenCalled(); expect(h.generate).not.toHaveBeenCalled();
});
it('reuses a fresh cache and never calls the model just for repeated renders', async () => {
  const view = await autoPage(automatic({nextAutoAt:Math.floor(Date.now()/1000)+21600}));
  view.rerender(<AccountOverview accountId="a" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(h.auto).not.toHaveBeenCalled();
});
it('can disable automatic generation before it starts and persists the preference', async () => {
  await autoPage(automatic({snapshot:null}));
  await act(async () => { fireEvent.click(screen.getByRole('switch')); });
  expect(h.settings).toHaveBeenCalledWith('a',{autoGenerate:false,windowDays:7});
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(h.auto).not.toHaveBeenCalled();
});
it('saves the selected range per account rather than borrowing an old snapshot range', async () => {
  h.get.mockResolvedValue({...data(),settings:{autoGenerate:false,windowDays:30}});
  render(<AccountOverview accountId="a"/>); await loaded();
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('30');
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'90'}});
  await waitFor(()=>expect(h.settings).toHaveBeenCalledWith('a',{autoGenerate:false,windowDays:90}));
  await waitFor(()=>expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('90'));
});
it('explains a background timeout while keeping the previous cards', async () => {
  await autoPage(automatic({autoError:'Translation error: 事项模型响应超时',stale:true}));
  expect(screen.getByRole('alert').textContent).toContain('AI 响应超时');
  expect(screen.getByText('Task task')).toBeTruthy();
  expect(h.auto).not.toHaveBeenCalled();
});
it('clears a scheduled auto refresh on unmount or account switch', async () => {
  const view = await autoPage(automatic());
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(h.auto).not.toHaveBeenCalled();
});
it('does not issue a paid refresh from the UI after new mail', async () => {
  await autoPage(automatic());
  act(()=>h.listeners.get('mail:new')?.({payload:{account_id:'a'}}));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(h.auto).not.toHaveBeenCalled();
});
it('uses distinct flat header classes and text labels, not color alone', async () => {
  render(<AccountOverview accountId="a"/>); await loaded();
  for (const [label,bucket] of [['需我处理','needs_action'],['等待对方','waiting'],['期限与风险','risk']]) {
    const region = screen.getByRole('region',{name:label});
    expect(region.className).toContain(`account-overview__column--${bucket}`);
    expect(within(region).getByRole('heading',{level:3}).textContent).toContain(label);
  }
});
it('never issues an automatic model request from StrictMode mounts', async () => {
  vi.useFakeTimers(); vi.spyOn(document,'hidden','get').mockReturnValue(false);
  h.get.mockResolvedValue(automatic({snapshot:null}));
  render(<StrictMode><AccountOverview accountId="a"/></StrictMode>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_000);});
  expect(h.auto).not.toHaveBeenCalled(); expect(h.generate).not.toHaveBeenCalled();
});
it('only reloads cache for a completion event belonging to the visible account', async () => {
  await autoPage(automatic());
  h.get.mockResolvedValue(data('a',[item('background-result')]));
  await act(async()=>h.listeners.get('account-overview:updated')?.({payload:'b'}));
  expect(screen.queryByText('Task background-result')).toBeNull();
  await act(async()=>h.listeners.get('account-overview:updated')?.({payload:'a'}));
  expect(screen.getByText('Task background-result')).toBeTruthy();
  expect(h.auto).not.toHaveBeenCalled();
});
it('picks up a generation finished elsewhere by reading cache, without a paid call', async () => {
  await autoPage(automatic({snapshot:null,nextAutoAt:Math.floor(Date.now()/1000)+900}));
  h.get.mockResolvedValue(automatic({nextAutoAt:Math.floor(Date.now()/1000)+21600}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(30_000);});
  expect(screen.getByText('Task task')).toBeTruthy();expect(h.auto).not.toHaveBeenCalled();
});
it('shows existing cards synchronously on returning while the encrypted cache is rechecked', async () => {
  const view=render(<AccountOverview accountId="a"/>);await loaded();view.unmount();
  h.get.mockImplementation(()=>new Promise(()=>{}));
  render(<AccountOverview accountId="a"/>);
  expect(screen.getByText('Task task')).toBeTruthy();
  expect(screen.queryByText(/正在读取本地事项缓存/)).toBeNull();
  expect(h.generate).not.toHaveBeenCalled();expect(h.auto).not.toHaveBeenCalled();
});
it('immediately shows the destination account cache without exposing previous account cards', async () => {
  h.get.mockImplementation((id:string)=>Promise.resolve(data(id,[item(id)])));
  const view=render(<AccountOverview accountId="a"/>);await loaded();
  view.rerender(<AccountOverview accountId="b"/>);await loaded();
  h.get.mockImplementation(()=>new Promise(()=>{}));
  view.rerender(<AccountOverview accountId="a"/>);
  expect(screen.getByText('Task a')).toBeTruthy();expect(screen.queryByText('Task b')).toBeNull();
});
it('retains a generation completed after leaving so the next visit can display it immediately', async () => {
  let finish!:(value:AccountOverviewData)=>void;
  h.generate.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const view=render(<AccountOverview accountId="a"/>);await loaded();
  fireEvent.click(screen.getByRole('button',{name:'刷新事项'}));view.unmount();
  await act(async()=>finish(data('a',[item('finished-while-away')])));
  h.get.mockImplementation(()=>new Promise(()=>{}));
  render(<AccountOverview accountId="a"/>);
  expect(screen.getByText('Task finished-while-away')).toBeTruthy();
});
it('shows last cards during a background model refresh instead of an empty loading page', async () => {
  h.generate.mockImplementation(()=>new Promise(()=>{}));
  render(<AccountOverview accountId="a"/>);await loaded();
  fireEvent.click(screen.getByRole('button',{name:'刷新事项'}));
  expect(screen.getByText('Task task')).toBeTruthy();
  expect(screen.getByRole('button',{name:'后台更新中…'})).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('不会清空卡片');
});
it('displays when the next native refresh check is eligible without shortening its interval', async () => {
  h.get.mockResolvedValue(automatic({nextAutoAt:Math.floor(Date.now()/1000)+21600}));
  render(<AccountOverview accountId="a"/>);await loaded();
  expect(screen.getByText(/最早下次自动更新检查/).textContent).toContain('不调用 AI');
  expect(h.auto).not.toHaveBeenCalled();
});
it('rejoins an unfinished generation on return and shows its result without another model call or polling delay', async () => {
  let finish!:(value:AccountOverviewData)=>void;
  h.generate.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const view=render(<AccountOverview accountId="a"/>);await loaded();
  fireEvent.click(screen.getByRole('button',{name:'刷新事项'}));view.unmount();
  render(<AccountOverview accountId="a"/>);await act(async()=>{});
  expect(screen.getByText('Task task')).toBeTruthy();
  expect(screen.getByRole('button',{name:'后台更新中…'})).toBeTruthy();
  await act(async()=>finish(data('a',[item('joined-result')])));
  expect(screen.getByText('Task joined-result')).toBeTruthy();
  expect(h.generate).toHaveBeenCalledTimes(1);expect(h.auto).not.toHaveBeenCalled();
});
