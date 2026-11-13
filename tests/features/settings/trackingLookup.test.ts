import { describe, expect, it } from "vitest";
import { identifyTrackingLookup } from "@/features/settings/trackingLookup";
import { FOREIGN_TOOL_SOURCES, hsCodeLookupUrl, trackTraceLookupUrl } from "@/features/settings/foreignToolSources";

describe("identifyTrackingLookup", () => {
  it("recognises ISO-style container numbers despite spaces", () => {
    const result = identifyTrackingLookup("MSCU 663987 1");
    expect(result).toMatchObject({ kind: "container", normalized: "MSCU6639871" });
    expect(result?.url).toContain("MSCU6639871");
    expect(new URL(result!.url).hostname).toBe("www.track-trace.com");
    expect(new URL(result!.url).pathname).toBe("/container");
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

  it("keeps air waybills out of parcel queries without guessing ambiguous digits", () => {
    expect(identifyTrackingLookup("000-12345678")).toMatchObject({ kind: "aircargo", normalized: "000-12345678" });
    expect(identifyTrackingLookup("AWB: 00012345678")).toMatchObject({ kind: "aircargo" });
    expect(identifyTrackingLookup("00012345678")).toMatchObject({ kind: "shipment" });
    expect(new URL(identifyTrackingLookup("000-12345678")!.url).hash).toBe("#00012345678");
  });

  it("preserves lookup input as data and actually requests obsolete-code filtering", () => {
    const hs = new URL(hsCodeLookupUrl("产品 & 材料 + 用途"));
    expect(hs.searchParams.get("keywords")).toBe("产品 & 材料 + 用途");
    expect(hs.searchParams.get("filterFailureCode")).toBe("true");
    const bol = new URL(trackTraceLookupUrl("billOfLading", " abcd123 & x "));
    expect(bol.pathname).toBe("/bol");
    expect(bol.hash).toBe("#ABCD123X");
    expect([...bol.searchParams.keys()]).toEqual([]);
    expect(new URL(FOREIGN_TOOL_SOURCES.customs).protocol).toBe("https:");
    expect(FOREIGN_TOOL_SOURCES.customs).not.toContain("taxRateQuery.html");
  });
});
