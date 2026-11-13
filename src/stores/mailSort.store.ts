import { create } from "zustand";

export type MailSortKey = "date" | "sender" | "subject" | "starred" | "attachments";
export interface MailSort { key: MailSortKey; dir: "asc" | "desc" }

function readSort(): MailSort {
  try {
    const stored = JSON.parse(localStorage.getItem("pebble-mail-sort") ?? "");
    if (["date", "sender", "subject", "starred", "attachments"].includes(stored?.key)
      && (stored.dir === "asc" || stored.dir === "desc")) return stored;
  } catch { /* Missing or malformed preference: newest first. */ }
  return { key: "date", dir: "desc" };
}

export const useMailSortStore = create<{
  sort: MailSort;
  toggleSort: (key: MailSortKey) => void;
}>((set) => ({
  sort: readSort(),
  toggleSort: (key) => set(({ sort }) => {
    const dir = sort.key === key
      ? sort.dir === "asc" ? "desc" : "asc"
      : key === "date" ? "desc" : "asc";
    const next: MailSort = { key, dir };
    localStorage.setItem("pebble-mail-sort", JSON.stringify(next));
    return { sort: next };
  }),
}));
