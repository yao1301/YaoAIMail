import { sanitizeHtml } from "./sanitizeHtml";

/** Decode legacy escaped documents without treating ordinary plain text as HTML. */
export function extractComposeBodyHtml(html: string): string {
  const source = html.trim();
  const doc = new DOMParser().parseFromString(source, "text/html");
  let body = doc.body.innerHTML;
  const decoded = doc.body.textContent?.trim() ?? "";
  if (/^\s*(?:&lt;|&#0*60;|&#x0*3c;)\s*\/?[a-z][\w:-]*(?:\s|\/?(?:&gt;|&#0*62;|&#x0*3e;))/i.test(source)
    && /<\s*\/?[a-z][\w:-]*(?:\s|\/?>)/i.test(decoded)) {
    body = new DOMParser().parseFromString(decoded, "text/html").body.innerHTML;
  }
  return sanitizeHtml(body);
}
