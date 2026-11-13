import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMailSortStore } from "../../src/stores/mailSort.store";
import { useMessagesQuery, snapshotMessagesCache, restoreMessagesCache, patchMessagesCache } from "../../src/hooks/queries/useMessagesQuery";

const mocks = vi.hoisted(() => ({ listMessages: vi.fn(), listUnreadMessages: vi.fn() }));
vi.mock("../../src/lib/api", () => mocks);
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem("pebble-mail-sort");
  useMailSortStore.setState({ sort: { key: "date", dir: "desc" } });
});
describe("folder sorting and pagination", () => {
  it('renders a stable row once when refreshed page boundaries overlap', async () => {
    const page = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, date: 100 - i }));
    mocks.listMessages.mockResolvedValueOnce(page).mockResolvedValueOnce([page[49], { id: 'genuine-other-copy', date: 50 }]);
    const { result } = renderHook(() => useMessagesQuery('sent'), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(50));
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.data).toHaveLength(51));
    expect(result.current.data.filter(message => message.id === 'm49')).toHaveLength(1);
    expect(result.current.data.at(-1)?.id).toBe('genuine-other-copy');
  });
  it("rolls back only a failed deletion, retaining other deletes and newer flags", () => {
    const client = new QueryClient();
    const key = ["messages", "inbox"];
    client.setQueryData(key, { pages: [[{ id: "a", is_read: false }, { id: "b" }, { id: "c" }]], pageParams: [null] });
    const snapshot = snapshotMessagesCache(client);
    patchMessagesCache(client, page => page.filter(message => message.id === "a").map(message => ({ ...message, is_read: true })));
    restoreMessagesCache(client, snapshot, ["b"]);
    expect(client.getQueryData(key)).toEqual({ pages: [[{ id: "a", is_read: true }, { id: "b" }]], pageParams: [null] });
    client.clear();
  });

  it("does not recreate an evicted list when a late deletion fails", () => {
    const client = new QueryClient();
    const key = ["messages", "inbox"];
    client.setQueryData(key, { pages: [[{ id: "b" }]], pageParams: [null] });
    const snapshot = snapshotMessagesCache(client);
    client.removeQueries({ queryKey: key });
    restoreMessagesCache(client, snapshot, ["b"]);
    expect(client.getQueryData(key)).toBeUndefined();
    client.clear();
  });
  it("defaults to newest-first cursor pagination", async () => {
    const page = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, date: 100 - i }));
    mocks.listMessages.mockResolvedValueOnce(page).mockResolvedValueOnce([]);
    const { result } = renderHook(() => useMessagesQuery("inbox"), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(50));
    await act(() => result.current.fetchNextPage());
    expect(mocks.listMessages).toHaveBeenLastCalledWith("inbox", 50, 0, undefined, { date: 51, id: "m49" }, undefined);
  });
  it("fetches sender-sorted pages for aggregated folders and resets when toggling direction", async () => {
    mocks.listMessages.mockImplementation((_folder, _limit, offset, _ids, _cursor, ascending) =>
      Promise.resolve(offset ? [] : Array.from({ length: 50 }, (_, i) => ({ id: `${ascending}-${i}`, date: i }))));
    const { result } = renderHook(() => useMessagesQuery("one", ["one", "two"]), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(50));
    act(() => useMailSortStore.getState().toggleSort("sender"));
    await waitFor(() => expect(result.current.data[0]?.id).toBe("true-0"));
    await act(() => result.current.fetchNextPage());
    expect(mocks.listMessages).toHaveBeenLastCalledWith("one", 50, 50, ["one", "two"], null, true);
    act(() => useMailSortStore.getState().toggleSort("sender"));
    await waitFor(() => expect(result.current.data[0]?.id).toBe("false-0"));
    expect(localStorage.getItem("pebble-mail-sort")).toBe(JSON.stringify({ key: "sender", dir: "desc" }));
  });
  it("applies sender order to all unread mail too", async () => {
    useMailSortStore.setState({ sort: { key: "sender", dir: "asc" } });
    mocks.listUnreadMessages.mockResolvedValue([{ id: "unread", date: 1 }]);
    const { result } = renderHook(() => useMessagesQuery(null, undefined, true), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(mocks.listUnreadMessages).toHaveBeenCalledWith(50, 0, true);
  });
  it("keeps the read row after a refresh and drops it on the next visit", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let read = false;
    mocks.listUnreadMessages.mockImplementation(async (_limit, _offset, _ascending, visibleIds?: string[]) =>
      !read || visibleIds?.includes("first") ? [{ id: "first", date: 1, is_read: read }] : []);
    const { result, rerender } = renderHook(({ visit }) => useMessagesQuery(null, undefined, true, visit), {
      initialProps: { visit: 1 }, wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current.data[0]?.is_read).toBe(false));
    read = true;
    await act(() => client.invalidateQueries({ queryKey: ["messages"] }));
    await waitFor(() => expect(result.current.data[0]?.is_read).toBe(true));
    expect(mocks.listUnreadMessages).toHaveBeenLastCalledWith(50, 0, undefined, ["first"]);
    rerender({ visit: 2 });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([]);
    expect(mocks.listUnreadMessages).toHaveBeenLastCalledWith(50, 0, undefined);
  });
});
