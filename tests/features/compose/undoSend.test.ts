import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNDO_SEND_DELAY_SECONDS,
  getUndoSendRemainingSeconds,
  readUndoSendDelay,
  writeUndoSendDelay,
} from "../../../src/features/compose/undoSend";

function storage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
  };
}

describe("undo send preference", () => {
  it("defaults to five seconds when no valid preference exists", () => {
    expect(DEFAULT_UNDO_SEND_DELAY_SECONDS).toBe(5);
    expect(readUndoSendDelay(storage() as Storage)).toBe(DEFAULT_UNDO_SEND_DELAY_SECONDS);
    expect(readUndoSendDelay(storage("12") as Storage)).toBe(DEFAULT_UNDO_SEND_DELAY_SECONDS);
  });

  it("persists supported choices including disabled", () => {
    const target = storage();
    writeUndoSendDelay(0, target as Storage);
    expect(readUndoSendDelay(target as Storage)).toBe(0);
    writeUndoSendDelay(30, target as Storage);
    expect(readUndoSendDelay(target as Storage)).toBe(30);
  });

  it("rounds remaining time upward and never returns a negative value", () => {
    expect(getUndoSendRemainingSeconds(10_000, 1)).toBe(10);
    expect(getUndoSendRemainingSeconds(10_000, 9_999)).toBe(1);
    expect(getUndoSendRemainingSeconds(10_000, 10_001)).toBe(0);
  });
});
