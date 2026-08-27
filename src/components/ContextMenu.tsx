import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  label?: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  /** Keep the menu open after the click (used for submenus). */
  keepOpen?: boolean;
  onClick?: () => void;
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/**
 * Lightweight right-click context menu. Closes on outside click, Escape or
 * scroll. `separator: true` renders a divider before the item.
 */
export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    function handleScroll(event: Event) {
      // 菜单自身内部滚动（菜单过长时的 overflow:auto 滚动条）不应关闭菜单；
      // 只有页面其他区域滚动才关闭。
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose]);

  const menuWidth = 230;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const left = Math.min(x, viewport.width - menuWidth - 8);
  const top = Math.min(y, viewport.height - Math.min(items.length * 32 + 16, viewport.height - 16));

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        position: "fixed",
        left: Math.max(8, left),
        top: Math.max(8, top),
        zIndex: 2147483000,
        minWidth: menuWidth,
        maxWidth: 320,
        maxHeight: "80vh",
        overflow: "auto",
        background: "var(--color-bg)",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        boxShadow: "0 8px 28px rgba(0,0,0,0.28)",
        padding: "4px",
        fontSize: 13,
        opacity: 1,
      }}
    >
      {items.map((item, index) => (
        <div key={`${item.label ?? "item"}-${index}`}>
          {item.separator && (
            <div style={{ height: 1, background: "var(--color-border)", margin: "4px 6px" }} />
          )}
          {!item.separator && (
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                if (!item.keepOpen) onClose();
                item.onClick?.();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "7px 10px",
                border: "none",
                background: "transparent",
                color: item.danger ? "#dc3545" : "var(--color-text-primary)",
                borderRadius: 5,
                cursor: item.disabled ? "default" : "pointer",
                opacity: item.disabled ? 0.45 : 1,
                textAlign: "left",
                fontSize: 13,
              }}
              onMouseEnter={(e) => {
                if (!item.disabled) e.currentTarget.style.backgroundColor = "var(--color-bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "transparent";
              }}
            >
              {item.icon && <span style={{ display: "flex", color: "var(--color-text-secondary)" }}>{item.icon}</span>}
              <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {item.label}
              </span>
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}
