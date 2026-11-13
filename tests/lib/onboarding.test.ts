import { afterEach, describe, expect, it, vi } from "vitest";
import { showOnboardingGuide, SHOW_ONBOARDING_EVENT } from "../../src/lib/onboarding";
const native = vi.hoisted(() => ({ getByLabel: vi.fn(), emitTo: vi.fn(), show: vi.fn(), setFocus: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({Window: { getByLabel: native.getByLabel }}));
afterEach(() => { window.history.replaceState({}, "", "/"); vi.clearAllMocks(); });
describe("reopen onboarding", () => {
  it("opens locally in the main window", async () => {
    const listener = vi.fn(); window.addEventListener(SHOW_ONBOARDING_EVENT, listener);
    await showOnboardingGuide();
    window.removeEventListener(SHOW_ONBOARDING_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(native.getByLabel).not.toHaveBeenCalled();
  });
  it("sends a request to the main window from detached settings", async () => {
    window.history.replaceState({}, "", "/?workspaceWindow=1");
    native.getByLabel.mockResolvedValue(native);
    await showOnboardingGuide();
    expect(native.getByLabel).toHaveBeenCalledWith("main");
    expect(native.emitTo).toHaveBeenCalledWith("main", SHOW_ONBOARDING_EVENT);
    expect(native.show).toHaveBeenCalledTimes(1);
    expect(native.setFocus).toHaveBeenCalledTimes(1);
  });
  it("reports a missing main window instead of silently doing nothing", async () => {
    window.history.replaceState({}, "", "/?workspaceWindow=1");
    native.getByLabel.mockResolvedValue(null);
    await expect(showOnboardingGuide()).rejects.toThrow("请先打开软件主窗口");
  });
});
