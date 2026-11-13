import { getAttachmentPath, getMessage, listAttachments } from "@/lib/api";
import { extractComposeBodyHtml } from "@/lib/composeBody";
import { inlineEmbeddedImages } from "@/lib/inlineImages";
import type { ComposeDraftSnapshot } from "./compose-draft";

function textBodyHtml(text: string): string {
  return text.split(/\r?\n/).map((line) => line
    ? `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`
    : "<p><br></p>").join("");
}

/** Re-edit is a full message copy, not a plain-text prefill or a reply. */
export async function loadMessageForEditing(messageId: string): Promise<ComposeDraftSnapshot> {
  const [message, files] = await Promise.all([getMessage(messageId), listAttachments(messageId)]);
  if (!message) throw new Error("邮件不存在或尚未同步完成");
  if (message.has_attachments && files.length === 0) {
    throw new Error("原邮件附件尚未下载完整，请先重新下载邮件后再编辑");
  }
  const attachments = await Promise.all(files.filter((file) =>
    !file.is_inline || !/^image\//i.test(file.mime_type),
  ).map(async (file) => {
    // Resolve through the native boundary, including moved portable profiles;
    // never trust old absolute local_path values or silently discard a file.
    const path = await getAttachmentPath(file.id);
    if (!path) throw new Error("原邮件附件不可用，请先重新下载邮件后再编辑");
    return { name: file.filename, path, size: file.size };
  }));
  const body = message.body_html_raw?.trim()
    ? await inlineEmbeddedImages(extractComposeBodyHtml(message.body_html_raw), message.id, { strict: true })
    : textBodyHtml(message.body_text);
  return {
    // A sent message must NEVER become the backend draft ID: save/delete
    // actions should affect only the new copy, not the original sent mail.
    ...(message.is_draft ? { sourceDraftId: message.id } : {}),
    ...(message.is_draft && message.in_reply_to ? { inReplyTo: message.in_reply_to } : {}),
    accountId: message.account_id,
    to: message.to_list.map((item) => item.address).filter(Boolean),
    cc: message.cc_list.map((item) => item.address).filter(Boolean),
    bcc: message.bcc_list.map((item) => item.address).filter(Boolean),
    subject: message.subject,
    rawSource: message.body_text,
    richTextHtml: body,
    editorMode: "rich",
    attachments,
    savedAt: Date.now(),
  };
}
