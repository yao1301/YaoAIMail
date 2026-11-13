import { describe, expect, it } from "vitest";
import { unreadCountForAllUnread } from "./folderAggregation";

describe("unreadCountForAllUnread", () => {
  it("includes archive and user folders while excluding spam", () => {
    const folders = [
      { id: "inbox", role: "inbox" },
      { id: "archive", role: "archive" },
      { id: "customer", role: null },
      { id: "spam", role: "spam" },
    ] as Parameters<typeof unreadCountForAllUnread>[0];

    expect(unreadCountForAllUnread(folders, {
      inbox: 2,
      archive: 3,
      customer: 4,
      spam: 99,
    })).toBe(9);
  });
});
