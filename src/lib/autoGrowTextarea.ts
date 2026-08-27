/** Resize a controlled textarea to fit its content, with a bounded scrollable maximum. */
export function resizeAutoGrowTextarea(element: HTMLTextAreaElement | null, maxHeight = 320) {
  if (!element) return;
  element.style.height = "auto";
  const minHeight = Number.parseFloat(window.getComputedStyle(element).minHeight) || 0;
  const height = Math.min(Math.max(element.scrollHeight, minHeight), maxHeight);
  element.style.height = `${height}px`;
  element.style.overflowY = element.scrollHeight > maxHeight ? "auto" : "hidden";
}
