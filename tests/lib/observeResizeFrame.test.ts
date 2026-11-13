import { afterEach, describe, expect, it, vi } from "vitest";
import { observeResizeFrame } from "../../src/lib/observeResizeFrame";

afterEach(() => vi.unstubAllGlobals());
describe("deferred layout observation", () => {
  it("coalesces notifications, ignores height-only self writes, and cancels on cleanup", () => {
    let notify!: ResizeObserverCallback;
    let next!: FrameRequestCallback;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class { constructor(cb: ResizeObserverCallback) { notify = cb; } observe() {} disconnect = disconnect; });
    const raf = vi.fn(cb => {next = cb; return 7;});
    const cancel = vi.fn(); vi.stubGlobal("requestAnimationFrame", raf); vi.stubGlobal("cancelAnimationFrame", cancel);
    const el = document.createElement("textarea"), fit = vi.fn();
    const stop = observeResizeFrame(el, fit, true);
    const resize = (width: number, height: number) => notify([{target: el, contentRect: {width, height}}] as ResizeObserverEntry[], {} as ResizeObserver);
    resize(100, 200); resize(100, 250);
    expect(fit).not.toHaveBeenCalled(); expect(raf).toHaveBeenCalledTimes(1);
    next(0); expect(fit).toHaveBeenCalledTimes(1);
    resize(100, 300); expect(raf).toHaveBeenCalledTimes(1);
    resize(150, 300); expect(raf).toHaveBeenCalledTimes(2);
    stop(); next(0); expect(fit).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledWith(7);
  });
});
