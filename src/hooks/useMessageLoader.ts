import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getMessageWithHtml, getRenderedHtml, listAttachments, readAttachmentFile } from "@/lib/api";
import { useUpdateFlagsMutation } from "@/hooks/mutations/useUpdateFlagsMutation";
import { sanitizeHtml } from "@/lib/sanitizeHtml";
import type { Message, RenderedHtml, PrivacyMode } from "@/lib/api";

function bytesToBase64(bytes: number[]): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.slice(i, i + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function normalizeCid(value: string): string {
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

async function inlineEmbeddedImages(html: string, messageId: string): Promise<string> {
  const attachments = await listAttachments(messageId);
  if (!/\bcid:/i.test(html)) return html;

  // IMAP servers and mail clients are inconsistent about Content-Disposition.
  // A genuine inline image may have Content-ID but no `inline` disposition;
  // filtering on `is_inline` alone leaves a broken image in the message body.
  const candidates = attachments.filter((attachment) =>
    Boolean(attachment.content_id)
      || (attachment.is_inline && /^image\//i.test(attachment.mime_type)),
  );
  if (candidates.length === 0) return html;

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
    if (!replacement && candidates.length === 1) {
      replacement = replacements.get(normalizeCid(candidates[0].filename));
    }
    if (replacement) image.setAttribute("src", replacement);
  });
  return template.innerHTML;
}

export function useMessageLoader(messageId: string | null, privacyMode: PrivacyMode) {
  const flagsMutation = useUpdateFlagsMutation();
  const [message, setMessage] = useState<Message | null>(null);
  const [rendered, setRendered] = useState<RenderedHtml | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const privacyModeRef = useRef(privacyMode);
  const renderedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    privacyModeRef.current = privacyMode;
  }, [privacyMode]);

  const renderKey = (id: string, mode: PrivacyMode) => `${id}:${JSON.stringify(mode)}`;

  // Load message when messageId changes
  useEffect(() => {
    if (!messageId) {
      setMessage(null);
      setRendered(null);
      setError(null);
      renderedKeyRef.current = null;
      setLoading(false);
      return;
    }

    let cancelled = false;
    const initialPrivacyMode = privacyModeRef.current;
    const initialRenderKey = renderKey(messageId, initialPrivacyMode);
    setLoading(true);
    setMessage(null);
    setRendered(null);
    setError(null);
    renderedKeyRef.current = null;

    async function load() {
      try {
        const result = await getMessageWithHtml(messageId!, initialPrivacyMode);
        if (cancelled || !result) return;
        const [msg, html] = result;
        setMessage(msg);
        renderedKeyRef.current = initialRenderKey;
        const hydratedHtml = await inlineEmbeddedImages(html.html, msg.id);
        setRendered({ ...html, html: sanitizeHtml(hydratedHtml) });

        if (!cancelled && !msg.is_read) {
          flagsMutation.mutate({ messageId: messageId!, isRead: true });
        }
      } catch (err) {
        if (!cancelled) {
          // 后端可能 reject 普通对象（非 Error），统一序列化，避免显示 [object Object]
          let message: string;
          if (typeof err === "string") message = err;
          else if (err instanceof Error) message = err.message;
          else {
            try { message = JSON.stringify(err); } catch { message = "加载失败"; }
          }
          setError(message || "加载失败");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [messageId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 后台补全正文完成（message:hydrated）→ 自动重新加载，正文无需手动刷新
  useEffect(() => {
    if (!messageId) return;
    const unlisten = listen<string>("message:hydrated", (event) => {
      if (event.payload !== messageId) return;
      const id = messageId;
      const mode = privacyModeRef.current;
      const key = renderKey(id, mode);
      void getMessageWithHtml(id, mode)
        .then((result) => {
          if (!result) return;
          const [msg, html] = result;
          setMessage(msg);
          renderedKeyRef.current = key;
          inlineEmbeddedImages(html.html, msg.id).then((h) =>
            setRendered({ ...html, html: sanitizeHtml(h) }),
          );
          setError(null);
        })
        .catch(() => {});
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [messageId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 正文下载失败（网络/服务器问题）→ 显示轻量提示（不覆盖已显示的头部信息）
  const [hydrateFailed, setHydrateFailed] = useState(false);
  useEffect(() => {
    if (!messageId) {
      setHydrateFailed(false);
      return;
    }
    const unlisten = listen<string>("message:hydrate-failed", (event) => {
      if (event.payload !== messageId) return;
      setHydrateFailed(true);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [messageId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-render HTML when privacy mode changes (without reloading message)
  useEffect(() => {
    if (!message || !messageId || message.id !== messageId) return;
    const currentRenderKey = renderKey(messageId, privacyMode);
    if (renderedKeyRef.current === currentRenderKey) return;

    let cancelled = false;
    setRendered(null);
    setError(null);

    getRenderedHtml(messageId, privacyMode)
      .then((html) => {
        if (!cancelled) {
          renderedKeyRef.current = currentRenderKey;
          inlineEmbeddedImages(html.html, message.id).then((hydratedHtml) => {
            if (!cancelled) setRendered({ ...html, html: sanitizeHtml(hydratedHtml) });
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => { cancelled = true; };
  }, [privacyMode, messageId, message]); // eslint-disable-line react-hooks/exhaustive-deps

  return { message, setMessage, rendered, loading, error, hydrateFailed };
}
