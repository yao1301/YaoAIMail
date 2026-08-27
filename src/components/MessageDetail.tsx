import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Languages } from "lucide-react";
import { trustSender } from "@/lib/api";
import { useTranslation } from "react-i18next";
import type { PrivacyMode, TranslateResult } from "@/lib/api";
import { useClickOutside } from "@/hooks/useClickOutside";import { MessageDetailSkeleton } from "./Skeleton";
import PrivacyBanner from "./PrivacyBanner";
import AttachmentList from "./AttachmentList";
import { ShadowDomEmail } from "./ShadowDomEmail";
import TranslatePopover from "../features/translate/TranslatePopover";
import MessageActionToolbar from "./MessageActionToolbar";
import { useMessageLoader } from "@/hooks/useMessageLoader";
import { useBilingualTranslation } from "@/hooks/useBilingualTranslation";
import { defaultPrivacyMode } from "@/lib/privacyMode";
import { useUIStore } from "@/stores/ui.store";
import SelectionActionPopover from "./SelectionActionPopover";
import type { EmailAddress } from "@/lib/api";

interface Props {
  messageId: string;
  onBack: () => void;
  folderRole?: string | null;
}

function formatFullDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRecipient(address: EmailAddress): string {
  const name = address.name?.trim();
  const email = address.address.trim();
  if (name && email) return `${name} <${email}>`;
  if (email) return `<${email}>`;
  return name ?? "";
}

function formatRecipients(addresses: EmailAddress[]): string {
  return addresses.map(formatRecipient).filter(Boolean).join(", ");
}

export default function MessageDetail({ messageId, onBack, folderRole }: Props) {
  const { t } = useTranslation();
  const [privacyMode, setPrivacyMode] = useState<PrivacyMode>(() => defaultPrivacyMode());
  const [showSelectionActions, setShowSelectionActions] = useState<{ text: string; position: { x: number; y: number } } | null>(null);
  const [showTranslate, setShowTranslate] = useState<{ text: string; position: { x: number; y: number } } | null>(null);

  const selectionActionsRef = useRef<HTMLDivElement>(null);
  const translateRef = useRef<HTMLDivElement>(null);

  const { message, setMessage, rendered, loading, error, hydrateFailed } = useMessageLoader(messageId, privacyMode);
  const { bilingualMode, bilingualResult, bilingualLoading, handleBilingualToggle, resetBilingual } = useBilingualTranslation(messageId, rendered, message);

  useClickOutside(selectionActionsRef, !!showSelectionActions, () => setShowSelectionActions(null));
  useClickOutside(translateRef, !!showTranslate, () => setShowTranslate(null));

  // Reset bilingual state when messageId changes
  useEffect(() => {
    resetBilingual();
  }, [messageId]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleLoadImages() {
    setPrivacyMode("LoadOnce");
  }

  async function handleTrustSender(trustType: "images" | "all") {
    if (message) {
      if (trustType === "all") {
        setPrivacyMode({ TrustSender: message.from_address });
      } else {
        setPrivacyMode("LoadOnce");
      }
      try {
        await trustSender(message.account_id, message.from_address, trustType);
      } catch (err) {
        console.error("Failed to persist trusted sender:", err);
      }
    }
  }

  function getCurrentSelectedText() {
    const selection = window.getSelection();
    return selection?.toString().trim() || "";
  }

  function getCurrentSelectionPosition() {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect();
    const x = rect && rect.width > 0 ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const y = rect && rect.height > 0 ? rect.bottom : window.innerHeight / 2;
    return { x, y };
  }

  function openSelectionActionsForSelection(position?: { x: number; y: number }, selectedText = getCurrentSelectedText()) {
    if (selectedText.length <= 5) return false;
    setShowTranslate(null);
    setShowSelectionActions({
      text: selectedText,
      position: position ?? getCurrentSelectionPosition(),
    });
    return true;
  }

  function openTranslateForSelection(position?: { x: number; y: number }) {
    const selectedText = getCurrentSelectedText();
    if (selectedText.length <= 5) return;
    setShowSelectionActions(null);
    setShowTranslate({ text: selectedText, position: position ?? getCurrentSelectionPosition() });
  }

  function handleTranslateSelectedText(text: string, position: { x: number; y: number }) {
    setShowSelectionActions(null);
    setShowTranslate({ text, position });
  }

  function handleSearchSelectedText(text: string) {
    useUIStore.getState().setSearchQuery(text);
    useUIStore.getState().setActiveView("search");
    setShowSelectionActions(null);
  }

  function handleCreateRuleFromSelection(text: string) {
    const ui = useUIStore.getState();
    ui.setPendingRuleDraftText(text);
    ui.setSettingsTab("rules");
    ui.setActiveView("settings");
    setShowSelectionActions(null);
  }

  function handleContextMenu(e: React.MouseEvent) {
    const selectedText = getCurrentSelectedText();
    if (selectedText.length <= 5) return;
    e.preventDefault();
    openSelectionActionsForSelection({ x: e.clientX, y: e.clientY }, selectedText);
  }

  useEffect(() => {
    const onTranslate = () => openTranslateForSelection();
    const onBilingual = () => handleBilingualToggle();
    document.addEventListener("pebble:translate-selection", onTranslate);
    document.addEventListener("pebble:toggle-bilingual", onBilingual);
    return () => {
      document.removeEventListener("pebble:translate-selection", onTranslate);
      document.removeEventListener("pebble:toggle-bilingual", onBilingual);
    };
  });

  if (loading) {
    return <MessageDetailSkeleton />;
  }

  if (error) {
    return (
      <div
        role="alert"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "var(--color-error, #dc2626)",
          fontSize: "14px",
          padding: "24px",
          textAlign: "center",
        }}
      >
        {t("common.messageLoadFailed", "Failed to load message")}: {error}
      </div>
    );
  }

  if (!message) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "var(--color-text-secondary)",
          fontSize: "14px",
        }}
      >
        {t("common.messageNotFound", "Message not found")}
      </div>
    );
  }

  const recipientLine = formatRecipients(message.to_list);
  const ccLine = formatRecipients(message.cc_list);

  return (
    <div
      className="message-detail-container"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "16px 18px",
          borderBottom: "1px solid var(--color-border)",
          boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
          flexShrink: 0,
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--color-accent) 7%, var(--color-bg-primary)) 0%, var(--color-bg-primary) 100%)",
          position: "relative",
          zIndex: 2,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
          <button
            onClick={onBack}
            aria-label={t("compose.back", "Back")}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "4px",
              borderRadius: "4px",
              color: "var(--color-text-secondary)",
              display: "flex",
              alignItems: "center",
            }}
          >
            <ArrowLeft size={18} />
          </button>
          <h2
            style={{
              fontSize: "15px",
              fontWeight: "600",
              color: "var(--color-text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              margin: 0,
            }}
          >
            {message.subject || t("inbox.noSubject", "(no subject)")}
          </h2>
          <button
            onClick={handleBilingualToggle}
            aria-pressed={bilingualMode}
            style={{
              background: bilingualMode ? "var(--color-bg-hover)" : "none",
              border: "none",
              cursor: "pointer",
              padding: "4px",
              borderRadius: "4px",
              color: bilingualMode ? "var(--color-accent)" : "var(--color-text-secondary)",
              display: "flex",
              alignItems: "center",
              flexShrink: 0,
            }}
            title={t("messageActions.bilingualView", "Toggle bilingual view")}
            aria-label={t("messageActions.bilingualView", "Toggle bilingual view")}
          >
            <Languages size={16} />
          </button>
        </div>
        {/* Action Toolbar */}
        <MessageActionToolbar
          message={message}
          folderRole={folderRole}
          onBack={onBack}
          onMessageUpdate={setMessage}
        />
        <div
          style={{
            paddingLeft: "32px",
            marginTop: 10,
            paddingTop: 10,
            borderTop: "1px dashed color-mix(in srgb, var(--color-border) 60%, transparent)",
          }}
        >
          <div style={{ fontSize: "13px", color: "var(--color-text-primary)", marginBottom: "2px" }}>
            <span style={{ fontWeight: "500" }}>
              {message.from_name || message.from_address}
            </span>
            {message.from_name && (
              <span style={{ color: "var(--color-text-secondary)", marginLeft: "6px" }}>
                &lt;{message.from_address}&gt;
              </span>
            )}
            {recipientLine && (
              <span style={{ color: "var(--color-text-secondary)", marginLeft: "6px", fontSize: "12px" }}>
                {t("messageDetail.to", "To:")}&nbsp;{recipientLine}
              </span>
            )}
            {ccLine && (
              <span style={{ color: "var(--color-text-secondary)", marginLeft: "6px", fontSize: "12px" }}>
                {t("messageDetail.cc", "Cc:")}&nbsp;{ccLine}
              </span>
            )}
          </div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
            {formatFullDate(message.date)}
          </div>
        </div>
      </div>

      {/* Privacy Banner */}
      {rendered && (
        <PrivacyBanner
          rendered={rendered}
          onLoadImages={handleLoadImages}
          onTrustSender={handleTrustSender}
        />
      )}

      {/* 正文下载失败提示（不覆盖已显示的头部/内容） */}
      {hydrateFailed && (
        <div
          role="status"
          style={{
            flexShrink: 0,
            margin: "8px 14px 0",
            padding: "8px 12px",
            borderRadius: 8,
            fontSize: 12,
            color: "#9a6700",
            background: "color-mix(in srgb, #f59e0b 10%, transparent)",
            border: "1px solid color-mix(in srgb, #f59e0b 40%, transparent)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <AlertTriangle size={13} />
          <span>正文下载暂时失败（网络/服务器波动），已显示邮件头部。网络恢复后重新打开该邮件即可自动补全。</span>
        </div>
      )}

      {/* Body */}
      <div
        className="scroll-region message-body-scroll"
        data-email-translation-scope
        tabIndex={0}
        role="region"
        aria-label={t("messageDetail.body", "Message body")}
        style={{ flex: 1, overflow: "auto", padding: "16px" }}
        onContextMenu={handleContextMenu}
      >
        {bilingualMode && bilingualLoading ? (
            <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("common.translating", "Translating...")}</div>
        ) : bilingualMode && bilingualResult ? (
          (bilingualResult as TranslateResult & { _isHtml?: boolean })._isHtml ? (
            <ShadowDomEmail html={bilingualResult.translated} />
          ) : (
            <pre
              style={{
                fontSize: "14px",
                color: "var(--color-text-primary)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                margin: 0,
                fontFamily: "inherit",
                lineHeight: 1.7,
              }}
            >
              {bilingualResult.translated}
            </pre>
          )
        ) : bilingualMode && !bilingualLoading ? (
            <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("common.translationFailed", "Translation failed")}</div>
        ) : rendered && rendered.html ? (
          <ShadowDomEmail html={rendered.html} />
        ) : (
          <pre
            style={{
              fontSize: "13px",
              color: "var(--color-text-primary)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              margin: 0,
              fontFamily: "inherit",
            }}
          >
            {message.body_text}
          </pre>
        )}
      </div>

      {/* Attachments */}
      {message.has_attachments && <AttachmentList messageId={message.id} />}

      {showTranslate && (
        <div ref={translateRef}>
          <TranslatePopover
            text={showTranslate.text}
            position={showTranslate.position}
            onClose={() => setShowTranslate(null)}
          />
        </div>
      )}

      {showSelectionActions && (
        <div ref={selectionActionsRef}>
          <SelectionActionPopover
            text={showSelectionActions.text}
            position={showSelectionActions.position}
            onTranslate={handleTranslateSelectedText}
            onSearch={handleSearchSelectedText}
            onCreateRule={handleCreateRuleFromSelection}
            onClose={() => setShowSelectionActions(null)}
          />
        </div>
      )}
    </div>
  );
}
