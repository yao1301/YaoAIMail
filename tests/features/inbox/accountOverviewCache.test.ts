import { beforeEach, expect, it, vi } from 'vitest';
import type { AccountOverviewData } from '../../../src/lib/api';
import { clearAccountOverviewMemoryCache, peekAccountOverview, readAccountOverview, updateAccountOverview, runAccountOverviewGeneration, overviewNoticeState } from '../../../src/features/inbox/accountOverviewCache';
const h=vi.hoisted(()=>({get:vi.fn(),namespace:'profile-a'}));
vi.mock('../../../src/lib/api',()=>({getAccountOverview:h.get}));
vi.mock('../../../src/lib/profileStorage',()=>({getProfileStorageNamespace:()=>h.namespace}));
const value=(accountId='a'):AccountOverviewData=>({accountId,snapshot:null,feedback:[],stale:false,settings:{autoGenerate:true,windowDays:7},nextAutoAt:21600});
beforeEach(()=>{clearAccountOverviewMemoryCache();vi.clearAllMocks();h.namespace='profile-a';h.get.mockReset().mockResolvedValue(value());});
it('keeps dismissals out of browser storage and isolates profile and account identities',()=>{
  const before=localStorage.length;
  overviewNoticeState('a','error').dismissed=true;
  expect(overviewNoticeState('a','error').dismissed).toBe(true);
  expect(overviewNoticeState('b','error').dismissed).toBe(false);
  h.namespace='profile-b';expect(overviewNoticeState('a','error').dismissed).toBe(false);
  expect(localStorage.length).toBe(before);
});
it('deduplicates local reads and retains the result for immediate presentation',async()=>{
  const first=readAccountOverview('a');const second=readAccountOverview('a');
  expect(first).toBe(second);expect(h.get).toHaveBeenCalledTimes(1);
  await first;expect(peekAccountOverview('a')).toEqual(value());expect(peekAccountOverview('b')).toBeNull();
});
it('never shares cards between accounts or profile namespaces',async()=>{
  await readAccountOverview('a');h.namespace='profile-b';expect(peekAccountOverview('a')).toBeNull();
  h.namespace='profile-a';expect(peekAccountOverview('a')?.accountId).toBe('a');
});
it('rejects a foreign account result without retaining it',async()=>{
  h.get.mockResolvedValue(value('foreign'));
  await expect(readAccountOverview('a')).rejects.toThrow('账户不匹配');expect(peekAccountOverview('a')).toBeNull();
});
it('does not let a delayed pre-generation read replace newer completed results',async()=>{
  let finish!:(data:AccountOverviewData)=>void;
  h.get.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const oldRead=readAccountOverview('a');const fresh={...value(),nextAutoAt:99999};
  await updateAccountOverview('a',async()=>fresh);finish(value());
  expect(await oldRead).toEqual(fresh);expect(peekAccountOverview('a')).toEqual(fresh);
});
it('keeps last good cards when a generation fails',async()=>{
  await readAccountOverview('a');
  await expect(runAccountOverviewGeneration('a',7,async()=>{throw new Error('Example model failed');})).rejects.toThrow('Example model failed');
  expect(peekAccountOverview('a')).toEqual(value());
});
it('reuses an in-flight generation after page remount and rejects a conflicting range',async()=>{
  let finish!:(data:AccountOverviewData)=>void;
  const run=vi.fn(()=>new Promise<AccountOverviewData>(resolve=>{finish=resolve;}));
  const first=runAccountOverviewGeneration('a',7,run);
  expect(runAccountOverviewGeneration('a',7,run)).toBe(first);
  await expect(runAccountOverviewGeneration('a',30,run)).rejects.toThrow('其他时间范围');
  expect(run).toHaveBeenCalledTimes(1);finish(value());await first;
  expect(peekAccountOverview('a')).toEqual(value());
});
it('bounds in-memory account records without creating browser storage records',async()=>{
  const before=localStorage.length;
  for(let i=0;i<17;i++) await updateAccountOverview(String(i),async()=>value(String(i)));
  expect(peekAccountOverview('0')).toBeNull();expect(peekAccountOverview('16')?.accountId).toBe('16');
  expect(localStorage.length).toBe(before);
});
