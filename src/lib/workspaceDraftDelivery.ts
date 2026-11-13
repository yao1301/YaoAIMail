type Draft = { body: string; subject?: string; signature?: string };
const deliveries = new Map<string, (draft: Draft) => void>();
export function registerDetachedDraft(id: string, deliver: (draft: Draft) => void) {
  deliveries.set(id, deliver);
  return () => { if (deliveries.get(id) === deliver) deliveries.delete(id); };
}
export function deliverToDetachedDraft(id: string, draft: Draft) {
  const deliver = deliveries.get(id);
  if (!deliver) return false;
  deliver(draft);
  return true;
}
