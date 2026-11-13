import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceStateBoundary, WorkspaceStateScope, getWorkspaceScope, useWorkspaceInitEffect, useWorkspacePrepare, useWorkspaceState, hasWorkspaceActivity } from '@/lib/workspaceState';
afterEach(cleanup);
function Form({ load = () => {} }: { load?: () => void }) {
  const [text, setText] = useWorkspaceState('form:text', '');
  useWorkspaceInitEffect('form:', load, []);
  useWorkspacePrepare(async () => () => {});
  return <input aria-label="field" value={text} onChange={e => setText(e.target.value)} />;
}
it('moves an unsaved field without reloading the stored configuration over it', () => {
  const load = vi.fn(); const original = render(<WorkspaceStateBoundary id="feature:settings"><Form load={load}/></WorkspaceStateBoundary>);
  fireEvent.change(screen.getByLabelText('field'), { target: { value: 'unsaved-local-value' } });
  const state = getWorkspaceScope('feature:settings')!.snapshot();
  expect(getWorkspaceScope('feature:settings')!.prepare).toBeTypeOf('function');
  original.unmount();
  render(<WorkspaceStateBoundary id="moved" initial={state}><Form load={load}/></WorkspaceStateBoundary>);
  expect((screen.getByLabelText('field') as HTMLInputElement).value).toBe('unsaved-local-value');
  expect(load).toHaveBeenCalledTimes(1);
});
it('still loads a settings subsection that was never opened before handoff', () => {
  const load = vi.fn();
  render(<WorkspaceStateBoundary id="moved" initial={{ 'other:field': 'existing' }}><Form load={load}/></WorkspaceStateBoundary>);
  expect(load).toHaveBeenCalledTimes(1);
});
it('retains functional setters and receives late results after source unmount', () => {
  const scope = new WorkspaceStateScope(); let update!: (value: string) => void;
  function Source() { const [, set] = useWorkspaceState('form:text', ''); update = set; return null; }
  const source = render(<WorkspaceStateBoundary id="source" scope={scope}><Source/></WorkspaceStateBoundary>);
  const receiving = new WorkspaceStateScope(scope.snapshot()); scope.observers.add((key, value) => receiving.write(key, value));
  source.unmount(); render(<WorkspaceStateBoundary id="target" scope={receiving}><Form/></WorkspaceStateBoundary>);
  act(() => update('late result')); expect((screen.getByLabelText('field') as HTMLInputElement).value).toBe('late result');
  fireEvent.change(screen.getByLabelText('field'), { target: { value: 'edited in target' } });
  expect(receiving.snapshot()['form:text']).toBe('edited in target');
});
it('tracks in-flight contact work across source unmount and preserves the receiver keepalive flag', async () => {
  const source = new WorkspaceStateScope();
  let complete!: () => void;
  const job = source.run(() => new Promise<void>(resolve => { complete = resolve; }));
  const receiving = new WorkspaceStateScope(source.snapshot());
  source.observers.add((key, value) => receiving.write(key, value));
  expect(hasWorkspaceActivity()).toBe(true); expect(receiving.isWorking()).toBe(true);
  complete(); await job;
  expect(receiving.isWorking()).toBe(false); expect(hasWorkspaceActivity()).toBe(false);
});
