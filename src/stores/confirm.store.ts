import { create } from "zustand";

interface ConfirmState {
  isOpen: boolean;
  title: string;
  message: string;
  destructive: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  alternateLabel?: string;
  onAlternate?: () => Promise<boolean>;
  busy: boolean;
  resolve: ((value: boolean) => void) | null;
  confirm: (opts: {
    title: string;
    message: string;
    destructive?: boolean;
    confirmLabel?: string;
    cancelLabel?: string;
    alternateLabel?: string;
    onAlternate?: () => Promise<boolean>;
  }) => Promise<boolean>;
  handleConfirm: () => void;
  handleCancel: () => void;
  handleAlternate: () => Promise<void>;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  isOpen: false,
  title: "",
  message: "",
  destructive: false,
  confirmLabel: undefined,
  cancelLabel: undefined,
  alternateLabel: undefined,
  onAlternate: undefined,
  busy: false,
  resolve: null,
  confirm: (opts) =>
    new Promise<boolean>((resolve) => {
      set({
        isOpen: true,
        title: opts.title,
        message: opts.message,
        destructive: opts.destructive ?? false,
        confirmLabel: opts.confirmLabel,
        cancelLabel: opts.cancelLabel,
        alternateLabel: opts.alternateLabel,
        onAlternate: opts.onAlternate,
        busy: false,
        resolve,
      });
    }),
  handleConfirm: () => {
    if (get().busy) return;
    const { resolve } = get();
    resolve?.(true);
    set({ isOpen: false, resolve: null });
  },
  handleCancel: () => {
    if (get().busy) return;
    const { resolve } = get();
    resolve?.(false);
    set({ isOpen: false, resolve: null });
  },
  handleAlternate: async () => {
    const { onAlternate, busy, resolve } = get();
    if (busy || !onAlternate) return;
    set({ busy: true });
    try {
      if (await onAlternate()) {
        if (get().resolve === resolve) { resolve?.(true); set({ isOpen: false, resolve: null }); }
      }
    } finally { set({ busy: false }); }
  },
}));
