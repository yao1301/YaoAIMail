import { useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';
import { shouldDetachMailTab, type Point, type TabStripBounds } from './mailTabDrag';
import type { NavTab } from '@/stores/ui.store';
import type { ComposeTab } from '@/stores/compose.store';
import { useToastStore } from '@/stores/toast.store';
import { extractErrorMessage } from '@/lib/extractErrorMessage';

export async function detachTab(tab: NavTab | ComposeTab) {
  try { const { detachWorkspaceTab } = await import('@/lib/workspaceWindows'); await detachWorkspaceTab(tab); }
  catch (error) { useToastStore.getState().addToast({ type: 'error', message: `无法移动标签：${extractErrorMessage(error)}。原标签仍保留。` }); }
}
export default function DetachableTab({ tab, onClick, style, title, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tab: NavTab | ComposeTab }) {
  const gesture = useRef<{ start: Point; strip: TabStripBounds; pointerId: number } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') { gesture.current = null; setDragging(false); } };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, []);
  return <><button {...props} aria-busy={moving} title={`${title ?? ''}（按住标签拖出标签栏，可在独立窗口打开）`} style={{ ...style, cursor: dragging ? 'grabbing' : 'pointer', userSelect: 'none', touchAction: 'none' }}
    onPointerDown={event => {
      if (moving || event.button !== 0 || (event.target as HTMLElement).closest('[role="button"]')) return;
      suppressClick.current = false;
      const strip = event.currentTarget.closest('[data-workspace-tabs]')?.getBoundingClientRect();
      if (!strip) return;
      gesture.current = { start: { x: event.clientX, y: event.clientY }, strip, pointerId: event.pointerId };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }}
    onPointerMove={event => {
      const drag = gesture.current;
      if (drag && Math.hypot(event.clientX-drag.start.x,event.clientY-drag.start.y) >= 12) { suppressClick.current = true; setDragging(true); event.preventDefault(); }
    }}
    onPointerUp={event => {
      const drag = gesture.current; gesture.current = null; setDragging(false);
      if (drag && drag.pointerId === event.pointerId && shouldDetachMailTab(drag.start, { x: event.clientX, y: event.clientY }, drag.strip)) { suppressClick.current = true; setMoving(true); void detachTab(tab).finally(() => setMoving(false)); }
    }}
    onPointerCancel={() => { gesture.current = null; setDragging(false); }}
    onLostPointerCapture={() => { gesture.current = null; setDragging(false); }}
    onClick={event => { if (suppressClick.current) { suppressClick.current = false; return; } onClick?.(event); }}
  />{(dragging || moving) && <span role="status" style={{position:"fixed",top:90,left:"50%",zIndex:1000,padding:"8px 14px",background:"var(--color-bg)",border:"1px solid var(--color-accent)",borderRadius:6,fontSize:12,pointerEvents:"none"}}>{moving ? '正在移到独立窗口…' : '拖出标签栏后松开，在独立窗口打开 · Esc 取消'}</span>}</>;
}
