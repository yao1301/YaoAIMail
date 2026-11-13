import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef } from "react";
import { useMailStore } from "@/stores/mail.store";

type CompleteDeletion = (deletedIds: readonly string[]) => boolean;
type PrepareDeletion = (optimisticIds?: readonly string[]) => CompleteDeletion;
interface LocalSelection {
  selectedId: string | null;
  scopeKey: string;
  onSelect: (id: string | null) => void;
}

const unhandledDeletion: CompleteDeletion = () => false;
export const MessageDeletionNavigationContext = createContext<PrepareDeletion>(() => unhandledDeletion);

/** Advance before cache removal; settle with successful IDs (including [] on failure). */
export function usePrepareMessageDeletion() {
  return useContext(MessageDeletionNavigationContext);
}

export function useMessageDeletionNavigation(orderedIds: string[], localSelection?: LocalSelection): PrepareDeletion {
  const latestIds = useRef(orderedIds);
  latestIds.current = orderedIds;
  const local = useRef(localSelection);
  local.current = localSelection;
  const mounted = useRef(true);
  const deleted = useRef(new Set<string>());
  const pending = useRef(new Map<symbol, readonly string[]>());
  const navigationVersion = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const accountId = useMailStore(s => s.activeAccountId);
  const folderId = useMailStore(s => s.activeFolderId);
  const globalSelectedId = useMailStore(s => s.selectedMessageId);
  const observedSelection = useRef(localSelection ? localSelection.selectedId : globalSelectedId);
  useLayoutEffect(() => {
    const selected = localSelection ? localSelection.selectedId : globalSelectedId;
    if (observedSelection.current !== selected) {
      observedSelection.current = selected;
      navigationVersion.current += 1;
    }
  }, [localSelection?.selectedId, globalSelectedId]);
  useEffect(() => {
    deleted.current.clear();
    pending.current.clear();
    navigationVersion.current += 1;
  }, [accountId, folderId, localSelection?.scopeKey]);
  useEffect(() => {
    const present = new Set(orderedIds);
    deleted.current.forEach(id => { if (!present.has(id)) deleted.current.delete(id); });
  }, [orderedIds]);

  return useCallback((optimisticIds?: readonly string[]) => {
    const readSelection = (): LocalSelection => {
      if (local.current) return local.current;
      const state = useMailStore.getState();
      return {
        selectedId: state.selectedMessageId,
        scopeKey: JSON.stringify([state.activeAccountId, state.activeFolderId]),
        onSelect: id => {
          if (id) state.selectMessage(id);
          else useMailStore.setState({ selectedMessageId: null, selectedThreadId: null });
        },
      };
    };
    const before = readSelection();
    const selectedId = before.selectedId;
    const order = [...latestIds.current];
    const index = selectedId ? order.indexOf(selectedId) : -1;
    const token = Symbol();
    let settled = false;
    let advanced = false;
    let next: string | null = null;
    let version = navigationVersion.current;
    const select = (current: LocalSelection, id: string | null) => {
      // Local React state may not have rendered yet when a fast request settles.
      if (local.current) local.current = { ...current, selectedId: id };
      observedSelection.current = id;
      current.onSelect(id);
    };
    const advance = (current: LocalSelection, removedIds: readonly string[]) => {
      if (!selectedId || !removedIds.includes(selectedId) || current.selectedId !== selectedId) return;
      const excluded = new Set([...deleted.current, ...[...pending.current.values()].flat()]);
      const remaining = new Set(latestIds.current.filter(id => !excluded.has(id)));
      next = order.slice(index + 1).find(id => remaining.has(id))
        ?? order.slice(0, index).reverse().find(id => remaining.has(id))
        ?? null;
      version = ++navigationVersion.current;
      advanced = true;
      // Preview only: advancing must not open another workspace tab.
      select(current, next);
    };
    if (optimisticIds && index >= 0 && mounted.current) {
      pending.current.set(token, optimisticIds);
      advance(before, optimisticIds);
    }
    return (deletedIds) => {
      if (settled) return index >= 0;
      settled = true;
      pending.current.delete(token);
      if (index < 0) return false;
      // A handled list deletion must not fall back to closing a newer preview.
      const current = readSelection();
      if (!mounted.current || current.scopeKey !== before.scopeKey) return true;
      deletedIds.forEach(id => deleted.current.add(id));
      if (advanced) {
        // Only undo our own still-current advance; never steal a newer preview.
        if (selectedId && !deletedIds.includes(selectedId)
          && current.selectedId === next && navigationVersion.current === version) {
          select(current, selectedId);
        }
      } else if (!optimisticIds) {
        advance(current, deletedIds);
      }
      return true;
    };
  }, []);
}
