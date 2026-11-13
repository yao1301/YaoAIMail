import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";

const SAFE_STYLE_PROPERTIES = new Set([
  "background-color", "color", "font-family", "font-size", "font-weight",
  "font-style", "text-decoration", "text-align", "vertical-align", "white-space",
  "line-height", "border-collapse", "border-spacing", "table-layout", "border-top", "border-right",
  "border-bottom", "border-left", "padding-top", "padding-right", "padding-bottom",
  "padding-left", "padding", "border", "border-color", "border-style", "border-width",
  "width", "min-width", "max-width", "height", "margin",
]);

function safeStyle(value: string | null): string | null {
  if (!value || /url\s*\(|expression\s*\(|behavior\s*:|<|>/i.test(value)) return null;
  const declarations = value
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf(":");
      if (separator <= 0) return null;
      const property = part.slice(0, separator).trim().toLowerCase();
      const cssValue = part.slice(separator + 1).trim();
      if (!SAFE_STYLE_PROPERTIES.has(property) || !cssValue) return null;
      return `${property}:${cssValue}`;
    })
    .filter((part): part is string => Boolean(part));
  return declarations.length > 0 ? declarations.join(";") : null;
}

function styleAttribute() {
  return {
    style: {
      default: null,
      parseHTML: (element: HTMLElement) => safeStyle(element.getAttribute("style")),
      renderHTML: (attributes: { style?: string | null }) =>
        attributes.style ? { style: attributes.style } : {},
    },
  };
}

const ComposeTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...styleAttribute(),
    };
  },
});

const ComposeTableRow = TableRow.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...styleAttribute(),
    };
  },
});

const ComposeTableCell = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...styleAttribute(),
    };
  },
});

const ComposeTableHeader = TableHeader.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...styleAttribute(),
    };
  },
});

/** Table extensions that retain safe spreadsheet formatting through Tiptap. */
export function composeTableExtensions() {
  return [
    ComposeTable.configure({
      resizable: false,
      HTMLAttributes: { style: "border-collapse:collapse;width:100%;max-width:100%;margin:12px 0" },
    }),
    ComposeTableCell.configure({
      HTMLAttributes: { style: "border:1px solid #d1d5db;padding:6px 8px;vertical-align:top" },
    }),
    ComposeTableHeader.configure({
      HTMLAttributes: { style: "border:1px solid #cbd5e1;padding:6px 8px;background-color:#f3f4f6;font-weight:600;text-align:left" },
    }),
    ComposeTableRow,
  ];
}
