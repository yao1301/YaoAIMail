import type { ActiveView } from "@/stores/ui.store";

export function isMessageWorkspaceTabActive(
  activeView: ActiveView,
  messageDetailId: string | null,
  messageId: string,
): boolean {
  return activeView === "messageDetail" && messageDetailId === messageId;
}

export function isComposeWorkspaceTabActive(
  activeView: ActiveView,
  activeComposeTabId: string | null,
  composeTabId: string,
): boolean {
  return activeView === "compose" && activeComposeTabId === composeTabId;
}
