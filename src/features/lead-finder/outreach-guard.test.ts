import { describe, expect, it } from "vitest";
import {
  normalizeOutreachEmailFormat,
  parseOutreachUserConstraints,
  violatesOutreachUserConstraints,
} from "./outreach-guard";

describe("outreach instruction guard", () => {
  it("recognizes a Chinese ban on asking for email or contacts", () => {
    const constraints = parseOutreachUserConstraints("不要问邮箱，不要问联系人，也不要请求转给采购负责人");
    expect(constraints.forbidContactRequests).toBe(true);
    expect(violatesOutreachUserConstraints(
      "Since this is a general inbox, could you point me toward the person handling sourcing?",
      constraints,
    )).toBe(true);
  });

  it("does not reject a direct value offer", () => {
    const constraints = parseOutreachUserConstraints("不要问邮箱，不要问联系人");
    expect(violatesOutreachUserConstraints(
      "I can send a one-page selection with six product photos and indicative price ranges.",
      constraints,
    )).toBe(false);
  });

  it("separates the greeting and sign-off into normal email paragraphs", () => {
    expect(normalizeOutreachEmailFormat(
      "Hi Bruce, I noticed your decorative lighting range.\nWould a six-item selection with price ranges be useful?\nBest regards, Jeremy",
    )).toBe(
      "Hi Bruce,\n\nI noticed your decorative lighting range.\nWould a six-item selection with price ranges be useful?\nBest regards,\nJeremy",
    );
  });
});
