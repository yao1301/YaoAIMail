import type { Message } from "@/lib/api";
import type { MailReference } from "@/lib/mailReferenceDrag";
import { readReplyDraftText } from "./documentDraft";

/** Explicit references are evidence, not a reply target or outgoing attachments. */
export function readMailReferenceContext(references: MailReference[], messages: Message[]): string {
  const sections = references.map(reference => {
    const message = messages.find(item => item.id === reference.id);
    if (!message || message.is_deleted) throw new Error(`参考邮件“${reference.title}”已不存在，请移除或重新添加。`);
    const body = readReplyDraftText(message);
    return `【用户添加的参考邮件】\n主题：${message.subject}\n发件人：${message.from_name || ""} <${message.from_address}>\n收件人：${message.to_list.map(item => item.address).join(", ")}\n日期（Unix 秒）：${message.date}\n正文：\n${body}`;
  });
  const text = sections.join("\n\n");
  if (text.length > 60_000) throw new Error("参考邮件合计超过 60000 字符，请减少选择；没有截断后继续生成。");
  return text;
}
