import type { MessageSummary } from "./ipc-types";
import type { MailSort } from "@/stores/mailSort.store";

/** Keep preview navigation in exactly the same order as the visible mail rows. */
export function sortMessages(messages: MessageSummary[], sort: MailSort): MessageSummary[] {
  // Sender order is applied to the whole folder before pagination in SQLite.
  if (sort.key === "sender") return messages;
  const factor = sort.dir === "asc" ? 1 : -1;
  return [...messages].sort((left, right) => {
    switch (sort.key) {
      case "subject": return (left.subject || "").localeCompare(right.subject || "", "zh") * factor;
      case "starred": return (Number(left.is_starred) - Number(right.is_starred)) * factor;
      case "attachments": return (Number(left.has_attachments) - Number(right.has_attachments)) * factor;
      default: return (left.date - right.date) * factor;
    }
  });
}
