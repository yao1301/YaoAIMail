import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Check, X } from "lucide-react";
import { translateText } from "@/lib/api";
import { profileLocalStorage } from "@/lib/profileStorage";
import {
  TRANSLATION_TARGET_LANGUAGES,
  useTranslationTargetLanguage,
} from "@/lib/translationPreferences";

interface Props {
  text: string;
  position: { x: number; y: number };
  onClose: () => void;
}

export default function TranslatePopover({ text, position, onClose }: Props) {
  const { t } = useTranslation();
  const [translated, setTranslated] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const defaultTarget = useTranslationTargetLanguage();
  const [targetOverride, setTargetOverride] = useState<string | null>(null);
  const targetLang = targetOverride ?? defaultTarget;
  const [windowPosition, setWindowPosition] = useState(() => ({
    x: Math.max(8, Math.min(position.x, window.innerWidth - 348)),
    y: Math.max(8, Math.min(position.y + 10, window.innerHeight - 208)),
  }));
  const dragRef = useRef<{ pointerX: number; pointerY: number; startX: number; startY: number } | null>(null);

  const [privacyAcked, setPrivacyAcked] = useState(() =>
    profileLocalStorage.getItem("pebble-translate-privacy-ack") === "1",
  );

  useEffect(() => {
    if (!privacyAcked) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    translateText(text, "auto", targetLang)
      .then((result) => {
        if (!cancelled) setTranslated(result.translated);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [text, targetLang, privacyAcked]);

  function handleAcceptPrivacy() {
    profileLocalStorage.setItem("pebble-translate-privacy-ack", "1");
    setPrivacyAcked(true);
  }

  function handleCopy() {
    navigator.clipboard.writeText(translated);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function startDragging(event: React.PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button,select")) return;
    dragRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      startX: windowPosition.x,
      startY: windowPosition.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function dragWindow(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    setWindowPosition({
      x: Math.max(0, Math.min(window.innerWidth - 120, drag.startX + event.clientX - drag.pointerX)),
      y: Math.max(0, Math.min(window.innerHeight - 44, drag.startY + event.clientY - drag.pointerY)),
    });
  }

  function stopDragging(event: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        left: windowPosition.x,
        top: windowPosition.y,
        width: "320px",
        minWidth: "260px",
        minHeight: "140px",
        maxWidth: "calc(100vw - 16px)",
        maxHeight: "calc(100vh - 16px)",
        resize: "both",
        overflow: "auto",
        padding: "12px",
        borderRadius: "8px",
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-bg)",
        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        zIndex: 1000,
        color: "var(--color-text-primary)",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header with target lang selector */}
      <div
        onPointerDown={startDragging}
        onPointerMove={dragWindow}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        title="拖动此处移动窗口；拖动右下角调整大小"
        style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px", cursor: "move", userSelect: "none", touchAction: "none" }}
      >
        <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", flex: 1 }}>
          {t("translate.title")}
        </span>
        <select
          aria-label={t("translate.targetLanguage", "Translation language")}
          value={targetLang}
          onChange={(e) => setTargetOverride(e.target.value)}
          style={{
            fontSize: "11px",
            padding: "2px 4px",
            border: "1px solid var(--color-border)",
            borderRadius: "4px",
            backgroundColor: "var(--color-bg)",
            color: "var(--color-text-primary)",
          }}
        >
          {TRANSLATION_TARGET_LANGUAGES.map((language) => (
            <option key={language.value} value={language.value}>{language.label}</option>
          ))}
        </select>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "2px",
            color: "var(--color-text-secondary)",
            display: "flex",
            alignItems: "center",
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Privacy notice for first-time use */}
      {!privacyAcked ? (
        <div style={{ fontSize: "13px", lineHeight: 1.5, padding: "8px 0" }}>
          <p style={{ margin: "0 0 8px", color: "var(--color-warning, #e67e22)" }}>
            {t(
              "translate.privacyNotice",
              "Translation will send the selected text to a third-party translation service. Your email content will leave this device.",
            )}
          </p>
          <button
            onClick={handleAcceptPrivacy}
            style={{
              padding: "6px 14px",
              border: "1px solid var(--color-border)",
              borderRadius: "4px",
              backgroundColor: "var(--color-accent, #3b82f6)",
              color: "#fff",
              fontSize: "12px",
              cursor: "pointer",
            }}
          >
            {t("translate.acceptAndContinue", "I understand, continue")}
          </button>
        </div>
      ) : /* Content */
      loading ? (
        <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", padding: "8px 0" }}>
          {t("common.translating")}
        </div>
      ) : error ? (
        <div style={{ fontSize: "13px", color: "#ef4444", padding: "8px 0" }}>
          {error}
        </div>
      ) : (
        <div>
          <div dir="auto" style={{ fontSize: "13px", lineHeight: "1.5", marginBottom: "8px" }}>
            {translated}
          </div>
          <button
            onClick={handleCopy}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "4px",
              padding: "4px 8px",
              border: "1px solid var(--color-border)",
              borderRadius: "4px",
              backgroundColor: "transparent",
              color: "var(--color-text-secondary)",
              fontSize: "11px",
              cursor: "pointer",
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? t("common.copied") : t("common.copy")}
          </button>
        </div>
      )}
    </div>
  );
}
