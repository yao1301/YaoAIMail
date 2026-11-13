import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(resolve("index.html"), "utf8");
const locale = JSON.parse(readFileSync(resolve("src/locales/zh.json"), "utf8"));
const KEY = "yaoaimail-startup-tip-index-v1";
const pages: JSDOM[] = [];
function launch(options: { search?: string; saved?: string; blockedStorage?: boolean } = {}) {
  let tick: () => void = () => {};
  const clear = vi.fn();
  const interval = vi.fn();
  const page = new JSDOM(html, {
    url: `https://app.test/${options.search ?? ""}`, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      if (options.saved !== undefined) window.localStorage.setItem(KEY, options.saved);
      if (options.blockedStorage) Object.defineProperty(window, "localStorage", { get() { throw new Error("storage disabled"); } });
      window.setInterval = ((callback: () => void, delay: number) => { tick = callback; interval(delay); return 42; }) as typeof window.setInterval;
      window.clearInterval = clear;
    },
  });
  pages.push(page);
  return { page, clear, interval, tick: () => tick(), text: () => page.window.document.getElementById("startup-tip-text")!.textContent! };
}
afterEach(() => { for (const page of pages.splice(0)) page.window.close(); });

describe("startup tips before React loads", () => {
  it("shows the same accurate privacy notice as About on the first startup", () => {
    const result = launch();
    expect(result.text()).toBe(locale.about.privacyAiNotice);
    expect(result.text()).toContain("发送至您配置的 AI 服务商");
    expect(result.text()).toContain("所在组织");
    expect(result.page.window.document.getElementById("root")?.childElementCount).toBe(0);
    expect(result.page.window.localStorage.getItem(KEY)).toBe("1");
    expect(result.interval).toHaveBeenCalledExactlyOnceWith(8000);
  });

  it("rotates between startups and wraps around to the privacy notice", () => {
    const first = launch();
    const second = launch({ saved: first.page.window.localStorage.getItem(KEY)! });
    expect(second.text()).not.toBe(first.text());
    expect(second.text()).toContain("参考文件不会自动成为发信附件");
    for (let index = 0; index < 7; index++) second.tick();
    expect(second.text()).toBe(first.text());
    expect(second.page.window.localStorage.getItem(KEY)).toBe("1");
  });

  it("rotates during actual long loading without changing the splash start time", () => {
    const result = launch();
    const start = (result.page.window as unknown as { __splashStart: number }).__splashStart;
    result.tick();
    expect(result.text()).toContain("参考文件不会自动成为发信附件");
    expect((result.page.window as unknown as { __splashStart: number }).__splashStart).toBe(start);
  });

  it.each(["?compose=1", "?mailWindow=1", "?workspaceWindow=1"])("does not run or advance the counter in detached windows: %s", search => {
    const result = launch({ search, saved: "3" });
    expect(result.interval).not.toHaveBeenCalled();
    expect(result.page.window.localStorage.getItem(KEY)).toBe("3");
    expect(result.page.window.getComputedStyle(result.page.window.document.getElementById("splash")!).display).toBe("none");
  });

  it("falls back safely with corrupt or unavailable local storage", () => {
    expect(launch({ saved: "not-a-counter" }).text()).toBe(locale.about.privacyAiNotice);
    const result = launch({ blockedStorage: true });
    expect(result.text()).toBe(locale.about.privacyAiNotice);
    result.tick();
    expect(result.text()).toContain("参考文件");
  });

  it.each(["fade", "remove"])("releases timers when the splash ends by %s", async method => {
    const result = launch();
    const splash = result.page.window.document.getElementById("splash")!;
    if (method === "fade") splash.classList.add("fade-out"); else splash.remove();
    await Promise.resolve();
    expect(result.clear).toHaveBeenCalledWith(42);
  });
});
