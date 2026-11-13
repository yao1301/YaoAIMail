import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startSync, stopSync } from "../../src/lib/api";
import { useComposeStore } from '../../src/stores/compose.store';
import { useConfirmStore } from '../../src/stores/confirm.store';
import { registerDraftSaver } from '../../src/features/compose/draftPersistence';
import { WorkspaceStateScope, trackWorkspaceSource } from '../../src/lib/workspaceState';

const mocks = vi.hoisted(() => ({
  accounts: [{ id: "account-1" }, { id: "account-2" }],
  closeHandler: undefined as undefined | ((event: { preventDefault: () => void }) => void | Promise<void>),
  focusHandler: undefined as undefined | ((event: { payload: boolean }) => void),
  hide: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  onCloseRequested: vi.fn((handler: (event: { preventDefault: () => void }) => void | Promise<void>) => {
    mocks.closeHandler = handler;
    return Promise.resolve(vi.fn());
  }),
  onFocusChanged: vi.fn((handler: (event: { payload: boolean }) => void) => {
    mocks.focusHandler = handler;
    return Promise.resolve(vi.fn());
  }),
  uiState: {
    keepRunningInBackground: false,
    pollInterval: 5,
    realtimeMode: "realtime" as "realtime" | "balanced" | "battery" | "manual",
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    hide: mocks.hide,
    destroy: mocks.destroy,
    onCloseRequested: mocks.onCloseRequested,
    onFocusChanged: mocks.onFocusChanged,
  }),
}));

vi.mock("../../src/lib/api", () => ({
  startSync: vi.fn().mockResolvedValue(undefined),
  stopSync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/hooks/queries", () => ({
  useAccountsQuery: () => ({ data: mocks.accounts }),
}));

vi.mock("../../src/stores/ui.store", () => {
  const useUIStore = (selector: (state: typeof mocks.uiState) => unknown) => selector(mocks.uiState);
  useUIStore.getState = () => mocks.uiState;
  return { useUIStore };
});

import { useCloseToBackground } from "../../src/app/useCloseToBackground";

function Harness() {
  useCloseToBackground();
  return null;
}

describe("useCloseToBackground", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useComposeStore.setState({ tabs: [], tabsById: {}, activeTabId: null, composeMode: null, composeDirty: false });
    useConfirmStore.setState({ isOpen: false, busy: false, resolve: null });
    mocks.closeHandler = undefined;
    mocks.focusHandler = undefined;
    mocks.accounts = [{ id: "account-1" }, { id: "account-2" }];
    mocks.uiState.keepRunningInBackground = false;
    mocks.uiState.pollInterval = 5;
    mocks.uiState.realtimeMode = "realtime";
  });

  it("lets the app close normally when background mode is disabled", async () => {
    render(<Harness />);

    await waitFor(() => expect(mocks.onCloseRequested).toHaveBeenCalledOnce());
    const preventDefault = vi.fn();
    await mocks.closeHandler?.({ preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(mocks.hide).not.toHaveBeenCalled();
  });

  it("keeps sync workers running when hiding the window to tray", async () => {
    mocks.uiState.keepRunningInBackground = true;
    render(<Harness />);

    await waitFor(() => expect(mocks.onCloseRequested).toHaveBeenCalledOnce());
    const preventDefault = vi.fn();
    await mocks.closeHandler?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.hide).toHaveBeenCalledOnce();
    expect(stopSync).not.toHaveBeenCalled();
  });
  it('retains transferred task callbacks even when background mode is disabled', async () => {
    const scope = new WorkspaceStateScope({'search:busy':true});
    const release = trackWorkspaceSource(scope);
    render(<Harness />);
    await waitFor(() => expect(mocks.onCloseRequested).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    try {
      const preventDefault = vi.fn();
      await mocks.closeHandler?.({preventDefault});
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(mocks.hide).toHaveBeenCalledOnce();
      expect(mocks.destroy).not.toHaveBeenCalled();
      scope.write('search:busy',false);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(mocks.destroy).toHaveBeenCalledOnce();
    } finally { release();vi.useRealTimers(); }
  });

  it("resumes sync when the hidden window regains focus", async () => {
    render(<Harness />);

    await waitFor(() => expect(mocks.onFocusChanged).toHaveBeenCalledOnce());
    mocks.focusHandler?.({ payload: true });

    expect(startSync).toHaveBeenCalledWith("account-1", 5);
    expect(startSync).toHaveBeenCalledWith("account-2", 5);
  });

  it("does not resume sync in manual realtime mode", async () => {
    mocks.uiState.realtimeMode = "manual";
    render(<Harness />);

    await waitFor(() => expect(mocks.onFocusChanged).toHaveBeenCalledOnce());
    mocks.focusHandler?.({ payload: true });

    expect(startSync).not.toHaveBeenCalled();
  });

  it('waits for save-and-exit before destroying a dirty window', async () => {
    useComposeStore.setState({ composeMode: 'new', composeDirty: true });
    const cleanup = registerDraftSaver(undefined, async () => { useComposeStore.getState().setComposeDirty(false); return 'draft'; });
    try {
      render(<Harness />);
      await waitFor(() => expect(mocks.onCloseRequested).toHaveBeenCalledOnce());
      const preventDefault = vi.fn();
      const closing = mocks.closeHandler?.({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(mocks.destroy).not.toHaveBeenCalled();
      await useConfirmStore.getState().handleAlternate();
      await closing;
      expect(mocks.destroy).toHaveBeenCalledOnce();
    } finally { cleanup(); }
  });
});
