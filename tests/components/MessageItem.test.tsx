import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageSummary } from "../../src/lib/api";
import { MessageDeletionNavigationContext } from "../../src/hooks/useMessageDeletionNavigation";

const mocks = vi.hoisted(() => ({
  queryClient: {
    invalidateQueries: vi.fn(),
  },
  patchMessagesCache: vi.fn(),
  snapshotMessagesCache: vi.fn(),
  restoreMessagesCache: vi.fn(),
  updateMessageFlags: vi.fn(),
  archiveMessage: vi.fn(),
  moveToFolder: vi.fn(),
  addToast: vi.fn(),
  getMessage: vi.fn(),
  listAttachments: vi.fn(),
  getAttachmentPath: vi.fn(),
  openDraft: vi.fn(),
  sendDrafts: vi.fn(),
  deleteMessage: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('../../src/hooks/useSendDrafts',()=>({useSendDrafts:()=>({sendDrafts:mocks.sendDrafts,sending:false})}));
vi.mock('../../src/stores/confirm.store', () => ({ useConfirmStore: { getState: () => ({ confirm: mocks.confirm }) } }));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const labels: Record<string, string> = {
        "messageActions.archive": "Archive",
        "messageActions.unarchive": "Unarchive",
        "messageActions.addToKanban": "Add to kanban",
        "messageActions.reportSpam": "Report spam",
        "messageActions.star": "Star",
        "messageActions.unstar": "Unstar",
      };
      return labels[key] ?? fallback ?? key;
    },
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => mocks.queryClient,
}));

vi.mock("../../src/hooks/queries", () => ({
  patchMessagesCache: mocks.patchMessagesCache,
  snapshotMessagesCache: mocks.snapshotMessagesCache,
  restoreMessagesCache: mocks.restoreMessagesCache,
}));

vi.mock("../../src/lib/api", () => ({
  updateMessageFlags: mocks.updateMessageFlags,
  archiveMessage: mocks.archiveMessage,
  moveToFolder: mocks.moveToFolder,
  deleteMessage: mocks.deleteMessage,
  getMessage: mocks.getMessage,
  listAttachments: mocks.listAttachments,
  getAttachmentPath: mocks.getAttachmentPath,
}));

vi.mock("../../src/stores/compose.store", () => ({
  useComposeStore: { getState: () => ({ openDraft: mocks.openDraft }) },
}));

vi.mock("../../src/stores/kanban.store", () => ({
  useKanbanStore: (selector: (state: { cardIdSet: Set<string> }) => unknown) =>
    selector({ cardIdSet: new Set() }),
}));

vi.mock("../../src/stores/toast.store", () => ({
  useToastStore: {
    getState: () => ({ addToast: mocks.addToast }),
  },
}));

import MessageItem from "../../src/components/MessageItem";

function makeMessage(overrides: Partial<MessageSummary> = {}): MessageSummary {
  return {
    id: "message-1",
    account_id: "account-1",
    remote_id: "remote-message-1",
    message_id_header: null,
    in_reply_to: null,
    references_header: null,
    thread_id: null,
    subject: "Archived message",
    snippet: "Snippet",
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
    ...overrides,
  };
}

describe("MessageItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.snapshotMessagesCache.mockReturnValue({ messages: "snapshot" });
    mocks.updateMessageFlags.mockResolvedValue(undefined);
    mocks.archiveMessage.mockResolvedValue("archived");
    mocks.moveToFolder.mockResolvedValue(undefined);
    mocks.deleteMessage.mockReset().mockResolvedValue(undefined);
    mocks.confirm.mockResolvedValue(true);
  });

  it("right-click deletion settles list navigation after success", async () => {
    const complete = vi.fn().mockReturnValue(true);
    render(<MessageDeletionNavigationContext.Provider value={() => complete}>
      <MessageItem message={makeMessage()} isSelected onClick={vi.fn()} />
    </MessageDeletionNavigationContext.Provider>);
    fireEvent.contextMenu(screen.getByRole("option"));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除", exact: true }));
    await waitFor(() => expect(complete).toHaveBeenCalledWith(["message-1"]));
    expect(mocks.deleteMessage).toHaveBeenCalledWith("message-1");
  });

  it("right-click deletion rolls back navigation when the delete fails", async () => {
    const complete = vi.fn();
    mocks.deleteMessage.mockRejectedValueOnce(new Error("offline"));
    render(<MessageDeletionNavigationContext.Provider value={() => complete}>
      <MessageItem message={makeMessage()} isSelected onClick={vi.fn()} />
    </MessageDeletionNavigationContext.Provider>);
    fireEvent.contextMenu(screen.getByRole("option"));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除", exact: true }));
    await waitFor(() => expect(mocks.restoreMessagesCache).toHaveBeenCalled());
    expect(complete).toHaveBeenCalledWith([]);
  });
  it('clearly labels an unsent draft, shows recipients and sends the batch selected by its context menu',()=>{
    render(<MessageItem message={makeMessage({is_draft:true,to_list:[{address:'buyer@example.test',name:null}]})} isSelected={true} onClick={vi.fn()} batchMode batchSelected draftSendIds={['message-1','message-2']} folderRole="drafts" />);
    expect(screen.getByLabelText('草稿，未发送')).toBeTruthy();expect(screen.getByText('收件人：buyer@example.test')).toBeTruthy();
    expect(screen.getByLabelText('草稿，未发送').textContent).toBe('');expect(screen.getByLabelText('草稿，未发送').title).toBe('草稿（未发送）');
    expect(screen.queryByText('草稿 · 未发送')).toBeNull();
    fireEvent.contextMenu(screen.getByRole('option'));fireEvent.click(screen.getByRole('menuitem',{name:'发送',exact:true}));expect(mocks.sendDrafts).toHaveBeenCalledWith(['message-1','message-2']);
  });
  it('does not offer a draft send command for received messages',()=>{
    render(<MessageItem message={makeMessage()} isSelected={false} onClick={vi.fn()}/>);
    fireEvent.contextMenu(screen.getByRole('option'));expect(screen.queryByRole('menuitem',{name:'发送',exact:true})).toBeNull();
  });

  it("labels the archive action as unarchive in the archive folder", () => {
    render(
      <MessageItem
        message={makeMessage()}
        isSelected={false}
        onClick={vi.fn()}
        {...({ folderRole: "archive" } as Record<string, unknown>)}
      />,
    );

    fireEvent.mouseEnter(screen.getByRole("option"));

    expect(screen.getByRole("button", { name: "Unarchive" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("opens sent-mail Edit as a full new draft with HTML and attachments", async () => {
    const sent = makeMessage({ has_attachments: true, to_list: [{ address: "buyer@example.org", name: null }] });
    mocks.getMessage.mockResolvedValue({ ...sent, body_text: "Plain fallback", body_html_raw: '<table style="table-layout:fixed"><tbody><tr><td colwidth="96" style="background-color:#fff2cc">Order</td></tr></tbody></table>' });
    mocks.listAttachments.mockResolvedValue([{ id: "attachment-1", filename: "Order.xlsx", is_inline: false, local_path: null, size: 8 }]);
    mocks.getAttachmentPath.mockResolvedValue("Y:/portable/data/attachments/Order.xlsx");
    render(<MessageItem message={sent} isSelected={false} onClick={vi.fn()} folderRole="sent" />);
    fireEvent.contextMenu(screen.getByRole("option"));
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑" }));
    await waitFor(() => expect(mocks.openDraft).toHaveBeenCalled());
    const snapshot = mocks.openDraft.mock.calls[0][0];
    expect(snapshot.sourceDraftId).toBeUndefined();
    expect(snapshot.accountId).toBe(sent.account_id);
    expect(snapshot.richTextHtml).toContain("<table");
    expect(snapshot.richTextHtml).toContain('colwidth="96"');
    expect(snapshot.attachments).toEqual([{ name: "Order.xlsx", path: "Y:/portable/data/attachments/Order.xlsx", size: 8 }]);
  });

  it("keeps the existing screen and shows an error when Edit cannot load an attachment", async () => {
    mocks.getMessage.mockResolvedValue({ ...makeMessage(), body_text: "Body", body_html_raw: "" });
    mocks.listAttachments.mockResolvedValue([{ id: "missing", is_inline: false }]);
    mocks.getAttachmentPath.mockRejectedValue(new Error("missing attachment"));
    render(<MessageItem message={makeMessage()} isSelected={false} onClick={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole("option"));
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑" }));
    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })));
    expect(mocks.openDraft).not.toHaveBeenCalled();
  });

  it("restores message lists when archive optimistic update fails", async () => {
    const snapshot = { messages: "before-archive" };
    mocks.snapshotMessagesCache.mockReturnValueOnce(snapshot);
    mocks.archiveMessage.mockRejectedValueOnce(new Error("archive failed"));

    render(
      <MessageItem
        message={makeMessage()}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(screen.getByRole("option"));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    expect(mocks.snapshotMessagesCache).toHaveBeenCalledWith(mocks.queryClient);
    expect(mocks.patchMessagesCache).toHaveBeenCalledWith(mocks.queryClient, expect.any(Function));
    await waitFor(() => expect(mocks.restoreMessagesCache).toHaveBeenCalledWith(mocks.queryClient, snapshot));
  });

  it("restores message lists when spam optimistic update fails", async () => {
    const snapshot = { messages: "before-spam" };
    mocks.snapshotMessagesCache.mockReturnValueOnce(snapshot);
    mocks.moveToFolder.mockRejectedValueOnce(new Error("spam failed"));

    render(
      <MessageItem
        message={makeMessage()}
        isSelected={false}
        onClick={vi.fn()}
        spamFolderId="folder-spam"
      />,
    );

    fireEvent.mouseEnter(screen.getByRole("option"));
    fireEvent.click(screen.getByRole("button", { name: "Report spam" }));

    expect(mocks.snapshotMessagesCache).toHaveBeenCalledWith(mocks.queryClient);
    expect(mocks.patchMessagesCache).toHaveBeenCalledWith(mocks.queryClient, expect.any(Function));
    await waitFor(() => expect(mocks.restoreMessagesCache).toHaveBeenCalledWith(mocks.queryClient, snapshot));
  });

  it("refreshes folder unread counts after a successful archive action", async () => {
    render(
      <MessageItem
        message={makeMessage()}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(screen.getByRole("option"));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(mocks.archiveMessage).toHaveBeenCalledWith("message-1"));
    expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["folder-unread-counts"] });
  });

  it("refreshes folder unread counts after a successful spam action", async () => {
    render(
      <MessageItem
        message={makeMessage()}
        isSelected={false}
        onClick={vi.fn()}
        spamFolderId="folder-spam"
      />,
    );

    fireEvent.mouseEnter(screen.getByRole("option"));
    fireEvent.click(screen.getByRole("button", { name: "Report spam" }));

    await waitFor(() => expect(mocks.moveToFolder).toHaveBeenCalledWith("message-1", "folder-spam"));
    expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["folder-unread-counts"] });
  });

  it("refreshes derived queries after starring from row actions", async () => {
    render(
      <MessageItem
        message={makeMessage()}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(screen.getByRole("option"));
    fireEvent.click(screen.getByRole("button", { name: "Star" }));

    await waitFor(() => expect(mocks.updateMessageFlags).toHaveBeenCalledWith("message-1", undefined, true));
    expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["messages"] });
    expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["threads"] });
    expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["starred-messages"] });
    expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["message", "message-1"] });
  });

  it("uses row highlighting without a duplicate checkbox in batch mode", () => {
    render(
      <MessageItem
        message={makeMessage()}
        isSelected={false}
        onClick={vi.fn()}
        batchMode
        batchSelected
      />,
    );
    expect(screen.queryByRole("checkbox", { name: "Select message" })).toBeNull();
    expect(screen.getByRole("option").getAttribute("aria-selected")).toBe("true");
  });

  it("does not keep the reading-pane selection highlighted after batch deselection", () => {
    render(
      <MessageItem
        message={makeMessage()}
        isSelected
        onClick={vi.fn()}
        batchMode
        batchSelected={false}
      />,
    );
    expect(screen.getByRole("option").getAttribute("aria-selected")).toBe("false");
  });

  it("shows the source account color marker when an account color is provided", () => {
    render(
      <MessageItem
        message={makeMessage()}
        isSelected={false}
        onClick={vi.fn()}
        {...({
          accountColor: "#22c55e",
          accountLabel: "Work <work@example.com>",
        } as Record<string, unknown>)}
      />,
    );

    const marker = screen.getByTitle("Work <work@example.com>");

    expect(marker.getAttribute("aria-label")).toBe("Work <work@example.com>");
    expect(marker.style.backgroundColor).toBe("rgb(34, 197, 94)");
  });

  it("marks unread rows with a row class", () => {
    render(
      <MessageItem
        message={makeMessage({ is_read: false })}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByRole("option").className).toContain("message-list-row--unread");
  });

  it("shows recipients as the primary contact in the sent folder", () => {
    render(
      <MessageItem
        message={makeMessage({
          from_name: "Current Account",
          from_address: "current@example.com",
          to_list: [{ name: "Destination", address: "destination@example.com" }],
        })}
        isSelected={false}
        onClick={vi.fn()}
        folderRole="sent"
      />,
    );

    expect(screen.getByText("Destination")).toBeTruthy();
    expect(screen.queryByText("Current Account")).toBeNull();
  });

  it("does not add unread row treatment to read rows", () => {
    render(
      <MessageItem
        message={makeMessage({ is_read: true })}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByRole("option").className).not.toContain("message-list-row--unread");
  });
});
