import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { describe, expect, it } from "vitest";

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
});
