import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { listFolders } from "@/lib/api";
import { currentFolderCacheRevision } from "@/lib/folderCache";

/**
 * A folder LIST started before a drag must not be allowed to replace the
 * committed tree after the drag. React Query normally writes every resolved
 * query result into its cache, even if a newer mutation has already updated
 * that cache, so the request itself must reject as stale.
 */
class StaleFolderQueryError extends Error {
  constructor() {
    super("stale folder query");
    this.name = "StaleFolderQueryError";
  }
}

async function listFoldersForCache(accountId: string) {
  const revision = currentFolderCacheRevision(accountId);
  const folders = await listFolders(accountId);
  if (currentFolderCacheRevision(accountId) !== revision) {
    throw new StaleFolderQueryError();
  }
  return folders;
}

function shouldRetryFolderQuery(failureCount: number, error: unknown) {
  // A stale response is expected during a drag and must never be retried.
  if (error instanceof StaleFolderQueryError) return false;
  return failureCount < 2;
}

export const foldersQueryKey = (accountId: string) =>
  ["folders", accountId] as const;

export function useFoldersQuery(accountId: string | null) {
  return useQuery({
    queryKey: foldersQueryKey(accountId ?? ""),
    queryFn: () => listFoldersForCache(accountId!),
    enabled: !!accountId,
    retry: shouldRetryFolderQuery,
    select: (folders) => [...folders].sort((a, b) => a.sort_order - b.sort_order),
  });
}

export function useFoldersForAccountsQuery(accountIds: string[]) {
  const queries = useQueries({
    queries: accountIds.map((accountId) => ({
      queryKey: foldersQueryKey(accountId),
      queryFn: () => listFoldersForCache(accountId),
      enabled: !!accountId,
      staleTime: 60_000,
      retry: shouldRetryFolderQuery,
    })),
  });

  const data = useMemo(
    () =>
      queries
        .flatMap((query) => query.data ?? [])
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [queries],
  );

  return {
    data,
    isFetched: accountIds.length === 0 || queries.every((query) => query.isFetched),
    isLoading: queries.some((query) => query.isLoading),
    isError: queries.some((query) => query.isError),
  };
}
