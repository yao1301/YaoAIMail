import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type DependencyList, type EffectCallback, type ReactNode, type SetStateAction, type Dispatch } from 'react';

type Slot = { value: unknown; listeners: Set<() => void> };
const pendingScopes = new Set<WorkspaceStateScope>();
const busyStateKey = /:(busy|pending|generating|loading|testing|saving|.*Busy|.*Generating)$/;
export class WorkspaceStateScope {
  readonly slots = new Map<string, Slot>();
  readonly restoredKeys: Set<string>;
  readonly observers = new Set<(key: string, value: unknown) => void>();
  prepare?: () => Promise<() => void>;
  element: HTMLDivElement | null = null;
  moved = false;
  transferring = false;
  readonly controls = new Set<() => void>();
  setTransferring(value: boolean) { this.transferring = value; this.controls.forEach(notify => notify()); }
  jobs = 0;
  outbound = 0;
  private jobOwner?: string;
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.jobOwner ??= crypto.randomUUID();
    this.jobs++; pendingScopes.add(this); this.write(`workspace:jobs:${this.jobOwner}`, this.jobs);
    try { return await work(); }
    finally { this.write(`workspace:jobs:${this.jobOwner}`, --this.jobs); if (this.jobs === 0) pendingScopes.delete(this); }
  }
  isWorking() { return this.jobs > 0 || this.outbound > 0 || [...this.slots].some(([key, slot]) => (busyStateKey.test(key) && slot.value === true) || (key.startsWith('workspace:jobs:') && Number(slot.value) > 0)); }
  constructor(initial?: Record<string, unknown>) {
    this.restoredKeys = new Set(Object.keys(initial ?? {}));
    for (const [key, value] of Object.entries(initial ?? {})) this.slots.set(key, { value, listeners: new Set() });
  }
  write(key: string, value: unknown, broadcast = true) {
    const slot = this.slots.get(key);
    if (!slot) {
      this.slots.set(key, { value, listeners: new Set() });
      if (broadcast) this.observers.forEach(observer => observer(key, value));
      return;
    }
    if (Object.is(value, slot.value)) return;
    slot.value = value;
    slot.listeners.forEach(notify => notify());
    if (broadcast) this.observers.forEach(observer => observer(key, value));
  }
  snapshot() { return Object.fromEntries([...this.slots].map(([key, slot]) => [key, slot.value])); }
}
const Context = createContext<WorkspaceStateScope | null>(null);
const mounted = new Map<string, WorkspaceStateScope>();
const transferred = new Map<WorkspaceStateScope, number>();
export function trackWorkspaceSource(scope: WorkspaceStateScope) {
  transferred.set(scope, (transferred.get(scope) ?? 0) + 1);
  return () => { const count = (transferred.get(scope) ?? 1) - 1; if (count) transferred.set(scope, count); else transferred.delete(scope); };
}
export function hasTransferredWork() { return [...transferred.keys()].some(scope => scope.isWorking()); }
export function hasWorkspaceActivity() { return pendingScopes.size > 0 || [...mounted.values()].some(scope => scope.isWorking()); }
export function getWorkspaceScope(id: string) { return mounted.get(id); }
export function WorkspaceStateBoundary({ id, initial, scope: supplied, children }: { id: string; initial?: Record<string, unknown>; scope?: WorkspaceStateScope; children: ReactNode }) {
  const reference = useRef<WorkspaceStateScope | null>(null);
  if (!reference.current) reference.current = supplied ?? new WorkspaceStateScope(initial);
  const scope = reference.current;
  useEffect(() => { mounted.set(id, scope); return () => { if (mounted.get(id) === scope) mounted.delete(id); }; }, [id, scope]);
  return <Context.Provider value={scope}><div ref={element => { scope.element = element; }} data-workspace-id={id} style={{ height: '100%', minHeight: 0 }}>{children}</div></Context.Provider>;
}
/** Explicit, per-component state keys. No React-internal inspection or storage
 * of drafts/credentials in localStorage or window URLs. */
export function useWorkspaceState<T = undefined>(key: string, initial?: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const shared = useContext(Context);
  const local = useRef<WorkspaceStateScope | null>(null);
  if (!shared && !local.current) local.current = new WorkspaceStateScope();
  const scope = (shared ?? local.current)!;
  if (!scope.slots.has(key)) scope.slots.set(key, { value: typeof initial === 'function' ? (initial as () => T)() : initial, listeners: new Set() });
  const slot = scope.slots.get(key)!;
  const value = useSyncExternalStore(notify => { slot.listeners.add(notify); return () => { slot.listeners.delete(notify); }; }, () => slot.value) as T;
  const setter = useRef<Dispatch<SetStateAction<T>>>((next) => {
    scope.write(key, typeof next === 'function' ? (next as (previous: T) => T)(slot.value as T) : next);
  }).current;
  return [value, setter];
}
export function useWorkspacePrepare(prepare: () => Promise<() => void>) {
  const scope = useContext(Context);
  useEffect(() => {
    if (!scope) return;
    scope.prepare = prepare;
    return () => { if (scope.prepare === prepare) scope.prepare = undefined; };
  }, [scope, prepare]);
}
export function useWorkspaceScope() { return useContext(Context); }
export function useWorkspaceIsTransferring() {
  const scope = useContext(Context);
  return useSyncExternalStore(notify => { scope?.controls.add(notify); return () => { scope?.controls.delete(notify); }; }, () => scope?.transferring ?? false);
}
export function useWorkspaceRestored(prefix: string) {
  const scope = useContext(Context);
  return Boolean(scope && [...scope.restoredKeys].some(key => key.startsWith(prefix)));
}
/** Use only for initial data loads; subscriptions and task completion effects
 * still run in the receiving window. */
export function useWorkspaceInitEffect(prefix: string, effect: EffectCallback, deps: DependencyList) {
  const scope = useContext(Context);
  const restored = useWorkspaceRestored(prefix);
  const initialDeps = useRef(deps);
  useEffect(() => {
    if (restored && deps.length === initialDeps.current.length && deps.every((value, index) => Object.is(value, initialDeps.current[index]))) return;
    const cleanup = effect();
    // Initial read callbacks must finish in their owner after a successful
    // handoff. Their explicit setters forward data into the receiving scope.
    return () => { if (!scope?.moved) cleanup?.(); };
  }, deps);
}
