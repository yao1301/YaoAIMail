import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextStyle } from "@tiptap/extension-text-style";
import FontFamily from "@tiptap/extension-font-family";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import { Markdown } from "tiptap-markdown";
import type { TFunction } from "i18next";
import { useComposeEditor } from "../../../src/hooks/useComposeEditor";
import type { Attachment, Message } from "../../../src/lib/api";
import { loadMessageForEditing } from "../../../src/features/compose/reopenMessage";
import { composeTableExtensions } from "../../../src/features/compose/composeTableExtensions";

const api = vi.hoisted(() => ({
  getMessage: vi.fn(), listAttachments: vi.fn(), getAttachmentPath: vi.fn(), readAttachmentFile: vi.fn(),
}));
vi.mock("../../../src/lib/api", () => api);

const tableHtml = '<table style="table-layout:fixed;border-collapse:collapse;width:384px"><colgroup><col style="width:96px"><col style="width:96px"><col style="width:192px"></colgroup><tbody><tr><td colwidth="96" style="background-color:#FFF2CC;font-family:Calibri;font-size:14px;font-weight:700;text-align:center;border:2px solid #123456;padding:3px 5px">SKU</td><td colwidth="96">Quantity</td><td colwidth="192">Date</td></tr><tr><td>EX-100</td><td colspan="2" colwidth="96,192">1,200</td></tr></tbody></table>';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "sent-1", account_id: "original-account", body_text: "Plain fallback", body_html_raw: tableHtml,
    subject: "Order", is_draft: false, has_attachments: false,
    to_list: [{ address: "buyer@example.org", name: "Buyer" }],
    cc_list: [{ address: "cc@example.org", name: null }],
    bcc_list: [{ address: "bcc@example.org", name: null }],
    ...overrides,
  } as Message;
}
function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return { id: "file-1", message_id: "sent-1", filename: "Order.xlsx", mime_type: "application/octet-stream", size: 8, local_path: "X:/old/data/attachments/Order.xlsx", content_id: null, is_inline: false, ...overrides };
}
function serialize(html: string): string {
  const editor = new Editor({
    extensions: [StarterKit, Placeholder, Markdown.configure({ html: true, transformPastedText: true }), ...composeTableExtensions(), TextStyle, FontFamily, Image.configure({ inline: true, allowBase64: true }), Underline],
    content: html,
  });
  const serialized = editor.getHTML();
  editor.destroy();
  return serialized;
}
function assertTable(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows = Array.from(doc.querySelectorAll("tr"));
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.children.length)).toEqual([3, 2]);
  expect(Array.from(rows[0].children).map((cell) => cell.getAttribute("colwidth"))).toEqual(["96", "96", "192"]);
  expect(rows[1].lastElementChild?.getAttribute("colspan")).toBe("2");
  const cell = rows[0].firstElementChild as HTMLElement;
  expect(cell.style.backgroundColor).toBe("rgb(255, 242, 204)");
  expect(cell.style.fontFamily).toBe("Calibri");
  expect(cell.style.fontSize).toBe("14px");
  expect(cell.style.fontWeight).toBe("700");
  expect(cell.style.textAlign).toBe("center");
  expect(cell.style.borderTopWidth).toBe("2px");
  expect(cell.style.paddingTop).toBe("3px");
  expect((doc.querySelector("table") as HTMLElement).style.tableLayout).toBe("fixed");
}

describe("reopen sent mail and saved drafts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.getMessage.mockResolvedValue(message());
    api.listAttachments.mockResolvedValue([]);
    api.getAttachmentPath.mockResolvedValue("Y:/portable/data/attachments/Order.xlsx");
  });

  it('retains In-Reply-To for saved drafts but not when copying a sent message into a new draft', async () => {
    api.getMessage.mockResolvedValue(message({ id: 'reply-draft', is_draft: true, in_reply_to: '<parent@example.test>' }));
    expect((await loadMessageForEditing('reply-draft')).inReplyTo).toBe('<parent@example.test>');
    api.getMessage.mockResolvedValue(message({ in_reply_to: '<parent@example.test>' }));
    expect((await loadMessageForEditing('sent-1')).inReplyTo).toBeUndefined();
  });

  it("copies the HTML, all recipients and original account without modifying the sent message", async () => {
    const original = message({ has_attachments: true });
    const files = [attachment()];
    api.getMessage.mockResolvedValue(original);
    api.listAttachments.mockResolvedValue(files);
    const before = JSON.stringify({ original, files });
    const snapshot = await loadMessageForEditing("sent-1");
    expect(snapshot.sourceDraftId).toBeUndefined();
    expect(snapshot.accountId).toBe("original-account");
    expect(snapshot.to).toEqual(["buyer@example.org"]);
    expect(snapshot.cc).toEqual(["cc@example.org"]);
    expect(snapshot.bcc).toEqual(["bcc@example.org"]);
    expect(snapshot.attachments).toEqual([{ name: "Order.xlsx", path: "Y:/portable/data/attachments/Order.xlsx", size: 8 }]);
    expect(api.getAttachmentPath).toHaveBeenCalledWith("file-1");
    assertTable(snapshot.richTextHtml);
    expect(JSON.stringify({ original, files })).toBe(before);
  });

  it("preserves cell formatting, widths and merged cells through repeated real Tiptap save/reopen serialization", async () => {
    let snapshot = await loadMessageForEditing("sent-1");
    for (let pass = 0; pass < 3; pass += 1) {
      const outgoingHtml = serialize(snapshot.richTextHtml);
      assertTable(outgoingHtml);
      api.getMessage.mockResolvedValue(message({ id: "draft-1", is_draft: true, body_html_raw: outgoingHtml }));
      snapshot = await loadMessageForEditing("draft-1");
      expect(snapshot.sourceDraftId).toBe("draft-1");
    }
  });

  it("initializes the actual compose hook from the reopened snapshot rather than the plain-text fallback", async () => {
    const snapshot = await loadMessageForEditing("sent-1");
    const t = ((key: string) => key) as TFunction;
    const { result, unmount } = renderHook(() => useComposeEditor({
      fromAccountId: snapshot.accountId, composeMode: "new", composeReplyTo: null,
      isReply: false, t, restoredDraft: snapshot,
    }));
    await waitFor(() => expect(result.current.editorContentReady).toBe(true));
    assertTable(result.current.editor!.getHTML());
    expect(result.current.editor!.getHTML()).not.toContain("Plain fallback");
    expect(result.current.quotedReplyHtml).toBe("");
    unmount();
  });

  it("hydrates CID images into portable outgoing body data without listing inline parts as ordinary files", async () => {
    api.getMessage.mockResolvedValue(message({ body_html_raw: '<p>Logo</p><img src="cid:logo@example.org">', has_attachments: true }));
    api.listAttachments.mockResolvedValue([attachment({ id: "logo", filename: "logo.png", is_inline: true, content_id: "<logo@example.org>", mime_type: "image/png" }), attachment()]);
    api.readAttachmentFile.mockResolvedValue({ mime_type: "image/png", bytes: [1, 2, 3] });
    const snapshot = await loadMessageForEditing("sent-1");
    expect(snapshot.attachments).toHaveLength(1);
    expect(serialize(snapshot.richTextHtml)).toContain('src="data:image/png;base64,AQID"');
    expect(snapshot.richTextHtml).not.toContain("cid:");
  });

  it("retains a Content-ID image declared as an ordinary attachment in both places", async () => {
    api.getMessage.mockResolvedValue(message({ body_html_raw: '<img src="cid:logo@example.org">' }));
    api.listAttachments.mockResolvedValue([attachment({ content_id: "logo@example.org", mime_type: "image/png" })]);
    api.readAttachmentFile.mockResolvedValue({ mime_type: "image/png", bytes: [1, 2, 3] });
    const snapshot = await loadMessageForEditing("sent-1");
    expect(snapshot.attachments).toHaveLength(1);
    expect(snapshot.richTextHtml).toContain("data:image/png;base64,AQID");
  });

  it("does not drop a spreadsheet declared with inline disposition instead of attachment", async () => {
    api.listAttachments.mockResolvedValue([attachment({ is_inline: true })]);
    const snapshot = await loadMessageForEditing("sent-1");
    expect(snapshot.attachments).toHaveLength(1);
    expect(snapshot.attachments[0].name).toBe("Order.xlsx");
  });

  it.each([null, new Error("not downloaded")])("does not silently open an attachment-less copy when a file is unavailable (%s)", async (failure) => {
    api.listAttachments.mockResolvedValue([attachment({ local_path: null })]);
    if (failure instanceof Error) api.getAttachmentPath.mockRejectedValue(failure);
    else api.getAttachmentPath.mockResolvedValue(failure);
    await expect(loadMessageForEditing("sent-1")).rejects.toThrow();
  });

  it("fails visibly when attachment metadata has not been downloaded", async () => {
    api.getMessage.mockResolvedValue(message({ has_attachments: true }));
    await expect(loadMessageForEditing("sent-1")).rejects.toThrow("附件尚未下载完整");
  });

  it("does not silently drop a missing CID image or replace it with an unrelated single image", async () => {
    api.getMessage.mockResolvedValue(message({ body_html_raw: '<img src="cid:missing@example.org">' }));
    api.listAttachments.mockResolvedValue([attachment({ is_inline: true, filename: "other.png", content_id: "other@example.org", mime_type: "image/png" })]);
    api.readAttachmentFile.mockResolvedValue({ mime_type: "image/png", bytes: [1, 2, 3] });
    await expect(loadMessageForEditing("sent-1")).rejects.toThrow("正文图片不可用");
  });

  it("escapes plain text and preserves blank lines without inventing a table", async () => {
    api.getMessage.mockResolvedValue(message({ body_html_raw: "", body_text: "<price> & qty\n\nNext" }));
    const snapshot = await loadMessageForEditing("sent-1");
    expect(snapshot.richTextHtml).toBe("<p>&lt;price&gt; &amp; qty</p><p><br></p><p>Next</p>");
  });

  it("retains safe table data but strips executable HTML before editing", async () => {
    api.getMessage.mockResolvedValue(message({ body_html_raw: `${tableHtml}<script>alert(1)</script><img src="x" onerror="alert(1)">` }));
    const snapshot = await loadMessageForEditing("sent-1");
    expect(snapshot.richTextHtml).not.toMatch(/<script|onerror=/);
    assertTable(snapshot.richTextHtml);
  });

  it("rejects a deleted message rather than opening an empty compose", async () => {
    api.getMessage.mockResolvedValue(null);
    await expect(loadMessageForEditing("sent-1")).rejects.toThrow("邮件不存在");
  });
});
