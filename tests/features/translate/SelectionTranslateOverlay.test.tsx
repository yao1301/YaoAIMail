import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SelectionTranslateOverlay from "../../../src/features/translate/SelectionTranslateOverlay";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: vi.fn() },
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));
vi.mock("../../../src/features/translate/TranslatePopover", () => ({
  default: ({ text }: { text: string }) => <div role="dialog">{text}</div>,
}));

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.spyOn(window, "getSelection").mockReturnValue(null);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("shared mail selection toolbar", () => {
  it("copies and translates a short Shadow DOM selection with no overlapping toolbar", async () => {
    render(<><div data-email-translation-scope data-testid="body" /><SelectionTranslateOverlay /></>);
    const root = screen.getByTestId("body").attachShadow({ mode: "open" });
    const span = document.createElement("span");
    span.textContent = "Hi";
    root.append(span);
    Object.defineProperty(root, "getSelection", { value: () => ({ toString: () => "Hi" }) });
    fireEvent(span, new MouseEvent("pointerup", { bubbles: true, composed: true, clientX: 100, clientY: 120 }));
    await waitFor(() => expect(screen.getAllByRole("toolbar")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Copy selected text" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Hi");
    fireEvent(span, new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true }));
    expect(screen.getAllByRole("toolbar")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Translate selected text" }));
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog").textContent).toBe("Hi");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reads editable draft selections after event dispatch and ignores content outside mail", async () => {
    render(<><textarea data-email-translation-scope defaultValue="Please confirm shipment" /><p>Other content</p><SelectionTranslateOverlay /></>);
    const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
    editor.setSelectionRange(7, 14);
    fireEvent(editor, new MouseEvent("pointerup", { bubbles: true }));
    await waitFor(() => expect(screen.getByRole("toolbar")).toBeTruthy());
    fireEvent(document, new Event("pebble:translate-selection"));
    expect(screen.getByRole("dialog").textContent).toBe("confirm");
    fireEvent.pointerDown(screen.getByText("Other content"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
