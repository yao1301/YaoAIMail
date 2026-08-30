import { describe, expect, it } from "vitest";
import {
  clipboardContainsHtmlTable,
  clipboardImageFiles,
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
