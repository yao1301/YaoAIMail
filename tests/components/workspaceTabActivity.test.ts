import { describe, expect, it } from "vitest";
import {
  isComposeWorkspaceTabActive,
  isMessageWorkspaceTabActive,
} from "@/components/workspaceTabActivity";

describe("workspace tab activity", () => {
  it("keeps the inbox tab as the only active tab in split-list view", () => {
    expect(isMessageWorkspaceTabActive("inbox", "message-1", "message-1")).toBe(false);
  });

  it("activates only the full message-detail tab", () => {
    expect(isMessageWorkspaceTabActive("messageDetail", "message-1", "message-1")).toBe(true);
    expect(isMessageWorkspaceTabActive("messageDetail", "message-1", "message-2")).toBe(false);
  });

  it("does not leave a compose tab active after navigating away", () => {
    expect(isComposeWorkspaceTabActive("compose", "compose-1", "compose-1")).toBe(true);
    expect(isComposeWorkspaceTabActive("inbox", "compose-1", "compose-1")).toBe(false);
  });
});
