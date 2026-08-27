import { useEffect, useRef, useState } from "react";
import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import TranslatePopover from "./TranslatePopover";

interface SelectionState {
  text: string;
  position: { x: number; y: number };
}

function selectedTextFromEvent(event: PointerEvent): string {
  const target = event.composedPath()[0];
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

/** Shared selected-text translator for received, sent and editable draft mail. */
export default function SelectionTranslateOverlay() {
  const { t } = useTranslation();
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [translating, setTranslating] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerUp = (event: PointerEvent) => {
      if (overlayRef.current?.contains(event.target as Node)) return;
      if (!eventIsInsideTranslationScope(event)) {
        setSelection(null);
        setTranslating(false);
        return;
      }

      requestAnimationFrame(() => {
        const text = selectedTextFromEvent(event);
        if (!text) {
          setSelection(null);
          setTranslating(false);
          return;
        }
        setSelection({ text, position: { x: event.clientX, y: event.clientY } });
        setTranslating(false);
      });
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (!overlayRef.current?.contains(event.target as Node)) {
        setSelection(null);
        setTranslating(false);
      }
    };

    document.addEventListener("pointerup", handlePointerUp, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerup", handlePointerUp, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
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
            setSelection(null);
            setTranslating(false);
          }}
        />
      ) : (
        <button
          type="button"
          aria-label={t("selection.translateSelectedText", "翻译所选文字")}
          title={t("selection.translateSelectedText", "翻译所选文字")}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setTranslating(true)}
          style={{
            position: "fixed",
            left: Math.max(8, Math.min(selection.position.x + 8, window.innerWidth - 92)),
            top: Math.max(8, Math.min(selection.position.y + 10, window.innerHeight - 42)),
            zIndex: 1200,
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "6px 10px",
            border: "1px solid var(--color-border)",
            borderRadius: 7,
            background: "var(--color-accent)",
            color: "#fff",
            boxShadow: "0 4px 14px rgba(0,0,0,.18)",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          <Languages size={14} />
          {t("selection.translate", "翻译")}
        </button>
      )}
    </div>
  );
}
