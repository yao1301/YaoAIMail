import { describe, it, expect, vi } from "vitest";
import { testBothMailDirections } from "../../src/lib/mailConnectionTest";

describe("both mail directions", () => {
  it("requires incoming and SMTP success", async () => {
    await expect(testBothMailDirections(async () => "IMAP authenticated", async () => "SMTP authenticated, no DATA")).resolves.toContain("发件 SMTP：通过");
  });
  it("does not report receive-only success when SMTP fails", async () => {
    await expect(testBothMailDirections(async () => "IMAP OK", async () => { throw new Error("SMTP failed"); })).rejects.toThrow(/收件：通过[\s\S]*发件 SMTP：失败/);
  });
  it("still tests SMTP when incoming fails", async () => {
    const smtp = vi.fn().mockResolvedValue("SMTP OK");
    await expect(testBothMailDirections(async () => { throw new Error("POP3 failed"); }, smtp)).rejects.toThrow(/收件：失败[\s\S]*发件 SMTP：通过/);
    expect(smtp).toHaveBeenCalledOnce();
  });
  it("shows both failures", async () => {
    await expect(testBothMailDirections(async () => { throw new Error("IMAP timeout"); }, async () => { throw new Error("SMTP authentication denied"); })).rejects.toThrow(/IMAP timeout[\s\S]*SMTP authentication denied/);
  });
});
