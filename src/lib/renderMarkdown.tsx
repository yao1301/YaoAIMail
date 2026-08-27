import MarkdownIt from "markdown-it";
import { sanitizeHtml } from "./sanitizeHtml";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

/** Convert markdown text to safe HTML for display (no raw `*`/`#` markers). */
export function markdownToHtml(text: string): string {
  return sanitizeHtml(markdown.render(text || ""));
}

export default function MarkdownView({
  text,
  className,
  style,
}: {
  text: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={className ? `markdown-body ${className}` : "markdown-body"}
      style={style}
      dangerouslySetInnerHTML={{ __html: markdownToHtml(text) }}
    />
  );
}
