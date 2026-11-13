/** Layout writes run after ResizeObserver delivery, never inside its loop. */
export function observeResizeFrame(element: Element, measure: () => void, widthOnly = false) {
  let frame = 0;
  let stopped = false;
  let width = -1, height = -1;
  const schedule = () => {
    if (frame || stopped) return;
    frame = requestAnimationFrame(() => { frame = 0; if (!stopped) measure(); });
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(entries => {
    const entry = entries.find(item => item.target === element);
    if (!entry) return;
    const nextWidth = Math.round(entry.contentRect.width);
    const nextHeight = Math.round(entry.contentRect.height);
    if (nextWidth === width && (widthOnly || nextHeight === height)) return;
    width = nextWidth; height = nextHeight;
    schedule();
  });
  observer?.observe(element);
  schedule();
  return () => { stopped = true; observer?.disconnect(); cancelAnimationFrame(frame); };
}

export function isResizeObserverDeliveryWarning(message: string) {
  return message === "ResizeObserver loop completed with undelivered notifications."
    || message === "ResizeObserver loop limit exceeded";
}
