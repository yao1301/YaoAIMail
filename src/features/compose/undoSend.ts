import { profileLocalStorage } from "@/lib/profileStorage";

export const UNDO_SEND_DELAY_OPTIONS = [0, 5, 10, 15, 30] as const;
export type UndoSendDelaySeconds = (typeof UNDO_SEND_DELAY_OPTIONS)[number];

const STORAGE_KEY = "pebble-undo-send-delay-seconds";
export const DEFAULT_UNDO_SEND_DELAY_SECONDS: UndoSendDelaySeconds = 5;

function isUndoSendDelay(value: number): value is UndoSendDelaySeconds {
  return UNDO_SEND_DELAY_OPTIONS.includes(value as UndoSendDelaySeconds);
}

export function readUndoSendDelay(
  storage: Pick<Storage, "getItem"> = profileLocalStorage,
): UndoSendDelaySeconds {
  const stored = storage.getItem(STORAGE_KEY);
  if (stored === null || stored.trim() === "") return DEFAULT_UNDO_SEND_DELAY_SECONDS;
  const parsed = Number(stored);
  return isUndoSendDelay(parsed) ? parsed : DEFAULT_UNDO_SEND_DELAY_SECONDS;
}

export function writeUndoSendDelay(
  seconds: UndoSendDelaySeconds,
  storage: Pick<Storage, "setItem"> = profileLocalStorage,
) {
  storage.setItem(STORAGE_KEY, String(seconds));
}

export function getUndoSendRemainingSeconds(deadlineMs: number, nowMs = Date.now()): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}
