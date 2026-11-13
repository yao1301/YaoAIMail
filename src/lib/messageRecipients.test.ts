import { describe, expect, it } from "vitest";
import { originalRecipientFields } from "./messageRecipients";

const address = (value: string) => ({ name: null, address: value });

describe("originalRecipientFields", () => {
  it("preserves all original To, Cc and Bcc recipient roles", () => {
    expect(originalRecipientFields(
      [address("buyer@example.com")],
      [address("manager@example.com")],
      [address("audit@example.com")],
    )).toEqual({
      to: ["buyer@example.com"],
      cc: ["manager@example.com"],
      bcc: ["audit@example.com"],
    });
  });

  it("trims, removes empty entries and de-duplicates across fields case-insensitively", () => {
    expect(originalRecipientFields(
      [address(" Buyer@Example.com "), address("")],
      [address("buyer@example.com"), address("cc@example.com")],
      [address("CC@example.com"), address("hidden@example.com")],
    )).toEqual({
      to: ["Buyer@Example.com"],
      cc: ["cc@example.com"],
      bcc: ["hidden@example.com"],
    });
  });

  it("supports messages that only have Cc or Bcc recipients", () => {
    expect(originalRecipientFields([], [address("cc@example.com")], [address("hidden@example.com")])).toEqual({
      to: [],
      cc: ["cc@example.com"],
      bcc: ["hidden@example.com"],
    });
  });
});
