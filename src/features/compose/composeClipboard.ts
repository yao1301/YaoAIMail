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

/**
 * WPS puts a styled HTML table on the Windows clipboard but, unlike Excel,
 * usually provides no bitmap preview. Render that original HTML to one PNG so
 * Tiptap cannot strip its cell colours, borders, fonts, widths, or alignment.
 */
export async function renderSpreadsheetHtmlToPng(html: string): Promise<string | null> {
  const content = spreadsheetFragment(html);
  if (!content || typeof document === "undefined") return null;

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = [
    "position:fixed", "left:-100000px", "top:0", "z-index:-1", "pointer-events:none",
    "width:max-content", "max-width:none", "background:#fff", "color:#000", "padding:2px",
  ].join(";");
  const style = document.createElement("style");
  style.textContent = `${content.styles}\n[data-spreadsheet-preview] { display:inline-block; background:#fff; }`;
  const preview = document.createElement("div");
  preview.dataset.spreadsheetPreview = "true";
  preview.innerHTML = content.fragment;
  host.append(style, preview);
  document.body.appendChild(host);

  try {
    await document.fonts?.ready;
    const bounds = preview.getBoundingClientRect();
    const naturalWidth = Math.max(1, Math.ceil(Math.max(bounds.width, preview.scrollWidth)));
    const naturalHeight = Math.max(1, Math.ceil(Math.max(bounds.height, preview.scrollHeight)));
    const maxWidth = 2400;
    const maxHeight = 5000;
    const maxPixels = 8_000_000;
    const scale = Math.min(1, maxWidth / naturalWidth, maxHeight / naturalHeight, Math.sqrt(maxPixels / (naturalWidth * naturalHeight)));
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));
    const serialized = new XMLSerializer().serializeToString(preview);
    const safeStyles = content.styles.replace(/<\/style/gi, "<\\/style");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${naturalWidth} ${naturalHeight}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="display:inline-block;background:#fff;color:#000;padding:2px"><style>${safeStyles}</style>${serialized}</div></foreignObject></svg>`;
    // The desktop WebView deliberately blocks blob: images in its CSP. Using a
    // blob URL here made WPS paste fail and silently fall back to Tiptap's
    // simplified table. data: is already allowed for composed inline images.
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Unable to render spreadsheet clipboard HTML"));
      img.src = svgUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/png");
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
