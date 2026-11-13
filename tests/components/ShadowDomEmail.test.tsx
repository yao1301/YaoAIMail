import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShadowDomEmail } from "@/components/ShadowDomEmail";
import { readEmailLinkMode, saveEmailLinkMode } from "@/lib/emailLinkPreference";
import i18n from "@/lib/i18n";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openMailtoUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@/app/useMailtoOpen", () => ({
  openMailtoUrl: mocks.openMailtoUrl,
}));

describe("ShadowDomEmail", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    saveEmailLinkMode("ask");
    mocks.invoke.mockReset();
    mocks.openMailtoUrl.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
    mocks.openMailtoUrl.mockResolvedValue(true);
  });

  it("uses app theme variables instead of hardcoded light text styles", async () => {
    document.documentElement.setAttribute("data-theme", "dark");

    const { container } = render(<ShadowDomEmail html="<p>Hello</p>" />);
    const host = container.firstChild as HTMLDivElement | null;

    await waitFor(() => {
      expect(host?.shadowRoot).not.toBeNull();
    });

    const shadowMarkup = host!.shadowRoot!.innerHTML;
    expect(shadowMarkup).toContain("var(--color-text-primary)");
    expect(shadowMarkup).toContain("var(--color-accent)");
    expect(shadowMarkup).not.toContain("color: #1a1a1a");
  });

  it("themes horizontal overflow inside email content", async () => {
    const { container } = render(<ShadowDomEmail html="<pre>long code line</pre>" />);
    const host = container.firstChild as HTMLDivElement | null;

    await waitFor(() => {
      expect(host?.shadowRoot).not.toBeNull();
    });

    const shadowMarkup = host!.shadowRoot!.innerHTML;
    expect(shadowMarkup).toContain("scrollbar-width: thin");
    expect(shadowMarkup).toContain("::-webkit-scrollbar-thumb");
  });

  it("keeps light-authored email html readable in dark theme", async () => {
    document.documentElement.setAttribute("data-theme", "dark");

    const { container } = render(
      <ShadowDomEmail html={'<div style="color: #000000">Dark inline text</div>'} />,
    );
    const host = container.firstChild as HTMLDivElement | null;

    await waitFor(() => {
      expect(host?.shadowRoot).not.toBeNull();
    });

    const shadowMarkup = host!.shadowRoot!.innerHTML;
    expect(shadowMarkup).toContain('class="pebble-email-content"');
    expect(shadowMarkup).toContain(':host-context([data-theme="dark"]) .pebble-email-content');
    expect(shadowMarkup).toContain("color-scheme: light");
    expect(shadowMarkup).toContain("background: #fff");
    expect(shadowMarkup).toContain("color: #202124");
  });

  it("prevents full-height email wrappers from painting a gray viewport canvas", async () => {
    const html = `
      <table height="100%" style="height: 100%; background: #f1f1f1">
        <tbody><tr><td>Cloudflare content</td></tr></tbody>
      </table>
    `;

    const { container } = render(<ShadowDomEmail html={html} />);
    const host = container.firstChild as HTMLDivElement | null;

    await waitFor(() => {
      expect(host?.shadowRoot?.querySelector(".pebble-email-content")).not.toBeNull();
    });

    const shadowMarkup = host!.shadowRoot!.innerHTML;
    expect(shadowMarkup).toContain('.pebble-email-content > table[height="100%"]');
    expect(shadowMarkup).toContain('style="height: 100%; background: #f1f1f1"');
    expect(shadowMarkup).toContain("height: auto !important");
    expect(shadowMarkup).toContain("min-height: 0 !important");
  });

  it("renders approved email CSS inside the shadow content", async () => {
    const html = `
      <style>.hero { color: red; }</style>
      <link rel="stylesheet" href="https://cdn.example.com/mail.css">
      <p class="hero">Styled body</p>
    `;

    const { container } = render(<ShadowDomEmail html={html} />);
    const host = container.firstChild as HTMLDivElement | null;

    await waitFor(() => {
      expect(host?.shadowRoot?.querySelector(".pebble-email-content")).not.toBeNull();
    });

    const content = host!.shadowRoot!.querySelector(".pebble-email-content")!;
    expect(content.querySelector("style")?.textContent).toContain(".hero");
    expect(content.querySelector("link")?.getAttribute("href")).toBe("https://cdn.example.com/mail.css");
    expect(content.querySelector(".hero")?.textContent).toBe("Styled body");
  });

  it("caps inline images without expanding small signature logos", async () => {
    const html = `
      <img
        src="data:image/png;base64,AA=="
        width="111"
        height="62"
        style="max-width: unset; width: 110.787px; height: 61.9px"
        alt="Example Carrier"
      >
    `;

    const { container } = render(<ShadowDomEmail html={html} />);
    const host = container.firstChild as HTMLDivElement | null;

    await waitFor(() => {
      expect(host?.shadowRoot?.querySelector("img")).not.toBeNull();
    });

    const image = host!.shadowRoot!.querySelector("img") as HTMLImageElement;
    expect(image.style.width).toBe("110.787px");
    expect(image.style.getPropertyValue("max-width")).toBe("100%");
    expect(image.style.getPropertyPriority("max-width")).toBe("important");
    expect(image.style.height).toBe("auto");
    expect(image.style.getPropertyPriority("height")).toBe("important");
  });

  it("lets the reader choose the default browser without navigating the mail window", async () => {
    const { container } = render(
      <ShadowDomEmail html={'<a href="http://example.com/"><b>Website</b></a>'} />,
    );
    const host = container.firstChild as HTMLDivElement | null;

    await waitFor(() => {
      expect(host?.shadowRoot?.querySelector("a")).not.toBeNull();
    });

    expect(fireEvent.click(host!.shadowRoot!.querySelector("b")!)).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").textContent).toContain("example.com");
    fireEvent.click(screen.getByRole("button", { name: "Open in default browser" }));

    expect(mocks.invoke).toHaveBeenCalledWith("open_external_url", { url: "http://example.com/" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(readEmailLinkMode()).toBe("ask");
  });

  it("remembers the chosen opener and reads preference changes on the next click", async () => {
    const { container } = render(<ShadowDomEmail html={'<a href="https://example.com/">Website</a>'} />);
    const anchor = container.firstElementChild!.shadowRoot!.querySelector("a")!;

    fireEvent.click(anchor);
    fireEvent.click(screen.getByRole("checkbox", { name: "Remember my choice" }));
    fireEvent.click(screen.getByRole("button", { name: "Open in YaoAIMail" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(readEmailLinkMode()).toBe("inApp");

    mocks.invoke.mockClear();
    await act(async () => { fireEvent.click(anchor); });
    expect(mocks.invoke).toHaveBeenCalledWith("open_mail_link_window", { url: "https://example.com/" });
    expect(screen.queryByRole("dialog")).toBeNull();

    saveEmailLinkMode("ask");
    fireEvent.click(anchor);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("offers the other opener if the remembered opener fails", async () => {
    saveEmailLinkMode("inApp");
    mocks.invoke.mockRejectedValueOnce(new Error("Preview unavailable"));
    const { container } = render(<ShadowDomEmail html={'<a href="https://example.com/">Website</a>'} />);
    const anchor = container.firstElementChild!.shadowRoot!.querySelector("a")!;

    fireEvent.click(anchor);
    fireEvent.click(await screen.findByRole("button", { name: "Open in default browser" }));
    expect(mocks.invoke).toHaveBeenLastCalledWith("open_external_url", { url: "https://example.com/" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(readEmailLinkMode()).toBe("inApp");
  });

  it("handles middle-click and the link context menu without launching an unmanaged popup", async () => {
    const { container } = render(<ShadowDomEmail html={'<a href="//example.org/path" target="_blank">Website</a>'} />);
    const anchor = container.firstElementChild!.shadowRoot!.querySelector("a")!;
    expect(anchor.hasAttribute("target")).toBe(false);
    expect(fireEvent(anchor, new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(fireEvent.contextMenu(anchor)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Open in YaoAIMail" }));
    expect(mocks.invoke).toHaveBeenCalledWith("open_mail_link_window", { url: "https://example.org/path" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens mailto links through the compose mailto handler", async () => {
    const { container } = render(
      <ShadowDomEmail html={'<a href="mailto:qingj1314@163.com">qingj1314@163.com</a>'} />,
    );
    const host = container.firstChild as HTMLDivElement | null;

    await waitFor(() => {
      expect(host?.shadowRoot?.querySelector("a")).not.toBeNull();
    });

    fireEvent.click(host!.shadowRoot!.querySelector("a")!);

    expect(mocks.openMailtoUrl).toHaveBeenCalledWith("mailto:qingj1314@163.com");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
