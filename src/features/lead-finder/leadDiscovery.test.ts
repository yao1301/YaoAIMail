import { describe, expect, it } from "vitest";
import { buildLeadDiscoveryRequest, qualityScore, fallbackProductBrief, normalizeProductBrief, interpretProductBrief, emptyLeadResultMessage, describeReviewIssues, describeLeadFailure, PRODUCT_BRIEF_VERSION } from "./leadDiscovery";
import type { LeadQuality } from "@/lib/api";

describe("evidence-first lead discovery", () => {
  it('classifies structured IPC errors without persisting upstream secrets or reporting zero customers', () => {
    expect(describeLeadFailure({kind:'Validation',message:'任务条件缺少用户原话依据，未执行筛选'})).toContain('用户条件理解未完成');
    expect(describeLeadFailure({error:{message:'403 forbidden sk-private'}})).toContain('认证或权限');
    expect(describeLeadFailure(new Error('raw provider body sk-private'))).not.toContain('sk-private');
  });
  const input = {
    product: "IP67 LED driver 24V", query: "Exclude China", market: "Germany", buyerType: "distributor",
    brief: { coreCategory: "防水电源", searchProduct: "waterproof power supply", searchAliases: ["LED power supply"], mandatoryQualifiers: ["IP67", "24V"], exclusionSignals: [] },
    websites: ["https://example.org"], page: 1, batchMode: true,
  };
  it("never translates away original English specifications", () => {
    const r = buildLeadDiscoveryRequest(input);
    expect(r.product).toBe("IP67 LED driver 24V");
    expect(r.aliases).toEqual(["LED power supply"]);
    expect(r.qualifiers).toEqual(["IP67", "24V"]);
    expect(r.requirements).toBe("Exclude China");
    expect(r.excludeWebsites).toEqual([]);
  });
  it('keeps product positioning and actual use cases in native research rather than discarding task context',()=>{
    const r=buildLeadDiscoveryRequest({...input,brief:{...input.brief,coreCategory:'户外标识用防水电源',useCases:['户外招牌照明','商业标识安装']}});
    expect(r.productPositioning).toBe('户外标识用防水电源');expect(r.useCases).toEqual(['户外招牌照明','商业标识安装']);
  });
  it("uses an English retrieval identity for Chinese input and keeps continuation exclusions", () => {
    const r = buildLeadDiscoveryRequest({ ...input, product: "食品级工业水泵", brief:{...input.brief,searchProduct:"food-grade industrial pump"}, page: 2 });
    expect(r.product).toBe("food-grade industrial pump"); expect(r.excludeWebsites).toEqual(input.websites);
  });
  it("uses interpreted product only for long prose or missing product", () => {
    expect(buildLeadDiscoveryRequest({ ...input, product: "" }).product).toBe("waterproof power supply");
  });
  it("explicit fields override only explicitly extracted task intent", () => {
    const brief = { ...input.brief, targetMarket: "France", buyerRole: "importer" };
    expect(buildLeadDiscoveryRequest({ ...input, brief }).market).toBe("Germany");
    const r = buildLeadDiscoveryRequest({ ...input, market: "", buyerType: "", brief });
    expect(r.market).toBe("France"); expect(r.buyerType).toBe("importer");
  });
  it("does not boost scores merely because an email was found", () => {
    const q: LeadQuality = { score: 70, level: "source_matched", productMatch: true, buyerMatch: true, checkedPages: 1, evidence: [], unknowns: [] };
    expect(qualityScore(q)).toBe(70); expect(qualityScore(q)).toBe(70);
    expect(qualityScore({ ...q, checkedPages: 0 })).toBe(49);
    expect(qualityScore({ ...q, productMatch: false })).toBe(49);
  });
  it("uses selected document identity, never numbered exclusion instructions, when interpretation fails", () => {
    const query = "帮我查找文档里面这个装饰类礼品的客户，排除以下对象：1. 线上电商平台2. 超大型跨国公司3. 大型公司，排除中国公司。";
    const brief = fallbackProductBrief("", query, "【用户选择的资料中心文件：Sample Decorative Gift.pdf】\nProduct name: Sample Decorative Gift\nA decorative gift.");
    const r = buildLeadDiscoveryRequest({ ...input, product: "", query, brief });
    expect(r.product).toBe("Sample Decorative Gift"); expect(r.qualifiers).toEqual([]);
    expect(r.product).not.toMatch(/排除|线上电商|大型公司/);
  });
  it("does not restore invalid numbered qualifiers when the model explicitly returns []", () => {
    const fallback = { ...input.brief, mandatoryQualifiers: ["平台2", "公司3"] };
    expect(normalizeProductBrief({ coreCategory: "Sample Decorative Gift", mandatoryQualifiers: [] }, fallback).mandatoryQualifiers).toEqual([]);
  });
  it("sends buyer channels instead of discarding a successful interpretation", () => {
    const r = buildLeadDiscoveryRequest({ ...input, product: "", brief: { ...input.brief, coreCategory: "Sample Decorative Gift", adjacentBuyerChannels: ["gift shops", "decor wholesalers"] } });
    expect(r.channels).toEqual(["gift shops", "decor wholesalers"]);
  });
  it("does not silently search the full instruction if both model and document parsing fail", () => {
    const query = "帮我查找文档里面这个产品的客户，排除以下对象：1. 大型公司";
    expect(() => buildLeadDiscoveryRequest({ ...input, product: "", query, brief: fallbackProductBrief("", query, "") })).toThrow("无法");
  });
  it("never treats image filenames as product evidence", () => {
    const brief = fallbackProductBrief("", "帮我找资料里的客户", "【用户选中的图片文件：Imaginary product.png】\n不能可靠读取图片像素");
    expect(brief.coreCategory).toBe("");
  });
  it("repairs malformed interpretation once and keeps the document and task scope", async () => {
    const attempts:boolean[]=[];
    const brief=await interpretProductBrief({product:"",query:"查找资料里的买家，排除平台",context:"Product name: Botanical Gift Light"},async repair=>{
      attempts.push(repair);
      return repair ? JSON.stringify({coreCategory:"Botanical Gift Light",adjacentBuyerChannels:["gift shops"],mandatoryQualifiers:[]}) : "Invalid JSON";
    });
    expect(attempts).toEqual([false,true]); expect(brief.coreCategory).toBe("Botanical Gift Light"); expect(brief.adjacentBuyerChannels).toEqual(["gift shops"]);
  });
  it("does not repeat model calls on a network or authentication failure", async () => {
    let calls=0;
    const brief=await interpretProductBrief({product:"",query:"帮我找资料里的买家",context:"Product name: Botanical Gift Light"},async()=>{calls++;throw Error("network");});
    expect(calls).toBe(1); expect(brief.coreCategory).toBe("Botanical Gift Light"); expect(brief.interpretation).toBe("document_fallback");
  });
  it("separates Chinese display and restrictions from overseas retrieval fields",()=>{
    const brief=normalizeProductBrief({coreCategory:"食品包装盒",searchProduct:"paper food packaging box",searchChannels:["packaging importers","food packaging wholesalers"],
      adjacentBuyerChannels:["包装进口商","食品包装批发商"],searchMarket:"Germany",searchBuyerRole:"importer",searchAliases:["纸质包装盒","paper takeaway box"],
      localQueries:[{language:"de",query:"Verpackungen Importeur Deutschland"},{language:"zh",query:"德国包装公司"}]},fallbackProductBrief("食品包装盒",""));
    const r=buildLeadDiscoveryRequest({...input,product:"食品包装盒",market:"德国",buyerType:"进口商",brief});
    expect(r.product).toBe("paper food packaging box");expect(r.market).toBe("Germany");expect(r.buyerType).toBe("importer");
    expect(r.channels).toEqual(["packaging importers","food packaging wholesalers"]);expect(r.aliases).toEqual(["paper takeaway box"]);
    expect(r.localQueries).toEqual([{language:"de",query:"Verpackungen Importeur Deutschland"}]);expect(brief.adjacentBuyerChannels?.[0]).toBe("包装进口商");
  });
  it("repairs a response with Chinese-only channels instead of issuing a hybrid query",async()=>{
    const calls:boolean[]=[];
    const brief=await interpretProductBrief({product:"工业水泵",query:"找德国进口商",context:""},async repair=>{
      calls.push(repair);return JSON.stringify({coreCategory:"工业水泵",searchProduct:"industrial pump",adjacentBuyerChannels:["工业设备进口商"],
        ...(repair?{searchChannels:["industrial equipment importers"],searchMarket:"Germany"}:{})});
    });
    expect(calls).toEqual([false,true]);expect(brief.searchChannels).toEqual(["industrial equipment importers"]);expect(brief.version).toBe(PRODUCT_BRIEF_VERSION);
  });
  it("does not silently fall back to Chinese retrieval if translation fails",()=>{
    expect(()=>buildLeadDiscoveryRequest({...input,product:"食品包装袋",brief:fallbackProductBrief("食品包装袋","")})).toThrow("无法");
  });
  it("does not hide an empty or truncated structured reply as document fallback",async()=>{
    for (const message of ["LLM empty_content", "模型未返回最终正文，未当作没有客户", "模型输出被截断，未当作没有客户"]) {
      let calls=0;
      await expect(interpretProductBrief({product:"gift light",query:"find buyers",context:"Product name: Gift Light"},async()=>{calls++;throw Error(message);})).rejects.toThrow("尚未开始海外搜索");
      expect(calls).toBe(1);
    }
  });
  it("distinguishes incomplete research from unavailable sources and rejected candidates",()=>{
    expect(emptyLeadResultMessage({outcome:"research_incomplete",pendingCompanies:7})).toContain("可继续查找");
    expect(emptyLeadResultMessage({outcome:"no_usable_sources"})).toContain("请稍后重试");
    expect(emptyLeadResultMessage({outcome:"no_company_candidates"})).toContain("暂未找到");
  });
  it("explains why few companies survived, without leaking search internals",()=>{
    const text=describeReviewIssues({reviewedCompanies:12,constraintPendingCompanies:3,reviewIssues:{not_a_target_buyer:5,specific_business_connection_unconfirmed:4,official_site_unconfirmed:3}});
    expect(text).toContain("判断了 12 家");
    expect(text).toContain("5 家自身业务未支持本次采购关系");
    expect(text).toContain("3 家条件还没证据");
    // 只解释原因，不出现查询词、渠道名等检索细节。
    expect(text).not.toMatch(/query|渠道|cookie/i);
    expect(describeReviewIssues({})).toBeNull();
    expect(describeReviewIssues({reviewIssues:{not_a_target_buyer:0}})).toBeNull();
  });
  it("does not blacklist business sectors by their names",()=>{
    const brief=normalizeProductBrief({coreCategory:"gift light",searchProduct:"paper takeaway box",searchChannels:["gift trade fairs","florist associations","gift distributor directories","independent gift wholesalers","museum gift shops"]},input.brief);
    expect(brief.searchChannels).toEqual(["gift trade fairs","florist associations","gift distributor directories","independent gift wholesalers","museum gift shops"]);
    const r=buildLeadDiscoveryRequest({...input,brief:{...brief,searchChannels:["gift directories","gift wholesalers"]}});
    expect(r.channels).toEqual(["gift directories","gift wholesalers"]);
  });
  it("accepts an interpreted trade-show customer instead of rejecting its sector word",async()=>{
    const calls:boolean[]=[];
    const brief=await interpretProductBrief({product:"booth lighting",query:"find trade show organizers buying lighting",context:""},async repair=>{
      calls.push(repair);return JSON.stringify({coreCategory:"booth lighting",searchProduct:"booth lighting",searchChannels:["trade show organizers"]});
    });
    expect(calls).toEqual([false]);expect(brief.searchChannels).toEqual(["trade show organizers"]);
  });
  it("does not spend search calls or claim a valid plan when the configured model rejects authorization",async()=>{
    let calls=0;
    await expect(interpretProductBrief({product:"",query:"找海外买家",context:"Product name: Botanical Gift Light"},async()=>{calls++;throw Error("HTTP 403 Forbidden");})).rejects.toThrow("尚未开始海外搜索");
    expect(calls).toBe(1);
  });
});
