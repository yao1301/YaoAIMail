import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import TrackingTools from "../../../src/features/settings/TrackingTools";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const call = vi.mocked(invoke);
function enter(value: string) { fireEvent.change(screen.getByLabelText("物流智能查询单号"), { target: { value } }); }

describe("TrackingTools", () => {
  beforeEach(() => { call.mockReset(); call.mockResolvedValue(undefined); });

  it("makes no background requests and opens one selected lookup with a reusable history entry", async () => {
    render(<TrackingTools />);
    expect(call).not.toHaveBeenCalled();
    enter("CSQU 3054383");
    fireEvent.click(screen.getByRole("button", { name: "查询", exact: true }));
    await screen.findByText(/已打开 Track-Trace/);
    expect(call).toHaveBeenCalledExactlyOnceWith("open_external_url", { url: "https://www.track-trace.com/container#CSQU3054383" });
    enter("123456789");
    fireEvent.click(screen.getByRole("button", { name: /集装箱号\s*CSQU3054383/ }));
    expect(screen.getByLabelText("物流智能查询单号")).toHaveValue("CSQU3054383");
    expect(screen.getByLabelText("物流查询类型")).toHaveValue("container");
    expect(call).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "清空查询记录" }));
    expect(screen.queryByText("最近查询 · 本次使用")).not.toBeInTheDocument();
  });

  it("shows failures with alternate sources and never records a failed launch as a result", async () => {
    call.mockRejectedValueOnce(new Error("launcher unavailable"));
    render(<TrackingTools />);
    enter("CSQU3054383"); fireEvent.click(screen.getByRole("button", { name: "查询", exact: true }));
    expect(await screen.findByRole("alert")).toHaveTextContent("launcher unavailable");
    expect(screen.queryByText("最近查询 · 本次使用")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /MSC 官网/ }));
    await screen.findByText(/已打开 MSC 官网/);
    expect(call).toHaveBeenLastCalledWith("open_external_url", { url: "https://www.msc.com/en/track-a-shipment" });
    expect(screen.getByRole("status")).toHaveTextContent("请复制单号后");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("validates before opening and supports explicit bill of lading queries", async () => {
    render(<TrackingTools />);
    enter("https://example.com"); fireEvent.click(screen.getByRole("button", { name: "查询", exact: true }));
    expect(screen.getByRole("alert")).toHaveTextContent("只输入一个单号");
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("物流查询类型"), { target: { value: "billOfLading" } });
    enter("BOOK123456"); fireEvent.click(screen.getByRole("button", { name: "查询", exact: true }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("open_external_url", { url: "https://www.track-trace.com/bol#BOOK123456" }));
  });

  it("prevents repeated launches while the opener is pending", async () => {
    let done!: () => void;
    call.mockImplementationOnce(() => new Promise<void>(resolve => { done = resolve; }));
    render(<TrackingTools />);
    enter("123456789"); fireEvent.click(screen.getByRole("button", { name: "查询", exact: true }));
    expect(screen.getByRole("button", { name: "正在打开…" })).toBeDisabled();
    expect(call).toHaveBeenCalledTimes(1);
    done();
    await screen.findByText(/已打开 17TRACK/);
  });
});
