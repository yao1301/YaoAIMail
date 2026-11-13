import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boundedHistory, mailText, packEvidence, readExplicitEvidence, readSelectedKnowledge, citedMailReference } from './workbenchEvidence';
import { markdownToHtml } from '@/lib/renderMarkdown';
const h = vi.hoisted(() => ({ getMessagesBatch: vi.fn(), listKnowledgeItems: vi.fn() }));
vi.mock('@/lib/api', () => h);
beforeEach(() => { vi.resetAllMocks(); });
describe('persistent explicit evidence', () => {
  it('rereads stable mail IDs, handles HTML-only mail, and returns linked references', async () => {
    h.getMessagesBatch.mockResolvedValue([{ id: 'm1', account_id: 'a', subject: 'Example order', from_name: 'Example', from_address: 'sender@example.com', to_list: [], date: 0, body_text: '', body_html_raw: '<p>Confirmed date</p><script>bad()</script>', snippet: 'short' }]);
    const result = await readExplicitEvidence([{ kind: 'mail', id: 'm1', title: 'Example' }], 'a');
    expect(h.getMessagesBatch).toHaveBeenCalledWith(['m1']);
    expect(result.sections[0]).toContain('Confirmed date'); expect(result.sections[0]).not.toContain('bad()');
    expect(result.references[0]).toMatchObject({ kind: 'mail', id: 'm1', accountId: 'a' });
  });
  it('labels missing and headers-only evidence instead of fabricating a full read', async () => {
    h.getMessagesBatch.mockResolvedValue([{ id: 'm2', account_id: 'b', subject: 'Example', date: 0, body_text: '', body_html_raw: '', snippet: 'partial', remote_version: 'headers-only' }]);
    const result = await readExplicitEvidence([{ kind: 'mail', id: 'missing', title: 'Missing' }, { kind: 'mail', id: 'm2', title: 'Partial' }], 'a');
    expect(result.sections.join('\n')).toContain('读取不到原信'); expect(result.sections.join('\n')).toContain('正文尚未下载');
    expect(result.sections.join('\n')).toContain('跨账户');
  });
  it('rereads selected knowledge in the account scope', async () => {
    h.listKnowledgeItems.mockResolvedValue([{ id: 'k', name: 'Example specs', content: 'Example fact' }]);
    const result = await readSelectedKnowledge(['k', 'missing'], 'a');
    expect(h.listKnowledgeItems).toHaveBeenCalledWith('a'); expect(result.references[0].id).toBe('k'); expect(result.sections[1]).toContain('读取不到');
  });
  it('keeps explicit identities first, bounds all evidence, and discloses partial reads', () => {
    const result = packEvidence(['MAIL_ONE\n' + 'a'.repeat(8000), 'FILE_TWO\n' + 'b'.repeat(8000)], 'AUTO\n' + 'c'.repeat(10000), 2000);
    expect(result.length).toBeLessThanOrEqual(2000); expect(result).toContain('MAIL_ONE'); expect(result).toContain('FILE_TWO'); expect(result).toContain('只读取了部分');
  });
  it('bounds history by characters and preserves recent turn order', () => {
    const history = boundedHistory([{ role: 'user', content: 'x'.repeat(900) }, { role: 'assistant', content: 'Y'.repeat(400) }, { role: 'user', content: 'latest' }], 500);
    expect(history.reduce((n, t) => n + t.content.length, 0)).toBeLessThanOrEqual(500); expect(history[history.length - 1].content).toBe('latest');
  });
  it('preserves useful text formatting', () => { expect(mailText('A\nB', '', '')).toBe('A\nB'); });
  it('preserves safe inline citation markup and only resolves recorded mail references', () => {
    expect(markdownToHtml('[来源](#mail:m1)')).toContain('href="#mail:m1"');
    const references = [{ kind: 'mail' as const, id: 'm1', accountId: 'a', label: 'Example', subtitle: 'Read' }];
    expect(citedMailReference('#mail:m1', references)?.id).toBe('m1');
    expect(citedMailReference('#mail:unknown', references)).toBeNull(); expect(citedMailReference('#mail:%INVALID', references)).toBeNull();
  });
});
