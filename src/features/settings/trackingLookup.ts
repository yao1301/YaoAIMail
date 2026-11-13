import { FOREIGN_TOOL_SOURCES, trackTraceLookupUrl } from "./foreignToolSources";

export type TrackingLookupKind = "container" | "billOfLading" | "vessel" | "shipment" | "aircargo";

export interface TrackingLookup {
  kind: TrackingLookupKind;
  normalized: string;
  label: string;
  provider: string;
  url: string;
}

function compact(value: string) {
  return value.trim().toUpperCase().replace(/[\s-]+/g, "");
}

function isValidImoNumber(value: string) {
  if (!/^\d{7}$/.test(value)) return false;
  const digits = [...value].map(Number);
  const sum = digits.slice(0, 6).reduce((total, digit, index) => total + digit * (7 - index), 0);
  return sum % 10 === digits[6];
}

/**
 * Recognises strong, non-overlapping identifiers first. Ambiguous identifiers
 * deliberately fall back to ordinary shipment tracking instead of guessing a
 * vessel and opening an unrelated result.
 */
export function identifyTrackingLookup(input: string): TrackingLookup | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const normalized = compact(trimmed);

  // ISO 6346: three-letter owner code, equipment category, six serial digits
  // and one check digit. Keep format-tolerant because some carriers publish a
  // legacy or mistyped check digit that should still be searchable.
  if (/^[A-Z]{3}[UJZ]\d{7}$/.test(normalized)) {
    return {
      kind: "container",
      normalized,
      label: "集装箱号",
      provider: "Track-Trace 集装箱查询",
      url: trackTraceLookupUrl("container", normalized),
    };
  }

  // A separated AWB or explicit label is strong evidence. Do not classify every
  // bare 11-digit courier number as air freight, since those formats overlap.
  const awb = trimmed.match(/^(?:AWB\s*[:：]?\s*)?(\d{3})[-\s]+(\d{8})$/i)
    ?? trimmed.match(/^AWB\s*[:：]?\s*(\d{3})(\d{8})$/i);
  if (awb) {
    const number = `${awb[1]}-${awb[2]}`;
    return { kind: "aircargo", normalized: number, label: "空运提单号（AWB）", provider: "Track-Trace 空运查询", url: trackTraceLookupUrl("aircargo", number) };
  }

  const explicitImo = trimmed.match(/^\s*IMO[\s:-]*(\d{7})\s*$/i)?.[1];
  const explicitMmsi = trimmed.match(/^\s*MMSI[\s:-]*(\d{9})\s*$/i)?.[1];
  const implicitImo = /^\d{7}$/.test(normalized) && isValidImoNumber(normalized) ? normalized : null;
  const vesselId = explicitImo || explicitMmsi || implicitImo;
  if (vesselId) {
    return {
      kind: "vessel",
      normalized: vesselId,
      label: explicitMmsi ? "船舶 MMSI" : "船舶 IMO 号",
      provider: "VesselFinder 船舶查询",
      url: `${FOREIGN_TOOL_SOURCES.vessel}?name=${encodeURIComponent(vesselId)}`,
    };
  }

  return {
    kind: "shipment",
    normalized,
    label: "物流 / 快递单号",
    provider: "17TRACK 国际物流查询",
    url: `${FOREIGN_TOOL_SOURCES.shipment}?nums=${encodeURIComponent(normalized)}`,
  };
}
