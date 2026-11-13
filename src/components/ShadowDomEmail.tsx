import { useCallback, useRef, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { openMailtoUrl } from "@/app/useMailtoOpen";
import { sanitizeHtml } from "@/lib/sanitizeHtml";
import { decorateHistoricalQuoteCards } from "@/lib/historicalQuoteCards";
import { readEmailLinkMode, saveEmailLinkMode, type EmailLinkMode } from "@/lib/emailLinkPreference";
import { useToastStore } from "@/stores/toast.store";
import ConfirmDialog from "./ConfirmDialog";

interface ShadowDomEmailProps {
  html: string;
  className?: string;
}

function setImportantStyles(element: HTMLElement, styles: Record<string, string>) {
  for (const [property, value] of Object.entries(styles)) {
    element.style.setProperty(property, value, "important");
  }
}

function directCardPart(card: HTMLElement, className: string): HTMLElement | null {
  return Array.from(card.children).find((child) => child.classList.contains(className)) as HTMLElement | null;
}

// Some production WebViews block inline <style> elements inside Shadow DOM.
// Keep the card's essential presentation on the display-only nodes themselves
// so provider-authored email CSS cannot make generated cards look like plain
// unstyled quoted text.
function applyHistoricalQuoteCardInlineStyles(container: HTMLElement) {
  container.querySelectorAll<HTMLElement>(".pebble-history-quote").forEach((card) => {
    setImportantStyles(card, {
      display: "block",
      "box-sizing": "border-box",
      "max-width": "100%",
      margin: "18px 0 0",
      padding: "0",
      overflow: "hidden",
      border: "1px solid #d9dde3",
      "border-radius": "10px",
      background: "#fff",
      color: "#24292f",
      "box-shadow": "0 1px 2px rgba(0,0,0,.03)",
    });

    const title = directCardPart(card, "pebble-history-quote__title")
      ?? card.querySelector<HTMLElement>(".pebble-history-quote__title");
    if (title) {
      setImportantStyles(title, {
        display: "block",
        margin: "0",
        padding: "9px 14px 0",
        background: "#f3f4f6",
        color: "#6b7280",
        "font-size": "12px",
        "font-weight": "700",
      });
    }

    const header = directCardPart(card, "pebble-history-quote__header")
      ?? card.querySelector<HTMLElement>(".pebble-history-quote__header");
    if (header) {
      setImportantStyles(header, {
        display: "block",
        "box-sizing": "border-box",
        width: "100%",
        margin: "0",
        padding: "11px 14px",
        border: "0",
        "border-bottom": "1px solid #d9dde3",
        background: "#f3f4f6",
        color: "#4b5563",
        "font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
        "font-size": "12px",
        "line-height": "1.55",
      });
      header.querySelectorAll<HTMLElement>("table").forEach((table) => {
        setImportantStyles(table, {
          width: "100%",
          "border-collapse": "collapse",
          color: "inherit",
          "font-family": "inherit",
          "font-size": "inherit",
          "line-height": "inherit",
        });
      });
      header.querySelectorAll<HTMLElement>("td, th").forEach((cell, index) => {
        setImportantStyles(cell, {
          padding: "3px 8px 3px 0",
          border: "0",
          "vertical-align": "top",
          "font-family": "inherit",
          "font-size": "inherit",
          "line-height": "inherit",
          "word-break": index % 2 === 0 ? "normal" : "break-word",
          "overflow-wrap": "anywhere",
        });
      });
    }

    const body = directCardPart(card, "pebble-history-quote__body")
      ?? card.querySelector<HTMLElement>(".pebble-history-quote__body");
    if (body) {
      setImportantStyles(body, {
        display: "block",
        "box-sizing": "border-box",
        width: "100%",
        margin: "0",
        padding: "14px 16px",
        border: "0",
        background: "#fff",
        color: "#24292f",
      });
    }

    card.querySelectorAll<HTMLElement>(".pebble-history-quote__separator").forEach((separator) => {
      setImportantStyles(separator, { display: "none" });
    });
    card.querySelectorAll<HTMLElement>(".pebble-history-quote .pebble-history-quote").forEach((nested) => {
      setImportantStyles(nested, { margin: "14px 0 0" });
    });
  });
}

function imageDimension(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  const match = normalized.match(/^(\d+(?:\.\d+)?)(px|%)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return `${match[1]}${match[2] ?? "px"}`;
}

function constrainEmailImages(container: ParentNode) {
  container.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const intendedWidth = imageDimension(img.getAttribute("width"));
    const intendedHeight = imageDimension(img.getAttribute("height"));

    setImportantStyles(img, {
      "max-width": "100%",
      "max-height": "min(70vh, 720px)",
      "object-fit": "contain",
    });

    if (intendedWidth) {
      img.style.setProperty("width", intendedWidth, "important");
      img.style.setProperty("height", "auto", "important");
    } else if (intendedHeight) {
      // Logo images frequently specify only a small height. Preserve it rather
      // than replacing it with auto and expanding the intrinsic bitmap to the
      // full reader width (for example Zoho's 48px mail logo).
      img.style.setProperty("width", "auto", "important");
      img.style.setProperty("height", intendedHeight, "important");
    } else {
      img.style.setProperty("width", "auto", "important");
      img.style.setProperty("height", "auto", "important");
    }
    img.setAttribute("data-yao-capped", "1");
  });
}

function declaredFixedWidth(element: HTMLElement): number | null {
  const attribute = element.getAttribute("width")?.trim();
  if (attribute && /^\d+(?:\.\d+)?$/.test(attribute)) return Number(attribute);
  const style = element.getAttribute("style") || "";
  const match = style.match(/(?:^|;)\s*width\s*:\s*(\d+(?:\.\d+)?)px\b/i);
  return match ? Number(match[1]) : null;
}

// Transactional senders commonly wrap a 600–760px email in a fixed-width
// shell. Keep the inner table's deliberate width, but let the outer shell use
// the reader width so the whole message is centered instead of appearing
// pushed to one side on a wide window.
function normalizeEmailShellLayout(container: HTMLElement) {
  const candidates = Array.from(container.querySelectorAll<HTMLElement>("[style], [width]"));
  for (const element of candidates) {
    const width = declaredFixedWidth(element);
    const parent = element.parentElement;
    const isContentShell = element.id.toLowerCase() === "content"
      || parent === container
      || parent?.id.toLowerCase() === "content";
    if (!width || width < 500 || !isContentShell || element.closest(".pebble-history-quote")) continue;
    setImportantStyles(element, {
      width: "100%",
      "max-width": "100%",
      "box-sizing": "border-box",
      "margin-left": "0",
      "margin-right": "0",
    });
  }
}

export function ShadowDomEmail({ html, className }: ShadowDomEmailProps) {
  const { t } = useTranslation();
  const [link, setLink] = useState<URL | null>(null);
  const opening = useRef(false);
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(false);

  const openLink = useCallback(async (destination: URL, mode: Exclude<EmailLinkMode, "ask">, rememberChoice = false) => {
    if (opening.current) return;
    opening.current = true;
    setBusy(true);
    try {
      await invoke(mode === "inApp" ? "open_mail_link_window" : "open_external_url", { url: destination.href });
      setLink(null);
      setRemember(false);
      if (rememberChoice) {
        try {
          saveEmailLinkMode(mode);
        } catch {
          useToastStore.getState().addToast({
            type: "error",
            message: t("emailLinks.saveFailed", "Could not save the link opening preference."),
          });
        }
      }
    } catch {
      setLink(destination);
      useToastStore.getState().addToast({
        type: "error",
        message: t("emailLinks.openFailed", "Could not open the link. Try the other option or check your browser."),
      });
    } finally {
      opening.current = false;
      setBusy(false);
    }
  }, [t]);
  const hostRef = useRef<HTMLDivElement>(null);

  // The shadow body must be ready before paint; otherwise the reader can flash
  // from the fallback text into the sanitized HTML a frame later.
  useLayoutEffect(() => {
    if (!hostRef.current) return;
    const shadow = hostRef.current.shadowRoot
      || hostRef.current.attachShadow({ mode: "open" });

    const safeHtml = sanitizeHtml(html);
    // Card the already-sanitized markup in a detached DOM before handing it to
    // the live Shadow DOM. WebView2 can repair malformed email tables while
    // assigning innerHTML; doing the structural move first keeps provider
    // markers and readable reply headers stable in production builds too.
    const preparedContent = document.createElement("div");
    preparedContent.innerHTML = safeHtml;
    decorateHistoricalQuoteCards(preparedContent);
    const preparedHtml = preparedContent.innerHTML;
    shadow.innerHTML = `
      <div class="pebble-email-content">${preparedHtml}</div>
      <!-- Keep reader-owned card rules after sender-authored style nodes. Email
           HTML commonly contains broad resets that otherwise erase the card UI. -->
      <style>
        :host {
          all: initial;
          display: block;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 14px;
          color: var(--color-text-primary);
          background: transparent;
          word-break: break-word;
        }
        img { max-width: 100% !important; height: auto !important; }
        a { color: var(--color-accent); }
        .pebble-email-content {
          box-sizing: border-box;
          max-width: 100%;
          overflow-x: auto;
          color: inherit;
          background: transparent;
        }
        :host-context([data-theme="dark"]) .pebble-email-content {
          display: inline-block;
          max-width: 100%;
          color-scheme: light;
          color: #202124;
          background: #fff;
        }
        pre {
          white-space: pre-wrap;
          overflow-x: auto;
          scrollbar-color: var(--color-scrollbar-thumb) transparent;
          scrollbar-width: thin;
        }
        pre::-webkit-scrollbar {
          width: 10px;
          height: 10px;
        }
        pre::-webkit-scrollbar-thumb {
          border: 3px solid transparent;
          border-radius: 999px;
          background-clip: content-box;
          background-color: var(--color-scrollbar-thumb);
        }
        pre:hover::-webkit-scrollbar-thumb {
          background-color: var(--color-scrollbar-thumb-hover);
        }
        table { border-collapse: collapse; }
        .pebble-email-content > table[height="100%"],
        .pebble-email-content > div[height="100%"],
        .pebble-email-content > center[height="100%"],
        .pebble-email-content > table[style*="height:100%" i],
        .pebble-email-content > table[style*="height: 100%" i],
        .pebble-email-content > table[style*="height:100vh" i],
        .pebble-email-content > table[style*="height: 100vh" i],
        .pebble-email-content > div[style*="height:100%" i],
        .pebble-email-content > div[style*="height: 100%" i],
        .pebble-email-content > div[style*="height:100vh" i],
        .pebble-email-content > div[style*="height: 100vh" i],
        .pebble-email-content > center[style*="height:100%" i],
        .pebble-email-content > center[style*="height: 100%" i],
        .pebble-email-content > center[style*="height:100vh" i],
        .pebble-email-content > center[style*="height: 100vh" i] {
          height: auto !important;
          min-height: 0 !important;
        }
        td, th { word-break: normal; overflow-wrap: normal; }
        body, div { word-wrap: break-word; overflow-wrap: break-word; }
        .blocked-image {
          display: inline-block;
          padding: 6px 12px;
          font-size: 12px;
          color: #888;
          background: #f5f5f5;
          border: 1px dashed #ccc;
          border-radius: 4px;
          text-align: center;
          max-width: 100%;
          box-sizing: border-box;
        }
        .pebble-history-quote {
          display: block !important;
          box-sizing: border-box !important;
          max-width: 100% !important;
          margin: 18px 0 0 !important;
          padding: 0 !important;
          overflow: hidden !important;
          border: 1px solid #d9dde3 !important;
          border-radius: 10px !important;
          background: #fff !important;
          color: #24292f !important;
          box-shadow: 0 1px 2px rgba(0,0,0,.03);
        }
        .pebble-history-quote__title {
          display: block !important;
          margin: 0 !important;
          padding: 9px 14px 0 !important;
          background: #f3f4f6 !important;
          color: #6b7280 !important;
          font-size: 12px !important;
          font-weight: 700 !important;
        }
        .pebble-history-quote__header {
          display: block !important;
          box-sizing: border-box !important;
          width: 100% !important;
          margin: 0 !important;
          padding: 11px 14px !important;
          border: 0 !important;
          border-bottom: 1px solid #d9dde3 !important;
          background: #f3f4f6 !important;
          color: #4b5563 !important;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif !important;
          font-size: 12px !important;
          line-height: 1.55 !important;
        }
        .pebble-history-quote__header table {
          width: 100% !important;
          color: inherit !important;
          font: inherit !important;
        }
        .pebble-history-quote__body {
          display: block !important;
          box-sizing: border-box !important;
          width: 100% !important;
          margin: 0 !important;
          padding: 14px 16px !important;
          border: 0 !important;
          background: #fff !important;
          color: #24292f !important;
        }
        .pebble-history-quote__separator { display: none !important; }
        .pebble-history-quote .pebble-history-quote {
          margin-top: 14px !important;
        }
      </style>
    `;

    // Apply the essential card presentation only after the final nodes are in
    // the live Shadow DOM. Production WebView2 may discard or decline to parse
    // styles that were serialized from a detached tree and then assigned via
    // innerHTML. Direct CSSOM writes on the live nodes are the same operation
    // that restored the cards during packaged-app diagnosis.
    const liveContent = shadow.querySelector<HTMLElement>(".pebble-email-content");
    if (liveContent) {
      applyHistoricalQuoteCardInlineStyles(liveContent);
      normalizeEmailShellLayout(liveContent);
      // Email HTML must not request its own WebView popup.
      liveContent.querySelectorAll("a[target]").forEach((anchor) => anchor.removeAttribute("target"));
      liveContent.scrollLeft = 0;
    }

    // Keep the sender-authored width for small signature logos while preventing
    // genuinely oversized images from overflowing the reader. Forcing
    // `width:auto !important` makes a 110px logo expand to its intrinsic bitmap
    // width, and a global max-height also distorts legitimate email content.
    constrainEmailImages(shadow);
  }, [html]);

  useLayoutEffect(() => {
    const shadow = hostRef.current?.shadowRoot;
    if (!shadow) return;

    const handleLink = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      const href = anchor?.getAttribute("href")?.trim();
      if (!href) return;
      if (event.type === "auxclick" && (event as MouseEvent).button !== 1) return;

      if (/^mailto:/i.test(href)) {
        if (event.type === "contextmenu") return;
        event.preventDefault();
        event.stopPropagation();
        void openMailtoUrl(href);
        return;
      }

      if (/^https?:/i.test(href) || href.startsWith("//")) {
        event.preventDefault();
        event.stopPropagation();
        if (opening.current) return;
        let destination: URL;
        try {
          destination = new URL(href.startsWith("//") ? `https:${href}` : href);
        } catch {
          // Malformed links must not fall back to WebView navigation.
          return;
        }
        const mode = event.type === "contextmenu" ? "ask" : readEmailLinkMode();
        setRemember(false);
        if (mode === "ask") {
          setLink(destination);
        } else {
          void openLink(destination, mode);
        }
        return;
      }

      // Relative URLs have no sender website as a base. Keep them from
      // navigating to the application's own origin.
      if (!href.startsWith("#")) {
        event.preventDefault();
      }
    };

    const linkEvents = ["click", "auxclick", "contextmenu"] as const;
    for (const name of linkEvents) shadow.addEventListener(name, handleLink, true);
    return () => {
      for (const name of linkEvents) shadow.removeEventListener(name, handleLink, true);
    };
  }, [openLink]);

  return <>
    <div ref={hostRef} className={className} />
    {link && createPortal(<ConfirmDialog
      title={t("emailLinks.title", "Open email link")}
      message={t("emailLinks.destination", "Destination: {{host}}", { host: link.host })}
      confirmLabel={t("emailLinks.browser", "Open in default browser")}
      alternateLabel={t("emailLinks.inApp", "Open in YaoAIMail")}
      busyLabel={t("emailLinks.opening", "Opening…")}
      busy={busy}
      onConfirm={() => void openLink(link, "browser", remember)}
      onAlternate={() => void openLink(link, "inApp", remember)}
      onCancel={() => { if (!opening.current) setLink(null); }}
    >
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <input type="checkbox" checked={remember} disabled={busy} onChange={(event) => setRemember(event.target.checked)} />
        {t("emailLinks.remember", "Remember my choice")}
      </label>
    </ConfirmDialog>, document.body)}
  </>;
}
