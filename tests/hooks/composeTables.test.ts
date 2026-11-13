import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { describe, expect, it } from "vitest";
import { composeTableExtensions } from "../../src/features/compose/composeTableExtensions";

describe("compose table serialization", () => {
  it("preserves an Excel-style HTML table when the draft is serialized for sending", () => {
    const editor = new Editor({
      extensions: [StarterKit, TableKit],
      content: "<table><tbody><tr><th>Product</th><th>Qty</th></tr><tr><td>Night light</td><td>120</td></tr></tbody></table>",
    });

    const html = editor.getHTML();
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("Night light");
    expect(html).toContain("120");
    editor.destroy();
  });

  it("retains safe spreadsheet cell styles through the compose editor schema", () => {
    const editor = new Editor({
      extensions: [StarterKit, ...composeTableExtensions()],
      content: '<table><tbody><tr><td colspan="2" style="background-color:rgb(0, 255, 0);font-weight:700;border:2px solid #123456">Night light</td></tr></tbody></table>',
    });

    const html = editor.getHTML();
    expect(html).toContain("Night light");
    expect(html).toContain("colspan=\"2\"");
    expect(html).toContain("background-color");
    expect(html).toContain("font-weight");
    expect(html).toContain("border");
    editor.destroy();
  });

  it("preserves explicit Excel colwidths and fixed table layout without ghost rows", () => {
    const editor = new Editor({
      extensions: [StarterKit, ...composeTableExtensions()],
      content: '<table style="border-collapse:collapse;table-layout:fixed"><colgroup><col width="96"><col width="96"><col width="192"></colgroup><tbody><tr><td colwidth="96">产品型号</td><td colwidth="96">数量</td><td colwidth="192">交期</td></tr><tr><td>YA-1001</td><td>1,200</td><td>2026-10-15</td></tr></tbody></table>',
    });

    const html = editor.getHTML();
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const rows = Array.from(parsed.querySelectorAll("tr"));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.children.length)).toEqual([3, 3]);
    expect(Array.from(rows[0].children).map((cell) => cell.getAttribute("colwidth")))
      .toEqual(["96", "96", "192"]);
    expect(parsed.querySelector("table")?.getAttribute("style")).toMatch(/table-layout:\s*fixed/);
    expect(Array.from(parsed.querySelectorAll("colgroup > col")).map((column) => column.getAttribute("style")))
      .toEqual(["width: 96px;", "width: 96px;", "width: 192px;"]);
    editor.destroy();
  });
});
