import { listAttachments, readAttachmentFile } from "@/lib/api";

export function bytesToBase64(bytes: number[]): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.slice(i, i + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function normalizeCid(value: string): string {
  let decoded = value.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // A malformed percent escape must not prevent the rest of the message
    // from rendering.
  }
  return decoded
    .replace(/^cid:/i, "")
    .replace(/^<+|>+$/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Rewrite `cid:` image references in an email HTML body into `data:` URLs by
 * resolving them against the message's stored inline attachments.
 *
 * Used by BOTH the reading view and the compose reply/forward quote paths —
 * the stored `body_html_raw` always keeps the original `cid:` references, so
 * every surface that displays this HTML needs this hydration step.
 */
export async function inlineEmbeddedImages(html: string, messageId: string, options: { strict?: boolean } = {}): Promise<string> {
  if (!/\bcid:/i.test(html)) return html;
  const attachments = await listAttachments(messageId);

  // IMAP servers and mail clients are inconsistent about Content-Disposition.
  // A genuine inline image may have Content-ID but no `inline` disposition;
  // filtering on `is_inline` alone leaves a broken image in the message body.
  const candidates = attachments.filter((attachment) =>
    Boolean(attachment.content_id)
      || (attachment.is_inline && /^image\//i.test(attachment.mime_type)),
  );
  if (candidates.length === 0 && !options.strict) return html;

  const replacements = new Map<string, string>();
  const filenameKeys = new Map<string, typeof candidates[number]>();
  for (const attachment of candidates) {
    filenameKeys.set(normalizeCid(attachment.filename), attachment);
  }

  await Promise.all(candidates.map(async (attachment) => {
    try {
      const file = await readAttachmentFile(attachment.id);
      const dataUrl = `data:${file.mime_type || attachment.mime_type || "application/octet-stream"};base64,${bytesToBase64(file.bytes)}`;
      if (attachment.content_id) {
        replacements.set(normalizeCid(attachment.content_id), dataUrl);
      }
      // Some clients put the filename (or filename@server) in cid:. Keeping
      // this fallback fixes those messages without allowing arbitrary remote
      // URLs into the rendered email.
      replacements.set(normalizeCid(attachment.filename), dataUrl);
    } catch {
      // A missing inline file should leave the image blocked rather than fail the message.
    }
  }));

  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll<HTMLImageElement>("img[src]").forEach((image) => {
    const src = image.getAttribute("src")?.trim() ?? "";
    if (!/^cid:/i.test(src)) return;

    const key = normalizeCid(src);
    let replacement = replacements.get(key);
    if (!replacement) {
      // A common form is cid:image001.png@ABC while the MIME part stores only
      // image001.png as its filename.
      const filenameKey = key.split("@")[0];
      const filenameAttachment = filenameKeys.get(filenameKey);
      if (filenameAttachment) {
        replacement = replacements.get(normalizeCid(filenameAttachment.filename));
      }
    }
    if (!replacement && candidates.length === 1 && !options.strict) {
      replacement = replacements.get(normalizeCid(candidates[0].filename));
    }
    if (replacement) image.setAttribute("src", replacement);
  });
  if (options.strict && Array.from(template.content.querySelectorAll("img[src]"))
    .some((image) => /^cid:/i.test(image.getAttribute("src")?.trim() ?? ""))) {
    throw new Error("原邮件正文图片不可用，请先重新下载邮件后再编辑");
  }
  return template.innerHTML;
}
