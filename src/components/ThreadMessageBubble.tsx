import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getRenderedHtml } from "@/lib/api";
import type { Message, RenderedHtml } from "@/lib/api";
import { privacyModeToApi, useStoredPrivacyMode, type StoredPrivacyMode } from "@/lib/privacyMode";
import { sanitizeHtml } from "@/lib/sanitizeHtml";
import { ShadowDomEmail } from "./ShadowDomEmail";
import { plainTextEmailToHtml } from "@/lib/historicalQuoteCards";

interface Props {
  message: Message;
  defaultExpanded?: boolean;
}

function formatFullDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString([], {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export default function ThreadMessageBubble({ message, defaultExpanded = false }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const privacyMode = useStoredPrivacyMode();
  const [cached, setCached] = useState<{ id: string; mode: StoredPrivacyMode; html: RenderedHtml } | null>(null);
  const rendered = cached?.id === message.id && cached.mode === privacyMode ? cached.html : null;

  useEffect(() => {
    let current = true;
    if (expanded && !rendered) {
      getRenderedHtml(message.id, privacyModeToApi(privacyMode))
        .then((html) => {
          if (current) setCached({ id: message.id, mode: privacyMode, html: { ...html, html: sanitizeHtml(html.html) } });
        })
        .catch((err) => console.warn("Failed to render thread message HTML", err));
    }
    return () => { current = false; };
  }, [expanded, rendered, message.id, privacyMode]);

  return (
    <div
      style={{
        border: "1px solid var(--color-border)",
        borderRadius: "8px",
        marginBottom: "8px",
        overflow: "hidden",
        backgroundColor: "var(--color-bg)",
      }}
    >
      {/* Header - always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "10px 14px",
          cursor: "pointer",
          backgroundColor: expanded ? "var(--color-bg-hover)" : "transparent",
          border: "none",
          width: "100%",
          textAlign: "left",
          color: "inherit",
          font: "inherit",
        }}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span style={{ fontSize: "13px", fontWeight: 500, flex: 1 }}>
          {message.from_name || message.from_address}
        </span>
        <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>
          {formatFullDate(message.date)}
        </span>
      </button>

      {/* Body - only when expanded */}
      {expanded && (
        <div style={{ padding: "12px 14px", borderTop: "1px solid var(--color-border)" }}>
          {/* To/Cc line */}
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "8px" }}>
            <div>
              {t("thread.to")} {message.to_list?.map((r: { address: string }) => r.address).join(", ")}
            </div>
            {message.cc_list?.length > 0 && (
              <div>
                {t("thread.cc", "Cc:")} {message.cc_list.map((r: { address: string }) => r.address).join(", ")}
              </div>
            )}
          </div>
          {/* Body content */}
          <ShadowDomEmail html={rendered?.html || plainTextEmailToHtml(message.body_text || "")} />
        </div>
      )}
    </div>
  );
}
