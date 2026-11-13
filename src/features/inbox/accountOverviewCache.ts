import { getAccountOverview, type AccountOverviewData } from '@/lib/api';
import { getProfileStorageNamespace } from '@/lib/profileStorage';

type Entry = {
  version: number;
  data?: AccountOverviewData;
  reading?: Promise<AccountOverviewData>;
  generating?: { days: number; result: Promise<AccountOverviewData> };
  notices?: Map<string, { firstSeen: number; dismissed: boolean }>;
};
// A small, per-WebView presentation cache only. Durable records, encryption and
// paid-refresh eligibility remain in the native data database, never localStorage.
const entries = new Map<string, Entry>();
const key = (accountId: string) => JSON.stringify([getProfileStorageNamespace(),accountId]);
function entry(accountId: string): Entry {
  const id = key(accountId);
  const value = entries.get(id) ?? {version:0};
  entries.delete(id); entries.set(id,value);
  while (entries.size > 16) entries.delete(entries.keys().next().value!);
  return value;
}
function checked(accountId: string, data: AccountOverviewData) {
  if (data.accountId !== accountId || (data.snapshot && data.snapshot.accountId !== accountId)) {
    throw new Error('事项结果账户不匹配，未显示其他账户内容');
  }
  return data;
}
export function peekAccountOverview(accountId: string): AccountOverviewData | null {
  return entries.get(key(accountId))?.data ?? null;
}
export function pendingAccountOverviewGeneration(accountId: string): Promise<AccountOverviewData> | null {
  return entries.get(key(accountId))?.generating?.result ?? null;
}
export function readAccountOverview(accountId: string): Promise<AccountOverviewData> {
  const slot = entry(accountId);
  if (slot.reading) return slot.reading;
  const version = slot.version;
  const result = getAccountOverview(accountId).then(value => {
    const data = checked(accountId,value);
    if (slot.version === version) slot.data = data;
    // A read started before a newer write completed cannot blank newer cards.
    return slot.version === version ? data : slot.data ?? data;
  }).finally(() => { if (slot.reading === result) slot.reading = undefined; });
  slot.reading = result;
  return result;
}
export async function updateAccountOverview(accountId: string, run: () => Promise<AccountOverviewData>): Promise<AccountOverviewData> {
  const slot = entry(accountId);
  const version = ++slot.version;
  slot.reading = undefined;
  const data = checked(accountId,await run());
  if (slot.version === version) { ++slot.version; slot.data = data; }
  // This completes even after the initiating page unmounts. The next visit can
  // immediately display it, rather than waiting for another disk round trip.
  return data;
}
export function runAccountOverviewGeneration(accountId: string, days: number, run: () => Promise<AccountOverviewData>): Promise<AccountOverviewData> {
  const slot = entry(accountId);
  if (slot.generating) {
    if (slot.generating.days !== days) return Promise.reject(new Error('该账户已有其他时间范围的分析，请等待完成后刷新'));
    return slot.generating.result;
  }
  const result = updateAccountOverview(accountId,run).finally(() => {
    if (slot.generating?.result === result) slot.generating = undefined;
  });
  slot.generating = {days,result};
  return result;
}
export function clearAccountOverviewMemoryCache() { entries.clear(); }

// Presentation only: dismissing a notice never changes the stored error,
// source freshness or the native paid-refresh cooldown. Scoped like cards.
export function overviewNoticeState(accountId: string, noticeId: string) {
  const slot = entry(accountId);
  const notices = slot.notices ??= new Map();
  let notice = notices.get(noticeId);
  if (!notice) {
    notice = { firstSeen: Date.now(), dismissed: false };
    notices.set(noticeId, notice);
    while (notices.size > 8) notices.delete(notices.keys().next().value!);
  }
  return notice;
}
