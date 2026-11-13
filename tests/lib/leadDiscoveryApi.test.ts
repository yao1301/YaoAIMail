import { beforeEach, expect, it, vi } from "vitest";
import { discoverLeads, forgetLeadTask, leadResearchPrompt, type LeadDiscoveryRequest, type LeadDiscoveryResponse } from "../../src/lib/api";

const h = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as Array<{ onmessage: (value: unknown) => void }> }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class { onmessage = (_value: unknown) => {}; constructor() { h.channels.push(this); } },
}));
beforeEach(() => { vi.clearAllMocks(); h.channels.length = 0; });
const request: LeadDiscoveryRequest = { product: "IP67 LED driver", market: "Germany", buyerType: "importer", aliases: [], qualifiers: ["IP67"], exclusions: [], requirements: "", excludeWebsites: [], page: 1, batchMode: true };
const response: LeadDiscoveryResponse = { items: [], report: { queries: 1, searchHits: 0, directoriesRead: 0, sitesRead: 0, pagesRead: 0, unreadSites: 0, warnings: [] } };

it("passes typed intent without replacing English and accepts native progress", async () => {
  h.invoke.mockResolvedValue(response); const progress = vi.fn();
  const result = await discoverLeads(request, progress);
  expect(h.invoke).toHaveBeenCalledWith("discover_leads", { request, onProgress: h.channels[0] });
  h.channels[0].onmessage(response); expect(progress).toHaveBeenCalledWith(response);
  expect(result).toEqual(response);
});
it("always supplies the mandatory native channel even without a progress callback", async () => {
  h.invoke.mockResolvedValue(response); await discoverLeads(request);
  expect(h.channels).toHaveLength(1); expect(() => h.channels[0].onmessage(response)).not.toThrow();
});
it("uses the native structured planning command instead of ordinary writing",async()=>{
  h.invoke.mockResolvedValue("{}");
  await expect(leadResearchPrompt("system","selected task")).resolves.toBe("{}");
  expect(h.invoke).toHaveBeenCalledWith("lead_research_prompt",{system:"system",user:"selected task"});
});
it('forgets the same account-scoped native task when its history is deleted',async()=>{
  h.invoke.mockResolvedValue(undefined);await forgetLeadTask('task-a','account-a');
  expect(h.invoke).toHaveBeenCalledWith('forget_lead_task',{sessionId:'task-a',scopeId:'account-a'});
});
