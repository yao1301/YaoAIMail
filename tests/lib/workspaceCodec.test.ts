import { expect, it } from 'vitest';
import { decodeWorkspaceValue, encodeWorkspaceValue } from '@/lib/workspaceCodec';
it('round-trips selected sets, dates, Unicode HTML, undefined and file bytes', async () => {
  const file = new File([new Uint8Array([0, 1, 255])], 'reference.pdf', { type: 'application/pdf', lastModified: 12345 });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([0, 1, 255]).buffer });
  const data = { body: '<table><tr><td>中文</td></tr></table>', selected: new Set(['a','b']), files: [file], absent: undefined, date: new Date('2026-01-01'), map: new Map([['a', 1]]) };
  const encoded = JSON.parse(JSON.stringify(await encodeWorkspaceValue(data)));
  const result = decodeWorkspaceValue(encoded) as typeof data;
  expect(result.body).toBe(data.body); expect(result.selected).toEqual(data.selected); expect(result.map).toEqual(data.map);
  expect(result).toHaveProperty('absent', undefined); expect(result.date).toEqual(data.date);
  expect(result.files[0].name).toBe(file.name); expect(result.files[0].size).toBe(3); expect(result.files[0].lastModified).toBe(12345);
});
it('rejects cycles and callbacks rather than silently deleting page state', async () => {
  const data: Record<string, unknown> = {}; data.self = data;
  await expect(encodeWorkspaceValue(data)).rejects.toThrow('循环引用');
  await expect(encodeWorkspaceValue({ callback: () => {} })).rejects.toThrow('无法交接');
});
it('keeps large JSON report history compact while preserving special siblings', async () => {
  const history = Array.from({ length: 2000 }, (_, i) => ({ id: i, company: `Company ${i}`, report: 'Evidence '.repeat(20), emails: ['contact@example.com'] }));
  const encoded = await encodeWorkspaceValue({ history, selected: new Set([3]) });
  const wire = JSON.stringify(encoded);
  expect(wire.length).toBeLessThan(JSON.stringify(history).length * 1.01);
  expect(decodeWorkspaceValue(JSON.parse(wire))).toEqual({ history, selected: new Set([3]) });
});
