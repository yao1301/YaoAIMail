import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposeDraft } from "../../src/hooks/useComposeDraft";
import { saveDraft } from "../../src/lib/api";
import { useComposeStore } from '../../src/stores/compose.store';
import { useConfirmStore } from '../../src/stores/confirm.store';

vi.mock("../../src/lib/api", () => ({
  saveDraft: vi.fn(),
}));

const saveDraftMock = vi.mocked(saveDraft);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function baseProps(overrides: Partial<Parameters<typeof useComposeDraft>[0]> = {}) {
  return {
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    rawSource: "",
    richTextHtml: "",
    editorMode: "rich" as const,
    composeMode: "new",
    fromAccountId: "account-1",
    editorReady: true,
    attachments: [],
    ...overrides,
  };
}

describe("useComposeDraft", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    saveDraftMock.mockReset();
    useComposeStore.setState({ tabs: [], tabsById: {}, activeTabId: null, composeMode: 'new', composeDirty: false, showComposeLeaveConfirm: false });
    useConfirmStore.setState({ isOpen: false, busy: false, resolve: null });
  });

  afterEach(() => vi.useRealTimers());

  it('preserves the real reply parent while autosaving a reopened document-generated draft', async () => {
    saveDraftMock.mockResolvedValue('reply-draft');
    renderHook(() => useComposeDraft(baseProps({ existingDraftId: 'reply-draft', inReplyTo: '<parent@example.test>', to: ['buyer@example.test'], subject: 'Re: Request', richTextHtml: '<p>Confirmed.</p>' })));
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(saveDraftMock).toHaveBeenCalledWith(expect.objectContaining({ existingDraftId: 'reply-draft', inReplyTo: '<parent@example.test>' }));
  });

  it("saves reopened table HTML and attachments without treating the sent message as the existing draft", async () => {
    saveDraftMock.mockResolvedValue("new-draft");
    const bodyHtml = '<table style="table-layout:fixed"><tbody><tr><td colwidth="96" style="background-color:#fff2cc">Order</td></tr></tbody></table>';
    const { result } = renderHook(() => useComposeDraft(baseProps({
      to: ["buyer@example.org"], subject: "Order", fromAccountId: "original-account",
      richTextHtml: bodyHtml, rawSource: "Plain fallback",
      attachments: [{ name: "Order.xlsx", path: "Y:/portable/data/attachments/Order.xlsx", size: 8 }],
    })));
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(saveDraftMock).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "original-account", bodyHtml,
      attachmentPaths: ["Y:/portable/data/attachments/Order.xlsx"], existingDraftId: undefined,
    }));
    expect(result.current.draftIdRef.current).toBe("new-draft");
    expect(localStorage.getItem("pebble-compose-draft")).toBeNull();
  });

  it("autosaves attachments only to the backend draft", async () => {
    saveDraftMock.mockResolvedValue("draft-1");

    renderHook((props) => useComposeDraft(props), {
      initialProps: baseProps({
        attachments: [{ name: "report.pdf", path: "C:\\tmp\\report.pdf", size: 1234 }],
      }) as Parameters<typeof useComposeDraft>[0],
    });

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(saveDraftMock).toHaveBeenCalledOnce();
    expect(saveDraftMock).toHaveBeenCalledWith(expect.objectContaining({
      attachmentPaths: ["C:\\tmp\\report.pdf"],
    }));
    expect(localStorage.getItem("pebble-compose-draft")).toBeNull();
  });

  it("does not reuse a stale draft id after switching accounts", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    saveDraftMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue("draft-account-2-later");

    const { rerender } = renderHook((props) => useComposeDraft(props), {
      initialProps: baseProps({ subject: "A", fromAccountId: "account-1" }) as Parameters<typeof useComposeDraft>[0],
    });

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(saveDraftMock).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account-1",
      existingDraftId: undefined,
    }));

    rerender(baseProps({ subject: "B", fromAccountId: "account-2" }) as Parameters<typeof useComposeDraft>[0]);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(saveDraftMock).toHaveBeenLastCalledWith(expect.objectContaining({
      accountId: "account-2",
      existingDraftId: undefined,
    }));

    await act(async () => {
      first.resolve("draft-account-1");
      await first.promise;
    });

    rerender(baseProps({ subject: "B updated", fromAccountId: "account-2" }) as Parameters<typeof useComposeDraft>[0]);
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(saveDraftMock).toHaveBeenLastCalledWith(expect.objectContaining({
      accountId: "account-2",
      existingDraftId: undefined,
    }));
    // The second account's update waits for its first save, then reuses that ID.
    expect(saveDraftMock).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve('draft-account-2'); await second.promise; });
    expect(saveDraftMock).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: 'account-2', existingDraftId: 'draft-account-2', subject: 'B updated' }));
  });

  it('serializes manual save with autosave and preserves the newest edit', async () => {
    const first = deferred<string>();
    saveDraftMock.mockReturnValueOnce(first.promise).mockResolvedValue('draft-1');
    const { result, rerender } = renderHook(props => useComposeDraft(props), { initialProps: baseProps({ subject: 'First' }) });
    await act(async () => { vi.advanceTimersByTime(3000); });
    rerender(baseProps({ subject: 'Latest' }));
    let manual!: Promise<string>;
    act(() => { manual = result.current.saveNow(); });
    expect(saveDraftMock).toHaveBeenCalledTimes(1);
    expect(useComposeStore.getState().composeDirty).toBe(true);
    await act(async () => { first.resolve('draft-1'); await manual; });
    expect(saveDraftMock).toHaveBeenCalledTimes(2);
    expect(saveDraftMock).toHaveBeenLastCalledWith(expect.objectContaining({ subject: 'Latest', existingDraftId: 'draft-1' }));
    expect(useComposeStore.getState().composeDirty).toBe(false);
  });

  it('keeps newer edits dirty while an older save completes', async () => {
    const first = deferred<string>();
    saveDraftMock.mockReturnValueOnce(first.promise);
    const { result, rerender } = renderHook(props => useComposeDraft(props), { initialProps: baseProps({ subject: 'First' }) });
    let task!: Promise<string>;
    act(() => { task = result.current.saveNow(); });
    rerender(baseProps({ subject: 'Changed while saving' }));
    await act(async () => { first.resolve('draft-1'); await task; });
    expect(useComposeStore.getState().composeDirty).toBe(true);
  });

  it('keeps failed saves dirty and retries without creating a duplicate ID', async () => {
    saveDraftMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValue('draft-1');
    const { result } = renderHook(() => useComposeDraft(baseProps({ existingDraftId: 'draft-1', subject: 'Saved' })));
    await act(async () => { await expect(result.current.saveNow()).rejects.toThrow('offline'); });
    await act(async () => { await result.current.saveNow(); });
    expect(saveDraftMock).toHaveBeenLastCalledWith(expect.objectContaining({ existingDraftId: 'draft-1' }));
  });

  it('treats clearing a saved draft as a change and persists the empty content', async () => {
    saveDraftMock.mockResolvedValue('draft-1');
    const { rerender } = renderHook(props => useComposeDraft(props), { initialProps: baseProps({ existingDraftId: 'draft-1', subject: 'Saved' }) });
    expect(useComposeStore.getState().composeDirty).toBe(false);
    rerender(baseProps({ existingDraftId: 'draft-1' }));
    expect(useComposeStore.getState().composeDirty).toBe(true);
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(saveDraftMock).toHaveBeenLastCalledWith(expect.objectContaining({ existingDraftId: 'draft-1', subject: '' }));
    expect(useComposeStore.getState().composeDirty).toBe(false);
  });

  it('pauses autosave while the close decision is open', async () => {
    useComposeStore.setState({ showComposeLeaveConfirm: true });
    renderHook(() => useComposeDraft(baseProps({ subject: 'Unsaved' })));
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(saveDraftMock).not.toHaveBeenCalled();
  });

  it('retains dirty state when restoring a newer in-memory snapshot of an existing draft', () => {
    renderHook(() => useComposeDraft(baseProps({ existingDraftId: 'draft-1', initialDirty: true, subject: 'Newer than saved copy' })));
    expect(useComposeStore.getState().composeDirty).toBe(true);
  });

  it('waits for in-flight saves before sent-draft cleanup and stops later autosaves', async () => {
    const first = deferred<string>();
    saveDraftMock.mockReturnValueOnce(first.promise);
    const { result, rerender } = renderHook(props => useComposeDraft(props), { initialProps: baseProps({ subject: 'Ready to send' }) });
    await act(async () => { vi.advanceTimersByTime(3000); });
    let stopped!: Promise<void>;
    act(() => { stopped = result.current.stopSaving(); });
    await act(async () => { first.resolve('saved-before-send'); await stopped; });
    expect(result.current.draftIdsByAccountRef.current['account-1']).toBe('saved-before-send');
    rerender(baseProps({ subject: 'No more saves' }));
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(saveDraftMock).toHaveBeenCalledTimes(1);
  });
});
