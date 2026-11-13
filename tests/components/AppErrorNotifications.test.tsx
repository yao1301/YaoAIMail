import { beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
const m = vi.hoisted(() => ({ handlers: new Map<string, (e: unknown) => void>(), unlisten: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, callback) => { m.handlers.set(name, callback); return m.unlisten; }) }));
import AppErrorNotifications from "../../src/components/AppErrorNotifications";
import { useToastStore } from "../../src/stores/toast.store";
import { queryClient } from '../../src/lib/query-client';

describe("background native error visibility", () => {
  beforeEach(() => {
    cleanup(); vi.clearAllMocks(); localStorage.clear(); m.handlers.clear(); useToastStore.setState({ toasts: [] });
    queryClient.setQueryData(['accounts'], [{ id: 'other-account', display_name: 'Other', email: 'other@example.test' }, { id: 'second-account', display_name: 'Second', email: 'second@example.test' }]);
  });
  it("does not turn a browser resize-delivery warning into a fatal toast", () => {
    render(<AppErrorNotifications />);
    window.dispatchEvent(new ErrorEvent("error", {message:"ResizeObserver loop completed with undelivered notifications.",cancelable:true}));
    expect(useToastStore.getState().toasts).toHaveLength(0);
    window.dispatchEvent(new ErrorEvent("error", {message:"layout-fixture-exception",error:new Error("layout-fixture-exception")}));
    expect(useToastStore.getState().toasts).toHaveLength(1);
    window.dispatchEvent(new ErrorEvent("error", {message:"ResizeObserver loop limit exceeded",error:new Error("ResizeObserver loop limit exceeded")}));
    expect(useToastStore.getState().toasts).toHaveLength(2);
  });
  it("shows a failed send from an unselected account and coalesces repeats", async () => {
    render(<AppErrorNotifications />);
    await waitFor(() => expect(m.handlers.size).toBe(3));
    const payload = { message: "native-send-fixture", account_id: "other-account" };
    m.handlers.get("mail:operation-error")!({ payload }); m.handlers.get("mail:operation-error")!({ payload });
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].duration).toBe(0);
    expect(useToastStore.getState().toasts[0].title).toBe('Other · other@example.test');
  });
  it('shows identical errors for two different accounts with separate account headings', async () => {
    render(<AppErrorNotifications />);
    await waitFor(() => expect(m.handlers.size).toBe(3));
    for (const account_id of ['other-account', 'second-account']) m.handlers.get('mail:operation-error')!({ payload: { operation_id: `op-${account_id}`, account_id, op_type: 'send', message: 'identical-failure-fixture' } });
    expect(useToastStore.getState().toasts.map(item => item.title)).toEqual(['Other · other@example.test', 'Second · second@example.test']);
  });
  it("shows sync failures instead of only changing a status icon", async () => {
    render(<AppErrorNotifications />);
    await waitFor(() => expect(m.handlers.size).toBe(3));
    m.handlers.get("mail:sync-progress")!({ payload: { status: "error", message: "sync-fixture" } });
    expect(useToastStore.getState().toasts[0].message).toContain("sync-fixture");
  });
  it("unsubscribes on unmount", async () => {
    const view = render(<AppErrorNotifications />);
    await waitFor(() => expect(m.handlers.size).toBe(3));
    await Promise.resolve(); view.unmount();
    expect(m.unlisten).toHaveBeenCalledTimes(3);
  });
});
