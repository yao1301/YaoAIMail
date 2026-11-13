import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ExternalServiceKeyList from "../../src/components/ExternalServiceKeyList";
import { deleteExternalServiceApiKey, listExternalServiceApiKeys, type ExternalServiceKeyStatus } from "../../src/lib/api";
vi.mock("../../src/lib/api", () => ({ deleteExternalServiceApiKey: vi.fn(), listExternalServiceApiKeys: vi.fn() }));
const initial: ExternalServiceKeyStatus = { tavilyConfigured: true, tavilyKeyCount: 2, braveConfigured: true, braveKeyCount: 1, firecrawlConfigured: false, firecrawlKeyCount: 0, hunterConfigured: false, hunterKeyCount: 0 };
function Fixture() {
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState(false);
  return <ExternalServiceKeyList provider="tavily" name="Tavily" status={status} busy={busy} onBusyChange={setBusy} onStatusChange={setStatus} />;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listExternalServiceApiKeys).mockResolvedValue([{id: "first-opaque", maskedKey: "••••••••1234"}, {id: "second-opaque", maskedKey: "••••••••1234"}]);
});
async function expand() {
  fireEvent.click(screen.getByRole("button", {name: "Tavily 已配置 2 个 Key"}));
  await screen.findByLabelText("删除 Tavily Key 2");
}
describe("single saved API key management", () => {
  it("loads only on expansion and deletes the selected opaque ID after confirmation", async () => {
    render(<Fixture />);
    expect(listExternalServiceApiKeys).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", {name: "删除"})).toBeNull();
    await expand();
    expect(screen.getAllByText("••••••••1234")).toHaveLength(2);
    fireEvent.click(screen.getByLabelText("删除 Tavily Key 2"));
    expect(deleteExternalServiceApiKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("取消"));
    expect(deleteExternalServiceApiKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("删除 Tavily Key 2"));
    vi.mocked(deleteExternalServiceApiKey).mockResolvedValue({...initial, tavilyKeyCount: 1});
    vi.mocked(listExternalServiceApiKeys).mockResolvedValue([{id: "first-refreshed-opaque", maskedKey: "••••••••1234"}]);
    fireEvent.click(screen.getByText("确认删除"));
    await waitFor(() => expect(screen.getByRole("button", {name: "Tavily 已配置 1 个 Key"})).toBeTruthy());
    expect(deleteExternalServiceApiKey).toHaveBeenCalledExactlyOnceWith("tavily", "second-opaque");
    await waitFor(() => expect(screen.queryByLabelText("删除 Tavily Key 2")).toBeNull());
    expect(screen.getByLabelText("删除 Tavily Key 1")).toBeTruthy();
  });
  it("keeps the saved list on deletion failure and never falls back to deleting the group", async () => {
    render(<Fixture />); await expand();
    vi.mocked(deleteExternalServiceApiKey).mockRejectedValue(new Error("配置已变更"));
    fireEvent.click(screen.getByLabelText("删除 Tavily Key 1"));
    fireEvent.click(screen.getByText("确认删除"));
    expect((await screen.findByRole("alert")).textContent).toContain("配置已变更");
    expect(screen.getByRole("button", {name: "Tavily 已配置 2 个 Key"})).toBeTruthy();
    expect(screen.getAllByText("••••••••1234")).toHaveLength(2);
    expect(deleteExternalServiceApiKey).toHaveBeenCalledExactlyOnceWith("tavily", "first-opaque");
  });
  it("offers local retry when the saved list cannot be read", async () => {
    vi.mocked(listExternalServiceApiKeys).mockRejectedValueOnce(new Error("无法读取"));
    render(<Fixture />);
    fireEvent.click(screen.getByRole("button", {name: "Tavily 已配置 2 个 Key"}));
    expect((await screen.findByRole("alert")).textContent).toContain("无法读取");
    fireEvent.click(screen.getByText("重新读取"));
    await screen.findByLabelText("删除 Tavily Key 2");
    expect(deleteExternalServiceApiKey).not.toHaveBeenCalled();
  });
});
