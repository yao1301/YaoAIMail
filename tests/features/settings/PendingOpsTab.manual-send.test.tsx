import { beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const m = vi.hoisted(() => ({ retry: vi.fn(), post:vi.fn(), confirmed:vi.fn(), cancel:vi.fn(), account: vi.fn(), open: vi.fn(), view: vi.fn(), detail: vi.fn(), refetch: vi.fn(), accepted: false,scheduled:false,duplicate:false,dismissed:false }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(vi.fn()) }));
vi.mock("@/lib/api", () => ({ retryPendingSendOnce: m.retry,retryPendingSendPostprocessing:m.post,confirmPendingSendDelivered:m.confirmed, cancelWorkbenchSchedule:m.cancel, dismissFailedPendingMailOps: vi.fn() }));
vi.mock("@/stores/mail.store", () => ({ useMailStore: Object.assign((selector: (s: unknown) => unknown) => selector({ activeAccountId: "a" }), { getState: () => ({ setActiveAccountId: m.account }) }) }));
vi.mock("@/stores/ui.store", () => ({ useUIStore: { getState: () => ({ openMessageInInbox: m.open, setActiveView: m.view, setMessageDetailId: m.detail }) } }));
vi.mock("@/hooks/queries", () => ({
  pendingMailOpsQueryKey: (id: string) => ["ops", id], pendingMailOpsSummaryQueryKey: (id: string) => ["summary", id],
  useAccountsQuery: () => ({ data: [{ id: "a", email: "sender@example.test" }] }),
  usePendingMailOpsSummary: () => ({ data: { failed_count: 1, pending_count: 0, in_progress_count: 0, total_active_count: 1, last_error: "Failed, held for review" }, refetch: m.refetch }),
  usePendingMailOpsQuery: () => ({ data: [{ id: "op-fixture", message_id: "mail-fixture", account_id: "a", status: m.scheduled?'pending':"failed", op_type: "send", attempts: m.scheduled?0:8, last_error: "Held", updated_at: 1, server_accepted: m.accepted,duplicate_submission:m.duplicate,dismissed:m.dismissed,workbench_schedule:m.scheduled,next_retry_at:m.scheduled?Math.floor(Date.now()/1000)+3600:null }], refetch: m.refetch }),
}));
import PendingOpsTab from "../../../src/features/settings/PendingOpsTab";
function show() { return render(<QueryClientProvider client={new QueryClient()}><PendingOpsTab /></QueryClientProvider>); }
describe("manual send retry gate", () => {
  beforeEach(() => { cleanup(); vi.clearAllMocks(); m.accepted = false;m.scheduled=false;m.duplicate=false;m.dismissed=false;m.cancel.mockResolvedValue('mail-fixture'); m.retry.mockResolvedValue(undefined); m.refetch.mockResolvedValue({}); });
  it("does not offer retry for a confirmed duplicate", () => {
    m.duplicate=true;show();expect(screen.queryByRole("button",{name:"核对后重试一次"})).toBeNull();
    expect(screen.getByText(/已核实为重复待发副本/)).toBeTruthy();expect(m.retry).not.toHaveBeenCalled();
  });
  it("labels an acknowledged error without calling it sent or removing its details",()=>{
    m.dismissed=true;show();expect(screen.getByText("已忽略")).toBeTruthy();expect(screen.getByText("Held")).toBeTruthy();
  });
  it('can cancel a persisted future schedule only after explicit confirmation',async()=>{
    m.scheduled=true;show();expect(m.cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'取消定时并恢复草稿'}));expect(m.cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'确认取消并恢复草稿'}));
    await waitFor(()=>expect(m.cancel).toHaveBeenCalledWith('a','op-fixture'));expect(m.retry).not.toHaveBeenCalled();
  });
  it("never retries just because the user opens the queue; requires confirmation", async () => {
    show(); expect(m.retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "核对后重试一次" }));
    expect(m.retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "已核对，重试一次" }));
    await waitFor(() => expect(m.retry).toHaveBeenCalledWith("op-fixture"));
    expect(m.retry).toHaveBeenCalledTimes(1);
  });
  it("opens the queued message in its actual account for review", () => {
    show(); fireEvent.click(screen.getByRole("button", { name: "查看邮件" }));
    expect(m.account).toHaveBeenCalledWith("a"); expect(m.open).toHaveBeenCalledWith("mail-fixture");
    expect(m.detail).toHaveBeenCalledWith("mail-fixture"); expect(m.view).toHaveBeenCalledWith("messageDetail");
  });
  it("never offers resend after the server already accepted the message", () => {
    m.accepted = true; show();
    expect(screen.queryByRole("button", { name: "核对后重试一次" })).toBeNull();
    expect(screen.getByText(/发件服务器已接受邮件/)).toBeTruthy(); expect(m.retry).not.toHaveBeenCalled();
  });
  it('continues accepted-send cleanup through a different command, never the send-retry command',async()=>{
    m.accepted=true;m.post.mockResolvedValue(undefined);show();
    fireEvent.click(screen.getByRole('button',{name:'继续归档'}));
    await waitFor(()=>expect(m.post).toHaveBeenCalledWith('op-fixture'));
    expect(m.retry).not.toHaveBeenCalled();expect(m.confirmed).not.toHaveBeenCalled();
  });
  it('ends a user-confirmed old send only after explicit confirmation without retrying',async()=>{
    m.confirmed.mockResolvedValue(undefined);show();
    fireEvent.click(screen.getByRole('button',{name:'已发送，结束待发'}));expect(m.confirmed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'我已确认发送，结束待发'}));
    await waitFor(()=>expect(m.confirmed).toHaveBeenCalledWith('a','op-fixture'));
    expect(m.retry).not.toHaveBeenCalled();expect(m.post).not.toHaveBeenCalled();
  });
});
