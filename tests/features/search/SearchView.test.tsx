import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchHit } from "../../../src/lib/api";
import SearchView from "../../../src/features/search/SearchView";
import { useUIStore } from "../../../src/stores/ui.store";
import { deleteMessage } from "../../../src/lib/api";

let searchResults: SearchHit[] = [];

vi.mock("../../../src/lib/api", () => ({
  advancedSearch: vi.fn(),
  deleteMessage: vi.fn(),
  listAccounts: vi.fn().mockResolvedValue([]),
  listFolders: vi.fn().mockResolvedValue([]),
  searchMessages: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  initReactI18next: {
    type: "3rdParty",
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const labels: Record<string, string> = {
        "inbox.searchPlaceholder": "Search mail",
        "search.title": "Search",
        "search.searchButton": "Search",
        "search.filters": "Filters",
        "search.results": "Search results",
      };
      return labels[key] ?? fallback ?? key;
    },
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: searchResults,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 76,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: `row-${index}`,
        start: index * 76,
      })),
    measureElement: vi.fn(),
    measure: vi.fn(),
  }),
}));

vi.mock("../../../src/features/search/SearchFilters", () => ({
  default: () => <div>Search filters</div>,
}));

vi.mock("../../../src/features/search/SearchResultItem", () => ({
  default: ({ hit, isSelected, onContextMenu, onClick }: { hit: SearchHit; isSelected: boolean; onContextMenu?: React.MouseEventHandler<HTMLDivElement>; onClick?: () => void }) => (
    <div role="option" aria-selected={isSelected} onContextMenu={onContextMenu} onClick={onClick}>
      {hit.subject}
    </div>
  ),
}));

vi.mock("../../../src/features/search/SearchMessageContextMenu", () => ({
  default: ({ messageId }: { messageId: string }) => <div role="menu">邮件菜单 {messageId}</div>,
}));

vi.mock("../../../src/components/MessageDetail", () => ({
  default: ({ messageId }: { messageId: string }) => <div data-testid="message-detail">Message detail {messageId}</div>,
}));

describe("SearchView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchResults = [];
    useUIStore.setState({ activeView: "search", searchQuery: "" });
    vi.mocked(deleteMessage).mockReset().mockResolvedValue(undefined);
  });

  it("Delete advances to the next result in the displayed search order", async () => {
    searchResults = [1, 2, 3].map(index => ({ message_id: `m-${index}`, subject: `Result ${index}`,
      score: 1, snippet: "Body", from_address: "sender@example.test", date: index }));
    render(<SearchView />);
    fireEvent.click(screen.getByRole("option", { name: "Result 2" }));
    fireEvent.keyDown(document.body, { key: "Delete" });
    await waitFor(() => expect(screen.getByTestId("message-detail").textContent).toContain("m-1"));
    expect(deleteMessage).toHaveBeenCalledWith("m-2");
  });

  it("advances during a slow delete and restores the local search selection on failure", async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(deleteMessage).mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
    searchResults = [1, 2, 3].map(index => ({ message_id: `m-${index}`, subject: `Result ${index}`,
      score: 1, snippet: "Body", from_address: "sender@example.test", date: index }));
    render(<SearchView />);
    fireEvent.click(screen.getByRole("option", { name: "Result 2" }));
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(screen.getByTestId("message-detail").textContent).toContain("m-1");
    await act(async () => { reject(new Error("offline")); });
    expect(screen.getByTestId("message-detail").textContent).toContain("m-2");
  });

  it("picks up context search queries while already mounted", () => {
    render(<SearchView />);

    act(() => {
      useUIStore.getState().setSearchQuery("invoice total");
    });

    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Search" }).value).toBe("invoice total");
    expect(useUIStore.getState().searchQuery).toBe("");
  });

  it("groups virtualized search results in a named listbox", () => {
    searchResults = [{
      message_id: "message-1",
      score: 1,
      subject: "Invoice total",
      snippet: "The invoice total is ready",
      from_address: "sender@example.com",
      date: 1_700_000_000,
    }];

    render(<SearchView />);

    const listbox = screen.getByRole("listbox", { name: "Search results" });
    expect(within(listbox).getByRole("option", { name: "Invoice total" })).toBeTruthy();
  });

  it("opens the email action menu when a search result is right-clicked", () => {
    searchResults = [{
      message_id: "message-1",
      score: 1,
      subject: "Invoice total",
      snippet: "The invoice total is ready",
      from_address: "sender@example.com",
      date: 1_700_000_000,
    }];

    render(<SearchView />);
    fireEvent.contextMenu(screen.getByRole("option", { name: "Invoice total" }), { clientX: 160, clientY: 90 });

    expect(screen.getByRole("menu").textContent).toContain("邮件菜单 message-1");
  });
});
