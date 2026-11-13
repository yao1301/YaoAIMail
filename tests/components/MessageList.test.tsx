import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Folder, MessageSummary } from "../../src/lib/api";
import { useMailStore } from "../../src/stores/mail.store";
import { MessageDeletionNavigationContext, useMessageDeletionNavigation } from "../../src/hooks/useMessageDeletionNavigation";
import { useMailSortStore } from "../../src/stores/mailSort.store";
import { sortMessages } from "../../src/lib/sortMessages";

const mocks = vi.hoisted(() => ({
  accounts: [] as Account[],
  folders: [] as Folder[],
  queryClient: {
    invalidateQueries: vi.fn(),
  },
  getMessageLabelsBatch: vi.fn(),
  batchArchive: vi.fn(),
  batchDelete: vi.fn(),
  deleteMessage: vi.fn(),
  batchMarkRead: vi.fn(),
  batchStar: vi.fn(),
  addToast: vi.fn(),
  confirm: vi.fn(),
  sendDrafts: vi.fn(),
}));
vi.mock('../../src/hooks/useSendDrafts',()=>({useSendDrafts:()=>({sendDrafts:mocks.sendDrafts,sending:false})}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: string | { defaultValue?: string }) => {
      if (typeof fallbackOrOptions === "string") return fallbackOrOptions;
      return fallbackOrOptions?.defaultValue ?? key;
    },
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: {} }),
  useQueryClient: () => mocks.queryClient,
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
    scrollToIndex: vi.fn(),
  }),
}));

vi.mock("../../src/hooks/queries", () => ({
  useAccountsQuery: () => ({
    data: mocks.accounts,
  }),
  useFoldersForAccountsQuery: () => ({ data: mocks.folders }),
}));

vi.mock("../../src/lib/api", () => ({
  getMessageLabelsBatch: mocks.getMessageLabelsBatch,
  batchArchive: mocks.batchArchive,
  batchDelete: mocks.batchDelete,
  deleteMessage: mocks.deleteMessage,
  batchMarkRead: mocks.batchMarkRead,
  batchStar: mocks.batchStar,
}));

vi.mock("../../src/stores/toast.store", () => ({
  useToastStore: (selector: (state: { addToast: (toast: unknown) => void }) => unknown) =>
    selector({ addToast: mocks.addToast }),
}));

vi.mock("../../src/stores/confirm.store", () => ({
  useConfirmStore: (selector: (state: { confirm: () => Promise<boolean> }) => unknown) =>
    selector({ confirm: mocks.confirm }),
}));

vi.mock("../../src/components/MessageItem", () => ({
  default: ({ message, folderRole, accountColor, accountLabel, onClick }: {
    message: MessageSummary;
    folderRole?: string | null;
    accountColor?: string;
    accountLabel?: string;
    onClick?: (event: React.SyntheticEvent) => void;
  }) => (
    <div
      data-testid={`message-${message.id}`}
      data-folder-role={folderRole ?? ""}
      data-account-color={accountColor ?? ""}
      data-account-label={accountLabel ?? ""}
      onClick={onClick}
    >
      {message.subject}
    </div>
  ),
}));

vi.mock("../../src/components/Skeleton", () => ({
  MessageListSkeleton: () => <div>Loading messages</div>,
}));

import MessageList from "../../src/components/MessageList";

function makeMessage(id: string): MessageSummary {
  return {
    id,
    account_id: "account-1",
    remote_id: `remote-${id}`,
    message_id_header: null,
    in_reply_to: null,
    references_header: null,
    thread_id: null,
    subject: `Subject ${id}`,
    snippet: `Snippet ${id}`,
    from_address: "sender@example.com",
    from_name: "Sender",
    to_list: [],
    cc_list: [],
    bcc_list: [],
    has_attachments: false,
    is_read: true,
    is_starred: false,
    is_draft: false,
    date: 1_700_000_000,
    remote_version: null,
    is_deleted: false,
    deleted_at: null,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
  };
}

function NavigableList({ messages }: { messages: MessageSummary[] }) {
  const sort = useMailSortStore(s => s.sort);
  const prepare = useMessageDeletionNavigation(sortMessages(messages, sort).map(message => message.id));
  const selectedId = useMailStore(s => s.selectedMessageId);
  return <MessageDeletionNavigationContext.Provider value={prepare}>
    <MessageList messages={messages} selectedMessageId={selectedId} onSelectMessage={id => useMailStore.getState().selectMessage(id)} loading={false} />
  </MessageDeletionNavigationContext.Provider>;
}

describe("MessageList", () => {
  it('offers Send in the batch toolbar only when every selected message is a draft',()=>{
    const drafts=[{...makeMessage('m-1'),is_draft:true},{...makeMessage('m-2'),is_draft:true}];
    useMailStore.setState({batchMode:true,selectedMessageIds:new Set(['m-1','m-2'])});
    const view=render(<MessageList messages={drafts} selectedMessageId={null} onSelectMessage={vi.fn()} loading={false}/>);
    const send=screen.getByRole('button',{name:'发送选中的草稿'});expect(send.textContent).toBe('');
    expect(send.style.padding).toBe(screen.getByRole('button',{name:'messageActions.archive'}).style.padding);
    fireEvent.click(send);expect(mocks.sendDrafts).toHaveBeenCalledWith(['m-1','m-2']);
    view.rerender(<MessageList messages={[drafts[0],{...drafts[1],is_draft:false}]} selectedMessageId={null} onSelectMessage={vi.fn()} loading={false}/>);
    expect(screen.queryByRole('button',{name:'发送选中的草稿'})).toBeNull();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accounts = [
      {
        id: "account-1",
        email: "one@example.com",
        display_name: "One",
        color: "#22c55e",
      },
      {
        id: "account-2",
        email: "two@example.com",
        display_name: "Two",
        color: "#3b82f6",
      },
      {
        id: "account-3",
        email: "three@example.com",
        display_name: "Three",
        color: null,
      },
      {
        id: "account-4",
        email: "four@example.com",
        display_name: "Four",
        color: null,
      },
    ];
    mocks.batchArchive.mockResolvedValue(1);
    mocks.batchDelete.mockResolvedValue(1);
    mocks.deleteMessage.mockReset().mockResolvedValue(undefined);
    useMailSortStore.setState({ sort: { key: "date", dir: "desc" } });
    mocks.batchMarkRead.mockResolvedValue(1);
    mocks.batchStar.mockResolvedValue(1);
    mocks.confirm.mockResolvedValue(true);
    mocks.folders = [{
      id: "folder-archive",
      account_id: "account-1",
      remote_id: "archive",
      name: "Archive",
      folder_type: "folder",
      role: "archive",
      parent_id: null,
      color: null,
      is_system: true,
      sort_order: 1,
    }];
    useMailStore.setState({
      activeAccountId: "account-1",
      activeFolderId: "folder-archive",
      selectedMessageId: null,
      selectedThreadId: null,
      threadView: false,
      selectedMessageIds: new Set(),
      batchMode: false,
    });
  });

  it("Delete advances to the next preview in the displayed date order", async () => {
    useMailStore.setState({ selectedMessageId: "b" });
    const messages = [makeMessage("a"), makeMessage("b"), makeMessage("c")];
    messages[0].date = 1; messages[1].date = 2; messages[2].date = 3;
    render(<NavigableList messages={messages} />);
    fireEvent.keyDown(document.body, { key: "Delete" });
    await waitFor(() => expect(useMailStore.getState().selectedMessageId).toBe("a"));
    expect(mocks.deleteMessage).toHaveBeenCalledWith("b");
  });

  it("batch Delete skips all removed rows and uses subject order", async () => {
    useMailSortStore.setState({ sort: { key: "subject", dir: "asc" } });
    useMailStore.setState({ selectedMessageId: "a", selectedMessageIds: new Set(["a", "b"]), batchMode: true });
    render(<NavigableList messages={[makeMessage("c"), makeMessage("b"), makeMessage("a")]} />);
    fireEvent.click(screen.getByRole("button", { name: "common.delete" }));
    await waitFor(() => expect(useMailStore.getState().selectedMessageId).toBe("c"));
    expect(mocks.deleteMessage.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("switches preview while the server delete is still pending and rolls back a failure", async () => {
    let reject!: (reason: Error) => void;
    mocks.deleteMessage.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    useMailStore.setState({ selectedMessageId: "b" });
    render(<NavigableList messages={[makeMessage("a"), makeMessage("b"), makeMessage("c")]} />);
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(mocks.deleteMessage).toHaveBeenCalledWith("b");
    expect(useMailStore.getState().selectedMessageId).toBe("c");
    expect(screen.queryByTestId("message-b")).toBeNull();
    await act(async () => { reject(new Error("offline")); });
    expect(useMailStore.getState().selectedMessageId).toBe("b");
    expect(screen.getByTestId("message-b")).toBeTruthy();
    expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    expect(mocks.addToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  });

  it("does not wait for the entire batch before advancing", async () => {
    let resolve!: () => void;
    mocks.deleteMessage.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
    useMailSortStore.setState({ sort: { key: "subject", dir: "asc" } });
    useMailStore.setState({ selectedMessageId: "a", selectedMessageIds: new Set(["a", "b"]), batchMode: true });
    render(<NavigableList messages={[makeMessage("a"), makeMessage("b"), makeMessage("c")]} />);
    fireEvent.click(screen.getByRole("button", { name: "common.delete" }));
    await waitFor(() => expect(mocks.deleteMessage).toHaveBeenCalledWith("a"));
    expect(useMailStore.getState().selectedMessageId).toBe("c");
    expect(mocks.deleteMessage).not.toHaveBeenCalledWith("b");
    await act(async () => { resolve(); });
    expect(mocks.deleteMessage).toHaveBeenCalledWith("b");
  });

  it("keeps a failed selected row visible and selected after Delete", async () => {
    mocks.deleteMessage.mockRejectedValueOnce(new Error("offline"));
    useMailStore.setState({ selectedMessageId: "b" });
    render(<NavigableList messages={[makeMessage("a"), makeMessage("b"), makeMessage("c")]} />);
    fireEvent.keyDown(document.body, { key: "Delete" });
    await waitFor(() => expect(mocks.addToast).toHaveBeenCalled());
    expect(useMailStore.getState().selectedMessageId).toBe("b");
    expect(screen.getByTestId("message-b")).toBeTruthy();
  });

  it("does not show Load more just because the current page has 50 messages", () => {
    render(
      <MessageList
        messages={Array.from({ length: 50 }, (_, index) => makeMessage(`m-${index + 1}`))}
        selectedMessageId={null}
        onSelectMessage={vi.fn()}
        loading={false}
        onLoadMore={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("lets Ctrl remove the Shift-range anchor from batch selection", () => {
    render(
      <MessageList
        messages={[makeMessage("m-1"), makeMessage("m-2"), makeMessage("m-3")]}
        selectedMessageId="m-1"
        onSelectMessage={vi.fn()}
        loading={false}
      />,
    );

    fireEvent.click(screen.getByTestId("message-m-1"));
    fireEvent.click(screen.getByTestId("message-m-3"), { shiftKey: true });
    expect([...useMailStore.getState().selectedMessageIds]).toEqual(["m-1", "m-2", "m-3"]);

    fireEvent.click(screen.getByTestId("message-m-1"), { ctrlKey: true });
    expect([...useMailStore.getState().selectedMessageIds]).toEqual(["m-2", "m-3"]);
  });

  it("offers a manual pagination fallback and loads the next page", () => {
    const onLoadMore = vi.fn();
    render(
      <MessageList
        messages={Array.from({ length: 50 }, (_, index) => makeMessage(`m-${index + 1}`))}
        selectedMessageId={null}
        onSelectMessage={vi.fn()}
        loading={false}
        onLoadMore={onLoadMore}
        hasNextPage
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "加载更多邮件" }));
    expect(onLoadMore).toHaveBeenCalled();
  });

  it("passes the active folder role to message items", () => {
    render(
      <MessageList
        messages={[makeMessage("m-1")]}
        selectedMessageId={null}
        onSelectMessage={vi.fn()}
        loading={false}
      />,
    );

    expect(screen.getByTestId("message-m-1").getAttribute("data-folder-role")).toBe("archive");
  });

  it("uses the shared smooth scroll region for the virtualized list", () => {
    render(
      <MessageList
        messages={[makeMessage("m-1")]}
        selectedMessageId={null}
        onSelectMessage={vi.fn()}
        loading={false}
      />,
    );

    const listbox = screen.getByRole("listbox", { name: "Messages" });

    expect(listbox.className).toContain("scroll-region");
    expect(listbox.className).toContain("message-list-scroll");
  });

  it("keeps account color markers hidden in the simplified unified inbox", () => {
    const message = { ...makeMessage("m-1"), account_id: "account-2" };
    useMailStore.setState({ activeAccountId: null });

    render(
      <MessageList
        messages={[message]}
        selectedMessageId={null}
        onSelectMessage={vi.fn()}
        loading={false}
      />,
    );

    const row = screen.getByTestId("message-m-1");

    expect(row.getAttribute("data-account-color")).toBe("");
    expect(row.getAttribute("data-account-label")).toBe("");
  });

  it("does not pass account color metadata when a single account is selected", () => {
    const message = { ...makeMessage("m-1"), account_id: "account-1" };

    render(
      <MessageList
        messages={[message]}
        selectedMessageId={null}
        onSelectMessage={vi.fn()}
        loading={false}
      />,
    );

    const row = screen.getByTestId("message-m-1");

    expect(row.getAttribute("data-account-color")).toBe("");
  });

  it("does not pass account color metadata when there is only one account", () => {
    mocks.accounts = [
      {
        id: "account-1",
        email: "one@example.com",
        display_name: "One",
        color: "#22c55e",
      },
    ];

    render(
      <MessageList
        messages={[makeMessage("m-1")]}
        selectedMessageId={null}
        onSelectMessage={vi.fn()}
        loading={false}
      />,
    );

    const row = screen.getByTestId("message-m-1");

    expect(row.getAttribute("data-account-color")).toBe("");
  });

  it("does not show a marker for an unknown account", () => {
    const message = { ...makeMessage("m-1"), account_id: "missing-account" };
    useMailStore.setState({ activeAccountId: null });

    render(
      <MessageList
        messages={[message]}
        selectedMessageId={null}
        onSelectMessage={vi.fn()}
        loading={false}
      />,
    );

    const color = screen.getByTestId("message-m-1").getAttribute("data-account-color");

    expect(color).toBe("");
  });

  it("keeps markers hidden for multiple accounts without saved colors", () => {
    useMailStore.setState({ activeAccountId: null });

    render(
      <MessageList
        messages={[
          { ...makeMessage("m-1"), account_id: "account-3" },
          { ...makeMessage("m-2"), account_id: "account-4" },
        ]}
        selectedMessageId={null}
        onSelectMessage={vi.fn()}
        loading={false}
      />,
    );

    const firstColor = screen.getByTestId("message-m-1").getAttribute("data-account-color");
    const secondColor = screen.getByTestId("message-m-2").getAttribute("data-account-color");

    expect(firstColor).toBe("");
    expect(secondColor).toBe("");
  });

  it("refreshes derived queries after a successful batch star action", async () => {
    mocks.batchStar.mockResolvedValueOnce(2);
    useMailStore.setState({
      selectedMessageIds: new Set(["m-1", "m-2"]),
      batchMode: true,
    });

    render(
      <MessageList
        messages={[makeMessage("m-1"), makeMessage("m-2")]}
        selectedMessageId={null}
        onSelectMessage={vi.fn()}
        loading={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Star" }));

    await waitFor(() => expect(mocks.batchStar).toHaveBeenCalledWith(["m-1", "m-2"], true));
    expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["messages"] });
    expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["threads"] });
    expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["starred-messages"] });
    expect(mocks.queryClient.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["folder-unread-counts"] });
  });

  it("refreshes folder unread counts after a successful batch archive action", async () => {
    mocks.batchArchive.mockResolvedValueOnce(2);
    useMailStore.setState({
      selectedMessageIds: new Set(["m-1", "m-2"]),
      batchMode: true,
    });

    render(
      <MessageList
        messages={[makeMessage("m-1"), makeMessage("m-2")]}
        selectedMessageId={null}
        onSelectMessage={vi.fn()}
        loading={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "messageActions.archive" }));

    await waitFor(() => expect(mocks.batchArchive).toHaveBeenCalledWith(["m-1", "m-2"]));
    expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["folder-unread-counts"] });
  });

  it("refreshes folder unread counts after a successful batch read-state action", async () => {
    mocks.batchMarkRead.mockResolvedValueOnce(2);
    useMailStore.setState({
      selectedMessageIds: new Set(["m-1", "m-2"]),
      batchMode: true,
    });

    render(
      <MessageList
        messages={[makeMessage("m-1"), makeMessage("m-2")]}
        selectedMessageId={null}
        onSelectMessage={vi.fn()}
        loading={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "batch.markRead" }));

    await waitFor(() => expect(mocks.batchMarkRead).toHaveBeenCalledWith(["m-1", "m-2"], true));
    expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["folder-unread-counts"] });
  });

  it("uses the custom checkbox control for select all", () => {
    useMailStore.setState({ batchMode: true });

    render(
      <MessageList
        messages={[makeMessage("m-1"), makeMessage("m-2")]}
        selectedMessageId={null}
        onSelectMessage={vi.fn()}
        loading={false}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: "Select all" });

    expect(checkbox.className).toContain("batch-checkbox");
    expect(checkbox.className).toContain("batch-select-all-checkbox");
    expect(checkbox.closest("label")?.className).toContain("batch-select-control");
  });
});
