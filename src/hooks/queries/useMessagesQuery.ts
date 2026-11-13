import { useId, useState } from "react";
import { useInfiniteQuery, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { listMessages, listUnreadMessages } from "@/lib/api";
import type { MessageSummary } from "@/lib/api";
import { useMailSortStore } from "@/stores/mailSort.store";

export const MESSAGES_PAGE_SIZE = 50;

export const messagesQueryKey = (folderId: string, folderIds?: string[], senderAscending?: boolean) =>
  senderAscending === undefined
    ? ["messages", folderId, folderIds] as const
    : ["messages", folderId, folderIds, "sender", senderAscending] as const;

/**
 * Paginated message list backed by React Query's useInfiniteQuery.
 * Each page is a MessageSummary[] fetched by a stable date/id cursor; `data` flattens them
 * so render code keeps the flat-array shape it already expects.
 * `unreadOnly`（"所有未读"视图）走 list_unread_messages，与文件夹无关。
 */
export function useMessagesQuery(
  folderId: string | null,
  folderIds?: string[],
  unreadOnly = false,
  folderVisit = 0,
) {
  const client = useQueryClient();
  const instanceId = useId();
  const [visit, setVisit] = useState({ unreadOnly, folderVisit, generation: 0 });
  const currentVisit = visit.unreadOnly === unreadOnly && visit.folderVisit === folderVisit
    ? visit : { unreadOnly, folderVisit, generation: visit.generation + 1 };
  if (currentVisit !== visit) setVisit(currentVisit);
  const unreadKey = ["messages", "__unread__", instanceId, currentVisit.generation] as const;
  const sort = useMailSortStore((s) => s.sort);
  const senderAscending = sort.key === "sender" ? sort.dir === "asc" : undefined;
  const query = useInfiniteQuery({
    queryKey: unreadOnly ? [...unreadKey, senderAscending] : messagesQueryKey(folderId ?? "", folderIds, senderAscending),
    queryFn: ({ pageParam }) => {
      if (unreadOnly) {
        // Keep rows already shown in this visit eligible even after their flag
        // changes. SQLite still supplies the current flags and overall sort.
        const visibleIds = [...new Set(client.getQueriesData<MessagesInfiniteData>({ queryKey: unreadKey })
          .flatMap(([, data]) => data?.pages.flatMap(page => page.map(message => message.id)) ?? []))];
        const offset = typeof pageParam === "number" ? pageParam : 0;
        return visibleIds.length
          ? listUnreadMessages(MESSAGES_PAGE_SIZE, offset, senderAscending, visibleIds)
          : listUnreadMessages(MESSAGES_PAGE_SIZE, offset, senderAscending);
      }
      return listMessages(
          folderId!,
          MESSAGES_PAGE_SIZE,
          senderAscending === undefined ? 0 : (pageParam as number),
          folderIds,
          senderAscending !== undefined || pageParam === 0 ? null : (pageParam as { date: number; id: string }),
          senderAscending,
        );
    },
    initialPageParam: 0 as number | { date: number; id: string },
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < MESSAGES_PAGE_SIZE) return undefined;
      if (unreadOnly || senderAscending !== undefined) return allPages.length * MESSAGES_PAGE_SIZE;
      const last = lastPage[lastPage.length - 1];
      return { date: last.date, id: last.id };
    },
    enabled: !!folderId || unreadOnly,
    // 15s staleTime：新邮件到达后（mail:new 事件 invalidate）立即刷新；
    // 即使事件偶发丢失，也最多 15 秒出现在列表，不会干等 60 秒。
    staleTime: unreadOnly ? 0 : 15_000,
  });

  // A row can move across a loaded page boundary during send/sync. Keep its
  // stable local ID once until the remaining pages finish refreshing.
  const seen = new Set<string>();
  const data: MessageSummary[] = (query.data?.pages.flat() ?? []).filter(message => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
  return {
    data,
    isLoading: query.isLoading,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
  };
}

export type MessagesInfiniteData = InfiniteData<MessageSummary[], number>;

/**
 * Patch every cached ["messages", ...] infinite-query entry with a transform
 * applied to each page's flat array. Used by optimistic flag/delete/move
 * updates so they don't have to know about the page shape.
 */
export function patchMessagesCache(
  queryClient: QueryClient,
  transform: (messages: MessageSummary[]) => MessageSummary[],
) {
  queryClient.setQueriesData<MessagesInfiniteData>(
    { queryKey: ["messages"] },
    (old) => {
      if (!old) return old;
      return { ...old, pages: old.pages.map(transform) };
    },
  );
}

/** Find the first cached message matching `predicate` across all pages. */
export function findCachedMessage(
  queryClient: QueryClient,
  predicate: (m: MessageSummary) => boolean,
): MessageSummary | undefined {
  const entries = queryClient.getQueriesData<MessagesInfiniteData>({ queryKey: ["messages"] });
  for (const [, data] of entries) {
    if (!data) continue;
    for (const page of data.pages) {
      const hit = page.find(predicate);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Read a flat snapshot of the first non-empty cached message list. */
export function readFirstCachedMessages(queryClient: QueryClient): MessageSummary[] {
  const entries = queryClient.getQueriesData<MessagesInfiniteData>({ queryKey: ["messages"] });
  for (const [, data] of entries) {
    const flat = data?.pages.flat() ?? [];
    if (flat.length > 0) return flat;
  }
  return [];
}

/**
 * Snapshot every ["messages", ...] cache entry so it can be restored on
 * optimistic-update rollback. Returns an array of [queryKey, data] pairs.
 */
export function snapshotMessagesCache(queryClient: QueryClient) {
  return queryClient.getQueriesData<MessagesInfiniteData>({ queryKey: ["messages"] });
}

export function restoreMessagesCache(
  queryClient: QueryClient,
  snapshot: ReturnType<typeof snapshotMessagesCache>,
  deletedIds?: readonly string[],
) {
  for (const [key, data] of snapshot) {
    if (!deletedIds) {
      queryClient.setQueryData(key, data);
      continue;
    }
    // A failed delete must not resurrect other concurrently deleted rows or
    // overwrite newer read/star flags with a whole-list snapshot.
    const restoreIds = new Set(deletedIds);
    queryClient.setQueryData<MessagesInfiniteData>(key, current => {
      if (!current || !data) return current;
      const present = new Set(current.pages.flat().map(message => message.id));
      const pages = current.pages.map(page => [...page]);
      data.pages.forEach((page, pageIndex) => {
        const target = pages[Math.min(pageIndex, pages.length - 1)];
        if (!target) return;
        page.forEach((message, index) => {
          if (restoreIds.has(message.id) && !present.has(message.id)) {
            target.splice(Math.min(index, target.length), 0, message);
            present.add(message.id);
          }
        });
      });
      return { ...current, pages };
    });
  }
}
