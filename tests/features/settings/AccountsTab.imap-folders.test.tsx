import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AccountsTab from "../../../src/features/settings/AccountsTab";
import {
  getAccountDetails,
  getImapSyncFolders,
  testAccountConnection,
  triggerSync,
  updateAccount,
  updateImapSyncFolders,
} from "../../../src/lib/api";

const mocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn(() => Promise.resolve()),
}));

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
    invalidateQueries: mocks.invalidateQueries,
  }),
}));

vi.mock("../../../src/hooks/queries", () => ({
  accountsQueryKey: ["accounts"],
  useAccountsQuery: () => ({
    data: [
      {
        id: "account-1",
        email: "user@example.com",
        display_name: "User",
        provider: "imap",
        color: "#22c55e",
        created_at: 1,
        updated_at: 1,
      },
    ],
  }),
}));

vi.mock("../../../src/lib/api", () => ({
  deleteAccount: vi.fn(),
  getImapSyncFolders: vi.fn(),
  getAccountDetails: vi.fn().mockResolvedValue({ email: "user@example.com", displayName: "User", color: "#22c55e", provider: "imap", imapHost: "imap.example.com", imapPort: 993, imapUsername: "user@example.com", imapSecurity: "tls", imapAcceptInvalidCerts: false, smtpHost: "smtp.example.com", smtpPort: 465, smtpUsername: "user@example.com", smtpSecurity: "tls", smtpAcceptInvalidCerts: false, proxyMode: "inherit", proxyHost: "", proxyPort: 0, passwordConfigured: true }),
  getOAuthAccountProxySetting: vi.fn(),
  testAccountConnection: vi.fn(),
  triggerSync: vi.fn(),
  updateAccount: vi.fn(),
  updateImapSyncFolders: vi.fn(),
  updateOAuthAccountProxySetting: vi.fn(),
}));

vi.mock("../../../src/lib/signatures", () => ({
  getSignature: vi.fn(() => Promise.resolve("")),
  setSignature: vi.fn(() => Promise.resolve()),
  listEmailSignatures: vi.fn(() => Promise.resolve([])),
  saveEmailSignature: vi.fn(() => Promise.resolve([])),
  deleteEmailSignature: vi.fn(() => Promise.resolve([])),
  setDefaultEmailSignature: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../../src/components/AccountSetup", () => ({
  default: () => null,
}));

vi.mock("../../../src/stores/mail.store", () => ({
  useMailStore: {
    getState: () => ({
      activeAccountId: null,
      setActiveAccountId: vi.fn(),
    }),
  },
}));

vi.mock("../../../src/stores/ui.store", () => ({
  useUIStore: (selector: (state: { realtimeStatusByAccount: Record<string, unknown> }) => unknown) =>
    selector({ realtimeStatusByAccount: {} }),
}));

vi.mock("../../../src/stores/toast.store", () => ({
  useToastStore: {
    getState: () => ({
      addToast: vi.fn(),
    }),
  },
}));

const folderSettings = {
  folders: [
    {
      id: "inbox-id",
      account_id: "account-1",
      remote_id: "INBOX",
      name: "Inbox",
      folder_type: "folder" as const,
      role: "inbox" as const,
      parent_id: null,
      color: null,
      is_system: true,
      sort_order: 0,
    },
    {
      id: "sent-id",
      account_id: "account-1",
      remote_id: "Sent",
      name: "Sent",
      folder_type: "folder" as const,
      role: "sent" as const,
      parent_id: null,
      color: null,
      is_system: true,
      sort_order: 1,
    },
    {
      id: "projects-id",
      account_id: "account-1",
      remote_id: "Projects",
      name: "Projects",
      folder_type: "folder" as const,
      role: null,
      parent_id: null,
      color: null,
      is_system: true,
      sort_order: 10,
    },
  ],
  selected_remote_ids: ["INBOX", "Sent"],
};

describe("AccountsTab IMAP folder selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getImapSyncFolders).mockResolvedValue(folderSettings);
    vi.mocked(updateImapSyncFolders).mockImplementation(
      async (_accountId, selectedRemoteIds) => ({
        ...folderSettings,
        selected_remote_ids: selectedRemoteIds,
      }),
    );
    vi.mocked(updateAccount).mockResolvedValue(undefined);
    vi.mocked(triggerSync).mockResolvedValue(undefined);
  });

  it("lists folders, locks Inbox, and saves additional selections", async () => {
    render(<AccountsTab />);

    fireEvent.click(screen.getByRole("button", { name: "Edit account" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose folders" }));

    await waitFor(() => {
      expect(getImapSyncFolders).toHaveBeenCalledWith("account-1");
    });

    const inbox = await screen.findByRole("checkbox", { name: "Inbox" });
    const sent = screen.getByRole("checkbox", { name: "Sent" });
    const projects = screen.getByRole("checkbox", { name: "Projects" });
    expect((inbox as HTMLInputElement).checked).toBe(true);
    expect((inbox as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(sent);
    fireEvent.click(projects);
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => {
      expect(updateImapSyncFolders).toHaveBeenCalledWith("account-1", [
        "INBOX",
        "Projects",
      ]);
    });
    expect(triggerSync).toHaveBeenCalledWith("account-1", "manual");
  });

  it("shows the persisted connection values when editing an account", async () => {
    render(<AccountsTab />);

    fireEvent.click(screen.getByRole("button", { name: "Edit account" }));
    expect(screen.queryByDisplayValue("imap.example.com")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Advanced connection settings" }));

    expect(await screen.findByDisplayValue("imap.example.com")).toBeTruthy();
    expect(screen.getByDisplayValue("993")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "IMAP host 登录用户名" }) as HTMLInputElement).value).toBe("user@example.com");
    expect((screen.getByRole("textbox", { name: "accountSetup.smtpHost 登录用户名" }) as HTMLInputElement).value).toBe("user@example.com");
    expect(screen.getByDisplayValue("smtp.example.com")).toBeTruthy();
    expect(screen.getByDisplayValue("465")).toBeTruthy();
    expect(screen.getByPlaceholderText("已保存（如需更改请重新输入）")).toBeTruthy();
  });

  it("tests a saved certificate exception strictly before restoring only the affected side", async () => {
    const savedDetails = await getAccountDetails("account-1");
    vi.mocked(getAccountDetails).mockResolvedValueOnce({ ...savedDetails, smtpAcceptInvalidCerts: true });
    vi.mocked(testAccountConnection).mockRejectedValueOnce(new Error("收件：失败 — 收件服务器无响应\n发件 SMTP：通过 — SMTP 连接成功"));
    render(<AccountsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Edit account" }));
    fireEvent.click(await screen.findByRole("button", { name: "Test with certificate verification" }));
    expect(testAccountConnection).toHaveBeenCalledWith("account-1", true);
    expect(updateAccount).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Restore certificate verification" }));
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() => expect(vi.mocked(updateAccount).mock.calls[0]?.[17]).toEqual({
      incoming: undefined, outgoing: false,
    }));
  });

  it("edits the private label separately from the outgoing sender name", async () => {
    render(<AccountsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Edit account" }));
    const sender = await screen.findByRole("textbox", { name: "对外发件人名称" });
    await waitFor(() => expect((sender as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByRole("textbox", { name: "账号昵称（仅自己可见）" }), { target: { value: "Local account label" } });
    fireEvent.change(sender, { target: { value: "Customer Service" } });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() => expect(updateAccount).toHaveBeenCalled());
    const args = vi.mocked(updateAccount).mock.calls[0];
    expect(args[2]).toBe("Local account label");
    expect(args[16]).toBe("Customer Service");
  });
});
