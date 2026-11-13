import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import WorkspaceWindowApp from '@/app/WorkspaceWindowApp';
import { profileLocalStorage } from '@/lib/profileStorage';
import { useUIStore } from '@/stores/ui.store';

const h = vi.hoisted(() => ({ invoke: vi.fn(), connect: vi.fn(), dispose: vi.fn(), ready: false, page: Promise.resolve() as Promise<void> }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {} }) }));
vi.mock('@/lib/workspaceWindows', () => ({ connectWorkspace: h.connect, hasTransferredWork: () => false }));
vi.mock('@/hooks/useKeyboard', () => ({ useKeyboard: () => {} }));
vi.mock('@/components/TitleBar', () => ({ default: () => <div>Window shell</div> }));
vi.mock('@/components/WorkspaceTabs', () => ({ default: () => null }));
vi.mock('@/components/ToastContainer', () => ({ default: () => null }));
vi.mock('@/features/translate/SelectionTranslateOverlay', () => ({ default: () => null }));
vi.mock('@/features/compose/ComposeWindowConfirm', () => ({ ComposeWindowConfirm: () => null }));
vi.mock('@/features/command-palette/CommandPalette', () => ({ default: () => null }));
vi.mock('@/features/command-palette/commands', () => ({ buildCommands: () => [] }));
vi.mock('@/app/WorkspaceContent', async () => {
  const { Suspense, useEffect } = await import('react');
  function Loaded({ onReady }: { onReady: () => void }) {
    useEffect(onReady, [onReady]);
    return <div>Restored feature</div>;
  }
  function SlowFeature({ onReady }: { onReady: () => void }) {
    if (!h.ready) throw h.page;
    return <Loaded onReady={onReady} />;
  }
  return { WorkspaceContent: ({ onReady }: { onReady: () => void }) => <Suspense fallback={<div>Loading feature</div>}><SlowFeature onReady={onReady} /></Suspense> };
});

afterEach(() => {
  cleanup();
  history.replaceState(null, '', '/');
  profileLocalStorage.removeItem('pebble-theme');
});

it('reveals the shell while the feature loads and confirms handoff only after it mounts', async () => {
  history.replaceState(null, '', '/?workspaceWindow=1&transfer=fixture');
  let release!: () => void;
  h.ready = false;
  profileLocalStorage.setItem('pebble-theme', 'studio');
  h.page = new Promise<void>(resolve => { release = resolve; });
  h.connect.mockResolvedValue({ dispose: h.dispose });
  h.invoke.mockImplementation(async (name: string) => name === 'read_workspace_window'
    ? JSON.stringify({ content: { type: 'json', value: { id: 'feature:leadFinder', view: 'leadFinder', queries: [], mail: {}, ui: { theme: 'light' }, tasks: {}, progress: {}, state: {} } } })
    : undefined);
  render(<WorkspaceWindowApp />);
  expect(await screen.findByText('Loading feature')).toBeTruthy();
  expect(screen.getByText('Window shell')).toBeTruthy();
  expect(useUIStore.getState().theme).toBe('studio');
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('show_workspace_window', { token: 'fixture' }));
  expect(h.invoke).not.toHaveBeenCalledWith('ready_workspace_window', expect.anything());
  await act(async () => { h.ready = true; release(); await h.page; });
  expect(screen.getByText('Restored feature')).toBeTruthy();
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('ready_workspace_window', { token: 'fixture' }));
});
