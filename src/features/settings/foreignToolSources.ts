/** Browser lookup entrances only. Opening one is not proof of tracking results. */
export const FOREIGN_TOOL_SOURCES = {
  container: "https://www.track-trace.com/container",
  billOfLading: "https://www.track-trace.com/bol",
  aircargo: "https://www.track-trace.com/aircargo",
  vessel: "https://www.vesselfinder.com/vessels",
  shipment: "https://www.17track.net/zh-cn",
  maersk: "https://www.maersk.com/tracking/",
  msc: "https://www.msc.com/en/track-a-shipment",
  cma: "https://www.cma-cgm.com/ebusiness/tracking",
  dhl: "https://www.dhl.com/global-en/home/tracking.html",
  ups: "https://www.ups.com/track",
  hsCode: "https://www.hsbianma.com/Search",
  wco: "https://www.wcotradetools.org/en/harmonized-system",
  // The former taxRateQuery.html returns 404; this is the official query directory.
  customs: "https://online.customs.gov.cn/static/pages/mySearch.html",
} as const;

export function trackTraceLookupUrl(type: "container" | "billOfLading" | "aircargo", number: string) {
  const url = new URL(FOREIGN_TOOL_SOURCES[type]);
  const value = number.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  // Verified against the site's wc_multi_form script: it reads location.hash,
  // not ?number=. A successful page request alone cannot verify prefilling.
  if (value) url.hash = value;
  return url.toString();
}

export function hsCodeLookupUrl(input: string) {
  const url = new URL(FOREIGN_TOOL_SOURCES.hsCode);
  if (input.trim()) url.searchParams.set("keywords", input.trim());
  // The old label promised this filter but never passed the form's parameter.
  url.searchParams.set("filterFailureCode", "true");
  return url.toString();
}
