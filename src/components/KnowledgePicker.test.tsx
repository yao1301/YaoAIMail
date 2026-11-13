import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  listKnowledgeItems: vi.fn(async () => [
    { id: "k1", name: "Sample Product Guide.docx", accountId: "a", sourceType: "file", content: "text", createdAt: 0 },
  ]),
}));

import KnowledgePicker from "./KnowledgePicker";

function setup() {
  const onChange = vi.fn();
  render(
    <div>
      <KnowledgePicker accountId="a" selectedIds={[]} onChange={onChange} label="引用产品资料" />
      <button type="button">点别处</button>
    </div>,
  );
  return { onChange };
}

describe("KnowledgePicker", () => {
  it("closes the material list when the user clicks somewhere else", async () => {
    setup();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /引用产品资料/ })); });
    expect(await screen.findByText("Sample Product Guide.docx")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("button", { name: "点别处" }));
    await waitFor(() => expect(screen.queryByText("Sample Product Guide.docx")).toBeNull());
  });

  it("closes on Escape", async () => {
    setup();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /引用产品资料/ })); });
    expect(await screen.findByText("Sample Product Guide.docx")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Sample Product Guide.docx")).toBeNull());
  });

  it("keeps the selection when the panel is dismissed", async () => {
    const onChange = vi.fn();
    render(<div><KnowledgePicker accountId="a" selectedIds={[]} onChange={onChange} label="引用产品资料" /><button type="button">点别处</button></div>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /引用产品资料/ })); });
    fireEvent.click(await screen.findByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith(["k1"]);
    fireEvent.mouseDown(screen.getByRole("button", { name: "点别处" }));
    await waitFor(() => expect(screen.queryByRole("checkbox")).toBeNull());
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
