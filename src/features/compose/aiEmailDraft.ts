export interface NormalizedAiEmailDraft {
  body: string;
  subject?: string;
}

/**
 * AI 有时会把 Subject/主题一起返回。只识别正文最前面的标题行，避免
 * 误删正文中正常出现的“主题”一词。
 */
export function normalizeAiEmailDraft(raw: string, isReply: boolean): NormalizedAiEmailDraft {
  let text = raw.trim().replace(/^```(?:text|markdown)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const lines = text.split(/\r?\n/);
  const first = lines[0]?.trim() ?? "";
  const match = first.match(/^(?:\*{0,2}|_{0,2})(?:subject|主题|标题|邮件主题)\s*[:：]\s*(.+?)(?:\*{0,2}|_{0,2})$/i);
  if (!match) return { body: text };

  const subject = match[1].trim();
  const body = lines.slice(1).join("\n").replace(/^\s*\n+/, "").trim();
  return isReply ? { body } : { body, subject: subject || undefined };
}
