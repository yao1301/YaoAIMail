import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { reportAppError, safeErrorMessage } from "../../src/lib/appErrors";
import { useToastStore } from "../../src/stores/toast.store";

describe("visible safe errors", () => {
  beforeEach(() => { vi.useFakeTimers(); useToastStore.setState({ toasts: [] }); });
  afterEach(() => { vi.useRealTimers(); });
  it("redacts gateway credentials before showing a notice", () => {
    const result = safeErrorMessage('https://user:privatepass@example.test error {"api_key":"private-key", "password":"private password"} Bearer test-token');
    for (const secret of ["privatepass", "private-key", "private password", "test-token"]) expect(result).not.toContain(secret);
    expect(result).toContain("example.test");
  });
  it("keeps errors visible until explicitly dismissed", () => {
    reportAppError(new Error("persistent-fixture"));
    vi.advanceTimersByTime(120_000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    const id = useToastStore.getState().toasts[0].id;
    useToastStore.getState().removeToast(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
  it("coalesces repeated polling and query notifications", () => {
    reportAppError("polling-fixture", "读取失败"); reportAppError("polling-fixture", "后台失败");
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
  it("does not treat explicit cancellation as an error", () => {
    reportAppError("用户取消");
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
