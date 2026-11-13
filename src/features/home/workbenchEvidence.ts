import { getMessagesBatch, listKnowledgeItems, type ChatTurn } from '@/lib/api';
import type { WorkbenchEvidence, WorkbenchReference } from './workbenchSession';

export function uniqueReferences(references: WorkbenchReference[]) {
  return [...new Map(references.map(reference => [`${reference.kind}:${reference.id}`, reference])).values()];
}
export function citedMailReference(href: string, references: WorkbenchReference[]): WorkbenchReference | null {
  if (!href.startsWith('#mail:')) return null;
  try {
    const id = decodeURIComponent(href.slice(6));
    return references.find(reference => reference.kind === 'mail' && reference.id === id) ?? null;
  } catch { return null; }
}
export function mailText(body: string, html: string, snippet: string): string {
  if (body.trim()) return body;
  if (html.trim()) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,noscript').forEach(node => node.remove());
    doc.querySelectorAll('br,p,div,tr,li,blockquote').forEach(node => node.append('\n'));
    return doc.body.textContent?.trim() || snippet;
  }
  return snippet;
}
export async function readExplicitEvidence(evidence: WorkbenchEvidence[], accountId: string | null) {
  const sections: string[] = []; const references: WorkbenchReference[] = [];
  const mailIds = evidence.filter(item => item.kind === 'mail').map(item => item.id);
  const messages = mailIds.length ? await getMessagesBatch(mailIds) : [];
  for (const item of evidence) {
    if (item.kind === 'file') { sections.push(`【显式文件：${item.title}】\n${item.text}`); continue; }
    const message = messages.find(mail => mail.id === item.id);
    if (!message) { sections.push(`【显式邮件：${item.title}】读取不到原信，不得猜测。`); continue; }
    references.push({ kind: 'mail', id: message.id, accountId: message.account_id, label: message.subject || item.title, subtitle: '用户明确提供的邮件' });
    const text = mailText(message.body_text, message.body_html_raw, message.snippet);
    sections.push(`【显式邮件 ${message.id}：${message.subject || item.title}】\n${message.account_id !== accountId ? '注意：这是用户明确提供的跨账户邮件，仅本对话引用。\n' : ''}发件人：${message.from_name} <${message.from_address}>\n收件人：${message.to_list?.map(address => address.address).join(', ') || ''}\n日期：${new Date(message.date * 1000).toLocaleString()}\n${message.remote_version === 'headers-only' ? '正文尚未下载，仅有列表摘要，不能据此完成完整分析。\n' : ''}${text || '没有可用正文，不能猜测。'}`);
  }
  return { sections, references };
}
export async function readSelectedKnowledge(ids: string[], accountId: string | null) {
  const sections: string[] = []; const references: WorkbenchReference[] = [];
  if (!ids.length) return { sections, references };
  const items = await listKnowledgeItems(accountId);
  for (const id of ids) {
    const item = items.find(entry => entry.id === id);
    if (!item) { sections.push(`【显式资料 ${id}】当前账户范围读取不到该资料，不得猜测。`); continue; }
    references.push({ kind: 'knowledge', id, label: item.name, subtitle: '本对话明确选择的资料', locator: '资料中心' });
    sections.push(`【显式资料：${item.name}】\n${item.content || '没有可读取的内容。'}`);
  }
  return { sections, references };
}
// Bound all sources together; retain every explicit item's identity, and make
// partial reads visible rather than silently claiming the whole file was read.
export function packEvidence(explicit: string[], automatic: string, max = 22_000): string {
  const parts: string[] = []; let remaining = max;
  const share = Math.max(100, Math.floor((max - 500) / Math.max(1, explicit.length)));
  for (const text of explicit) {
    const limit = Math.min(share, remaining);
    const part = text.length > limit ? `${text.slice(0, Math.max(0, limit - 60))}\n[此资料只读取了部分内容，不能声称全文分析完成]` : text;
    parts.push(part); remaining -= part.length + 2;
  }
  if (automatic && remaining > 120) parts.push(automatic.length > remaining ? `${automatic.slice(0, remaining - 60)}\n[自动检索上下文被截断，覆盖范围有限]` : automatic);
  return parts.join('\n\n') || '本任务没有提供本地证据；不要编造用户的邮件、客户或文件事实。';
}
export function boundedHistory(turns: ChatTurn[], max = 10_000): ChatTurn[] {
  const selected: ChatTurn[] = []; let remaining = max;
  for (const turn of [...turns].reverse()) {
    if (remaining < 100) break;
    const content = turn.content.length > remaining ? `${turn.content.slice(0, remaining - 30)}\n[较早对话节选]` : turn.content;
    selected.unshift({ role: turn.role, content }); remaining -= content.length;
  }
  return selected;
}
