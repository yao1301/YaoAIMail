import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Sidebar from "../../src/components/Sidebar";
import { useComposeStore } from "../../src/stores/compose.store";
import { useMailStore } from "../../src/stores/mail.store";
import { useUIStore } from "../../src/stores/ui.store";
import type { Folder } from "../../src/lib/api";
import * as api from "../../src/lib/api";
import { ACCOUNT_ORDER_KEY, ACCOUNT_DRAG_TYPE } from "../../src/lib/accountOrder";
import { profileLocalStorage } from "../../src/lib/profileStorage";
import { useToastStore } from "../../src/stores/toast.store";

const mocks = vi.hoisted(() => ({
  accounts: [{
    id: "account-1",
    email: "user@example.com",
    display_name: "User",
    provider: "imap",
    color: null,
    created_at: 1,
    updated_at: 1,
  }],
  folders: [] as Folder[],
}));

vi.mock("react-i18next", () => ({
  initReactI18next: {
    type: "3rdParty",
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const labels: Record<string, string> = {
        "search.title": "Search",
        "sidebar.navigation": "Sidebar",
        "sidebar.search": "Search",
        "sidebar.mail": "Mail",
        "sidebar.mailFolders": "Mail folders",
        "sidebar.tools": "Tools",
        "sidebar.inbox": "Inbox",
        "sidebar.sent": "Sent",
        "sidebar.drafts": "Drafts",
        "sidebar.trash": "Trash",
        "sidebar.archive": "Archive",
        "sidebar.spam": "Spam",
        "sidebar.starred": "Starred",
        "sidebar.snoozed": "Snoozed",
        "sidebar.kanban": "Kanban",
        "sidebar.settings": "Settings",
      };
      return labels[key] ?? fallback ?? key;
    },
  }),
}));

vi.mock("../../src/hooks/queries", () => ({
  useAccountsQuery: () => ({
    data: mocks.accounts,
  }),
  useFoldersForAccountsQuery: () => ({
    data: mocks.folders,
    isFetched: true,
  }),
}));

vi.mock("../../src/hooks/queries/useFolderUnreadCounts", () => ({
  useFolderUnreadCountsForAccounts: () => ({ data: {} }),
}));

function folder(id: string, role: Folder["role"], sortOrder: number): Folder {
  return {
    id,
    account_id: "account-1",
    remote_id: id,
    name: id,
    folder_type: "folder",
    role,
    parent_id: null,
    color: null,
    is_system: true,
    sort_order: sortOrder,
  };
}

describe("Sidebar folder order", () => {
  beforeEach(() => {
    localStorage.clear();
    // jsdom has no native DragEvent; preserve the final pointer coordinates.
    class Drag extends MouseEvent {
      readonly dataTransfer: DataTransfer | null;
      constructor(type: string, init: DragEventInit = {}) { super(type, init); this.dataTransfer = init.dataTransfer ?? null; }
    }
    vi.stubGlobal('DragEvent', Drag);
    useUIStore.setState({
      sidebarCollapsed: false,
      activeView: "inbox",
      previousView: "inbox",
      showFolderUnreadCount: false,
      backgroundImage: null,
    });
    useMailStore.setState({
      activeAccountId: "account-1",
      activeFolderId: "inbox",
    });
    useComposeStore.setState({
      composeMode: null,
      composeReplyTo: null,
      composeDirty: false,
      showComposeLeaveConfirm: false,
      pendingView: null,
    });
    mocks.folders = [
      folder("drafts", "drafts", 1),
      folder("spam", "spam", 2),
      folder("inbox", "inbox", 3),
      folder("trash", "trash", 4),
      folder("archive", "archive", 5),
      folder("sent", "sent", 6),
    ];
    mocks.accounts = [{
      id: "account-1",
      email: "user@example.com",
      display_name: "User",
      provider: "imap",
      color: null,
      created_at: 1,
      updated_at: 1,
    }];
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  function multipleAccounts() {
    mocks.accounts = ['A', 'B', 'C'].map((name, index) => ({
      id: `account-${index + 1}`, email: `${name.toLowerCase()}@example.test`, display_name: name,
      provider: 'imap', color: null, created_at: index, updated_at: index,
    }));
    mocks.folders = mocks.accounts.map(account => ({ ...folder(`${account.id}-inbox`, 'inbox', 0), account_id: account.id }));
    useMailStore.setState({ activeAccountId: 'account-1', activeFolderId: 'account-1-inbox' });
  }
  function accountIds() {
    return Array.from(document.querySelectorAll<HTMLElement>('[data-sidebar-account-id]')).map(element => element.dataset.sidebarAccountId);
  }
  function header(id: string) {
    return document.querySelector<HTMLElement>(`[data-sidebar-account-id="${id}"] .sidebar-account-button`)!;
  }
  function transfer() { return { setData: vi.fn(), getData: () => '', effectAllowed: 'none', dropEffect: 'none' }; }
  function bounds(element: HTMLElement) {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 200, height: 100, left: 0, right: 180, width: 180, x: 0, y: 100, toJSON: () => ({}) });
  }

  it('moves an entire account before or after another and restores the saved order on remount', () => {
    multipleAccounts();
    const move = vi.spyOn(api, 'moveFolder');
    const view = render(<Sidebar />);
    bounds(header('account-1'));
    const dataTransfer = transfer();
    fireEvent.dragStart(header('account-3'), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith(ACCOUNT_DRAG_TYPE, 'account-3');
    fireEvent.dragOver(header('account-1'), { dataTransfer, clientY: 110 });
    fireEvent.drop(header('account-1'), { dataTransfer, clientY: 110 });
    expect(accountIds()).toEqual(['account-3', 'account-1', 'account-2']);
    expect(JSON.parse(profileLocalStorage.getItem(ACCOUNT_ORDER_KEY)!)).toEqual(accountIds());
    expect(move).not.toHaveBeenCalled();
    expect(useMailStore.getState().activeAccountId).toBe('account-1');
    view.unmount(); render(<Sidebar />);
    expect(accountIds()).toEqual(['account-3', 'account-1', 'account-2']);
    bounds(header('account-2'));
    fireEvent.dragStart(header('account-3'), { dataTransfer });
    // Final drop coordinates win over a stale dragover position.
    fireEvent.dragOver(header('account-2'), { dataTransfer, clientY: 110 });
    fireEvent.drop(header('account-2'), { dataTransfer, clientY: 190 });
    expect(accountIds()).toEqual(['account-1', 'account-2', 'account-3']);
  });

  it('handles account drops over a folder without calling the server folder-move command', () => {
    multipleAccounts();
    const move = vi.spyOn(api, 'moveFolder');
    render(<Sidebar />);
    const group = document.querySelector<HTMLElement>('[data-sidebar-account-id="account-2"]')!;
    bounds(group);
    const dataTransfer = transfer();
    fireEvent.dragStart(header('account-1'), { dataTransfer });
    fireEvent.drop(group.querySelector('[data-folder-id]')!, { dataTransfer, clientY: 190 });
    expect(accountIds()).toEqual(['account-2', 'account-1', 'account-3']);
    expect(move).not.toHaveBeenCalled();
  });

  it('cancels account dragging and ignores mail, file and unrelated folder drops', () => {
    multipleAccounts(); render(<Sidebar />);
    const dataTransfer = transfer();
    fireEvent.dragStart(header('account-3'), { dataTransfer });
    fireEvent.dragEnd(header('account-3'));
    for (const type of ['application/x-pebble-message-id', 'Files', 'text/plain']) {
      fireEvent.drop(header('account-1'), { dataTransfer: { types: [type], getData: () => 'account-3' }, clientY: 0 });
    }
    expect(accountIds()).toEqual(['account-1', 'account-2', 'account-3']);
    expect(profileLocalStorage.getItem(ACCOUNT_ORDER_KEY)).toBeNull();
  });

  it('keeps saved accounts in order while ignoring deleted/duplicate ids and appending new accounts', () => {
    multipleAccounts();
    profileLocalStorage.setItem(ACCOUNT_ORDER_KEY, JSON.stringify(['deleted', 'account-2', 'account-2', 42, 'account-1']));
    render(<Sidebar />);
    expect(accountIds()).toEqual(['account-2', 'account-1', 'account-3']);
    fireEvent.keyDown(header('account-3'), { altKey: true, key: 'ArrowUp' });
    expect(accountIds()).toEqual(['account-2', 'account-3', 'account-1']);
  });

  it('shows a save failure and leaves the previous order intact', () => {
    multipleAccounts(); render(<Sidebar />);
    const notify = vi.spyOn(useToastStore.getState(), 'addToast');
    vi.spyOn(profileLocalStorage, 'setItem').mockImplementation(() => { throw new Error('storage full'); });
    fireEvent.keyDown(header('account-3'), { altKey: true, key: 'ArrowUp' });
    expect(accountIds()).toEqual(['account-1', 'account-2', 'account-3']);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringContaining('顺序保存失败') }));
  });

  it("uses the same system folder order for a single account as all accounts", () => {
    render(<Sidebar />);

    const folderNav = screen.getByRole("navigation", { name: "Mail folders" });
    const expectedOrder = ["Inbox", "Sent", "Archive", "Drafts", "Trash", "Spam"];
    const labels = within(folderNav).getAllByRole("button")
      .map((button) => button.textContent ?? "")
      .filter((label) => expectedOrder.includes(label));

    expect(labels).toEqual(expectedOrder);
  });

  it("renders each account as a directly selectable group", () => {
    mocks.accounts = [
      {
        id: "account-1",
        email: "user@example.com",
        display_name: "User",
        provider: "imap",
        color: null,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: "account-2",
        email: "second@example.com",
        display_name: "Second",
        provider: "imap",
        color: null,
        created_at: 2,
        updated_at: 2,
      },
    ];
    useMailStore.setState({ activeAccountId: null });
    useUIStore.setState({
      backgroundImage: {
        path: "/tmp/backgrounds/background.png",
        filename: "background.png",
        fit: "cover",
        opacity: 1,
        updatedAt: 1,
      },
    });

    render(<Sidebar />);

    expect(screen.getAllByRole("button", { name: "User" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Second" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("combobox", { name: "Email Accounts" })).toBeNull();
  });
});
