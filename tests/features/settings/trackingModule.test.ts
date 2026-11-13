import { describe, expect, it } from "vitest";
import { prepareTracking, rememberTracking } from "../../../src/features/settings/trackingModule";

describe("lightweight tracking module", () => {
  it("allows manual override of ambiguous numbers without guessing a carrier", () => {
    expect(prepareTracking("12345678901").plan?.lookup.kind).toBe("shipment");
    const awb = prepareTracking("12345678901", "aircargo").plan!;
    expect(awb.lookup.normalized).toBe("123-45678901");
    expect(new URL(awb.lookup.url).hash).toBe("#12345678901");
    const bol = prepareTracking(" abcd-12345 ", "billOfLading").plan!;
    expect(bol.lookup.kind).toBe("billOfLading");
    expect(new URL(bol.lookup.url).hash).toBe("#ABCD12345");
    expect(bol.sources.map(item => item.id)).toContain("maersk");
  });

  it("checks container and air waybill digits without blocking external verification", () => {
    expect(prepareTracking("CSQU3054383").plan?.warning).toBeUndefined();
    expect(prepareTracking("CSQU3054384").plan?.warning).toContain("校验位");
    expect(prepareTracking("123-12345675").plan?.warning).toBeUndefined();
    expect(prepareTracking("123-12345676").plan?.warning).toContain("校验位");
  });

  it("rejects URLs, prose, multiple lines and wrong explicitly selected formats", () => {
    for (const input of ["", "https://example.com/12345", "hello@example.com", "12345\n67890", "12345&other=67890", "1".repeat(81)]) {
      expect(prepareTracking(input).plan).toBeUndefined();
      expect(prepareTracking(input).error).toBeTruthy();
    }
    expect(prepareTracking("123456789", "container").error).toContain("集装箱号");
    expect(prepareTracking("123456789", "aircargo").error).toContain("11 位");
    expect(prepareTracking("ABC12345", "vessel").error).toContain("IMO");
    expect(prepareTracking("IMO: 9176187", "vessel").plan?.lookup.normalized).toBe("9176187");
  });

  it("builds only fixed HTTPS sources and never sends the number to unselected carrier sites", () => {
    const plan = prepareTracking("CSQU3054383").plan!;
    expect(plan.sources[0].prefilled).toBe(true);
    for (const source of plan.sources) {
      expect(new URL(source.url).protocol).toBe("https:");
      if (source.id !== "default") {
        expect(source.prefilled).toBe(false);
        expect(source.url).not.toContain(plan.lookup.normalized);
      }
    }
    expect(prepareTracking("MMSI 477995838").plan?.lookup.kind).toBe("vessel");
    expect(prepareTracking("123456789").plan?.lookup.kind).toBe("shipment");
  });

  it("deduplicates recent lookups, preserves type and caps history at ten entries", () => {
    let history = [] as ReturnType<typeof rememberTracking>;
    for (let index = 0; index < 15; index++) history = rememberTracking(history, prepareTracking(`ABCD${10000 + index}`).plan!.lookup, index);
    expect(history).toHaveLength(10);
    const lookup = prepareTracking("ABCD10005").plan!.lookup;
    history = rememberTracking(history, lookup, 50);
    expect(history).toHaveLength(10);
    expect(history[0]).toEqual({ number: "ABCD10005", kind: "shipment", openedAt: 50 });
    expect(Object.keys(history[0]).sort()).toEqual(["kind", "number", "openedAt"]);
    history = rememberTracking(history, prepareTracking("ABCD10005", "billOfLading").plan!.lookup, 51);
    expect(history.filter(item => item.number === "ABCD10005")).toHaveLength(2);
  });
});
