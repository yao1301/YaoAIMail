import { describe, expect, it } from "vitest";
import {
  clipboardContainsHtmlTable,
  clipboardImageFiles,
  prepareSpreadsheetTableHtml,
  normalizeImageWidthPercent,
  scaledImageWidthPx,
} from "../../../src/features/compose/composeClipboard";

describe("clipboardContainsHtmlTable", () => {
  it("prefers an editable Excel HTML table over its duplicate image preview", () => {
    const data = { getData: (type: string) => type === "text/html" ? "<html><body><!--StartFragment--><table class='xl65'><tr><td>45W</td></tr></table><!--EndFragment--></body></html>" : "" };
    expect(clipboardContainsHtmlTable(data)).toBe(true);
  });

  it("does not block ordinary pasted images or similarly named tags", () => {
    expect(clipboardContainsHtmlTable({ getData: () => "<p><img src='data:image/png;base64,abc'></p>" })).toBe(false);
    expect(clipboardContainsHtmlTable({ getData: () => "<tableau-view></tableau-view>" })).toBe(false);
  });
});

describe("normalizeImageWidthPercent", () => {
  it("accepts a percentage with or without the percent sign", () => {
    expect(normalizeImageWidthPercent("35")).toBe(35);
    expect(normalizeImageWidthPercent("62.5%")).toBe(62.5);
  });

  it("rejects unsafe or out-of-range sizes", () => {
    expect(normalizeImageWidthPercent("0")).toBeNull();
    expect(normalizeImageWidthPercent("101")).toBeNull();
    expect(normalizeImageWidthPercent("100px")).toBeNull();
  });
});

describe("clipboardImageFiles", () => {
  it("keeps only rendered image representations", () => {
    const preview = new File(["preview"], "excel-preview.png", { type: "image/png" });
    const document = new File(["sheet"], "sheet.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const items = [
      { kind: "string", type: "text/html", getAsFile: () => null },
      { kind: "file", type: preview.type, getAsFile: () => preview },
      { kind: "file", type: document.type, getAsFile: () => document },
    ];
    expect(clipboardImageFiles(items)).toEqual([preview]);
  });
});

describe("prepareSpreadsheetTableHtml", () => {
  it("keeps a styled editable table instead of producing an image", () => {
    const html = `<!--StartFragment--><style>.xl-cell { background-color: rgb(0, 255, 0); font-weight: 700; }</style><table class="xl-table"><tr><td class="xl-cell" colspan="2">Night light</td></tr></table><!--EndFragment-->`;
    const prepared = prepareSpreadsheetTableHtml(html);
    expect(prepared).toContain("<table");
    expect(prepared).toContain("Night light");
    expect(prepared).toContain("colspan=\"2\"");
    expect(prepared).toContain("background-color");
    expect(prepared).toContain("font-weight");
    expect(prepared).not.toContain("<img");
    expect(prepared).not.toContain("data:image");
    expect(prepared).not.toContain("<style");
  });

  it("keeps Excel structure and column widths without hidden-preview cell dimensions", () => {
    const html = `<html><head><style>
      .xl65 { background:#FFF2CC;font-family:Calibri,sans-serif;font-weight:700;text-align:center; }
    </style></head><body><!--StartFragment-->
      <table style="border-collapse:collapse;table-layout:fixed;width:288pt">
        <col width="96" span="2" style="width:72pt">
        <col width="192" style="width:144pt">
        <tr height="20">
          <td class="xl65" width="96" style="width:72pt;height:15pt">产品型号</td>
          <td class="xl65" width="96" style="width:72pt">数量</td>
          <td class="xl65" width="192" style="width:144pt">交期</td>
        </tr>
        <tr><td>YA-1001</td><td>1,200</td><td>2026-10-15</td></tr>
      </table>
    <!--EndFragment--></body></html>`;

    const prepared = prepareSpreadsheetTableHtml(html);
    expect(prepared).not.toBeNull();

    const parsed = new DOMParser().parseFromString(prepared!, "text/html");
    const table = parsed.querySelector("table")!;
    const rows = Array.from(table.querySelectorAll("tr"));
    const columns = Array.from(table.querySelectorAll("colgroup > col"));
    const firstRowCells = Array.from(rows[0].children) as HTMLElement[];

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.children.length)).toEqual([3, 3]);
    expect(columns).toHaveLength(3);
    expect(columns.map((column) => column.getAttribute("width"))).toEqual(["96", "96", "192"]);
    expect(firstRowCells.map((cell) => cell.getAttribute("colwidth"))).toEqual(["96", "96", "192"]);
    expect(table.getAttribute("style")).toContain("table-layout:fixed");
    expect(firstRowCells[0].getAttribute("style")).not.toMatch(/(?:^|;)\s*(?:width|min-width|height)\s*:/i);
    expect(prepared).not.toMatch(/>\s+</);
  });

  it("makes blank Excel/WPS cells valid for the Tiptap table schema", () => {
    const html = `<!--StartFragment--><table><tr><td>型号</td><td></td><td> </td></tr><tr></tr></table><!--EndFragment-->`;
    const prepared = prepareSpreadsheetTableHtml(html);
    const parsed = new DOMParser().parseFromString(prepared!, "text/html");
    const cells = Array.from(parsed.querySelectorAll("td"));

    expect(parsed.querySelectorAll("tr")).toHaveLength(1);
    expect(cells).toHaveLength(3);
    expect(cells[0].textContent).toBe("型号");
    expect(cells[1].innerHTML).toBe("<p></p>");
    expect(cells[2].innerHTML).toBe("<p></p>");
  });
});

describe("scaledImageWidthPx", () => {
  it("scales from intrinsic image width rather than the compose container", () => {
    expect(scaledImageWidthPx(1200, 20)).toBe(240);
    expect(scaledImageWidthPx(1200, 50)).toBe(600);
    expect(scaledImageWidthPx(1200, 80)).toBe(960);
  });

  it("rejects unavailable intrinsic sizes and invalid scales", () => {
    expect(scaledImageWidthPx(0, 50)).toBeNull();
    expect(scaledImageWidthPx(1200, 0)).toBeNull();
    expect(scaledImageWidthPx(1200, 101)).toBeNull();
  });
});
