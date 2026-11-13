export interface HistoryPoint { left: number; top: number }
interface Size { width: number; height: number }
interface Anchor { left: number; right: number; top: number; bottom: number }
const EDGE = 10;

export function clampHistoryPosition(point: HistoryPoint, panel: Size, viewport: Size): HistoryPoint {
  return {
    left: Math.max(EDGE, Math.min(point.left, Math.max(EDGE, viewport.width - panel.width - EDGE))),
    top: Math.max(EDGE, Math.min(point.top, Math.max(EDGE, viewport.height - panel.height - EDGE))),
  };
}

/** Prefer the button's lower-right edge; flip upwards only when it has more room. */
export function anchorHistoryPosition(anchor: Anchor, panel: Size, viewport: Size) {
  const below = Math.max(0, viewport.height - anchor.bottom - EDGE - 6);
  const above = Math.max(0, anchor.top - EDGE - 6);
  const upwards = below < Math.min(220, panel.height) && above > below;
  const maxHeight = Math.min(560, Math.max(120, upwards ? above : below), Math.max(120, viewport.height - EDGE * 2));
  const height = Math.min(panel.height, maxHeight);
  return { ...clampHistoryPosition({ left:anchor.right-panel.width, top:upwards ? anchor.top-6-height : anchor.bottom+6 },{...panel,height},viewport), maxHeight };
}
