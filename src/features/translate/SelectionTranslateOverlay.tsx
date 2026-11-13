import { useEffect, useRef, useState } from "react";
import TranslatePopover from "./TranslatePopover";
import SelectionActionPopover from "@/components/SelectionActionPopover";
import { useUIStore } from "@/stores/ui.store";
import { useMailStore } from "@/stores/mail.store";
import { useComposeStore } from "@/stores/compose.store";

interface SelectionState {
  text: string;
  position: { x: number; y: number };
}

function selectedTextFromTarget(target: EventTarget | undefined): string {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    return target.value.slice(Math.min(start, end), Math.max(start, end)).trim();
  }

  const pathRoot = target instanceof Node ? target.getRootNode() : null;
  const shadowSelection = pathRoot instanceof ShadowRoot
    ? (pathRoot as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.()
    : null;
  return (shadowSelection?.toString() || window.getSelection()?.toString() || "").trim();
}

function eventIsInsideTranslationScope(event: Event): boolean {
  return event.composedPath().some((node) =>
    node instanceof HTMLElement && node.hasAttribute("data-email-translation-scope"),
  );
}

/** One selection toolbar for received, sent, thread and editable draft mail. */
export default function SelectionTranslateOverlay() {
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [translating, setTranslating] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<SelectionState | null>(null);
  const activeView = useUIStore((s) => s.activeView);
  const messageId = useMailStore((s) => s.selectedMessageId);
  const threadId = useMailStore((s) => s.selectedThreadId);
  const detailId = useUIStore((s) => s.messageDetailId);
  const composeTabId = useComposeStore((s) => s.activeTabId);

  useEffect(() => {
    selectionRef.current = null;
    setSelection(null);
    setTranslating(false);
  }, [activeView, messageId, threadId, detailId, composeTabId]);

  useEffect(() => {
    let frame = 0;
    const close = () => {
      cancelAnimationFrame(frame);
      selectionRef.current = null;
      setSelection(null);
      setTranslating(false);
    };
    const select = (text: string, position: SelectionState["position"]) => {
      if (!text) {
        close();
        return false;
      }
      const next = { text, position };
      selectionRef.current = next;
      setSelection(next);
      setTranslating(false);
      return true;
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (overlayRef.current?.contains(event.target as Node)) return;
      if (event.button !== 0) return;
      if (!eventIsInsideTranslationScope(event)) {
        close();
        return;
      }
      // composedPath() is cleared after dispatch; preserve the Shadow DOM or
      // textarea target before reading the final selection in the next frame.
      const target = event.composedPath()[0];
      const position = { x: event.clientX, y: event.clientY };
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => select(selectedTextFromTarget(target), position));
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (!overlayRef.current?.contains(event.target as Node)) {
        close();
      }
    };
    const handleContextMenu = (event: MouseEvent) => {
      if (!eventIsInsideTranslationScope(event)) return;
      cancelAnimationFrame(frame);
      if (select(selectedTextFromTarget(event.composedPath()[0]), {
        x: Number.isFinite(event.clientX) ? event.clientX : 80,
        y: Number.isFinite(event.clientY) ? event.clientY : 80,
      })) event.preventDefault();
    };
    const handleTranslate = () => {
      if (selectionRef.current) setTranslating(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      const selectsAll = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a";
      if ((!event.shiftKey && !selectsAll) || !eventIsInsideTranslationScope(event)) return;
      const text = selectedTextFromTarget(event.composedPath()[0]);
      if (!text) return close();
      const selected = window.getSelection();
      const range = selected?.rangeCount ? selected.getRangeAt(0) : null;
      const rect = range?.getBoundingClientRect();
      const next = { text, position: { x: rect?.left ?? 80, y: rect?.bottom ?? 80 } };
      selectionRef.current = next;
      setSelection(next);
      setTranslating(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const handleScroll = (event: Event) => {
      if (!overlayRef.current?.contains(event.target as Node)) close();
    };

    document.addEventListener("pointerup", handlePointerUp, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("contextmenu", handleContextMenu, true);
    document.addEventListener("pebble:translate-selection", handleTranslate);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    document.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", close);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerup", handlePointerUp, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("contextmenu", handleContextMenu, true);
      document.removeEventListener("pebble:translate-selection", handleTranslate);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
      document.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", close);
    };
  }, []);

  if (!selection) return null;

  return (
    <div ref={overlayRef}>
      {translating ? (
        <TranslatePopover
          text={selection.text}
          position={selection.position}
          onClose={() => {
            selectionRef.current = null;
            setSelection(null);
            setTranslating(false);
          }}
        />
      ) : (
        <SelectionActionPopover
          key={selection.text}
          text={selection.text}
          position={selection.position}
          onTranslate={() => setTranslating(true)}
          onSearch={(text) => {
            useUIStore.getState().setSearchQuery(text);
            useUIStore.getState().setActiveView("search");
          }}
          onCreateRule={(text) => {
            const ui = useUIStore.getState();
            ui.setPendingRuleDraftText(text);
            ui.setSettingsTab("rules");
            ui.setActiveView("settings");
          }}
          onClose={() => {
            selectionRef.current = null;
            setSelection(null);
          }}
        />
      )}
    </div>
  );
}
