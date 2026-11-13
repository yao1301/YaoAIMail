export interface Point { x: number; y: number }
export interface TabStripBounds { left: number; right: number; top: number; bottom: number }

/** Small pointer jitter and a drop among the tabs must never tear a tab off. */
export function shouldDetachMailTab(start: Point, end: Point, strip: TabStripBounds): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) >= 12
    && (end.y < strip.top - 24 || end.y > strip.bottom + 24 || end.x < strip.left - 24 || end.x > strip.right + 24);
}
