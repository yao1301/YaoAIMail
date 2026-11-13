import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ComposeView from "../../../src/features/compose/ComposeView";
import { deleteDraft, aiChat, readAttachmentFile, getMessagesBatch } from "../../../src/lib/api";
import type { Message } from "../../../src/lib/api";
import type { ComposeTab } from "../../../src/stores/compose.store";
import { writeUndoSendDelay } from "../../../src/features/compose/undoSend";
import type { ComposeDraftSnapshot } from "../../../src/features/compose/compose-draft";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  closeCompose: vi.fn(),
  openCompose: vi.fn(),
  setComposeDirty: vi.fn(),
  addToast: vi.fn(),
  setImage: vi.fn(),
  insertContent: vi.fn(),
  loadDraftFromStorage: vi.fn(),
  quotedReplyHtml: "",
  draftSnapshot: null as ComposeDraftSnapshot | null,
  referenceTab: null as ComposeTab | null,
  clearAiReferences: vi.fn(),
  editorHtml: "<p>Hello</p>",
  editorContentReady: true,
  setContent: vi.fn(),
  clearPendingAiBody: vi.fn(),
  saveNow: vi.fn(),
  showLeave: false,
  recipients: {
    to: ["to@example.com"] as string[],
    cc: [] as string[],
    bcc: [] as string[],
  },
}));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: vi.fn() },
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

vi.mock("../../../src/stores/mail.store", () => ({
  useMailStore: (selector: (state: { activeAccountId: string }) => unknown) =>
    selector({ activeAccountId: "account-1" }),
}));

vi.mock("../../../src/stores/compose.store", () => ({
  useComposeStore: Object.assign(
    (selector: (state: {
      composeMode: string;
      composeReplyTo: null;
      composePrefill: null;
      draftSnapshot: ComposeDraftSnapshot | null;
      pendingAiBody: null;
      tabsById: Record<string, ComposeTab>;
      activeTabId: string | null;
      setDraftSnapshot: ReturnType<typeof vi.fn>;
      setActiveDraftContext: ReturnType<typeof vi.fn>;
      clearPendingAiBody: ReturnType<typeof vi.fn>;
      closeCompose: () => void;
      showComposeLeaveConfirm: boolean;
      confirmCloseCompose: () => void;
      cancelCloseCompose: () => void;
    }) => unknown) =>
      selector({
        composeMode: "new",
        composeReplyTo: null,
        composePrefill: null,
        draftSnapshot: mocks.draftSnapshot,
        pendingAiBody: null,
        tabsById: mocks.referenceTab ? { [mocks.referenceTab.id]: mocks.referenceTab } : {},
        activeTabId: mocks.referenceTab?.id ?? null,
        setDraftSnapshot: vi.fn(),
        setActiveDraftContext: vi.fn(),
        clearPendingAiBody: mocks.clearPendingAiBody,
        closeCompose: mocks.closeCompose,
        showComposeLeaveConfirm: mocks.showLeave,
        confirmCloseCompose: vi.fn(),
        cancelCloseCompose: vi.fn(),
      }),
    {
      getState: () => ({ setComposeDirty: mocks.setComposeDirty, composeMode: "new", tabsById: {}, clearAiReferences: mocks.clearAiReferences, openCompose: mocks.openCompose }),
    },
  ),
}));

vi.mock("../../../src/hooks/queries", () => ({
  useAccountsQuery: () => ({
    data: [{ id: "account-1", email: "me@example.com", display_name: "Me" }],
  }),
}));

vi.mock("../../../src/hooks/mutations", () => ({
  useSendEmailMutation: () => ({
    isPending: false,
    mutate: mocks.mutate,
  }),
}));

vi.mock("../../../src/hooks/useComposeRecipients", () => ({
  useComposeRecipients: () => ({
    fromAccountId: "account-1",
    setFromAccountId: vi.fn(),
    to: mocks.recipients.to,
    setTo: vi.fn(),
    cc: mocks.recipients.cc,
    setCc: vi.fn(),
    bcc: mocks.recipients.bcc,
    setBcc: vi.fn(),
    showCc: false,
    setShowCc: vi.fn(),
    showBcc: false,
    setShowBcc: vi.fn(),
  }),
}));

vi.mock("../../../src/hooks/useComposeDraft", () => ({
  useComposeDraft: () => ({
    draftIdRef: { current: "draft-1" },
    draftIdsByAccountRef: { current: { "account-1": "draft-1" } },
    saveNow: mocks.saveNow,
    isSaving: false,
    stopSaving: vi.fn().mockResolvedValue(undefined),
    hasUnsavedChanges: () => false,
  }),
  loadDraftFromStorage: mocks.loadDraftFromStorage,
  clearDraftStorage: vi.fn(),
}));

vi.mock("../../../src/hooks/useComposeEditor", () => ({
  useComposeEditor: () => {
    const chain = {
      focus: vi.fn(() => chain),
      setImage: vi.fn((attributes: { src: string }) => { mocks.setImage(attributes); return chain; }),
      insertContent: vi.fn((content: string) => { mocks.insertContent(content); return chain; }),
      run: vi.fn(() => true),
    };
    return {
      editor: {
      getHTML: () => mocks.editorHtml,
      getText: () => "Hello",
      commands: { setContent: mocks.setContent },
        chain: () => chain,
      },
      editorContentReady: mocks.editorContentReady,
      editorMode: "rich",
      rawSource: "",
      setRawSource: vi.fn(),
      richTextHtml: mocks.editorHtml,
      htmlPreview: false,
      setHtmlPreview: vi.fn(),
      switchMode: vi.fn(),
      textareaRef: { current: null },
      quotedReplyHtml: mocks.quotedReplyHtml,
    };
  },
  appendReplyQuoteHtml: (bodyHtml: string, quotedReplyHtml: string) =>
    quotedReplyHtml.trim() ? `${bodyHtml}<br/><br/>${quotedReplyHtml.trim()}` : bodyHtml,
}));

vi.mock("../../../src/components/ContactAutocomplete", () => ({
  default: ({
    id,
    name,
    ariaLabelledBy,
    inputValue,
    placeholder,
    onInputValueChange,
  }: {
    id?: string;
    name?: string;
    ariaLabelledBy?: string;
    inputValue?: string;
    placeholder?: string;
    onInputValueChange?: (value: string) => void;
  }) => (
    <input
      id={id}
      name={name}
      role="combobox"
      aria-labelledby={ariaLabelledBy}
      value={inputValue ?? ""}
      placeholder={placeholder}
      onChange={(event) => onInputValueChange?.(event.currentTarget.value)}
    />
  ),
}));

vi.mock("../../../src/features/compose/ComposeToolbar", () => ({
  ModeButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button type="button" onClick={onClick}>{label}</button>
  ),
  EditorToolbar: () => <div />,
  MarkdownToolbar: () => <div />,
  composeStyles: {
    backBtn: {},
    fieldRow: {},
    fieldLabel: {},
    toggleBtn: {},
  },
}));

vi.mock("@tiptap/react", () => ({
  EditorContent: () => <div data-testid="editor" />,
}));

vi.mock("../../../src/lib/templates", () => ({
  listTemplates: () => [],
  saveTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
}));

vi.mock("../../../src/stores/confirm.store", () => ({
  useConfirmStore: { getState: () => ({ confirm: vi.fn().mockResolvedValue(true) }) },
}));

vi.mock("../../../src/stores/toast.store", () => ({
  useToastStore: { getState: () => ({ addToast: mocks.addToast }) },
}));

vi.mock("../../../src/lib/api", () => ({
  deleteDraft: vi.fn(),
  listStyleProfiles: vi.fn().mockResolvedValue([]),
  listKnowledgeItems: vi.fn().mockResolvedValue([]),
  searchKnowledgeBase: vi.fn().mockResolvedValue([]),
  getMessagesBatch: vi.fn().mockResolvedValue([]),
  readAttachmentFile: vi.fn(),
  aiChat: vi.fn(),
  stageComposeAttachment: vi.fn(),
  getSendGuardConfig: vi.fn().mockResolvedValue({ enabled: false }),
  checkSendGuard: vi.fn(),
  scheduleEmail: vi.fn(),
}));

describe("ComposeView", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    writeUndoSendDelay(0);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.mutate.mockReset();
    mocks.saveNow.mockReset().mockResolvedValue('draft-1');
    mocks.showLeave = false;
    mocks.editorContentReady = true;
    mocks.setContent.mockReset().mockImplementation((html: string) => { mocks.editorHtml = html; return true; });
    mocks.clearPendingAiBody.mockReset();
    mocks.closeCompose.mockReset();
    mocks.openCompose.mockReset();
    mocks.setComposeDirty.mockReset();
    mocks.addToast.mockReset();
    mocks.setImage.mockReset();
    mocks.insertContent.mockReset();
    mocks.loadDraftFromStorage.mockReset();
    mocks.quotedReplyHtml = "";
    mocks.draftSnapshot = null;
    mocks.referenceTab = null;
    mocks.clearAiReferences.mockReset().mockImplementation(() => {
      if (mocks.referenceTab) mocks.referenceTab.pendingAiReferences = [];
    });
    mocks.editorHtml = "<p>Hello</p>";
    mocks.recipients.to = ["to@example.com"];
    mocks.recipients.cc = [];
    mocks.recipients.bcc = [];
    mocks.loadDraftFromStorage.mockReturnValue(null);
    vi.mocked(deleteDraft).mockReset();
    vi.mocked(aiChat).mockReset();
    vi.mocked(readAttachmentFile).mockReset();
    vi.mocked(getMessagesBatch).mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    localStorage.clear();
    warnSpy.mockRestore();
  });

  it('saves from the matching toolbar icon and Ctrl+S without sending or closing', async () => {
    render(<ComposeView />);
    const save = screen.getByRole('button', { name: '保存草稿' });
    expect(save.className).toBe('compose-toolbar-icon-button');
    fireEvent.click(save);
    await waitFor(() => expect(mocks.saveNow).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(save, { key: 's', ctrlKey: true });
    await waitFor(() => expect(mocks.saveNow).toHaveBeenCalledTimes(2));
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.closeCompose).not.toHaveBeenCalled();
  });

  it('reports manual save failures and leaves the editor open', async () => {
    mocks.saveNow.mockRejectedValue(new Error('offline'));
    render(<ComposeView />);
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringContaining('offline') })));
    expect(mocks.closeCompose).not.toHaveBeenCalled();
  });

  it('offers discard, continue and save-and-exit, closing only after save resolves', async () => {
    mocks.showLeave = true;
    let finish!: (id: string) => void;
    mocks.saveNow.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
    render(<ComposeView />);
    expect(screen.getByRole('button', { name: '丢弃修改' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '继续编辑' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存退出' }));
    expect(mocks.closeCompose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '丢弃修改' }).hasAttribute('disabled')).toBe(true);
    await act(async () => { finish('draft-1'); });
    expect(mocks.closeCompose).toHaveBeenCalledOnce();
  });

  it('does not close after save-and-exit fails', async () => {
    mocks.showLeave = true;
    mocks.saveNow.mockRejectedValue(new Error('offline'));
    render(<ComposeView />);
    fireEvent.click(screen.getByRole('button', { name: '保存退出' }));
    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(mocks.closeCompose).not.toHaveBeenCalled();
  });

  it("shows a user-visible error when sent draft cleanup fails", async () => {
    vi.mocked(deleteDraft).mockRejectedValue(new Error("remote draft delete failed"));
    mocks.mutate.mockImplementation((_params, options) => options.onSuccess({ status: "sent", operationId: null, warning: null }));

    render(<ComposeView />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(deleteDraft).toHaveBeenCalledWith("account-1", "draft-1"));
    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({
      type: "error",
    })));
  });

  it("validates a restored new-message draft against loaded account ids", () => {
    render(<ComposeView />);

    expect(mocks.loadDraftFromStorage).toHaveBeenCalledWith(["account-1"]);
  });

  it("warns persistently when sending was held instead of claiming success", async () => {
    vi.mocked(deleteDraft).mockResolvedValue(undefined);
    mocks.mutate.mockImplementation((_params, options) => options.onSuccess({ status: "queued", operationId: "op-test", warning: "邮件未发送，自动重试已暂停" }));
    render(<ComposeView />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ type: "error", duration: 0, title:'Me · me@example.com', message: expect.stringContaining('邮件未发送，自动重试已暂停') })));
    expect(mocks.addToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  });

  it("passes reopened table HTML and all attachments to the send mutation", async () => {
    mocks.editorHtml = '<table style="table-layout:fixed"><tbody><tr><td colwidth="96" style="background-color:#fff2cc">Order</td></tr></tbody></table>';
    mocks.draftSnapshot = {
      accountId: "account-1", to: ["to@example.com"], cc: [], bcc: [], subject: "Order",
      rawSource: "Order", richTextHtml: mocks.editorHtml, editorMode: "rich", savedAt: Date.now(),
      attachments: [{ name: "Order.xlsx", path: "Y:/portable/data/attachments/Order.xlsx", size: 8 }],
    };
    render(<ComposeView />);
    expect(screen.getByText("Order.xlsx")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith(expect.objectContaining({
      bodyHtml: mocks.editorHtml,
      attachmentPaths: ["Y:/portable/data/attachments/Order.xlsx"],
      subject: "Order",
    }), expect.any(Object)));
  });

  it('retains saved reply linkage when a document draft is later manually sent', async () => {
    mocks.draftSnapshot = { accountId: 'account-1', sourceDraftId: 'reply-draft', inReplyTo: '<parent@example.test>', to: ['to@example.com'], cc: [], bcc: [], subject: 'Re: Request', rawSource: 'Confirmed', richTextHtml: '<p>Confirmed</p>', editorMode: 'rich', attachments: [], savedAt: Date.now() };
    render(<ComposeView />);
    expect(mocks.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith(expect.objectContaining({ inReplyTo: '<parent@example.test>' }), expect.any(Object)));
  });

  it('waits for the editor to accept a queued answer before clearing it or reporting success', async () => {
    mocks.referenceTab = { id: 'waiting-draft', mode: 'new', key: 1, dirty: false, replyTo: null, prefill: null,
      draftSnapshot: null, pendingAiBody: 'The generated body', pendingAiSubject: 'Generated subject', pendingAiSignature: null, activeDraftContext: null };
    mocks.editorContentReady = false;
    const { rerender } = render(<ComposeView tabId="waiting-draft" />);
    expect(mocks.setContent).not.toHaveBeenCalled();
    expect(mocks.clearPendingAiBody).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    mocks.editorContentReady = true;
    mocks.setContent.mockReturnValue(false);
    rerender(<ComposeView tabId="waiting-draft" />);
    expect(mocks.clearPendingAiBody).not.toHaveBeenCalled();
    mocks.setContent.mockReturnValue(true);
    rerender(<ComposeView tabId="waiting-draft" />);
    await waitFor(() => expect(mocks.clearPendingAiBody).toHaveBeenCalledWith('waiting-draft'));
    expect(mocks.setContent).toHaveBeenCalledWith(expect.stringContaining('The generated body'));
  });

  it('fills a slow answer into an already initialized editor and lets the user reuse only the original instruction', async () => {
    let finish!: (answer: string) => void;
    vi.mocked(aiChat).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<ComposeView />);
    const input = screen.getByPlaceholderText(/输入指令/);
    fireEvent.change(input, { target: { value: 'Please adjust the delivery date' } });
    fireEvent.click(screen.getByRole('button', { name: '生成草稿', exact: true }));
    await waitFor(() => expect(aiChat).toHaveBeenCalled());
    expect(mocks.setContent).not.toHaveBeenCalled();
    await act(async () => { finish('The updated delivery date is Friday.'); });
    expect(mocks.setContent).toHaveBeenCalledWith(expect.stringContaining('The updated delivery date is Friday.'));
    expect((input as HTMLTextAreaElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /撤销到上一步/ }));
    expect((input as HTMLTextAreaElement).value).toBe('Please adjust the delivery date');
    expect(mocks.editorHtml).toBe('<p>Hello</p>');
    fireEvent.click(screen.getByRole('button', { name: /恢复到下一步/ }));
    expect((input as HTMLTextAreaElement).value).toBe('Please adjust the delivery date');
    expect(mocks.editorHtml).toContain('The updated delivery date is Friday.');
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('revises the user-edited body instead of the old AI reply and restores the hand edits on undo', async () => {
    vi.mocked(aiChat).mockResolvedValueOnce('Ship on Monday.').mockResolvedValueOnce('Could we please ship on Thursday?');
    render(<ComposeView />);
    const input = screen.getByPlaceholderText(/输入指令/);
    fireEvent.change(input, { target: { value: 'Draft the first version' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成草稿', exact: true })); });
    mocks.editorHtml = '<p>Ship on <strong>Thursday</strong>.</p><p>Keep the hand-entered payment terms.</p>';
    fireEvent.change(input, { target: { value: 'Make the tone warmer' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /继续对话/ })); });
    expect(mocks.editorHtml).toContain('Could we please ship on Thursday?');
    const turns = vi.mocked(aiChat).mock.calls[1][0];
    expect(turns.map(turn => turn.role)).toEqual(['system', 'user']);
    expect(turns[1].content).toContain('【当前草稿】');
    expect(turns[1].content).toContain('Ship on Thursday.\nKeep the hand-entered payment terms.');
    expect(turns[1].content).toContain('Make the tone warmer');
    expect(turns[1].content).not.toMatch(/Monday|Draft the first version|<strong>/);
    expect(screen.getByRole('button', { name: /撤销到上一步/ }).textContent).toContain('Draft the first version');
    fireEvent.click(screen.getByRole('button', { name: /撤销到上一步/ }));
    expect(mocks.editorHtml).toContain('<strong>Thursday</strong>');
    expect((input as HTMLTextAreaElement).value).toBe('Draft the first version');
    expect(screen.getByRole('button', { name: /恢复到下一步/ }).textContent).toContain('Make the tone warmer');
    fireEvent.click(screen.getByRole('button', { name: /恢复到下一步/ }));
    expect(mocks.editorHtml).toContain('Could we please ship on Thursday?');
    expect((input as HTMLTextAreaElement).value).toBe('Make the tone warmer');
    expect(aiChat).toHaveBeenCalledTimes(2); // navigating revisions costs no model calls
  });

  it('opens the AI answer separately when the user edits the draft while the model is running', async () => {
    let finish!: (answer: string) => void;
    vi.mocked(aiChat).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<ComposeView />);
    fireEvent.change(screen.getByPlaceholderText(/输入指令/), { target: { value: 'Polish this email' } });
    fireEvent.click(screen.getByRole('button', { name: '生成草稿', exact: true }));
    await waitFor(() => expect(aiChat).toHaveBeenCalled());
    mocks.editorHtml = '<p>Keep these later changes.</p>';
    await act(async () => { finish('AI candidate.'); });
    expect(mocks.editorHtml).toBe('<p>Keep these later changes.</p>');
    expect(mocks.openCompose).toHaveBeenCalledWith('new', null, expect.objectContaining({ body: 'AI candidate.' }));
  });

  it('can pick a reference document in the existing AI instruction box and reads its tail without sending', async () => {
    vi.mocked(aiChat).mockResolvedValue('Dear buyer, confirmed EUR 112.50.');
    render(<ComposeView />);
    expect(screen.queryByRole('button',{name:/按文件.*指令生成草稿/})).toBeNull();
    const file = new File(['fixture'], 'specification.txt');
    Object.defineProperty(file, 'text', { value: async () => 'x'.repeat(17_000) + '\nFinal price EUR 112.50' });
    fireEvent.change(document.querySelector('input[accept*=".docx"]')!, { target: { files: [file] } });
    fireEvent.change(screen.getByPlaceholderText(/输入指令/), { target: { value: '根据文档写邮件' } });
    fireEvent.click(screen.getByRole('button', { name: '生成草稿', exact: true }));
    await waitFor(() => expect(aiChat).toHaveBeenCalled());
    const turns = vi.mocked(aiChat).mock.calls.at(-1)![0];
    expect(turns.at(-1)!.content).toContain('Final price EUR 112.50');
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it.each(['received', 'sent'])('uses a %s mail dropped directly onto the draft AI textarea, retaining the full body', async (kind) => {
    vi.mocked(aiChat).mockResolvedValue('New draft');
    vi.mocked(getMessagesBatch).mockResolvedValue([{
      id: 'reference-1', subject: 'Shipment facts', from_address: 'contact@example.test', from_name: 'Contact',
      to_list: [{ address: 'buyer@example.test', name: null }], date: 1234,
      body_text: 'x'.repeat(17000) + ' FINAL FACT: EUR 730.25', body_html_raw: '',
      is_deleted: false, remote_version: null,
    } as Message]);
    render(<ComposeView />);
    const input = screen.getByPlaceholderText(/输入指令/);
    const dataTransfer = { files: [], items: [], getData: (type: string) => type === 'application/x-pebble-message-id' ? 'reference-1' : type === 'text/plain' ? `邮件：${kind} facts` : '' };
    fireEvent.drop(input, { dataTransfer });
    fireEvent.drop(input, { dataTransfer });
    expect(screen.getAllByRole('button', { name: `移除参考邮件：${kind} facts` })).toHaveLength(1);
    expect(getMessagesBatch).not.toHaveBeenCalled(); // dropping does not call the model or read the whole mailbox
    fireEvent.change(input, { target: { value: '根据参考邮件，写一封新的付款邮件' } });
    fireEvent.click(screen.getByRole('button', { name: '生成草稿', exact: true }));
    await waitFor(() => expect(aiChat).toHaveBeenCalledTimes(1));
    expect(getMessagesBatch).toHaveBeenCalledWith(['reference-1']);
    expect(vi.mocked(aiChat).mock.calls[0][0].at(-1)!.content).toContain('FINAL FACT: EUR 730.25');
    expect(vi.mocked(aiChat).mock.calls[0][0].at(-1)!.content).toContain('contact@example.test');
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('consumes a mail dropped on this exact draft tab and displays it in the AI instruction box', async () => {
    mocks.referenceTab = {
      id: 'draft-target', mode: 'new', key: 1, dirty: false, replyTo: null, prefill: null,
      draftSnapshot: null, pendingAiBody: null, pendingAiSubject: null, pendingAiSignature: null, activeDraftContext: null,
      pendingAiReferences: [{ id: 'mail-from-list', title: 'List reference' }],
    };
    render(<ComposeView tabId="draft-target" />);
    await screen.findByRole('button', { name: '移除参考邮件：List reference' });
    expect(mocks.clearAiReferences).toHaveBeenCalledExactlyOnceWith('draft-target');
    expect(aiChat).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('lets the user remove a referenced mail before generating', async () => {
    vi.mocked(aiChat).mockResolvedValue('New draft');
    render(<ComposeView />);
    const input = screen.getByPlaceholderText(/输入指令/);
    fireEvent.drop(input, { dataTransfer: { files: [], items: [], getData: (type: string) => type === 'application/x-pebble-message-id' ? 'reference-1' : type === 'text/plain' ? '邮件：Private mail' : '' } });
    fireEvent.click(screen.getByRole('button', { name: '移除参考邮件：Private mail' }));
    fireEvent.change(input, { target: { value: '写一封问候邮件' } });
    fireEvent.click(screen.getByRole('button', { name: '生成草稿', exact: true }));
    await waitFor(() => expect(aiChat).toHaveBeenCalledTimes(1));
    expect(getMessagesBatch).not.toHaveBeenCalled();
  });

  it('stops instead of silently ignoring a reference mail that is no longer available', async () => {
    render(<ComposeView />);
    const input = screen.getByPlaceholderText(/输入指令/);
    fireEvent.drop(input, { dataTransfer: { files: [], items: [], getData: (type: string) => type === 'application/x-pebble-message-id' ? 'missing-mail' : type === 'text/plain' ? '邮件：Missing' : '' } });
    fireEvent.change(input, { target: { value: '根据邮件写信' } });
    fireEvent.click(screen.getByRole('button', { name: '生成草稿', exact: true }));
    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringContaining('已不存在') })));
    expect(aiChat).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '移除参考邮件：Missing' })).toBeTruthy();
  });

  it('reads a file dropped directly on the instruction textarea and distinguishes example values from file facts', async () => {
    vi.mocked(aiChat).mockResolvedValue('The total is EUR 678.90. Please arrange payment.');
    render(<ComposeView />);
    const input = screen.getByPlaceholderText(/输入指令/);
    const file = new File(['fixture'], 'statement.txt');
    Object.defineProperty(file, 'text', { value: async () => 'Statement period: 2025-02-01 to 2025-03-31\nTotal: EUR 678.90' });
    fireEvent.drop(input, { dataTransfer: { files: [file], items: [], getData: () => '' } });
    expect(screen.getByText('文件：statement.txt')).toBeTruthy();
    fireEvent.change(input, { target: { value: '根据附件文档，按这个句式生成催款邮件：Please find attached the bill. The total amount is $99.99.' } });
    fireEvent.click(screen.getByRole('button', { name: '生成草稿', exact: true }));
    await waitFor(() => expect(aiChat).toHaveBeenCalledTimes(1));
    const turns = vi.mocked(aiChat).mock.calls[0][0];
    expect(turns[0].content).toContain('示例仅用于句式');
    expect(turns.at(-1)!.content).toContain('Total: EUR 678.90');
    expect(turns.at(-1)!.content).toContain('2025-03-31');
    expect(turns.at(-1)!.content).toContain('若要求根据文件，句式示例只供表达参考，事实以本轮文件为准');
    await screen.findByText('已读取 1 个文件');
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('accepts a WebView drop whose file is present only in DataTransfer.items', async () => {
    vi.mocked(aiChat).mockResolvedValue('Draft');
    render(<ComposeView />);
    const file = new File(['fixture'], 'statement.txt');
    Object.defineProperty(file, 'text', { value: async () => 'Total: EUR 678.90' });
    const input = screen.getByPlaceholderText(/输入指令/);
    fireEvent.drop(input, { dataTransfer: { files: [], items: [{ kind: 'file', getAsFile: () => file }], getData: () => '' } });
    fireEvent.change(input, { target: { value: '根据文件生成邮件' } });
    fireEvent.click(screen.getByRole('button', { name: '生成草稿', exact: true }));
    await waitFor(() => expect(aiChat).toHaveBeenCalledTimes(1));
    expect(vi.mocked(aiChat).mock.calls[0][0].at(-1)!.content).toContain('EUR 678.90');
  });

  it('blocks generation rather than copying an example when the requested file never arrived', async () => {
    render(<ComposeView />);
    fireEvent.drop(screen.getByPlaceholderText(/输入指令/), { dataTransfer: { files: [], items: [], getData: () => '' } });
    fireEvent.change(screen.getByPlaceholderText(/输入指令/), { target: { value: '根据附件文档生成催款邮件，按示例句式' } });
    fireEvent.click(screen.getByRole('button', { name: '生成草稿', exact: true }));
    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringContaining('没有接收到文件') })));
    expect(aiChat).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText(/输入指令/) as HTMLTextAreaElement).value).toContain('根据附件');
  });

  it('waits for internally dragged files and blocks on a failed transfer', async () => {
    let reject!: (error: Error) => void;
    vi.mocked(readAttachmentFile).mockReturnValue(new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    render(<ComposeView />);
    const input = screen.getByPlaceholderText(/输入指令/);
    fireEvent.change(input, { target: { value: '根据附件文档生成邮件' } });
    fireEvent.drop(input, { dataTransfer: { files: [], items: [], getData: (type: string) => type === 'application/x-pebble-attachment-id' ? 'attachment-1' : '' } });
    expect((screen.getByRole('button', { name: '生成草稿', exact: true }) as HTMLButtonElement).disabled).toBe(true);
    expect(aiChat).not.toHaveBeenCalled();
    await act(async () => { reject(new Error('missing file')); });
    expect(screen.getByRole('alert').textContent).toContain('读取拖入文件失败');
    fireEvent.click(screen.getByRole('button', { name: '生成草稿', exact: true }));
    expect(aiChat).not.toHaveBeenCalled();
  });

  it("sends a typed valid recipient without requiring Enter first", async () => {
    mocks.recipients.to = [];

    render(<ComposeView />);

    const sendButton = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);

    fireEvent.change(screen.getByRole("combobox", { name: "To" }), {
      target: { value: "typed@example.com" },
    });

    await waitFor(() => expect(sendButton.disabled).toBe(false));
    fireEvent.click(sendButton);

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ to: ["typed@example.com"] }),
      expect.any(Object),
    ));
  });

  it("lets the user collapse and re-expand quoted replies", () => {
    mocks.quotedReplyHtml = "<blockquote><p>Original message body</p></blockquote>";

    render(<ComposeView />);

    expect(screen.getByRole("button", { name: "Hide quoted message" })).toBeTruthy();
    expect(screen.getByText("Original message body")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide quoted message" }));
    expect(screen.queryByText("Original message body")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show quoted message" }));
    expect(screen.getByText("Original message body")).toBeTruthy();
  });

  it("keeps the message local during the undo window and cancels before SMTP", async () => {
    writeUndoSendDelay(10);
    render(<ComposeView />);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(mocks.mutate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("秒后发送"));
    fireEvent.click(screen.getByRole("button", { name: "取消发送" }));

    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "取消发送" })).toBeNull();
    expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({
      message: "已取消发送，邮件仍保留在草稿中",
    }));
  });

  it("shows distinct and mutually exclusive drop purposes for attachments and AI context", () => {
    render(<ComposeView />);
    const dataTransfer = { types: ["Files"], files: [], dropEffect: "none" };

    fireEvent.dragOver(screen.getByTestId("editor"), { dataTransfer });
    expect(screen.getByRole("status").textContent).toContain("松开，添加为邮件附件");
    expect(screen.getByRole("status").textContent).toContain("文件将随邮件一起发送");

    fireEvent.dragOver(screen.getByPlaceholderText(/输入指令/), { dataTransfer });
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toContain("松开，作为 AI 输入上下文");
    expect(screen.getByRole("status").textContent).toContain("不会作为邮件附件发送");
  });

  it("keeps Excel as formatted editable HTML and ignores its duplicate image preview", async () => {
    render(<ComposeView />);
    const preview = new File(["excel preview"], "excel.png", { type: "image/png" });
    const clipboardData = {
      getData: (type: string) => type === "text/html"
        ? '<!--StartFragment--><table><tr><td style="background-color:#fff2cc;font-weight:700">Excel</td><td></td></tr></table><!--EndFragment-->'
        : "Excel",
      items: [{ kind: "file", type: "image/png", getAsFile: () => preview }],
    };

    const dispatched = fireEvent.paste(screen.getByTestId("editor"), { clipboardData });

    expect(dispatched).toBe(false);
    await waitFor(() => expect(mocks.insertContent).toHaveBeenCalledWith(expect.stringContaining("<table")));
    expect(mocks.insertContent).toHaveBeenCalledWith(expect.stringContaining("Excel"));
    expect(mocks.insertContent).toHaveBeenCalledWith(expect.stringContaining("background-color"));
    expect(mocks.insertContent).not.toHaveBeenCalledWith(expect.stringContaining("<img"));
    expect(mocks.setImage).not.toHaveBeenCalled();
  });
});
