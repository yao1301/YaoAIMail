import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ComposeView from "../../../src/features/compose/ComposeView";
import { deleteDraft } from "../../../src/lib/api";
import { writeUndoSendDelay } from "../../../src/features/compose/undoSend";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  closeCompose: vi.fn(),
  setComposeDirty: vi.fn(),
  addToast: vi.fn(),
  setImage: vi.fn(),
  loadDraftFromStorage: vi.fn(),
  quotedReplyHtml: "",
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
      draftSnapshot: null;
      pendingAiBody: null;
      tabsById: Record<string, never>;
      activeTabId: null;
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
        draftSnapshot: null,
        pendingAiBody: null,
        tabsById: {},
        activeTabId: null,
        setDraftSnapshot: vi.fn(),
        setActiveDraftContext: vi.fn(),
        clearPendingAiBody: vi.fn(),
        closeCompose: mocks.closeCompose,
        showComposeLeaveConfirm: false,
        confirmCloseCompose: vi.fn(),
        cancelCloseCompose: vi.fn(),
      }),
    {
      getState: () => ({ setComposeDirty: mocks.setComposeDirty, composeMode: "new", tabsById: {} }),
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
  }),
  loadDraftFromStorage: mocks.loadDraftFromStorage,
  clearDraftStorage: vi.fn(),
}));

vi.mock("../../../src/hooks/useComposeEditor", () => ({
  useComposeEditor: () => {
    const chain = {
      focus: vi.fn(() => chain),
      setImage: vi.fn((attributes: { src: string }) => { mocks.setImage(attributes); return chain; }),
      run: vi.fn(() => true),
    };
    return {
      editor: {
      getHTML: () => "<p>Hello</p>",
      getText: () => "Hello",
      commands: { setContent: vi.fn() },
        chain: () => chain,
      },
      editorMode: "rich",
      rawSource: "",
      setRawSource: vi.fn(),
      richTextHtml: "<p>Hello</p>",
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
    mocks.closeCompose.mockReset();
    mocks.setComposeDirty.mockReset();
    mocks.addToast.mockReset();
    mocks.setImage.mockReset();
    mocks.loadDraftFromStorage.mockReset();
    mocks.quotedReplyHtml = "";
    mocks.recipients.to = ["to@example.com"];
    mocks.recipients.cc = [];
    mocks.recipients.bcc = [];
    mocks.loadDraftFromStorage.mockReturnValue(null);
    vi.mocked(deleteDraft).mockReset();
  });

  afterEach(() => {
    localStorage.clear();
    warnSpy.mockRestore();
  });

  it("shows a user-visible error when sent draft cleanup fails", async () => {
    vi.mocked(deleteDraft).mockRejectedValue(new Error("remote draft delete failed"));
    mocks.mutate.mockImplementation((_params, options) => options.onSuccess());

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

  it("keeps the rendered Excel preview and blocks the simplified HTML table", async () => {
    render(<ComposeView />);
    const preview = new File(["excel preview"], "excel.png", { type: "image/png" });
    const clipboardData = {
      getData: (type: string) => type === "text/html" ? "<table><tr><td>Excel</td></tr></table>" : "",
      items: [{ kind: "file", type: "image/png", getAsFile: () => preview }],
    };

    const dispatched = fireEvent.paste(screen.getByTestId("editor"), { clipboardData });

    expect(dispatched).toBe(false);
    await waitFor(() => expect(mocks.setImage).toHaveBeenCalledWith(expect.objectContaining({
      src: expect.stringMatching(/^data:image\/png;base64,/),
    })));
  });
});
