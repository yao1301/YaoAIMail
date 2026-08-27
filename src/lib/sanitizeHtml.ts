import DOMPurify from "dompurify";

const SAFE_STYLE_PROPERTIES = new Set([
  "background",
  "background-color",
  "border",
  "border-bottom",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "border-collapse",
  "border-color",
  "border-left",
  "border-radius",
  "border-right",
  "border-spacing",
  "border-style",
  "border-top",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-width",
  "color",
  "display",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "height",
  "line-height",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-height",
  "max-width",
  "min-height",
  "min-width",
  "opacity",
  "overflow",
  "overflow-x",
  "overflow-y",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "text-align",
  "text-decoration",
  "vertical-align",
  "visibility",
  "white-space",
  "width",
]);

function isSafeBackgroundShorthandValue(value: string): boolean {
  const normalized = value
    .trim()
    .replace(/\s*!important\s*$/i, "")
    .trim()
    .toLowerCase();

  if (!normalized) return false;
  if (
    /(url\s*\(|image-set\s*\(|-webkit-image-set\s*\(|cross-fade\s*\(|element\s*\(|paint\s*\(|expression\s*\(|javascript:|vbscript:|data:|@import|\\)/i.test(
      normalized,
    )
  ) {
    return false;
  }
  if (["none", "transparent", "currentcolor"].includes(normalized)) return true;
  if (/^#[0-9a-f]{3,8}$/i.test(normalized)) return true;
  if (/^(rgb|rgba|hsl|hsla)\([\d\s.,%/+-]+\)$/i.test(normalized)) return true;
  return /^[a-z]+$/.test(normalized);
}

function filterStyleAttribute(style: string): string {
  return style
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const [rawName, ...rawValue] = part.split(":");
      const name = rawName.trim().toLowerCase();
      const value = rawValue.join(":").trim().toLowerCase();
      if (!SAFE_STYLE_PROPERTIES.has(name) || !value) return false;
      if (name === "background") return isSafeBackgroundShorthandValue(value);
      if (value.includes("\\")) return false;
      return !/(url\s*\(|expression\s*\(|javascript:|vbscript:|data:|@import)/i.test(value);
    })
    .join("; ");
}

function filterInlineStyles(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    const filtered = filterStyleAttribute(element.getAttribute("style") ?? "");
    if (filtered) {
      element.setAttribute("style", filtered);
    } else {
      element.removeAttribute("style");
    }
  });
  return template.innerHTML;
}

interface SafeImageDimensions {
  width?: string;
  height?: string;
}

function safeImageDimension(value: string | null): string | undefined {
  const normalized = value?.trim().replace(/\s*!important\s*$/i, "").trim().toLowerCase();
  if (!normalized) return undefined;
  // Email clients commonly serialize signature sizes as decimal pixels. Keep
  // only plain non-negative lengths so this restoration cannot carry CSS
  // functions, URLs, escapes, or other executable syntax through sanitizing.
  const match = normalized.match(/^(\d+(?:\.\d+)?)(px|%)?$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  return `${match[1]}${match[2] ?? "px"}`;
}

function imageStyleDimension(style: string | null, property: "width" | "height") {
  let result: string | undefined;
  for (const declaration of (style ?? "").split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const name = declaration.slice(0, colon).trim().toLowerCase();
    if (name !== property) continue;
    const safe = safeImageDimension(declaration.slice(colon + 1));
    if (safe) result = safe;
  }
  return result;
}

function dimensionAttributeValue(value: string): string {
  return value.endsWith("px") ? value.slice(0, -2) : value;
}

function collectImageDimensions(html: string): SafeImageDimensions[] {
  const template = document.createElement("template");
  template.innerHTML = html;
  return Array.from(template.content.querySelectorAll<HTMLImageElement>("img"), (image) => ({
    // Production WebView can retain getAttribute("style") while exposing an
    // empty CSSStyleDeclaration for detached template images. Parse the raw
    // declaration text instead of relying on image.style.width/height.
    width: imageStyleDimension(image.getAttribute("style"), "width")
      ?? safeImageDimension(image.getAttribute("width")),
    height: imageStyleDimension(image.getAttribute("style"), "height")
      ?? safeImageDimension(image.getAttribute("height")),
  }));
}

function restoreImageDimensions(
  html: string,
  dimensions: SafeImageDimensions[],
): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll<HTMLImageElement>("img").forEach((image, index) => {
    const original = dimensions[index];
    if (!original) return;
    // Standard attributes survive repeated DOMPurify passes and continue to
    // work when production WebView refuses to parse the detached inline style.
    if (original.width) image.setAttribute("width", dimensionAttributeValue(original.width));
    if (original.height) image.setAttribute("height", dimensionAttributeValue(original.height));
  });
  return template.innerHTML;
}

function normalizeLinkAttributes(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
    const href = anchor.getAttribute("href")?.trim() ?? "";
    if (/^(https?:|mailto:)/i.test(href)) {
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer");
    } else {
      anchor.removeAttribute("target");
      anchor.removeAttribute("rel");
    }
  });
  return template.innerHTML;
}

function filterStylesheetLinks(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll<HTMLLinkElement>("link").forEach((link) => {
    const rel = link.getAttribute("rel")?.toLowerCase() ?? "";
    const href = link.getAttribute("href")?.trim() ?? "";
    const isStylesheet = rel.split(/\s+/).includes("stylesheet");
    const isHttp = /^https?:\/\//i.test(href);
    if (!isStylesheet || !isHttp) {
      link.remove();
    }
  });
  return template.innerHTML;
}

function looksLikeFullHtmlDocument(html: string): boolean {
  return /<\s*(html|head|body)\b/i.test(html);
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function extractApprovedCssNodes(html: string): { cssNodes: string; htmlWithoutCssNodes: string } {
  if (looksLikeFullHtmlDocument(html)) {
    return { cssNodes: "", htmlWithoutCssNodes: html };
  }

  const template = document.createElement("template");
  template.innerHTML = html;
  const cssNodes: string[] = [];

  template.content.querySelectorAll<HTMLStyleElement>("style").forEach((style) => {
    cssNodes.push(`<style>${style.textContent ?? ""}</style>`);
    style.remove();
  });

  template.content.querySelectorAll<HTMLLinkElement>("link").forEach((link) => {
    const rel = link.getAttribute("rel")?.toLowerCase() ?? "";
    const href = link.getAttribute("href")?.trim() ?? "";
    const isStylesheet = rel.split(/\s+/).includes("stylesheet");
    const isHttp = /^https?:\/\//i.test(href);
    if (isStylesheet && isHttp) {
      const type = link.getAttribute("type")?.trim();
      const media = link.getAttribute("media")?.trim();
      cssNodes.push(
        `<link rel="stylesheet" href="${escapeAttribute(href)}"` +
          (type ? ` type="${escapeAttribute(type)}"` : "") +
          (media ? ` media="${escapeAttribute(media)}"` : "") +
          ">",
      );
    }
    link.remove();
  });

  return {
    cssNodes: cssNodes.join(""),
    htmlWithoutCssNodes: template.innerHTML,
  };
}

/** Sanitize HTML to prevent XSS while preserving email formatting. */
export function sanitizeHtml(html: string): string {
  const imageDimensions = collectImageDimensions(html);
  const { cssNodes, htmlWithoutCssNodes } = extractApprovedCssNodes(html);
  const sanitized = DOMPurify.sanitize(htmlWithoutCssNodes, {
    ALLOWED_TAGS: [
      "a", "abbr", "address", "article", "b", "bdi", "bdo", "blockquote",
      "br", "caption", "center", "cite", "code", "col", "colgroup", "dd", "del",
      "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure",
      "font", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i",
      "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre",
      "q", "rp", "rt", "ruby", "s", "samp", "section", "small", "span",
      "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot",
      "th", "thead", "time", "tr", "u", "ul", "var", "wbr",
    ],
    ALLOWED_ATTR: [
      "href", "src", "alt", "title", "width", "height", "class",
      "target", "rel",
      "dir", "id", "lang", "colspan", "rowspan", "border", "cellpadding",
      "cellspacing", "align", "valign", "bgcolor", "color", "face", "size",
      "style",
    ],
    ALLOW_DATA_ATTR: false,
  });
  const filtered = normalizeLinkAttributes(filterStylesheetLinks(filterInlineStyles(sanitized)));
  return cssNodes + restoreImageDimensions(filtered, imageDimensions);
}
