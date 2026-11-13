import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { filesFromTransfer, useAiFileContext } from '../../src/hooks/useAiFileContext';
const h = vi.hoisted(() => ({ extract: vi.fn(), attachment: vi.fn() }));
vi.mock('../../src/lib/documentText', () => ({ extractDocumentText: h.extract }));
vi.mock('../../src/lib/api', () => ({ readAttachmentFile: h.attachment }));
beforeEach(() => { vi.resetAllMocks(); h.extract.mockImplementation(async (file: File) => `CONTENT_FROM_${file.name}`); });

describe('shared file ingestion for all AI inputs', () => {
  it('reads every accepted file independently of its subject or user task', async () => {
    const { result } = renderHook(() => useAiFileContext('scope'));
    const files = ['inventory.txt', 'material.docx', 'spec.xlsx', 'statement.pdf', 'records.csv'].map(name => new File(['bytes'], name));
    act(() => result.current.add(files));
    let sections: { name: string; text: string }[] = [];
    await act(async () => { sections = await result.current.read(); });
    expect(sections.map(item => item.text)).toEqual(files.map(file => `CONTENT_FROM_${file.name}`));
    expect(h.extract).toHaveBeenCalledTimes(5);
    expect(result.current.status).toBe('已读取 5 个文件');
  });
  it('does not silently keep only the first twelve files', async () => {
    const { result } = renderHook(() => useAiFileContext('scope'));
    act(() => result.current.add(Array.from({ length: 13 }, (_, index) => new File(['x'], `${index}.txt`))));
    expect(result.current.files).toHaveLength(0);
    await expect(result.current.read()).rejects.toThrow('12');
    expect(h.extract).not.toHaveBeenCalled();
  });
  it('rejects an oversized batch without passing only its smaller files onward', async () => {
    const { result } = renderHook(() => useAiFileContext('scope'));
    const large = new File(['x'], 'large.txt'); Object.defineProperty(large, 'size', { value: 21 * 1024 * 1024 });
    act(() => result.current.add([new File(['a'], 'small.txt'), large]));
    expect(result.current.files).toHaveLength(0);
    await expect(result.current.read()).rejects.toThrow('20 MB');
  });
  it('rejects aggregate text overflow without returning partial file content', async () => {
    const { result } = renderHook(() => useAiFileContext('scope'));
    h.extract.mockResolvedValue('x'.repeat(31_000));
    act(() => result.current.add([new File(['a'], 'one.txt'), new File(['b'], 'two.txt')]));
    await act(async () => { await expect(result.current.read()).rejects.toThrow('60000'); });
    expect(result.current.files).toHaveLength(2);
    expect(result.current.status).toBe('');
  });
  it('does not continue after one of the selected files fails to parse', async () => {
    const { result } = renderHook(() => useAiFileContext('scope'));
    h.extract.mockResolvedValueOnce('READABLE').mockRejectedValueOnce(new Error('bad file'));
    act(() => result.current.add([new File(['a'], 'good.txt'), new File(['b'], 'broken.pdf')]));
    await act(async () => { await expect(result.current.read()).rejects.toThrow('无法读取'); });
    expect(result.current.error).toContain('broken.pdf');
    expect(result.current.files).toHaveLength(2);
  });
  it('waits for native attachment bytes and rejects a failed transfer even when another file exists', async () => {
    let reject!: (error: Error) => void;
    h.attachment.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    const { result } = renderHook(() => useAiFileContext('scope'));
    act(() => { result.current.add([new File(['x'], 'existing.txt')]); result.current.loadAttachment('attachment'); });
    await expect(result.current.read()).rejects.toThrow('正在加载');
    await act(async () => { reject(new Error('missing')); });
    await expect(result.current.read()).rejects.toThrow('读取拖入文件失败');
    expect(h.extract).not.toHaveBeenCalled();
  });
  it('ignores a delayed attachment after switching account/task scope', async () => {
    let resolve!: (value: unknown) => void;
    h.attachment.mockReturnValue(new Promise(done => { resolve = done; }));
    const { result, rerender } = renderHook(({ scope }) => useAiFileContext(scope), { initialProps: { scope: 'one' } });
    act(() => result.current.loadAttachment('old'));
    rerender({ scope: 'two' });
    await act(async () => { resolve({ name: 'old.txt', bytes: [65] }); });
    expect(result.current.files).toHaveLength(0);
    expect(result.current.pending).toBe(false);
  });
  it('accepts files available only through drag/paste items', () => {
    const file = new File(['abc'], 'data.txt');
    expect(filesFromTransfer({ files: [], items: [{ kind: 'file', getAsFile: () => file }] } as unknown as DataTransfer)).toEqual([file]);
  });
  it('receives native attachment data without losing the file identity', async () => {
    h.attachment.mockResolvedValue({ name: 'note.txt', bytes: [65, 66], mime_type: 'text/plain' });
    const { result } = renderHook(() => useAiFileContext('scope'));
    act(() => result.current.loadAttachment('id'));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.files[0].file.name).toBe('note.txt');
    expect(result.current.files[0].file.size).toBe(2);
  });
});
