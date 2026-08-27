import { useEffect } from "react";
import { getMessage } from "@/lib/api";
import { useComposeStore } from "@/stores/compose.store";
import { useMailStore } from "@/stores/mail.store";
import { useUIStore } from "@/stores/ui.store";

/**
 * 全局邮件快捷键（对照成熟邮件客户端的常用键位）：
 * Ctrl+N 写新邮件；Ctrl+R 回复选中邮件；Ctrl+Shift+R 全部回复；
 * Ctrl+F 转发选中邮件；Ctrl+K 聚焦搜索；Ctrl+, 打开设置。
 * 输入框/编辑器内不拦截（Ctrl+Enter 发送由写信窗口单独处理）。
 */
export function useGlobalShortcuts() {
  useEffect(() => {
    function isTyping(target: EventTarget | null): boolean {
      return (
        target instanceof HTMLElement &&
        !!target.closest("input, textarea, [contenteditable='true'], select")
      );
    }

    async function replySelected(replyAll: boolean) {
      const id = useMailStore.getState().selectedMessageId;
      if (!id) return;
      const msg = await getMessage(id);
      if (!msg) return;
      useComposeStore.getState().openCompose(replyAll ? "reply-all" : "reply", msg);
    }

    async function forwardSelected() {
      const id = useMailStore.getState().selectedMessageId;
      if (!id) return;
      const msg = await getMessage(id);
      if (!msg) return;
      useComposeStore.getState().openCompose("forward", msg);
    }

    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "enter") return; // 写信窗口内部处理 Ctrl+Enter 发送
      if (isTyping(e.target)) return;
      switch (k) {
        case "n":
          e.preventDefault();
          useComposeStore.getState().openCompose("new");
          break;
        case "r":
          e.preventDefault();
          void replySelected(e.shiftKey);
          break;
        case "f":
          e.preventDefault();
          void forwardSelected();
          break;
        case "k":
          e.preventDefault();
          (document.querySelector(".search-input") as HTMLInputElement | null)?.focus();
          break;
        case ",":
          e.preventDefault();
          useUIStore.getState().setActiveView("settings");
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
