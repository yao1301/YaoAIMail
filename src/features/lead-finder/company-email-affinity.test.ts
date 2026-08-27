import { describe, expect, it } from "vitest";
import { emailStrictlyMatchesCompany } from "./company-email-affinity";

describe("strict company email affinity", () => {
  const lead = { companyName: "Scandinavian Design Center", website: "https://scandinavian-design.center", websiteStatus: "已核验" };

  it("rejects screenshot domains that only share the generic word design", () => {
    expect(emailStrictlyMatchesCompany({ ...lead, email: "hello@scandinavian-design.center", evidenceSource: "官网同站深挖" })).toBe(true);
    expect(emailStrictlyMatchesCompany({ ...lead, email: "info.tw@ifdesign.com", evidenceSource: "公开检索" })).toBe(false);
    expect(emailStrictlyMatchesCompany({ ...lead, email: "service.tw@eifdesign.com", evidenceSource: "公开检索" })).toBe(false);
  });

  it("keeps a genuine branded alias but rejects an unrelated repeated domain", () => {
    expect(emailStrictlyMatchesCompany({ email: "info@ocambiance.com", companyName: "Ambiance Home", website: "ambiancehome.com" })).toBe(true);
    expect(emailStrictlyMatchesCompany({ email: "sales@unrelated-example.com", companyName: "Ambiance Home", website: "ambiancehome.com" })).toBe(false);
  });

  it("accepts public mail only as first-party evidence on a verified website", () => {
    const base = { email: "owner@gmail.com", companyName: "Nordic Bloom", website: "nordicbloom.se", websiteStatus: "已核验" };
    expect(emailStrictlyMatchesCompany({ ...base, evidenceSource: "官网同站深挖" })).toBe(true);
    expect(emailStrictlyMatchesCompany({ ...base, evidenceSource: "第三方目录" })).toBe(false);
  });
});
