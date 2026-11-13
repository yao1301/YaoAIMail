import { expect, it } from 'vitest';
import type { Message } from '../../../src/lib/api';
import { readMailReferenceContext } from '../../../src/features/compose/mailReferenceContext';

const references = [{ id: 'm1', title: 'Facts' }];
const mail = { id: 'm1', subject: 'Facts', from_name: 'Buyer', from_address: 'buyer@example.test',
  to_list: [], date: 0, is_deleted: false, remote_version: null, body_text: '',
  body_html_raw: '<p>Line one</p><table><tr><td>EUR 125.50</td></tr></table>',
} as unknown as Message;

it('reads HTML-only mail, removes script/style and retains the table facts', () => {
  const text = readMailReferenceContext(references, [{ ...mail, body_html_raw: mail.body_html_raw + '<script>private_script()</script><style>.hidden{}</style>' }]);
  expect(text).toContain('EUR 125.50');
  expect(text).not.toContain('private_script');
  expect(text).not.toContain('.hidden');
});
it('rejects header-only, deleted, missing and oversized references instead of substituting snippets', () => {
  expect(() => readMailReferenceContext(references, [{ ...mail, remote_version: 'headers-only' }])).toThrow('尚未下载');
  expect(() => readMailReferenceContext(references, [{ ...mail, is_deleted: true }])).toThrow('已不存在');
  expect(() => readMailReferenceContext(references, [])).toThrow('已不存在');
  expect(() => readMailReferenceContext(references, [{ ...mail, body_text: 'x'.repeat(60001) }])).toThrow('60000');
  expect(() => readMailReferenceContext([...references, { id: 'm2', title: 'More' }], [
    { ...mail, body_text: 'a'.repeat(31000) }, { ...mail, id: 'm2', body_text: 'b'.repeat(31000) },
  ])).toThrow('合计超过');
});
