import { Sparkles, Wrench, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUIStore, type RightPanelTool } from "@/stores/ui.store";
import AiWritingTab from "@/features/settings/AiWritingTab";
import ForeignToolsTab from "@/features/settings/ForeignToolsTab";
import { useCallback, useState } from "react";

const TOOLS: Array<{ id: RightPanelTool; label: string; icon: React.ReactNode }> = [
  { id: "aiWriting", label: "AI 写作", icon: <Sparkles size={15} /> },
  { id: "foreignTools", label: "外贸工具", icon: <Wrench size={15} /> },
];

/** 右侧工具区：点击某个工具只打开该工具；两个工具都打开时并排显示，最多两个。 */
export default function RightToolsPanels() {
  const { t } = useTranslation();
  const openTools = useUIStore((state) => state.rightPanelTools);
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

  if (openTools.length === 0) return null;

  return (
    <div aria-label={t("sidebar.tools", "Tools")} style={{ display: "flex", flexDirection: "row", minWidth: 0, minHeight: 0, maxWidth: "100%" }}>
      {openTools.map((toolId) => {
        const item = TOOLS.find((candidate) => candidate.id === toolId);
        if (!item) return null;
        const multiple = openTools.length > 1;
        return (
          <aside
            key={item.id}
            aria-label={item.label}
            style={{
              width: multiple ? "min(360px, 42vw)" : `${panelWidth}px`,
              minWidth: multiple ? "min(280px, 38vw)" : "300px",
              maxWidth: multiple ? "42vw" : "60vw",
              flex: multiple ? "1 1 0" : "0 0 auto",
              display: "flex",
              flexDirection: "column",
              borderLeft: "1px solid var(--color-border)",
              background: "var(--color-bg-primary)",
              minHeight: 0,
              position: "relative",
            }}
          >
            <div role="separator" aria-label={`调整${item.label}宽度`} onMouseDown={beginResize} style={{ position: "absolute", left: "-3px", top: 0, bottom: 0, width: "6px", cursor: "col-resize", zIndex: 5 }} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--color-border)", flexShrink: 0, background: "var(--color-bg-secondary)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, fontSize: 12, fontWeight: 600 }}>
                {item.icon}
                <span>{item.label}</span>
                {item.id === "aiWriting" && aiBgTask?.running && aiBgTask.source === "panel" && <span className="spinner" style={{ width: 10, height: 10, border: "2px solid var(--color-border)", borderTopColor: "var(--color-accent)", borderRadius: "50%", display: "inline-block" }} title="AI 生成中…" />}
                {item.id === "aiWriting" && aiBgTask && !aiBgTask.running && aiBgTask.source === "panel" && aiBgTask.result && <span style={{ fontSize: 10, color: "#22c55e", fontWeight: 700 }} title="AI 生成完成，草稿已写入写信页">✓</span>}
              </div>
              <button type="button" aria-label={`关闭${item.label}`} title={`关闭${item.label}`} onClick={() => closeRightPanel(item.id)} style={{ width: 26, height: 26, display: "grid", placeItems: "center", border: 0, borderRadius: 5, background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}>
                <X size={15} />
              </button>
            </div>
            <div className="scroll-region" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "18px" }}>
              {item.id === "aiWriting" && <AiWritingTab quick />}
              {item.id === "foreignTools" && <ForeignToolsTab />}
            </div>
          </aside>
        );
      })}
    </div>
  );
}
