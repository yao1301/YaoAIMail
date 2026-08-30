import { describe, expect, it } from "vitest";
import { detectTradeSkill, extractOutreachDraft, getTradeSkill, TRADE_SKILLS } from "./tradeSkills";

describe("trade skill registry and router", () => {
  it("contains the seven approved skills and excludes inquiry extraction", () => {
    expect(TRADE_SKILLS).toHaveLength(7);
    expect(TRADE_SKILLS.map((skill) => skill.id)).not.toContain("inquiry-analysis");
  });

  it.each([
    ["调研一下这家公司是否适合做客户", "account-research"],
    ["验证这些邮箱是不是属于这家公司", "company-email-verification"],
    ["研究后帮我写一封英文开发信", "research-first-outreach"],
    ["分析客户的压价，我应该怎么回复", "trade-reply-strategy"],
    ["规划未来三次跟进", "follow-up-planner"],
    ["给我今天的邮件简报", "daily-trade-briefing"],
    ["总结这个客户的往来邮件", "conversation-summary"],
  ])("routes %s", (prompt, expected) => {
    expect(detectTradeSkill(prompt)?.id).toBe(expected);
  });

  it("does not force ordinary chat into a skill", () => {
    expect(detectTradeSkill("这个产品有哪些常见用途？")).toBeNull();
    expect(getTradeSkill("conversation-summary")?.permission).toBe("只读分析");
  });

  it("extracts only the draft section for hard-constraint validation", () => {
    const result = "## 切入策略\n不要询问联系人。\n\n## 邮件正文\nHi team,\n\nWould a six-item selection be useful?\n\n## 发送前确认\n核实产品。";
    expect(extractOutreachDraft(result)).toBe("Hi team,\n\nWould a six-item selection be useful?");
  });
});
