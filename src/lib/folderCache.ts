import type { QueryClient } from "@tanstack/react-query";
import type { Folder } from "./api";

// Folder LIST requests can outlive a drag mutation. A response started before
// the mutation must never overwrite the authoritative tree returned by the
// mutation, otherwise the server and the sidebar diverge even though the DB
// already contains the new parent_id.
const revisions = new Map<string, number>();

export function beginFolderCacheRevision(accountId: string): number {
  const next = (revisions.get(accountId) ?? 0) + 1;
  revisions.set(accountId, next);
  return next;
}

export function currentFolderCacheRevision(accountId: string): number {
  return revisions.get(accountId) ?? 0;
}

export function setFolderCacheIfCurrent(
  queryClient: QueryClient,
  accountId: string,
  folders: Folder[],
  revision: number,
): boolean {
  if (currentFolderCacheRevision(accountId) !== revision) return false;
  queryClient.setQueryData<Folder[]>(["folders", accountId], folders);
  return true;
}

