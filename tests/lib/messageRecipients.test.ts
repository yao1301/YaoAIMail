import { describe, expect, it } from "vitest";
import { originalRecipientFields } from "../../src/lib/messageRecipients";

describe("originalRecipientFields", () => {
  it("keeps recipient roles while removing empty duplicates across To, Cc and Bcc", () => {
    expect(originalRecipientFields([
      { name: "A", address: " a@example.com " },
      { name: "A duplicate", address: "a@example.com" },
      { name: "B", address: "b@example.com" },
      { name: "Empty", address: " " },
    ], [
      { name: "A again", address: "A@example.com" },
      { name: "C", address: "c@example.com" },
    ], [
      { name: "C again", address: "C@example.com" },
      { name: "D", address: "d@example.com" },
    ])).toEqual({
      to: ["a@example.com", "b@example.com"],
      cc: ["c@example.com"],
      bcc: ["d@example.com"],
    });
  });
});
