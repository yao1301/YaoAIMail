import { beforeEach, describe, it, expect, vi } from "vitest";
const m = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke, Channel: class {} }));
import { getGlobalProxy, getMailProxy, updateMailProxy, saveSharedProxySettings, sendEmail, retryPendingSendOnce, retryPendingSendPostprocessing, confirmPendingSendDelivered, testSmtpConnection } from "../../src/lib/api";
import { useToastStore } from "../../src/stores/toast.store";

describe("network and sending IPC contracts", () => {
  beforeEach(() => { vi.clearAllMocks(); useToastStore.setState({ toasts: [] }); });
  it("uses independent IPC commands for AI and mail", async () => {
    m.invoke.mockResolvedValue(null);
    await getGlobalProxy(); await getMailProxy(); await updateMailProxy();
    expect(m.invoke.mock.calls.map((c) => c[0])).toEqual(["get_global_proxy", "get_mail_proxy", "update_mail_proxy"]);
  });
  it("preserves queued rather than reporting sent", async () => {
    const result = { status: "queued", operationId: "op-fixture", warning: "manual review" };
    m.invoke.mockResolvedValue(result);
    await expect(sendEmail("account-fixture", ["recipient@example.test"], [], [], "Fixture", "Fixture")).resolves.toEqual(result);
  });
  it("saves the shared address and explicit mail opt-in in one IPC request", async () => {
    m.invoke.mockResolvedValue(undefined);
    await saveSharedProxySettings('127.0.0.1',11001,false);
    expect(m.invoke).toHaveBeenCalledWith('save_shared_proxy_settings',{proxyHost:'127.0.0.1',proxyPort:11001,mailUseProxy:false});
    expect(m.invoke).toHaveBeenCalledTimes(1);
  });
  it("manual retry only targets the selected operation", async () => {
    m.invoke.mockResolvedValue(undefined); await retryPendingSendOnce("op-fixture");
    expect(m.invoke).toHaveBeenCalledWith("retry_pending_send_once", { operationId: "op-fixture" });
  });
  it('keeps confirmed-send resolution and postprocessing separate from sending',async()=>{
    m.invoke.mockResolvedValue(undefined);
    await confirmPendingSendDelivered('account-fixture','op-fixture');
    await retryPendingSendPostprocessing('op-fixture');
    expect(m.invoke.mock.calls.map(c=>c[0])).toEqual(['confirm_pending_send_delivered','retry_pending_send_postprocessing']);
    expect(m.invoke).toHaveBeenCalledWith('confirm_pending_send_delivered',{accountId:'account-fixture',operationId:'op-fixture'});
  });
  it("SMTP authentication testing does not call send_email", async () => {
    m.invoke.mockResolvedValue("authenticated");
    await testSmtpConnection({ smtp_host: "smtp.example.test", smtp_port: 465, smtp_security: "tls", username: "fixture", password: "fixture-only", email: "sender@example.test" });
    expect(m.invoke.mock.calls.map((c) => c[0])).toEqual(["test_smtp_connection"]);
  });
  it("shows an IPC failure even when its caller catches and ignores it", async () => {
    m.invoke.mockRejectedValue({ message: "ipc-fixture password=should-not-display" });
    await getMailProxy().catch(() => undefined);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].message).not.toContain("should-not-display");
    expect(useToastStore.getState().toasts[0].duration).toBe(0);
  });
});
