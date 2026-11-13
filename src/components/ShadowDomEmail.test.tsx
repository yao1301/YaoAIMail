import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/app/useMailtoOpen", () => ({ openMailtoUrl: vi.fn() }));

import { ShadowDomEmail } from "./ShadowDomEmail";

describe("ShadowDomEmail historical quote presentation", () => {
  it("writes essential card styles onto the final live Shadow DOM nodes", () => {
    const { container } = render(
      <ShadowDomEmail
        html={'<div class="gmail_quote"><div class="gmail_attr">On Monday wrote:</div><blockquote>Previous reply</blockquote></div>'}
      />,
    );

    const host = container.firstElementChild as HTMLDivElement;
    const card = host.shadowRoot?.querySelector<HTMLElement>(".pebble-history-quote");
    const header = host.shadowRoot?.querySelector<HTMLElement>(".pebble-history-quote__header");

    expect(card).not.toBeNull();
    expect(card?.style.getPropertyValue("border")).toBe("1px solid rgb(217, 221, 227)");
    expect(card?.style.getPropertyPriority("border")).toBe("important");
    expect(card?.style.getPropertyValue("background")).toBe("rgb(255, 255, 255)");
    expect(header?.style.getPropertyValue("background")).toBe("rgb(243, 244, 246)");
  });

  it("preserves a height-only logo instead of expanding it to the reader width", () => {
    const { container } = render(
      <ShadowDomEmail html={'<a href="https://www.zoho.com/mail"><img height="48" src="https://example.com/large-logo.png" title="Zoho Mail"></a>'} />,
    );

    const host = container.firstElementChild as HTMLDivElement;
    const image = host.shadowRoot?.querySelector<HTMLImageElement>("img");

    expect(image?.style.getPropertyValue("width")).toBe("auto");
    expect(image?.style.getPropertyValue("height")).toBe("48px");
    expect(image?.style.getPropertyPriority("height")).toBe("important");
    expect(image?.style.getPropertyValue("max-height")).toBe("min(70vh, 720px)");
  });

  it("caps images without trustworthy dimensions", () => {
    const { container } = render(
      <ShadowDomEmail html={'<img src="https://example.com/huge-image.png">'} />,
    );

    const host = container.firstElementChild as HTMLDivElement;
    const image = host.shadowRoot?.querySelector<HTMLImageElement>("img");

    expect(image?.style.getPropertyValue("max-width")).toBe("100%");
    expect(image?.style.getPropertyValue("max-height")).toBe("min(70vh, 720px)");
    expect(image?.style.getPropertyValue("object-fit")).toBe("contain");
  });

  it("makes a fixed-width transactional email shell responsive", () => {
    const { container } = render(
      <ShadowDomEmail
        html={'<div id="content"><div style="width:760px;margin:0 auto"><table width="640"><tbody><tr><td>Notice</td></tr></tbody></table></div></div>'}
      />,
    );

    const host = container.firstElementChild as HTMLDivElement;
    const shell = host.shadowRoot?.querySelector<HTMLElement>("#content > div");

    expect(shell?.style.getPropertyValue("width")).toBe("100%");
    expect(shell?.style.getPropertyPriority("width")).toBe("important");
    expect(shell?.style.getPropertyValue("max-width")).toBe("100%");
  });
});
