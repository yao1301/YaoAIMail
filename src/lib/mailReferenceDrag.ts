export const MAIL_REFERENCE_TYPE = "application/x-pebble-message-id";
export type MailReference = { id: string; title: string };

// During dragover the browser protects the payload; inspect types, not getData.
export function isMailReferenceDrag(transfer: DataTransfer): boolean {
  return Array.from(transfer.types ?? []).includes(MAIL_REFERENCE_TYPE);
}

export function readMailReference(transfer: DataTransfer): MailReference | null {
  const id = transfer.getData(MAIL_REFERENCE_TYPE).trim();
  if (!id) return null;
  const title = transfer.getData("text/plain").trim().replace(/^邮件[：:]\s*/, "");
  return { id, title: title || "无主题邮件" };
}

export function revealComposeAiContext(tabId: string) {
  requestAnimationFrame(() => {
    const zone = Array.from(document.querySelectorAll<HTMLElement>("[data-compose-ai-tab]"))
      .find(element => element.dataset.composeAiTab === tabId);
    zone?.scrollIntoView?.({ block: "nearest" });
  });
}
