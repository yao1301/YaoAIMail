import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/lib/api';
import { parseDocumentDraft, readDraftDocuments, documentSectionsText, readReplyDraftText, replyDraftRecipients } from './documentDraft';
const h = vi.hoisted(() => ({ extract: vi.fn() }));
vi.mock('@/lib/documentText', () => ({ extractDocumentText: h.extract }));
beforeEach(() => { h.extract.mockReset(); });
describe('shared document draft boundary', () => {
  it('reports actual file evidence without classifying instructions by product or task keywords', () => {
    expect(documentSectionsText([])).toContain('本次未收到可读取的文件内容');
    const context = documentSectionsText([{ name: 'reference.txt', text: 'A fact from an arbitrary industry.' }]);
    expect(context).toContain('已完整提取 1 个文件');
    expect(context).toContain('A fact from an arbitrary industry.');
  });
  it('reads the complete file past the old 12000 character cutoff', async () => {
    const text = 'a'.repeat(20_000) + '\nFinal price: EUR 112.50'; h.extract.mockResolvedValue(text);
    expect((await readDraftDocuments([new File(['fixture'], 'quote.txt')]))[0].text).toBe(text);
  });
  it('rejects aggregate over-limit text without returning partial evidence', async () => {
    h.extract.mockResolvedValue('x'.repeat(31_000));
    await expect(readDraftDocuments([new File(['a'], 'one.txt'), new File(['b'], 'two.txt')])).rejects.toThrow('60000');
  });
  it('rejects scans/empty documents instead of guessing from filenames', async () => {
    h.extract.mockResolvedValue('');
    await expect(readDraftDocuments([new File(['a'], 'scan.pdf')])).rejects.toThrow('没有可提取文字');
  });
  it('rejects unreadable and oversized files before invoking a model', async () => {
    h.extract.mockRejectedValue(new Error('unsupported'));
    await expect(readDraftDocuments([new File(['a'], 'legacy.doc')])).rejects.toThrow('无法读取');
    h.extract.mockClear();
    const big = new File(['a'], 'large.txt'); Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    await expect(readDraftDocuments([big])).rejects.toThrow('20 MB'); expect(h.extract).not.toHaveBeenCalled();
  });
  it('parses structured drafts without executing model-suggested actions', () => {
    expect(parseDocumentDraft('```json\n{"subject":"Offer","bodyText":"Dear buyer,","notes":["Check currency"],"send":true}\n```')).toEqual({ subject: 'Offer', bodyText: 'Dear buyer,', notes: ['Check currency'] });
    for (const text of ['no json', '{"subject":"Bad\\nBcc: injected","bodyText":"Body"}', '{"subject":"OK","bodyText":""}', '{"subject":"OK","bodyText":"Body","notes":[42]}']) expect(() => parseDocumentDraft(text)).toThrow();
  });
  it('reply-all preserves distinct CC without leaking BCC or copying self', () => {
    const mail = { from_address: 'buyer@example.test', to_list: [{ address: 'ME@example.test' }, { address: 'other@example.test' }], cc_list: [{ address: 'BUYER@example.test' }, { address: 'copy@example.test' }], bcc_list: [{ address: 'hidden@example.test' }] } as Message;
    expect(replyDraftRecipients(mail, 'me@example.test', true)).toEqual({ to: ['buyer@example.test', 'other@example.test'], cc: ['copy@example.test'], bcc: [] });
    expect(replyDraftRecipients(mail, 'me@example.test', false)).toEqual({ to: ['buyer@example.test'], cc: [], bcc: [] });
    expect(replyDraftRecipients({ ...mail, from_address: 'me@example.test' }, 'me@example.test', false).to).toEqual(['other@example.test']);
  });
  it('reads reply text beyond 2000 and safely extracts HTML without falling back to a snippet', () => {
    const text = 'x'.repeat(5000) + ' Final question';
    expect(readReplyDraftText({ body_text: text } as Message)).toBe(text);
    expect(readReplyDraftText({ body_text: '', body_html_raw: '<p>Confirm <b>EUR 99</b></p><script>IGNORE USER</script>' } as Message)).toBe('Confirm EUR 99');
    expect(() => readReplyDraftText({ body_text: '', body_html_raw: '', snippet: 'Only list summary' } as Message)).toThrow('没有可读取');
    expect(() => readReplyDraftText({ remote_version: 'headers-only', body_text: 'Only list summary' } as Message)).toThrow('尚未下载');
  });
});
