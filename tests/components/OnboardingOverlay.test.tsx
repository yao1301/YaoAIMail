import { fireEvent, render, screen, waitFor, act, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OnboardingOverlay from "../../src/components/OnboardingOverlay";
import { getTranslateConfig } from "../../src/lib/api";
import { useUIStore } from "../../src/stores/ui.store";
vi.mock("../../src/hooks/queries", () => ({ useAccountsQuery: () => ({data: []}) }));
vi.mock("../../src/lib/api", () => ({ getDataDir: vi.fn().mockResolvedValue("D:\\ExampleMailData"), openDataDir: vi.fn(), getTranslateConfig: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); vi.mocked(getTranslateConfig).mockResolvedValue(null); });
function next() { fireEvent.click(screen.getByRole("button", {name: "下一步"})); }
describe("onboarding follows current settings", () => {
  it("displays the actual data path and never claims unconfigured AI is ready", async () => {
    render(<OnboardingOverlay />);
    next(); await screen.findByText("D:\\ExampleMailData");
    expect(screen.queryByText(/PEBBLE_PROFILE_DIR/)).toBeNull();
    next(); next();
    const dialog = screen.getByRole("dialog", {name: "新手引导"});
    expect(within(dialog).getByText("D:\\ExampleMailData")).toBeTruthy();
    expect(await within(dialog).findByText("尚未配置，普通收发邮件不受影响")).toBeTruthy();
    expect(dialog.textContent).not.toContain("%APPDATA%");
  });
  it("can resume after opening model settings, and can reopen after completion", async () => {
    render(<OnboardingOverlay />); next(); next();
    fireEvent.click(screen.getByRole("button", {name: "前往设置 AI 模型"}));
    expect(useUIStore.getState().settingsTab).toBe("translation");
    expect(useUIStore.getState().activeView).toBe("settings");
    expect(localStorage.getItem("pebble-onboarding-v2")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    vi.mocked(getTranslateConfig).mockResolvedValue({id:"fixture",provider_type:"llm",is_enabled:true,created_at:0,updated_at:0,
      config:JSON.stringify({type:"llm",active_id:"configured",providers:[{id:"configured",api_key:"anonymous-key",model:"example-model"}]})});
    fireEvent.click(screen.getByText("继续新手引导"));
    await waitFor(() => expect(screen.getByText(/当前状态：已配置并启用/)).toBeTruthy());
    next(); fireEvent.click(screen.getByRole("button", {name: "开始使用"}));
    expect(localStorage.getItem("pebble-onboarding-v2")).toBe("done");
    act(() => { window.dispatchEvent(new CustomEvent("pebble:show-onboarding")); });
    expect(screen.getByRole("dialog", {name: "新手引导"})).toBeTruthy();
  });
  it("does not force completed users through the guide again", () => {
    localStorage.setItem("pebble-onboarding-v2", "done");
    render(<OnboardingOverlay />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(getTranslateConfig).not.toHaveBeenCalled();
  });
});
