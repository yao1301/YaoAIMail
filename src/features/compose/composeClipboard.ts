/** Excel commonly provides both an editable HTML table and a rendered preview. */
export function clipboardContainsHtmlTable(clipboardData: Pick<DataTransfer, "getData">): boolean {
  const html = clipboardData.getData("text/html");
  return /<table(?:\s|>)/i.test(html);
}

interface ClipboardFileItem {
  kind: string;
  type: string;
  getAsFile(): File | null;
}

export function clipboardImageFiles(items: ArrayLike<ClipboardFileItem> | null | undefined): File[] {
  if (!items) return [];
  const result: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) result.push(file);
  }
  return result;
}

function spreadsheetFragment(html: string): { fragment: string; styles: string } | null {
  if (!/<table(?:\s|>)/i.test(html)) return null;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script, iframe, object, embed, link, meta").forEach((node) => node.remove());
  parsed.querySelectorAll<HTMLElement>("*").forEach((node) => {
    for (const attr of Array.from(node.attributes)) {
      if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
    }
  });
  parsed.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    if (image.src && !image.src.startsWith("data:")) image.remove();
  });

  const rawFragment = /<!--\s*StartFragment\s*-->([\s\S]*?)<!--\s*EndFragment\s*-->/i.exec(html)?.[1];
  let fragment = rawFragment ?? parsed.body.innerHTML;
  if (rawFragment) {
    const fragmentDoc = new DOMParser().parseFromString(fragment, "text/html");
    fragmentDoc.querySelectorAll("script, iframe, object, embed, link, meta").forEach((node) => node.remove());
    fragmentDoc.querySelectorAll<HTMLElement>("*").forEach((node) => {
      for (const attr of Array.from(node.attributes)) {
        if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      }
    });
    fragment = fragmentDoc.body.innerHTML;
  }
  const styles = Array.from(parsed.querySelectorAll("style"))
    .map((style) => style.textContent ?? "")
    .join("\n")
    .replace(/@import[^;]+;/gi, "")
    .replace(/url\([^)]*\)/gi, "none");
  return { fragment, styles };
}

function positiveInteger(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function cssLengthToPixels(value: string | null): number | null {
  if (!value) return null;
  const match = /^([0-9]+(?:\.[0-9]+)?)(px|pt)?$/i.exec(value.trim());
  if (!match) return null;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.max(1, Math.round(match[2]?.toLowerCase() === "pt" ? numeric * 96 / 72 : numeric));
}

function spreadsheetElementWidth(element: HTMLElement): number | null {
  return cssLengthToPixels(element.getAttribute("width"))
    ?? cssLengthToPixels(element.style.width);
}

/** Expand Excel's `<col span>` shorthand so every logical column has one node. */
function expandSpreadsheetColumns(table: HTMLTableElement): number[] {
  const widths: number[] = [];
  const columns = Array.from(table.querySelectorAll<HTMLTableColElement>("col"))
    .filter((column) => column.closest("table") === table);

  for (const column of columns) {
    const span = positiveInteger(column.getAttribute("span")) ?? 1;
    const width = spreadsheetElementWidth(column);
    const parent = column.parentNode;
    const insertionPoint = column.nextSibling;
    column.removeAttribute("span");
    if (width) column.setAttribute("width", String(width));
    widths.push(width ?? 0);

    if (!parent) continue;
    for (let index = 1; index < span; index += 1) {
      const clone = column.cloneNode(true) as HTMLTableColElement;
      clone.removeAttribute("span");
      if (width) clone.setAttribute("width", String(width));
      parent.insertBefore(clone, insertionPoint);
      widths.push(width ?? 0);
    }
  }

  return widths;
}

/**
 * Tiptap derives the rendered colgroup only from the first row. Supplying an
 * explicit colwidth on every first-row cell avoids its col-index zero bug and
 * keeps widths correct after Excel `<col span>` nodes have been expanded.
 */
function writeFirstRowColumnWidths(table: HTMLTableElement, columnWidths: number[]) {
  const firstRow = Array.from(table.rows).find((row) => row.closest("table") === table);
  if (!firstRow) return;

  let columnIndex = 0;
  for (const cell of Array.from(firstRow.cells)) {
    const colspan = positiveInteger(cell.getAttribute("colspan")) ?? 1;
    let widths = columnWidths.slice(columnIndex, columnIndex + colspan);

    // Some spreadsheet producers omit colgroup. Preserve a source-authored
    // cell width as a fallback, but never use hidden-preview measurements.
    if (widths.length !== colspan || widths.some((width) => width <= 0)) {
      const ownWidth = spreadsheetElementWidth(cell);
      widths = ownWidth && colspan === 1 ? [ownWidth] : [];
    }

    if (widths.length === colspan) {
      cell.setAttribute("colwidth", widths.join(","));
    }
    columnIndex += colspan;
  }
}

/** Remove only whitespace that is illegal between table structure elements. */
function removeTableStructureWhitespace(table: HTMLTableElement) {
  const structuralParents: Element[] = [
    table,
    ...Array.from(table.querySelectorAll("colgroup, thead, tbody, tfoot, tr")),
  ];
  for (const parent of structuralParents) {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE && !(child.textContent ?? "").trim()) {
        child.remove();
      }
    }
  }
}

/** WPS may put style-only spacer rows with no cells on the clipboard. */
function removeEmptySpreadsheetRows(table: HTMLTableElement) {
  for (const row of Array.from(table.rows)) {
    if (row.closest("table") === table && row.cells.length === 0) row.remove();
  }
}

/** Tiptap table cells require at least one block node, even when Excel/WPS copied a blank cell. */
function ensureSpreadsheetCellsHaveContent(table: HTMLTableElement) {
  const cells = Array.from(table.querySelectorAll<HTMLTableCellElement>("td, th"))
    .filter((cell) => cell.closest("table") === table);
  for (const cell of cells) {
    const hasMeaningfulContent = Array.from(cell.childNodes).some((child) => {
      if (child.nodeType === Node.TEXT_NODE) return Boolean((child.textContent ?? "").trim());
      return child.nodeType === Node.ELEMENT_NODE;
    });
    if (!hasMeaningfulContent) {
      cell.replaceChildren(document.createElement("p"));
    }
  }
}

/**
 * Convert spreadsheet clipboard HTML into an email-safe styled table.
 *
 * Excel/WPS often put the formatting in a mixture of inline styles and a
 * `<style>` block with generated class names. Tiptap's table schema cannot
 * retain those stylesheet rules by itself, so let the browser resolve the
 * rules and copy the visual table properties back onto each table element.
 * The result remains an editable HTML table and is safe to send to mail
 * clients; it is not a local-only data URL image.
 */
export function prepareSpreadsheetTableHtml(html: string): string | null {
  const content = spreadsheetFragment(html);
  if (!content || typeof document === "undefined") return null;

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = [
    "position:fixed", "left:-100000px", "top:0", "z-index:-1", "pointer-events:none",
    "width:max-content", "max-width:none", "background:#fff", "color:#000", "padding:2px",
  ].join(";");
  const style = document.createElement("style");
  style.textContent = content.styles;
  const preview = document.createElement("div");
  preview.innerHTML = content.fragment;
  host.append(style, preview);
  document.body.appendChild(host);

  try {
    const table = preview.querySelector("table");
    if (!table) return null;

    const tables = Array.from(preview.querySelectorAll<HTMLTableElement>("table"));
    for (const spreadsheetTable of tables) {
      removeTableStructureWhitespace(spreadsheetTable);
      removeEmptySpreadsheetRows(spreadsheetTable);
      ensureSpreadsheetCellsHaveContent(spreadsheetTable);
      const columnWidths = expandSpreadsheetColumns(spreadsheetTable);
      writeFirstRowColumnWidths(spreadsheetTable, columnWidths);
    }

    // These properties are widely supported by mail clients and cover the
    // formatting normally produced for a copied spreadsheet range. Deliberately
    // omit URL-bearing properties such as background-image. Width and height
    // are handled separately so hidden-preview measurements are never frozen
    // onto cells and allowed to fight Excel's real column widths.
    const visualProperties = [
      "background-color", "color", "font-family", "font-size", "font-weight",
      "font-style", "text-decoration", "text-align", "vertical-align", "white-space",
      "line-height", "border-collapse", "border-spacing", "border-top", "border-right",
      "border-bottom", "border-left", "padding-top", "padding-right", "padding-bottom",
      "padding-left",
    ];
    preview.querySelectorAll<HTMLElement>("table, thead, tbody, tfoot, tr, th, td, col, colgroup")
      .forEach((element) => {
        const computed = getComputedStyle(element);
        const elementProperties = [
          ...visualProperties,
          ...(element.tagName === "TABLE" ? ["table-layout"] : []),
          ...(element.tagName === "TABLE" || element.tagName === "COL" || element.tagName === "COLGROUP"
            ? ["width", "min-width"]
            : []),
          ...(element.tagName === "TR" ? ["height"] : []),
        ];
        const declarations = elementProperties
          .map((property) => {
            const value = computed.getPropertyValue(property).trim();
            return value ? `${property}:${value}` : "";
          })
          .filter(Boolean)
          .join(";");
        if (declarations) element.setAttribute("style", declarations);
        // The class names only point back to the clipboard stylesheet, which
        // is not part of the outgoing message after the paste.
        element.removeAttribute("class");
      });

    preview.querySelectorAll("style, script, iframe, object, embed, link, meta")
      .forEach((node) => node.remove());
    return preview.innerHTML.trim();
  } finally {
    host.remove();
  }
}

export function normalizeImageWidthPercent(value: string): number | null {
  const normalized = value.trim().replace(/%$/, "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const percent = Number(normalized);
  if (!Number.isFinite(percent) || percent < 1 || percent > 100) return null;
  return Math.round(percent * 10) / 10;
}

/** Convert a scale relative to the image's intrinsic width into an email-safe pixel width. */
export function scaledImageWidthPx(originalWidth: number, percent: number): number | null {
  if (!Number.isFinite(originalWidth) || originalWidth <= 0) return null;
  if (!Number.isFinite(percent) || percent < 1 || percent > 100) return null;
  return Math.max(1, Math.round(originalWidth * percent / 100));
}
