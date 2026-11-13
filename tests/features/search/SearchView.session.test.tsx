import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SearchView from "../../../src/features/search/SearchView";
import { advancedSearch, deleteMessage, searchMessages } from "../../../src/lib/api";
import { useMailStore } from "../../../src/stores/mail.store";
import { useUIStore } from "../../../src/stores/ui.store";
import type { SearchHit } from "../../../src/lib/ipc-types";

vi.mock("../../../src/lib/api", () => ({
  advancedSearch: vi.fn(), searchMessages: vi.fn(), deleteMessage: vi.fn(),
  listAccounts: vi.fn().mockResolvedValue([]), listFolders: vi.fn().mockResolvedValue([]),
}));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: vi.fn() },
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 76,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 76 })),
    measureElement: vi.fn(), measure: vi.fn(),
  }),
}));
vi.mock("../../../src/features/search/SearchFilters", () => ({ default: () => null }));
vi.mock("../../../src/features/search/SearchMessageContextMenu", () => ({ default: () => null }));
vi.mock("../../../src/components/MessageDetail", () => ({
  default: ({ messageId }: { messageId: string }) => <div data-testid="preview">{messageId}</div>,
}));
vi.mock("../../../src/features/search/SearchResultItem", () => ({
  default: ({ hit, onClick, onDoubleClick }: { hit: SearchHit; onClick: () => void; onDoubleClick: () => void }) =>
    <button role="option" onClick={onClick} onDoubleClick={onDoubleClick}>{hit.subject}</button>,
}));

let client: QueryClient;
const hits: SearchHit[] = [
  { message_id: "a", subject: "Alpha", score: 1, snippet: "Body", date: 1 },
  { message_id: "b", subject: "Bravo", score: 1, snippet: "Body", date: 2 },
  { message_id: "c", subject: "Charlie", score: 1, snippet: "Body", date: 3 },
];
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

async function search() {
  fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "purchase order" } });
  fireEvent.click(screen.getByRole("button", { name: "search.searchButton" }));
  await screen.findByRole("option", { name: "Bravo" });
}

describe("search tab session with real query caching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    vi.mocked(advancedSearch).mockResolvedValue(hits);
    vi.mocked(searchMessages).mockResolvedValue(hits);
    vi.mocked(deleteMessage).mockResolvedValue(undefined);
    useUIStore.setState({ activeView: "search", searchQuery: "", pendingSearchFilters: null });
    useMailStore.setState({ activeAccountId: "account-1", activeFolderId: "inbox-1",
      searchScope: { kind: "folder", accountId: "account-1", folderId: "inbox-1" }, searchRange: "auto" });
  });
  afterEach(() => { cleanup(); client.clear(); });

  it("restores keyword, scope, order, preview and scroll after visiting another account", async () => {
    const view = render(<SearchView />, { wrapper });
    await search();
    fireEvent.click(screen.getByRole("button", { name: "主题" }));
    fireEvent.click(screen.getByRole("option", { name: "Bravo" }));
    const list = screen.getByRole("listbox").closest(".search-results-scroll") as HTMLElement;
    list.scrollTop = 420;
    fireEvent.scroll(list);
    view.rerender(<SearchView isActive={false} />);
    act(() => {
      useMailStore.getState().setActiveAccountId("account-2");
      useMailStore.getState().setSearchScope({ kind: "folder", accountId: "account-2", folderId: "sent-2" });
    });
    list.scrollTop = 0; // Hidden WebView layouts can report a zero scroll position.
    fireEvent.scroll(list);
    view.rerender(<SearchView isActive />);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Search" }).value).toBe("purchase order");
    expect(screen.getAllByRole("option").map(row => row.textContent)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(screen.getByTestId("preview").textContent).toBe("b");
    expect(list.scrollTop).toBe(420);
    expect(advancedSearch).toHaveBeenCalledTimes(1);
    expect(advancedSearch).toHaveBeenCalledWith(expect.objectContaining({ accountId: "account-1", folderId: "inbox-1" }), 100);
  });

  it("does not delete hidden search selections when Delete is used in another tab", async () => {
    const view = render(<SearchView />, { wrapper });
    await search();
    fireEvent.click(screen.getByRole("option", { name: "Bravo" }));
    view.rerender(<SearchView isActive={false} />);
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("preserves filters and lets its range control change only this search", async () => {
    const view = render(<SearchView />, { wrapper });
    await search();
    fireEvent.click(screen.getByRole("button", { name: "仅看有附件" }));
    await waitFor(() => expect(advancedSearch).toHaveBeenLastCalledWith(expect.objectContaining({ hasAttachment: true }), 100));
    view.rerender(<SearchView isActive={false} />);
    view.rerender(<SearchView isActive />);
    expect(screen.getByRole("button", { name: "取消附件筛选" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    fireEvent.click(screen.getByRole("button", { name: "全部账号" }));
    await waitFor(() => expect(advancedSearch).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: undefined, folderId: undefined }), 100));
    expect(useMailStore.getState().searchRange).toBe("auto");
  });

  it("accepts an explicit new filter-only request without carrying the old keyword or scope", async () => {
    const view = render(<SearchView />, { wrapper });
    await search();
    view.rerender(<SearchView isActive={false} />);
    act(() => {
      useMailStore.getState().setActiveAccountId("account-2");
      useMailStore.getState().setSearchScope({ kind: "account", accountId: "account-2" });
      useUIStore.getState().setSearchQuery("");
      useUIStore.getState().setPendingSearchFilters({ hasAttachment: true });
    });
    view.rerender(<SearchView isActive />);
    await waitFor(() => expect(advancedSearch).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: "account-2", hasAttachment: true, text: undefined }), 100));
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Search" }).value).toBe("");
    expect(useUIStore.getState().pendingSearchFilters).toBeNull();
  });

  it("keeps the preview selected after opening the result in its own mail tab", async () => {
    const view = render(<SearchView />, { wrapper });
    await search();
    fireEvent.click(screen.getByRole("option", { name: "Bravo" }));
    fireEvent.doubleClick(screen.getByRole("option", { name: "Bravo" }));
    view.rerender(<SearchView isActive={false} />);
    view.rerender(<SearchView isActive />);
    expect(screen.getByTestId("preview").textContent).toBe("b");
  });
});
