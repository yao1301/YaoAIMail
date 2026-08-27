import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseMailtoUrl } from "@/features/compose/mailto";
import { useComposeStore, type ComposePrefill } from "@/stores/compose.store";

const OPEN_MAILTO_EVENT = "app:open-mailto";

interface OpenMailtoPayload {
  urls: string[];
}

function parseMailtoUrls(urls: string[]) {
  const parsed: ComposePrefill[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const prefill = parseMailtoUrl(url);
    if (prefill) parsed.push(prefill);
  }
  return parsed;
}

export async function openMailtoUrl(url: string) {
  return openMailtoUrls([url]);
}

async function openMailtoUrls(urls: string[]) {
  const parsed = parseMailtoUrls(urls);
  if (parsed.length === 0) return false;
  // 多标签模式：每个 mailto 链接在主窗口打开一个新的写信标签，
  // 不丢弃任何已有草稿。
  for (const prefill of parsed) {
    useComposeStore.getState().openCompose("new", null, prefill);
  }
  return true;
}

export function useMailtoOpen() {
  useEffect(() => {
    invoke<string[]>("take_pending_mailto_urls")
      .then((urls) => {
        void openMailtoUrls(urls);
      })
      .catch((err) => console.warn("Failed to read pending mailto URLs:", err));

    const unlisten = listen<OpenMailtoPayload>(OPEN_MAILTO_EVENT, (event) => {
      void openMailtoUrls(event.payload.urls);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
}
