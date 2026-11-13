import { create } from "zustand";
import { useToastStore } from "./toast.store";
import { reportAppError, safeErrorMessage } from "@/lib/appErrors";

export type BackgroundTaskStatus = "running" | "success" | "error";

export interface BackgroundTask<T = unknown> {
  id: string;
  label: string;
  /** Lightweight native stage; retained when the originating view unmounts. */
  progress?: string;
  status: BackgroundTaskStatus;
  /** Value returned by the runner when the task finishes. */
  result?: T;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

interface BackgroundTasksState {
  tasks: Record<string, BackgroundTask>;
  /**
   * Start a long-running task. The task lives in this store, so navigating to
   * another view does not cancel it; a toast announces completion and the
   * result stays available for the originating view to pick up.
   */
  start: (
    id: string,
    label: string,
    runner: () => Promise<unknown>,
    options?: {
      /** Custom success toast; a function receives the result. Return null to suppress the toast. */
      successMessage?: string | ((result: unknown) => string | null);
    },
  ) => void;
  clear: (id: string) => void;
}

export const useBackgroundTasksStore = create<BackgroundTasksState>((set) => ({
  tasks: {},
  start: (id, label, runner, options) => {
    set((state) => ({
      tasks: {
        ...state.tasks,
        [id]: { id, label, status: "running", startedAt: Date.now() },
      },
    }));
    runner()
      .then((result) => {
        set((state) => ({
          tasks: {
            ...state.tasks,
            [id]: {
              ...state.tasks[id],
              status: "success",
              result,
              error: undefined,
              finishedAt: Date.now(),
            },
          },
        }));
        const custom = typeof options?.successMessage === "function"
          ? options.successMessage(result)
          : options?.successMessage;
        const message = custom === undefined ? `${label}已完成。` : custom;
        if (message) {
          useToastStore.getState().addToast({ message, type: "success" });
        }
      })
      .catch((error: unknown) => {
        const message = safeErrorMessage(error);
        set((state) => ({
          tasks: {
            ...state.tasks,
            [id]: {
              ...state.tasks[id],
              status: "error",
              error: message,
              finishedAt: Date.now(),
            },
          },
        }));
        reportAppError(error, `${label}失败`);
      });
  },
  clear: (id) =>
    set((state) => {
      const next = { ...state.tasks };
      delete next[id];
      return { tasks: next };
    }),
}));
