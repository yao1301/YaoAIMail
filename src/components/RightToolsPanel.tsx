import { Maximize2, Sparkles, Wrench, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUIStore, type RightPanelTool } from "@/stores/ui.store";
import AiWritingTab from "@/features/settings/AiWritingTab";
import ForeignToolsTab from "@/features/settings/ForeignToolsTab";
import { useCallback, useState } from "react";

const TOOLS: Array<{
  id: RightPanelTool;
  label: string;
  icon: React.ReactNode;
}> = [
  { id: "aiWriting", label: "AI 写作", icon: <Sparkles size={15} /> },
  { id: "foreignTools", label: "外贸工具", icon: <Wrench size={15} /> },
];

export default function RightToolsPanel() {
  const { t } = useTranslation();
  const tool = useUIStore((state) => state.rightPanelTool);
  const openRightPanel = useUIStore((state) => state.openRightPanel);
  const closeRightPanel = useUIStore((state) => state.closeRightPanel);
  const aiBgTask = useUIStore((state) => state.aiBgTask);
  const [panelWidth, setPanelWidth] = useState(() => {
    const stored = Number(localStorage.getItem("yaoaimail-right-panel-width-v2"));
    return Number.isFinite(stored) && stored >= 300 ? Math.min(stored, 720) : 360;
  });
  const beginResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidth;
    const onMove = (moveEvent: MouseEvent) => {
      setPanelWidth(Math.min(720, Math.max(300, startWidth + startX - moveEvent.clientX)));
    };
    const onUp = (upEvent: MouseEvent) => {
      const next = Math.min(720, Math.max(300, startWidth + startX - upEvent.clientX));
      localStorage.setItem("yaoaimail-right-panel-width-v2", String(next));
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [panelWidth]);

  return (
    <aside
      aria-label={t("sidebar.tools", "Tools")}
      style={{
        width: `${panelWidth}px`,
        minWidth: "300px",
        maxWidth: "60vw",
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid var(--color-border)",
        background: "var(--color-bg-primary)",
        minHeight: 0,
        position: "relative",
      }}
    >
      <div
        role="separator"
        aria-label="调整右侧工具栏宽度"
        onMouseDown={beginResize}
        style={{
          position: "absolute",
          left: "-3px",
          top: 0,
          bottom: 0,
          width: "6px",
          cursor: "col-resize",
          zIndex: 5,
        }}
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr auto",
          alignItems: "stretch",
          borderBottom: "1px solid var(--color-border)",
          flexShrink: 0,
        }}
      >
        {TOOLS.map((item) => {
          const active = item.id === tool;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={active}
              onClick={() => openRightPanel(item.id)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "5px",
                minWidth: 0,
                padding: "10px 6px",
                border: "none",
                borderBottom: active ? "2px solid var(--color-accent)" : "2px solid transparent",
                background: active ? "var(--color-bg-hover)" : "transparent",
                color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                fontSize: "12px",
                fontWeight: active ? 600 : 500,
                cursor: "pointer",
              }}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.id === "aiWriting" && aiBgTask?.running && aiBgTask.source === "panel" && (
                <span className="spinner" style={{ width: 10, height: 10, border: "2px solid var(--color-border)", borderTopColor: "var(--color-accent)", borderRadius: "50%", display: "inline-block" }} title="AI 生成中…" />
              )}
              {item.id === "aiWriting" && aiBgTask && !aiBgTask.running && aiBgTask.source === "panel" && aiBgTask.result && (
                <span style={{ fontSize: 10, color: "#22c55e", fontWeight: 700 }} title="AI 生成完成，草稿已写入写信页">✓</span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          aria-label="关闭右侧工具栏"
          title="关闭右侧工具栏"
          onClick={() => closeRightPanel()}
          style={{
            width: "34px",
            border: "none",
            background: "transparent",
            color: "var(--color-text-secondary)",
            cursor: "pointer",
          }}
        >
          <X size={16} />
        </button>
        {tool === "aiWriting" && (
          <button
            type="button"
            title="弹出悬浮 AI 写作"
            aria-label="弹出悬浮 AI 写作"
            onClick={() => closeRightPanel()}
            style={{ display: "none", width: "34px", border: "none", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}
          >
            <Maximize2 size={15} />
          </button>
        )}
      </div>

      <div className="scroll-region" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "18px" }}>
        {tool === "aiWriting" && <AiWritingTab quick />}
        {tool === "foreignTools" && <ForeignToolsTab />}
      </div>
    </aside>
  );
}
