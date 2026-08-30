import { describe, expect, it } from "vitest";
import { originalRecipientAddresses } from "../../src/lib/messageRecipients";

describe("originalRecipientAddresses", () => {
  it("uses every original To recipient and removes empty duplicates", () => {
    expect(originalRecipientAddresses([
      { name: "A", address: " a@example.com " },
      { name: "A duplicate", address: "a@example.com" },
      { name: "B", address: "b@example.com" },
      { name: "Empty", address: " " },
    ])).toEqual(["a@example.com", "b@example.com"]);
  });
});
