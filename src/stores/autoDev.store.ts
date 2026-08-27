import { create } from "zustand";

export interface AutoDevReportItem {
  company: string;
  email: string;
  person?: string;
  status: "sent" | "failed" | "skipped";
  error?: string;
  subject?: string;
  timestamp?: number;
}

export interface AutoDevState {
  running: boolean;
  paused: boolean;
  stopRequested: boolean;
  useStyle: boolean;
  startTime: number | null;
  endTime: number | null;
  autoNext: boolean;
  total: number;
  done: number;
  sent: number;
  failed: number;
  skipped: number;
  report: AutoDevReportItem[];
  current: string;
  sendAccountId: string;
}

const initial: AutoDevState = {
  running: false,
  paused: false,
  stopRequested: false,
  useStyle: true,
  startTime: null,
  endTime: null,
  autoNext: false,
  total: 0,
  done: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
  report: [],
  current: "",
  sendAccountId: "",
};

interface AutoDevStore extends AutoDevState {
  configure: (patch: Partial<AutoDevState>) => void;
  begin: (patch: Partial<AutoDevState>) => void;
  updateProgress: (patch: Partial<AutoDevState>) => void;
  pause: () => void;
  resume: () => void;
  requestStop: () => void;
  finish: (patch: Partial<AutoDevState>) => void;
}

export const useAutoDevStore = create<AutoDevStore>((set) => ({
  ...initial,
  configure: (patch) => set((state) => state.running ? state : { ...state, ...patch }),
  begin: (patch) => set({ ...initial, ...patch, running: true, stopRequested: false, paused: false }),
  updateProgress: (patch) => set((state) => ({ ...state, ...patch })),
  pause: () => set((state) => state.running ? { ...state, paused: true, current: `已暂停 · ${state.current}` } : state),
  resume: () => set((state) => state.running ? { ...state, paused: false, current: state.current.replace(/^已暂停 · /, "") } : state),
  requestStop: () => set((state) => state.running ? { ...state, stopRequested: true, paused: false, current: "正在停止（当前请求完成后停止）…" } : state),
  finish: (patch) => set((state) => ({ ...state, ...patch, running: false, paused: false, stopRequested: false })),
}));

export async function waitForAutoDevControl(delayMs = 0): Promise<"continue" | "stop"> {
  const end = Date.now() + delayMs;
  while (Date.now() < end || useAutoDevStore.getState().paused) {
    const state = useAutoDevStore.getState();
    if (state.stopRequested) return "stop";
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return useAutoDevStore.getState().stopRequested ? "stop" : "continue";
}
