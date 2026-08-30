import { useState, useEffect, useRef, useMemo } from "react";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { TextStyle } from "@tiptap/extension-text-style";
import FontFamily from "@tiptap/extension-font-family";
import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import Underline from "@tiptap/extension-underline";
import { Markdown as MarkdownExtension } from "tiptap-markdown";
import TurndownService from "turndown";
import { getSignature, listEmailSignatures } from "@/lib/signatures";
import { sanitizeHtml } from "@/lib/sanitizeHtml";
import type { EmailAddress, Message } from "@/lib/ipc-types";
import type { TFunction } from "i18next";

export type EditorMode = "rich" | "markdown" | "html";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

interface UseComposeEditorArgs {
  fromAccountId: string;
  composeMode: string | null;
  composeReplyTo: Message | null;
  isReply: boolean;
  t: TFunction;
  restoredDraft: {
    editorMode?: EditorMode;
    rawSource?: string;
    richTextHtml?: string;
    quotedReplyHtml?: string;
  } | null;
  prefillBody?: string;
  preferredSignatureId?: string;
}

interface BuildComposeEditorContentArgs {
  composeMode: string | null;
  composeReplyTo: Message | null;
  isReply: boolean;
  signatureHtml: string;
  prefillBody?: string;
  t: TFunction;
}

interface BuildReplyQuoteHtmlArgs {
  composeReplyTo: Message | null;
  t: TFunction;
}

interface ShouldApplyInitialEditorContentArgs {
  editorExists: boolean;
  initialized: boolean;
  signatureReady: boolean;
  hasRestoredDraft: boolean;
}

function formatQuoteAddress(item: EmailAddress) {
  const address = escapeHtml(item.address || "");
  const linkedAddress = `<a href="mailto:${address}" style="color:#2563eb;text-decoration:none">${address}</a>`;
  return item.name?.trim() ? `${escapeHtml(item.name.trim())} &lt;${linkedAddress}&gt;` : linkedAddress;
}

function formatQuoteAddressList(items: EmailAddress[]) {
  return items.map(formatQuoteAddress).join(", ");
}

function quoteHeaderRow(label: string, value: string) {
  if (!value) return "";
  return `<tr><td style="width:68px;padding:3px 12px 3px 0;color:#6b7280;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td><td style="padding:3px 0;color:#24292f;vertical-align:top;word-break:break-word">${value}</td></tr>`;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function plainTextToParagraphs(text: string) {
  // 段落规则：
  // 1. 显式空行（\n{2,}）一定是段落分隔。
  // 2. 单换行（无空行）时，若行较短（< 90 字符）也按段落切分——
  //    开发信/AI 草稿常用单换行分隔短段落，若全并成一段会没有段距。
  //    长行（>= 90 字符）视为同一段内的折行，用 <br/> 连接。
  // 3. 列表项（- / 1. 开头）保持为同一段内的换行（<br/>），避免拆散列表。
  const paragraphs = text
    .split(/\r?\n{2,}/)
    .flatMap((para) => {
      const lines = para.split(/\r?\n/);
      if (lines.length <= 1) return [para];
      // 判断是否列表块（大多数行以 -、*、数字. 开头）
      const listLike = lines.filter((l) => l.trim()).every((l) => /^\s*(?:[-*•]|\d+[.)])\s/.test(l));
      if (listLike) return [lines.join("\n")];
      // 单换行短行 → 各自成段；长行合并
      const out: string[] = [];
      let buf: string[] = [];
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        if (line.length >= 90) {
          if (buf.length) { out.push(buf.join("\n")); buf = []; }
          out.push(line);
        } else {
          buf.push(line);
        }
      }
      if (buf.length) out.push(buf.join("\n"));
      return out;
    })
    .map((para) => {
      const lines = para
        .split(/\r?\n/)
        .map((line) => escapeHtml(line))
        .join("<br/>");
      return `<p>${lines}</p>`;
    })
    .join("");
  return paragraphs || "<p></p>";
}

function parseBodyHtml(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.innerHTML;
}

function decodeHtmlEntities(value: string) {
  const doc = new DOMParser().parseFromString(value, "text/html");
  return doc.body.textContent ?? "";
}

function startsWithEncodedHtmlTag(value: string) {
  return /^\s*(?:&lt;|&#0*60;|&#x0*3c;)\s*\/?[a-z][\w:-]*(?:\s|\/?(?:&gt;|&#0*62;|&#x0*3e;))/i.test(value);
}

function looksLikeHtml(value: string) {
  return /<\s*\/?[a-z][\w:-]*(?:\s|\/?>)/i.test(value);
}

export function extractComposeBodyHtml(html: string) {
  try {
    const source = html.trim();
    let body = parseBodyHtml(source);
    const decoded = decodeHtmlEntities(body).trim();

    if (startsWithEncodedHtmlTag(source) && decoded !== body.trim() && looksLikeHtml(decoded)) {
      body = parseBodyHtml(decoded);
    }

    return sanitizeHtml(body);
  } catch {
    return `<p>${escapeHtml(html)}</p>`;
  }
}

export function buildComposeEditorContent({
  composeMode,
  composeReplyTo,
  isReply,
  signatureHtml,
  prefillBody,
  t,
}: BuildComposeEditorContentArgs) {
  try {
    if (isReply && composeReplyTo) {
      const replyBody = prefillBody?.trim()
        ? plainTextToParagraphs(prefillBody)
        : "<p><br></p>";
      return `${replyBody}${signatureHtml}`;
    }
    if (composeMode === "forward" && composeReplyTo) {
      const sender = escapeHtml(composeReplyTo.from_name || composeReplyTo.from_address || "");
      const fwdSubject = escapeHtml(composeReplyTo.subject || "");
      const body = composeReplyTo.body_html_raw
        ? extractComposeBodyHtml(composeReplyTo.body_html_raw)
        : `<p>${escapeHtml(composeReplyTo.body_text || "")}</p>`;
      return `${signatureHtml}<br/><br/><p>${escapeHtml(t("compose.forwardedHeader"))}</p><p>${escapeHtml(t("compose.forwardedFrom", { sender }))}</p><p>${escapeHtml(t("compose.forwardedSubject", { subject: fwdSubject }))}</p>${body}`;
    }
    if (composeMode === "new" && prefillBody?.trim()) {
      return `${plainTextToParagraphs(prefillBody)}${signatureHtml}`;
    }
    return signatureHtml;
  } catch (err) {
    console.error("[ComposeView] Failed to build editor content:", err);
    return "";
  }
}

export function buildReplyQuoteHtml({ composeReplyTo, t }: BuildReplyQuoteHtmlArgs) {
  if (!composeReplyTo) return "";

  const sender = formatQuoteAddress({
    name: composeReplyTo.from_name || null,
    address: composeReplyTo.from_address || "",
  });
  const dateStr = escapeHtml(new Date((composeReplyTo.date || 0) * 1000).toLocaleString());
  const to = formatQuoteAddressList(composeReplyTo.to_list || []);
  const cc = formatQuoteAddressList(composeReplyTo.cc_list || []);
  const subject = escapeHtml(composeReplyTo.subject || "");
  const body = composeReplyTo.body_html_raw
    ? extractComposeBodyHtml(composeReplyTo.body_html_raw)
    : `<p>${escapeHtml(composeReplyTo.body_text || "")}</p>`;
  return `<div class="compose-original-quote" style="margin:18px 0 0;border:1px solid #d9dde3;border-radius:10px;overflow:hidden;background:#ffffff;color:#24292f;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55"><div style="padding:12px 14px;background:#f3f4f6;border-bottom:1px solid #d9dde3"><div style="margin:0 0 7px;color:#4b5563;font-size:12px;font-weight:700">${escapeHtml(t("compose.originalMessage"))}</div><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font:inherit"><tbody>${quoteHeaderRow(t("compose.from"), sender)}${quoteHeaderRow(t("compose.sentDate"), dateStr)}${quoteHeaderRow(t("compose.to"), to)}${quoteHeaderRow(t("compose.cc"), cc)}${quoteHeaderRow(t("compose.subject"), subject)}</tbody></table></div><div style="padding:14px 16px;background:#ffffff">${body}</div></div>`;
}

export function appendReplyQuoteHtml(bodyHtml: string, quotedReplyHtml: string) {
  const quote = quotedReplyHtml.trim();
  if (!quote) return bodyHtml;
  const body = bodyHtml.trim() || "<p><br></p>";
  return `${body}<br/><br/>${quote}`;
}

export function shouldApplyInitialEditorContent({
  editorExists,
  initialized,
  signatureReady,
  hasRestoredDraft,
}: ShouldApplyInitialEditorContentArgs) {
  if (!editorExists || initialized) return false;
  return hasRestoredDraft || signatureReady;
}

export function useComposeEditor({
  fromAccountId,
  composeMode,
  composeReplyTo,
  isReply,
  t,
  restoredDraft,
  prefillBody,
  preferredSignatureId,
}: UseComposeEditorArgs) {
  const [editorMode, setEditorMode] = useState<EditorMode>(restoredDraft?.editorMode ?? "rich");
  const [rawSource, setRawSource] = useState(restoredDraft?.rawSource ?? prefillBody ?? "");
  const [richTextHtml, setRichTextHtml] = useState("");
  const [htmlPreview, setHtmlPreview] = useState(false);
  const [signature, setSignature] = useState("");
  const [signatureReady, setSignatureReady] = useState(Boolean(restoredDraft));
  const [editorContentReady, setEditorContentReady] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const contentInitializedRef = useRef(false);

  useEffect(() => {
    if (restoredDraft) {
      setSignatureReady(true);
      return;
    }
    let cancelled = false;
    setSignatureReady(false);
    const loadSignature = async () => {
      if (preferredSignatureId) {
        const signatures = await listEmailSignatures(fromAccountId);
        const preferred = signatures.find((item) => item.id === preferredSignatureId);
        if (preferred) return preferred.content;
      }
      return getSignature(fromAccountId);
    };
    loadSignature()
      .then((loaded) => {
        if (!cancelled) setSignature(loaded);
      })
      .catch((err) => {
        console.warn("Failed to load signature:", err);
        if (!cancelled) setSignature("");
      })
      .finally(() => {
        if (!cancelled) setSignatureReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [fromAccountId, preferredSignatureId, restoredDraft]);

  // Build signature HTML block. New-style signatures are stored as HTML
  // (rich text editor); legacy plain-text signatures are escaped.
  const signatureHtml = useMemo(() => {
    const sig = signature;
    if (!sig) return "";
    const isHtml = /<[a-z][\s\S]*>/i.test(sig);
    const body = isHtml ? sig : escapeHtml(sig).replace(/\n/g, "<br/>");
    return `<br/><br/><div style="color:var(--color-text-secondary);font-size:13px">--<br/>${body}</div>`;
  }, [signature]);

  const editorContent = useMemo(() => {
    return buildComposeEditorContent({ composeMode, composeReplyTo, isReply, signatureHtml, prefillBody, t });
  }, [composeMode, composeReplyTo, isReply, t, signatureHtml, prefillBody]);
  const generatedQuotedReplyHtml = useMemo(() => {
    return isReply ? buildReplyQuoteHtml({ composeReplyTo, t }) : "";
  }, [composeReplyTo, isReply, t]);
  // The reply target is a live store object. It can briefly disappear while
  // switching compose tabs, applying an AI draft, or restoring a backend
  // draft. A reply must keep the original quote that was visible when the
  // compose session started; otherwise later AI rounds and the final send can
  // silently lose the incoming message.
  const [stableQuotedReplyHtml, setStableQuotedReplyHtml] = useState(
    () => restoredDraft?.quotedReplyHtml?.trim() ?? "",
  );
  useEffect(() => {
    if (!isReply || stableQuotedReplyHtml || !generatedQuotedReplyHtml) return;
    setStableQuotedReplyHtml(generatedQuotedReplyHtml);
  }, [generatedQuotedReplyHtml, isReply, stableQuotedReplyHtml]);
  const quotedReplyHtml = stableQuotedReplyHtml || generatedQuotedReplyHtml;

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: t("compose.editorPlaceholder", "Write your message...") }),
      MarkdownExtension.configure({ html: true, transformPastedText: true }),
      TableKit.configure({
        table: {
          resizable: false,
          HTMLAttributes: { style: "border-collapse:collapse;width:100%;max-width:100%;margin:12px 0" },
        },
        tableCell: {
          HTMLAttributes: { style: "border:1px solid #d1d5db;padding:6px 8px;vertical-align:top" },
        },
        tableHeader: {
          HTMLAttributes: { style: "border:1px solid #cbd5e1;padding:6px 8px;background-color:#f3f4f6;font-weight:600;text-align:left" },
        },
      }),
      TextStyle,
      FontFamily.configure({ types: ["textStyle"] }),
      Image.configure({ inline: true, allowBase64: true }),
      Underline,
    ],
    content: "",
  });

  // Set editor content after creation to avoid initialization crashes
  useEffect(() => {
    if (!shouldApplyInitialEditorContent({
      editorExists: Boolean(editor),
      initialized: contentInitializedRef.current,
      signatureReady,
      hasRestoredDraft: Boolean(restoredDraft),
    }) || !editor) return;
    // If restoring a draft, prefer its richTextHtml over generated editorContent
    if (restoredDraft?.richTextHtml) {
      editor.commands.setContent(restoredDraft.richTextHtml);
    } else if (editorContent) {
      editor.commands.setContent(editorContent);
    }
    if (isReply && !restoredDraft) {
      requestAnimationFrame(() => editor.commands.focus("start"));
    }
    contentInitializedRef.current = true;
    setEditorContentReady(true);
  }, [editor, editorContent, isReply, restoredDraft, signatureReady]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const syncRichTextHtml = () => {
      setRichTextHtml(editor.getHTML());
    };

    syncRichTextHtml();
    editor.on("update", syncRichTextHtml);

    return () => {
      editor.off("update", syncRichTextHtml);
    };
  }, [editor]);

  // Switch between modes, syncing content
  function switchMode(newMode: EditorMode) {
    if (newMode === editorMode || !editor) return;

    if (editorMode === "rich") {
      if (newMode === "markdown") {
        setRawSource(turndown.turndown(editor.getHTML()));
      } else {
        setRawSource(editor.getHTML());
      }
    } else if (editorMode === "markdown") {
      if (newMode === "rich") {
        editor.commands.setContent(rawSource);
      } else {
        editor.commands.setContent(rawSource);
        setRawSource(editor.getHTML());
      }
    } else {
      if (newMode === "rich") {
        editor.commands.setContent(rawSource);
      } else {
        setRawSource(turndown.turndown(rawSource));
      }
    }

    setEditorMode(newMode);
  }

  return {
    editor,
    editorMode,
    rawSource,
    setRawSource,
    richTextHtml,
    htmlPreview,
    setHtmlPreview,
    switchMode,
    textareaRef,
    editorContentReady,
    quotedReplyHtml,
  };
}
