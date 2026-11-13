import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useMessageDeletionNavigation } from "../../src/hooks/useMessageDeletionNavigation";
import { useMailStore } from "../../src/stores/mail.store";

describe("mail list deletion navigation", () => {
  beforeEach(() => {
    useMailStore.setState({ activeAccountId: "account", activeFolderId: "inbox",
      selectedMessageId: "b", selectedThreadId: null, openMessageIds: [] });
  });

  it("uses the pre-delete order even after optimistic cache removal, without opening a tab", () => {
    const { result, rerender } = renderHook(({ ids }) => useMessageDeletionNavigation(ids),
      { initialProps: { ids: ["a", "b", "c"] } });
    const complete = result.current();
    rerender({ ids: ["a", "c"] });
    act(() => { complete(["b"]); });
    expect(useMailStore.getState().selectedMessageId).toBe("c");
    expect(useMailStore.getState().openMessageIds).toEqual([]);
  });

  it("advances immediately without waiting for the delete request, and restores on failure", () => {
    const { result } = renderHook(() => useMessageDeletionNavigation(["a", "b", "c"]));
    let complete!: ReturnType<typeof result.current>;
    act(() => { complete = result.current(["b"]); });
    expect(useMailStore.getState().selectedMessageId).toBe("c");
    expect(useMailStore.getState().openMessageIds).toEqual([]);
    act(() => { complete([]); });
    expect(useMailStore.getState().selectedMessageId).toBe("b");
  });

  it("skips the pending batch immediately and restores the failed selected mail on partial failure", () => {
    const { result } = renderHook(() => useMessageDeletionNavigation(["a", "b", "c", "d"]));
    let complete!: ReturnType<typeof result.current>;
    act(() => { complete = result.current(["b", "c"]); });
    expect(useMailStore.getState().selectedMessageId).toBe("d");
    act(() => { complete(["c"]); });
    expect(useMailStore.getState().selectedMessageId).toBe("b");
  });

  it("does not undo the user's newer manual selection on failure", () => {
    const { result } = renderHook(() => useMessageDeletionNavigation(["a", "b", "c"]));
    let complete!: ReturnType<typeof result.current>;
    act(() => { complete = result.current(["b"]); });
    act(() => { useMailStore.getState().selectMessage("a"); complete([]); });
    expect(useMailStore.getState().selectedMessageId).toBe("a");
  });

  it("skips other pending deletions and does not undo a newer deletion's navigation", () => {
    const { result } = renderHook(() => useMessageDeletionNavigation(["a", "b", "c"]));
    let first!: ReturnType<typeof result.current>;
    let second!: ReturnType<typeof result.current>;
    act(() => { first = result.current(["b"]); });
    act(() => { second = result.current(["c"]); });
    expect(useMailStore.getState().selectedMessageId).toBe("a");
    act(() => { first([]); second(["c"]); });
    expect(useMailStore.getState().selectedMessageId).toBe("a");
  });

  it("does not undo a manual move away and back to the automatic target", () => {
    const { result } = renderHook(() => useMessageDeletionNavigation(["a", "b", "c"]));
    let complete!: ReturnType<typeof result.current>;
    act(() => { complete = result.current(["b"]); });
    act(() => { useMailStore.getState().selectMessage("a"); });
    act(() => { useMailStore.getState().selectMessage("c"); });
    act(() => { complete([]); });
    expect(useMailStore.getState().selectedMessageId).toBe("c");
  });

  it("does not roll back into another folder or after unmount", () => {
    const { result, unmount } = renderHook(() => useMessageDeletionNavigation(["a", "b", "c"]));
    let complete!: ReturnType<typeof result.current>;
    act(() => { complete = result.current(["b"]); });
    act(() => { useMailStore.getState().setActiveFolderId("sent"); });
    unmount();
    act(() => { complete([]); });
    expect(useMailStore.getState().selectedMessageId).toBeNull();
  });

  it("skips the rest of a deleted batch", () => {
    const { result } = renderHook(() => useMessageDeletionNavigation(["a", "b", "c", "d"]));
    act(() => { result.current()(["b", "c"]); });
    expect(useMailStore.getState().selectedMessageId).toBe("d");
  });

  it("falls back to the previous remaining row at the end", () => {
    const { result } = renderHook(() => useMessageDeletionNavigation(["a", "b", "c"]));
    act(() => { result.current()(["b", "c"]); });
    expect(useMailStore.getState().selectedMessageId).toBe("a");
  });

  it("clears preview when the list becomes empty", () => {
    const { result } = renderHook(() => useMessageDeletionNavigation(["b"]));
    act(() => { result.current()(["b"]); });
    expect(useMailStore.getState().selectedMessageId).toBeNull();
  });

  it("does not move when deleting the selected row fails or only another row succeeds", () => {
    const { result } = renderHook(() => useMessageDeletionNavigation(["a", "b", "c"]));
    act(() => { result.current()([]); });
    expect(useMailStore.getState().selectedMessageId).toBe("b");
    act(() => { result.current()(["a"]); });
    expect(useMailStore.getState().selectedMessageId).toBe("b");
  });

  it("leaves a newer manually selected mail alone", () => {
    const { result } = renderHook(() => useMessageDeletionNavigation(["a", "b", "c"]));
    const complete = result.current();
    act(() => { useMailStore.getState().selectMessage("a"); complete(["b"]); });
    expect(useMailStore.getState().selectedMessageId).toBe("a");
  });

  it("leaves another folder alone while a deletion is pending", () => {
    const { result } = renderHook(() => useMessageDeletionNavigation(["a", "b", "c"]));
    const complete = result.current();
    act(() => {
      useMailStore.getState().setActiveFolderId("sent");
      useMailStore.getState().selectMessage("other");
      expect(complete(["b"])).toBe(true);
    });
    expect(useMailStore.getState().selectedMessageId).toBe("other");
  });

  it("does not navigate after the list has been unmounted", () => {
    const { result, unmount } = renderHook(() => useMessageDeletionNavigation(["a", "b", "c"]));
    const complete = result.current();
    unmount();
    expect(complete(["b"])).toBe(true);
    expect(useMailStore.getState().selectedMessageId).toBe("b");
  });
});
