import {fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";
import AiSearchSettings from "../../../src/features/settings/AiSearchSettings";
import ExternalServicesTab from "../../../src/features/settings/ExternalServicesTab";
const api = vi.hoisted(() => ({
  getAiSearchSettings: vi.fn(), saveAiSearchSettings: vi.fn(), testAiSearch: vi.fn(),
  getExternalServiceKeyStatus: vi.fn(), getExternalServiceUsage: vi.fn(),
  deleteExternalServiceApiKey: vi.fn(), saveExternalServiceApiKey: vi.fn(), validateExternalServiceApiKey: vi.fn(),
  setDeepseekSearchEnabled: vi.fn(),
  listExternalServiceApiKeys: vi.fn(),
}));
vi.mock("../../../src/lib/api", () => api);
vi.mock("@tauri-apps/api/core", () => ({invoke: vi.fn()}));
const initial = {
  tavilyConfigured: true, braveConfigured: true, firecrawlConfigured: false, hunterConfigured: false,
  tavilyKeyCount: 1, braveKeyCount: 1, firecrawlKeyCount: 0, hunterKeyCount: 0,
  deepseekConfigured: false, deepseekKeyCount: 0,
  deepseekSearchEnabled: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  api.getExternalServiceKeyStatus.mockResolvedValue(initial);
  api.getExternalServiceUsage.mockResolvedValue({valid: true, message: "已配置"});
  api.listExternalServiceApiKeys.mockResolvedValue([{id: "opaque-row-1", maskedKey: "••••••••1234"}]);
});
describe("simple automatic search experience", () => {
  it("explains ordinary use without making the user configure a service", () => {
    render(<AiSearchSettings />);
    expect(screen.getByText(/无需配置本地搜索服务/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("does not expose OpenSERP endpoints, budget knobs, or a diagnostic search form", () => {
    const view = render(<AiSearchSettings />);
    expect(view.container.textContent).not.toContain("OpenSERP");
    expect(view.container.textContent).not.toContain("搜索测试");
    expect(view.container.textContent).not.toContain("127.0.0.1");
    expect(api.getAiSearchSettings).not.toHaveBeenCalled();
    expect(api.saveAiSearchSettings).not.toHaveBeenCalled();
    expect(api.testAiSearch).not.toHaveBeenCalled();
  });
  it("collapses personal API configuration and does not query providers on ordinary page entry", async () => {
    const view = render(<ExternalServicesTab />);
    await waitFor(() => expect(api.getExternalServiceKeyStatus).toHaveBeenCalled());
    expect(view.container.querySelector("details")?.open).toBe(false);
    expect(screen.getByText("自备外部服务 API（高级，可选）")).toBeTruthy();
    expect(api.getExternalServiceUsage).not.toHaveBeenCalled();
    expect(api.testAiSearch).not.toHaveBeenCalled();
    expect(api.validateExternalServiceApiKey).not.toHaveBeenCalled();
  });
  it("requires separate billing consent after saving a Key and can turn it off without deleting the Key", async () => {
    const view = render(<ExternalServicesTab />);
    api.validateExternalServiceApiKey.mockResolvedValue({valid: true, message: "Key 有效"});
    api.saveExternalServiceApiKey.mockResolvedValue({...initial, deepseekConfigured: true, deepseekKeyCount: 1});
    api.deleteExternalServiceApiKey.mockResolvedValue(initial);
    const details = view.container.querySelector("details")!;
    details.open = true;
    const card = screen.getByText("DeepSeek 网页搜索与读取").closest("section")!;
    const key = within(card).getByLabelText("DeepSeek 网页搜索与读取 API Key");
    expect(api.validateExternalServiceApiKey).not.toHaveBeenCalled();
    fireEvent.change(key, {target: {value: "fixture-key"}});
    fireEvent.click(within(card).getByRole("button", {name: "保存"}));
    await waitFor(() => expect(within(card).getByText("Key 已保存，付费搜索未开启")).toBeTruthy());
    expect(api.saveExternalServiceApiKey).toHaveBeenCalledWith("deepseek", "fixture-key");
    expect(api.setDeepseekSearchEnabled).not.toHaveBeenCalled();
    const consent = within(card).getByRole("checkbox", {name: "允许在搜客和资信调研中使用 DeepSeek 付费搜索"});
    expect(consent).toHaveProperty("checked", false);
    api.setDeepseekSearchEnabled.mockResolvedValue({...initial, deepseekConfigured: true, deepseekKeyCount: 1, deepseekSearchEnabled: true});
    fireEvent.click(consent);
    await waitFor(() => expect(consent).toHaveProperty("checked", true));
    expect(api.setDeepseekSearchEnabled).toHaveBeenLastCalledWith(true);
    api.setDeepseekSearchEnabled.mockResolvedValue({...initial, deepseekConfigured: true, deepseekKeyCount: 1});
    fireEvent.click(consent);
    await waitFor(() => expect(consent).toHaveProperty("checked", false));
    expect(api.setDeepseekSearchEnabled).toHaveBeenLastCalledWith(false);
    expect(api.deleteExternalServiceApiKey).not.toHaveBeenCalled();
    expect(key).toHaveProperty("value", "");
    expect(api.getExternalServiceUsage).not.toHaveBeenCalledWith("deepseek");
    fireEvent.click(within(card).getByRole("button", {name: /DeepSeek.*已配置 1 个 Key/}));
    await waitFor(() => expect(within(card).getByLabelText("删除 DeepSeek 网页搜索与读取 Key 1")).toBeTruthy());
    fireEvent.click(within(card).getByLabelText("删除 DeepSeek 网页搜索与读取 Key 1"));
    expect(api.deleteExternalServiceApiKey).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", {name: "确认删除"}));
    await waitFor(() => expect(within(card).getByText("未配置")).toBeTruthy());
    expect(api.deleteExternalServiceApiKey).toHaveBeenCalledWith("deepseek", "opaque-row-1");
  });
  it("does not turn on billing for an old saved Key, and a failed opt-in leaves it disabled", async () => {
    api.getExternalServiceKeyStatus.mockResolvedValue({...initial, deepseekConfigured: true, deepseekSearchEnabled: undefined});
    api.setDeepseekSearchEnabled.mockRejectedValue(new Error("保存失败"));
    const view = render(<ExternalServicesTab />);
    const card = screen.getByText("DeepSeek 网页搜索与读取").closest("section")!;
    const consent = within(card).getByRole("checkbox");
    await waitFor(() => expect(consent).toHaveProperty("disabled", false));
    expect(consent).toHaveProperty("checked", false);
    expect(api.setDeepseekSearchEnabled).not.toHaveBeenCalled();
    fireEvent.click(consent);
    await waitFor(() => expect(consent).toHaveProperty("disabled", false));
    expect(consent).toHaveProperty("checked", false);
    expect(view.container.textContent).toContain("一次任务可能包含多次请求");
  });
});
