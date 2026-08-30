import { describe, expect, it } from "vitest";
import { identifyTrackingLookup } from "@/features/settings/trackingLookup";

describe("identifyTrackingLookup", () => {
  it("recognises ISO-style container numbers despite spaces", () => {
    const result = identifyTrackingLookup("MSCU 663987 1");
    expect(result).toMatchObject({ kind: "container", normalized: "MSCU6639871" });
    expect(result?.url).toContain("MSCU6639871");
  });

  it("recognises explicit and checksum-valid vessel identifiers", () => {
    expect(identifyTrackingLookup("IMO 9176187")).toMatchObject({ kind: "vessel", normalized: "9176187" });
    expect(identifyTrackingLookup("9176187")).toMatchObject({ kind: "vessel" });
    expect(identifyTrackingLookup("MMSI: 477995838")).toMatchObject({ kind: "vessel", normalized: "477995838" });
  });

  it("routes ambiguous identifiers to normal shipment tracking", () => {
    expect(identifyTrackingLookup("1Z999AA10123456784")).toMatchObject({ kind: "shipment" });
    expect(identifyTrackingLookup("123456789")).toMatchObject({ kind: "shipment" });
  });

  it("does nothing for empty input", () => {
    expect(identifyTrackingLookup("   ")).toBeNull();
  });
});
