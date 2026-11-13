import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Folder } from "../../../src/lib/api";

const mocks = vi.hoisted(() => ({
  mailState: {
    activeAccountId: null as string | null,
    activeFolderId: "all:inbox" as string | null,
    folderVisit: 1,
    searchScope: null as {kind:'account';accountId:string} | null,
    selectedMessageId: null as string | null,
    selectedThreadId: null as string | null,
    threadView: false,
    setSelectedMessage: vi.fn(),
    selectMessage: vi.fn(),
    setSelectedThreadId: vi.fn(),
    toggleThreadView: vi.fn(),
  },
  accounts: [
    { id: "account-1", email: "one@example.com" },
    { id: "account-2", email: "two@example.com" },
  ] as Account[],
  folders: [
    { id: "a1-inbox", account_id: "account-1", role: "inbox", sort_order: 0 },
    { id: "a2-inbox", account_id: "account-2", role: "inbox", sort_order: 0 },
  ] as Folder[],
  useFoldersForAccountsQuery: vi.fn(),
  useMessagesQuery: vi.fn(),
  useThreadsQuery: vi.fn(),
  sendDrafts: vi.fn(),
  deleteMessage: vi.fn(),
  selectedMessage: null as { id: string } | null,
}));
vi.mock('../../../src/hooks/useSendDrafts',()=>({useSendDrafts:()=>({sendDrafts:mocks.sendDrafts,sending:false})}));

vi.mock("react-i18next", () => ({
  initReactI18next: {
    type: "3rdParty",
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("../../../src/stores/mail.store", () => ({
  useMailStore: Object.assign((selector: (state: typeof mocks.mailState) => unknown) => selector(mocks.mailState), {
    getState: () => mocks.mailState,
  }),
}));

vi.mock("../../../src/stores/ui.store", () => ({
  useUIStore: (selector: (state: { setActiveView: () => void }) => unknown) =>
    selector({ setActiveView: vi.fn() }),
}));

vi.mock("../../../src/stores/toast.store", () => ({
  useToastStore: (selector: (state: { addToast: () => void }) => unknown) =>
    selector({ addToast: vi.fn() }),
}));

vi.mock("../../../src/hooks/queries", () => ({
  useAccountsQuery: () => ({ data: mocks.accounts }),
  useFoldersQuery: () => ({
    data: mocks.folders.slice(0, 1),
    isFetched: true,
  }),
  useFoldersForAccountsQuery: mocks.useFoldersForAccountsQuery,
  useMessagesQuery: mocks.useMessagesQuery,
  useThreadsQuery: mocks.useThreadsQuery,
  useMessageQuery: () => ({ data: mocks.selectedMessage }),
  patchMessagesCache: vi.fn(),
  snapshotMessagesCache: vi.fn(),
  restoreMessagesCache: vi.fn(),
}));

vi.mock("../../../src/components/SearchBar", () => ({
  default: () => <div>Search bar</div>,
}));

vi.mock("../../../src/components/MessageList", () => ({
  default: () => <div>Message list</div>,
}));

vi.mock("../../../src/components/MessageDetail", () => ({
  default: () => <div>Message detail</div>,
}));

vi.mock("../../../src/features/inbox/ThreadView", () => ({
  default: () => <div>Thread detail</div>,
}));

vi.mock("../../../src/components/ConfirmDialog", () => ({
  default: () => <div>Confirm dialog</div>,
}));

vi.mock("../../../src/lib/api", () => ({
  emptyTrash: vi.fn(),
  deleteMessage: mocks.deleteMessage,
}));
vi.mock("../../../src/features/inbox/AccountOverview", () => ({ default: ({accountId}: {accountId:string}) => <div>Account overview {accountId}</div> }));

import InboxView from "../../../src/features/inbox/InboxView";

describe("InboxView all accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mailState.activeAccountId = null;
    mocks.mailState.activeFolderId = "all:inbox";
    mocks.mailState.searchScope = null;
    mocks.mailState.selectedMessageId = null;
    mocks.mailState.selectedThreadId = null;
    mocks.mailState.threadView = false;
    mocks.selectedMessage = null;
    mocks.deleteMessage.mockReset().mockResolvedValue(undefined);
    mocks.mailState.selectMessage.mockImplementation(id => { mocks.mailState.selectedMessageId = id; });
    mocks.useFoldersForAccountsQuery.mockReturnValue({
      data: mocks.folders,
      isFetched: true,
    });
    mocks.useMessagesQuery.mockReturnValue({
      data: [],
      isLoading: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    });
    mocks.useThreadsQuery.mockReturnValue({
      data: [],
      isLoading: false,
    });
  });

  it("queries all matching inbox folders when all accounts are selected", () => {
    render(<InboxView />);

    expect(mocks.useFoldersForAccountsQuery).toHaveBeenCalledWith(["account-1", "account-2"]);
    expect(mocks.useMessagesQuery).toHaveBeenCalledWith("a1-inbox", ["a1-inbox", "a2-inbox"], true, 1);
  });

  it("top toolbar Delete keeps the next mail preview selected", async () => {
    mocks.mailState.selectedMessageId = "b";
    mocks.selectedMessage = { id: "b" };
    mocks.useMessagesQuery.mockReturnValue({ data: [{ id: "a", date: 1 }, { id: "b", date: 2 }, { id: "c", date: 3 }],
      isLoading: false, fetchNextPage: vi.fn() });
    render(<InboxView />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.mailState.selectMessage).toHaveBeenCalledWith("a"));
    expect(mocks.deleteMessage).toHaveBeenCalledWith("b");
    expect(mocks.mailState.setSelectedMessage).not.toHaveBeenCalledWith(null);
  });
  it('offers single draft Send without a repeated status icon and disables thread grouping in Drafts',()=>{
    cleanup();mocks.mailState.activeAccountId='account-1';mocks.mailState.activeFolderId='drafts';mocks.mailState.selectedMessageId='draft';mocks.mailState.threadView=true;
    mocks.useFoldersForAccountsQuery.mockReturnValue({data:[{id:'drafts',account_id:'account-1',role:'drafts'}]});
    mocks.useMessagesQuery.mockReturnValue({data:[{id:'draft',is_draft:true}],isLoading:false,fetchNextPage:vi.fn()});
    render(<InboxView/>);expect(screen.queryByLabelText('当前文件夹：草稿箱')).toBeNull();
    expect((screen.getByRole('button',{name:'发送草稿'}) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('button',{name:'发送草稿'}).textContent).toBe('');
    expect(screen.getByRole('button',{name:'发送草稿'}).classList.contains('inbox-toolbar-button')).toBe(true);
    expect(screen.queryByText('草稿箱 · 未发送')).toBeNull();
    expect(mocks.useThreadsQuery).toHaveBeenCalledWith(null,50,0,undefined);
  });
  it("keeps account-wide search and mounts the overview for the selected account", () => {
    cleanup();
    mocks.mailState.activeAccountId = 'account-1'; mocks.mailState.activeFolderId = null;
    mocks.mailState.searchScope = {kind:'account',accountId:'account-1'};
    render(<InboxView />);
    expect(screen.getByRole('textbox',{name:'搜索整个账号的邮件'})).toBeTruthy();
    expect(screen.getByText('Account overview account-1')).toBeTruthy();
  });
});
