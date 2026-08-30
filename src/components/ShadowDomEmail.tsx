import { useRef, useLayoutEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openMailtoUrl } from "@/app/useMailtoOpen";
import { sanitizeHtml } from "@/lib/sanitizeHtml";
import { decorateHistoricalQuoteCards } from "@/lib/historicalQuoteCards";

interface ShadowDomEmailProps {
  html: string;
  className?: string;
}

export function ShadowDomEmail({ html, className }: ShadowDomEmailProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  // The shadow body must be ready before paint; otherwise the reader can flash
  // from the fallback text into the sanitized HTML a frame later.
  useLayoutEffect(() => {
    if (!hostRef.current) return;
    const shadow = hostRef.current.shadowRoot
      || hostRef.current.attachShadow({ mode: "open" });

    const safeHtml = sanitizeHtml(html);
    shadow.innerHTML = `
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
      <div class="pebble-email-content">${safeHtml}</div>
    `;
    decorateHistoricalQuoteCards(shadow.querySelector(".pebble-email-content")!);

    // Keep the sender-authored width for small signature logos while preventing
    // genuinely oversized images from overflowing the reader. Forcing
    // `width:auto !important` makes a 110px logo expand to its intrinsic bitmap
    // width, and a global max-height also distorts legitimate email content.
    shadow.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
      img.style.setProperty("max-width", "100%", "important");
      img.style.setProperty("height", "auto", "important");
      img.setAttribute("data-yao-capped", "1");
    });

    const handleClick = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      const href = anchor?.getAttribute("href")?.trim();
      if (!href) return;

      if (/^mailto:/i.test(href)) {
        event.preventDefault();
        void openMailtoUrl(href);
        return;
      }

      if (/^https?:\/\//i.test(href)) {
        event.preventDefault();
        void invoke("open_external_url", { url: href })
          .catch((err) => console.warn("Failed to open email body link", err));
      }
    };

    shadow.addEventListener("click", handleClick);
    return () => {
      shadow.removeEventListener("click", handleClick);
    };
  }, [html]);

  return <div ref={hostRef} className={className} />;
}
