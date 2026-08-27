/**
 * Convert AI-produced Markdown into readable, editable plain text for customer
 * profiles. Profiles are stored in a textarea, so preserving Markdown source
 * markers would expose formatting syntax instead of the formatted report.
 */
export function formatProfileText(text: string): string {
  const cleaned = text
    .replace(/\r\n?/g, "\n")
    .replace(/^```[^\n]*$/gm, "")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, label: string, url: string) =>
      label.trim() ? `${label.trim()}（${url.trim()}）` : url.trim())
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) =>
      `${label.trim()}（${url.trim()}）`)
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1$2")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return cleaned
    .split("\n")
    .filter((line) => !/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line))
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return line;
      return trimmed
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(" ｜ ");
    })
    .join("\n")
    .replace(/\\([\\`*_[\]{}()#+.!>|-])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
