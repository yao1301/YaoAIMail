import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { Star } from "lucide-react";
import { useStarredMessagesQuery } from "@/hooks/queries";
import { useMailStore } from "@/stores/mail.store";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import MessageItem from "@/components/MessageItem";
import MessageDetail from "@/components/MessageDetail";
import { deleteMessage } from "@/lib/api";
import { useToastStore } from "@/stores/toast.store";

const EMPTY_REMOVED_IDS = new Set<string>();

export default function StarredView() {
  const { t } = useTranslation();
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const addToast = useToastStore((s) => s.addToast);
  const [stateAccountId, setStateAccountId] = useState(activeAccountId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [removedIds, setRemovedIds] = useState<Set<string>>(() => new Set());
  const accountStateMatches = stateAccountId === activeAccountId;
  const scopedRemovedIds = accountStateMatches ? removedIds : EMPTY_REMOVED_IDS;
  const scopedSelectedId = accountStateMatches ? selectedId : null;
  const { data: messages, loading, error, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } =
    useStarredMessagesQuery(activeAccountId, scopedRemovedIds.size);

  useEffect(() => {
    if (stateAccountId === activeAccountId) return;
    setStateAccountId(activeAccountId);
    setSelectedId(null);
    setRemovedIds(new Set());
  }, [activeAccountId, stateAccountId]);

  const visibleMessages = useMemo(() => {
    const seen = new Set<string>();
    return messages.filter((message) => {
      if (scopedRemovedIds.has(message.id) || seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
  }, [messages, scopedRemovedIds]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 76,
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 5,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastVisibleIndex = virtualItems.length > 0
    ? virtualItems[virtualItems.length - 1].index
    : -1;

  function handleOpen(messageId: string) {
    setSelectedId(messageId);
  }

  useEffect(() => {
    if (
      hasNextPage
      && !isFetchingNextPage
      && lastVisibleIndex >= Math.max(0, visibleMessages.length - 5)
    ) {
      fetchNextPage();
    }
  }, [
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    lastVisibleIndex,
    visibleMessages.length,
  ]);

  const handleToggleStar = useCallback((messageId: string, newStarred: boolean) => {
    if (newStarred) return;
    setRemovedIds((prev) => {
      const next = new Set(prev);
      next.add(messageId);
      return next;
    });
    if (scopedSelectedId === messageId) {
      setSelectedId(null);
    }
  }, [scopedSelectedId]);

  const totalCount = visibleMessages.length;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" || !scopedSelectedId) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true'], select")) return;
      event.preventDefault();
      const id = scopedSelectedId;
      void deleteMessage(id).then(() => {
        setRemovedIds((old) => new Set(old).add(id));
        setSelectedId(null);
        addToast({ message: "邮件已移到废纸篓", type: "success" });
      }).catch((error) => addToast({ message: `删除失败：${extractErrorMessage(error)}`, type: "error" }));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addToast, scopedSelectedId]);

  if (error && messages.length === 0) {
    return (
      <div className="fade-in" style={{
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        height: "100%", gap: "12px", color: "var(--color-text-secondary)",
      }}>
        <Star size={40} strokeWidth={1.2} />
        <p style={{ color: "var(--color-error, #e53e3e)", fontSize: "14px", margin: 0 }}>
          {t("starred.loadError", "Failed to load starred messages")}
        </p>
        <p style={{ fontSize: "13px", margin: 0 }}>{extractErrorMessage(error)}</p>
        <button
          onClick={() => refetch()}
          style={{
            marginTop: "4px",
            padding: "6px 16px",
            borderRadius: "4px",
            border: "1px solid var(--color-border)",
            backgroundColor: "transparent",
            color: "var(--color-accent)",
            fontSize: "13px",
            cursor: "pointer",
          }}
        >
          {t("common.retry", "Retry")}
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--color-text-secondary)" }}>
        <Star size={20} className="spinner" style={{ marginRight: "8px" }} />
        {t("common.loading", "Loading...")}
      </div>
    );
  }

  if (visibleMessages.length === 0 && !hasNextPage) {
    return (
      <div className="fade-in" style={{
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        height: "100%", gap: "12px", color: "var(--color-text-secondary)",
      }}>
        <Star size={40} strokeWidth={1.2} />
        <p style={{ fontSize: "14px", margin: 0 }}>{t("starred.empty", "No starred messages")}</p>
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ display: "flex", height: "100%" }}>
      <div style={{
        width: scopedSelectedId ? "340px" : "100%",
        borderRight: scopedSelectedId ? "1px solid var(--color-border)" : "none",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        transition: "width 0.15s ease",
      }}>
        <div style={{
          padding: "12px 16px", borderBottom: "1px solid var(--color-border)",
          fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)",
          display: "flex", alignItems: "center", gap: "8px",
        }}>
          <Star size={16} />
          {t("starred.title", "Starred Messages")}
          <span style={{
            fontSize: "12px", fontWeight: 400, color: "var(--color-text-secondary)",
            backgroundColor: "var(--color-bg-secondary, rgba(0,0,0,0.06))",
            padding: "2px 8px", borderRadius: "10px",
          }}>
            {totalCount}
          </span>
        </div>

        <div ref={parentRef} className="scroll-region starred-list-scroll" style={{ flex: 1, overflow: "auto" }}>
          <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
            {virtualItems.map((virtualItem) => {
              const msg = visibleMessages[virtualItem.index];
              return (
                <div
                  key={msg.id}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <MessageItem
                    message={msg}
                    isSelected={msg.id === scopedSelectedId}
                    onClick={() => handleOpen(msg.id)}
                    onToggleStar={handleToggleStar}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {hasNextPage && isFetchingNextPage && (
          <div style={{
            borderTop: "1px solid var(--color-border)",
            padding: "10px 16px",
            display: "flex",
            justifyContent: "center",
          }}>
            <span role="status" style={{ color: "var(--color-text-secondary)", fontSize: "12px" }}>
              {t("common.loading", "Loading...")}
            </span>
          </div>
        )}
      </div>

      {scopedSelectedId && (
        <div className="scroll-region starred-detail-scroll" style={{ flex: 1, overflow: "auto" }}>
          <MessageDetail
            messageId={scopedSelectedId}
            onBack={() => setSelectedId(null)}
          />
        </div>
      )}
    </div>
  );
}
