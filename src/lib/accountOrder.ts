import { profileLocalStorage } from './profileStorage';

export const ACCOUNT_ORDER_KEY = 'pebble-sidebar-account-order';
export const ACCOUNT_DRAG_TYPE = 'application/x-pebble-account-id';

export function readAccountOrder(): string[] {
  try {
    const value: unknown = JSON.parse(profileLocalStorage.getItem(ACCOUNT_ORDER_KEY) ?? '[]');
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))] : [];
  } catch { return []; }
}

/** Deleted accounts disappear; newly added accounts follow the saved ones. */
export function orderAccounts<T extends { id: string }>(accounts: T[], order: string[]): T[] {
  const remaining = new Map(accounts.map(account => [account.id, account]));
  const result: T[] = [];
  for (const id of order) {
    const account = remaining.get(id);
    if (account) { result.push(account); remaining.delete(id); }
  }
  return [...result, ...remaining.values()];
}

export function moveAccountInOrder(ids: string[], source: string, target: string, position: 'before' | 'after'): string[] {
  if (source === target || !ids.includes(source) || !ids.includes(target)) return ids;
  const next = ids.filter(id => id !== source);
  next.splice(next.indexOf(target) + (position === 'after' ? 1 : 0), 0, source);
  return next;
}

export function saveAccountOrder(ids: string[]) {
  profileLocalStorage.setItem(ACCOUNT_ORDER_KEY, JSON.stringify(ids));
}
