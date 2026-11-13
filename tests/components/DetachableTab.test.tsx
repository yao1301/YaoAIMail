import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DetachableTab from '@/components/DetachableTab';
import type { NavTab } from '@/stores/ui.store';
const h = vi.hoisted(() => ({ detach: vi.fn() }));
vi.mock('@/lib/workspaceWindows', () => ({ detachWorkspaceTab: h.detach }));
beforeEach(() => {
  h.detach.mockReset().mockResolvedValue(undefined);
  class Pointer extends MouseEvent { readonly pointerId: number; constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; } }
  vi.stubGlobal('PointerEvent', Pointer);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup(view: NavTab['view']) {
  const tab: NavTab = { key: `feature:${view}`, kind: 'feature', view, label: view };
  const click = vi.fn();
  const rendered = render(<div data-workspace-tabs><DetachableTab tab={tab} onClick={click}>{view}<span role="button">close</span></DetachableTab></div>);
  vi.spyOn(rendered.container.firstElementChild!, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 1000, top: 30, bottom: 70 } as DOMRect);
  return { tab: screen.getByRole('button', { name: `${view} close` }), data: tab, click };
}
function drag(element: HTMLElement, endY = 180) {
  fireEvent.pointerDown(element, { button: 0, pointerId: 1, clientX: 100, clientY: 50 });
  fireEvent.pointerMove(element, { pointerId: 1, clientX: 120, clientY: endY });
  fireEvent.pointerUp(element, { pointerId: 1, clientX: 120, clientY: endY });
}
it.each(['leadFinder','companyResearch','settings','aiWriting'] as const)('detaches %s and suppresses the following click', async view => {
  const { tab, data, click } = setup(view); drag(tab); fireEvent.click(tab);
  await waitFor(() => expect(h.detach).toHaveBeenCalledExactlyOnceWith(data)); expect(click).not.toHaveBeenCalled();
});
it('retains normal clicks and rejects an in-strip drag or close-icon gesture', () => {
  const { tab, click } = setup('settings'); fireEvent.click(tab); expect(click).toHaveBeenCalledOnce();
  drag(tab, 55); drag(tab.querySelector('[role="button"]')!); expect(h.detach).not.toHaveBeenCalled();
});
it('cancels a move with Escape', () => {
  const { tab } = setup('leadFinder');
  fireEvent.pointerDown(tab, { button: 0, pointerId: 1, clientX: 100, clientY: 50 });
  fireEvent.pointerMove(tab, { pointerId: 1, clientX: 120, clientY: 180 });
  expect(screen.getByRole('status').textContent).toContain('拖出标签栏后松开');
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.pointerUp(tab, { pointerId: 1, clientX: 120, clientY: 180 });
  expect(h.detach).not.toHaveBeenCalled();
});
