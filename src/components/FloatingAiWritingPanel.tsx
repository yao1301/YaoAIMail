import { ChevronsRight, X } from "lucide-react";
import { useRef } from "react";
import AiWritingTab from "@/features/settings/AiWritingTab";
import { useUIStore } from "@/stores/ui.store";

export default function FloatingAiWritingPanel() {
  const position = useUIStore((s) => s.aiWritingFloatPosition);
  const setPosition = useUIStore((s) => s.setAiWritingFloatPosition);
  const setFloating = useUIStore((s) => s.setAiWritingFloating);
  const drag = useRef<{ startX: number; startY: number; x: number; y: number } | null>(null);

  function beginDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    drag.current = { startX: event.clientX, startY: event.clientY, x: position.x, y: position.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const next = {
      x: Math.max(8, Math.min(window.innerWidth - 360, drag.current.x + event.clientX - drag.current.startX)),
      y: Math.max(35, Math.min(window.innerHeight - 120, drag.current.y + event.clientY - drag.current.startY)),
    };
    setPosition(next);
  }

  return (
    <section style={{ position: "fixed", left: position.x, top: position.y, width: 430, height: "min(760px, calc(100vh - 55px))", minWidth: 360, minHeight: 300, maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100vh - 45px)", resize: "both", zIndex: 80, display: "flex", flexDirection: "column", border: "1px solid var(--color-border)", borderRadius: 10, overflow: "hidden", background: "var(--color-bg-primary)", boxShadow: "0 18px 50px rgba(0,0,0,.28)" }}>
      <div
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={() => { drag.current = null; }}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "9px 12px", cursor: "move", userSelect: "none", background: "var(--color-bg-secondary)", borderBottom: "1px solid var(--color-border)" }}
      >
        <strong style={{ fontSize: 13 }}>AI 写作（可拖动）</strong>
        <div style={{ display: "flex", gap: 4 }}>
          <button type="button" title="收回右侧 AI 写作面板" aria-label="收回右侧 AI 写作面板" onPointerDown={(e) => e.stopPropagation()} onClick={() => { setFloating(false); useUIStore.getState().openRightPanel("aiWriting"); }} style={{ border: 0, background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}><ChevronsRight size={16} /></button>
          <button type="button" title="关闭悬浮窗口" onPointerDown={(e) => e.stopPropagation()} onClick={() => setFloating(false)} style={{ border: 0, background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}><X size={15} /></button>
        </div>
      </div>
      <div className="scroll-region" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 14 }}><AiWritingTab quick /></div>
    </section>
  );
}
