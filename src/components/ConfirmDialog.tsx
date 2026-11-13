import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  alternateLabel?: string;
  onAlternate?: () => void;
  busy?: boolean;
  busyLabel?: string;
  children?: ReactNode;
}

function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) {
    return [];
  }

  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("disabled"));
}

export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive,
  onConfirm,
  onCancel,
  alternateLabel,
  onAlternate,
  busy = false,
  busyLabel,
  children,
}: Props) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onConfirmRef = useRef(onConfirm);
  const onCancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => { onConfirmRef.current = onConfirm; }, [onConfirm]);
  useEffect(() => { onCancelRef.current = onCancel; }, [onCancel]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // For destructive actions, focus Cancel by default to prevent accidental confirmation
    if (destructive) {
      cancelRef.current?.focus();
    } else {
      confirmRef.current?.focus();
    }

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (busyRef.current) return;
        onCancelRef.current();
        return;
      }

      if (e.key !== "Tab") {
        return;
      }

      const focusable = getFocusableElements(dialogRef.current);
      if (focusable.length === 0) {
        return;
      }

      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = e.shiftKey
        ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
        : (currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);

      e.preventDefault();
      focusable[nextIndex]?.focus();
    }

    document.addEventListener("keydown", handleKey);

    return () => {
      document.removeEventListener("keydown", handleKey);
      previousFocus?.focus();
    };
  }, [destructive]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1100,
      }}
    >
      <div
        ref={dialogRef}
        style={{
          width: "380px",
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'calc(100vh - 48px)',
          backgroundColor: "var(--color-sidebar-bg)",
          color: "var(--color-text-primary)",
          border: "1px solid var(--color-border)",
          borderRadius: "8px",
          boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <h3
          id="confirm-dialog-title"
          style={{ margin: 0, fontSize: "15px", fontWeight: 600, color: "var(--color-text-primary)" }}
        >
          {title}
        </h3>
        <p
          id="confirm-dialog-message"
          style={{ margin: 0, fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: '50vh', overflow: 'auto', overflowWrap: 'anywhere' }}
        >
          {message}
        </p>
        {children}
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: "8px" }}>
          <button
            ref={cancelRef}
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: "7px 16px",
              borderRadius: "6px",
              border: "1px solid var(--color-border)",
              backgroundColor: "transparent",
              color: "var(--color-text-primary)",
              fontSize: "13px",
              cursor: "pointer",
            }}
          >
            {cancelLabel || t("common.cancel", "Cancel")}
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            disabled={busy}
            style={{
              padding: "7px 16px",
              borderRadius: "6px",
              border: "none",
              backgroundColor: destructive ? "#ef4444" : "var(--color-accent)",
              color: "#fff",
              fontSize: "13px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {(busy && busyLabel) || confirmLabel || t("common.confirm", "Confirm")}
          </button>
          {alternateLabel && onAlternate && <button type="button" onClick={onAlternate} disabled={busy}
            style={{ padding: '7px 16px', borderRadius: 6, border: 'none', backgroundColor: 'var(--color-accent)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: busy ? 'wait' : 'pointer' }}>
            {busy ? busyLabel ?? t('compose.savingDraft', '正在保存…') : alternateLabel}
          </button>}
        </div>
      </div>
    </div>
  );
}
