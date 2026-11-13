/** Shared per-view queue: every admitted company gets a turn, at bounded concurrency. */
export class LeadContactQueue {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly concurrency = 3) {}
  async run<T>(job: () => Promise<T>): Promise<T> {
    await new Promise<void>(resolve => {
      const start = () => { this.active++; resolve(); };
      if (this.active < this.concurrency) start(); else this.waiting.push(start);
    });
    try { return await job(); }
    finally { this.active--; this.waiting.shift()?.(); }
  }
}

export interface ContactProgress {
  emailDiscoveryStatus?: "pending" | "running" | "completed" | "failed";
  emails?: string[];
  emailEvidence?: unknown[];
  contactStatus?: "可联系" | "待补全";
  websiteStatus?: string;
  websiteStatusReason?: string;
  contacts?: unknown[];
  buyingSignals?: unknown[];
}

export function contactJobKey(sessionId: string, companyKey: string): string {
  return `${sessionId}:${companyKey}`;
}
export function shouldDiscoverContact(item: ContactProgress, force = false): boolean {
  return force || (item.emailDiscoveryStatus !== "completed" && item.emailDiscoveryStatus !== "failed");
}

/** Fresh discovery snapshots must not erase a concurrently completed contact job.
 * A real completed response with [] deliberately clears stale evidence. */
export function mergeContactProgress<T extends ContactProgress>(old: T | undefined, incoming: T): T {
  const merged = { ...old, ...incoming };
  if (old && (old.emailDiscoveryStatus === "running" || old.emailDiscoveryStatus === "completed" || old.emailDiscoveryStatus === "failed")
      && (!incoming.emailDiscoveryStatus || incoming.emailDiscoveryStatus === "pending")) {
    return { ...merged, emails: old.emails, emailEvidence: old.emailEvidence, contactStatus: old.contactStatus,
      contacts: old.contacts, buyingSignals: old.buyingSignals,
      emailDiscoveryStatus: old.emailDiscoveryStatus, websiteStatus: old.websiteStatus, websiteStatusReason: old.websiteStatusReason };
  }
  return merged;
}
