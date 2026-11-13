function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function plainTextToHtml(value: string) {
  return escapeHtml(value).replace(/\r?\n/g, "<br/>");
}

function bodyToHtml(value: string) {
  return value.trim().split(/\n{2,}/).map((paragraph) => `<p>${plainTextToHtml(paragraph)}</p>`).join("");
}

/** AI 草稿使用保存的签名原文，不套用默认签名的颜色、字号或分隔线。 */
export function appendExactAiSignatureHtml(body: string, signature?: string) {
  const bodyHtml = bodyToHtml(body);
  const savedSignature = signature ?? "";
  if (!savedSignature.trim()) return bodyHtml;
  const signatureHtml = /<[a-z][\s\S]*>/i.test(savedSignature)
    ? savedSignature
    : plainTextToHtml(savedSignature);
  return `${bodyHtml}<br/><br/>${signatureHtml}`;
}

/** 保留写信编辑器已经生成的默认签名块（包含用户原签名和默认样式）。 */
export function appendDefaultSignatureHtml(body: string, signatureHtml: string) {
  return `${markdownToHtml(body)}${signatureHtml}`;
}

export function appendExactAiSignatureText(body: string, signature?: string) {
  const savedSignature = signature ?? "";
  const cleanBody = formatProfileText(body);
  return savedSignature.trim() ? `${cleanBody}\n\n${savedSignature}` : cleanBody;
}
import { markdownToHtml } from "@/lib/renderMarkdown";
import { formatProfileText } from "@/lib/profileText";
