const GENERIC_COMPANY_WORDS = new Set([
  "the", "and", "company", "home", "group", "global", "international", "ltd", "limited", "inc", "llc",
  "design", "designs", "center", "centre", "shop", "store", "studio", "decor", "decoration", "gift", "gifts",
  "lighting", "furniture", "interior", "interiors", "official", "online",
]);

const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "yahoo.co.uk", "hotmail.com", "outlook.com", "live.com", "icloud.com", "aol.com",
  "protonmail.com", "proton.me", "qq.com", "163.com", "126.com", "sina.com", "foxmail.com",
]);

function websiteDomain(website: string): string {
  try {
    const value = /^https?:\/\//i.test(website) ? website : `https://${website}`;
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function emailDomain(email: string): string {
  return email.toLowerCase().split("@").pop() || "";
}

function hasDistinctiveCompanyToken(domain: string, companyName: string): boolean {
  return companyName.toLowerCase().split(/[^a-z0-9]+/)
    .some((token) => token.length >= 5 && !GENERIC_COMPANY_WORDS.has(token) && domain.includes(token));
}

export function emailStrictlyMatchesCompany(input: {
  email: string;
  companyName: string;
  website: string;
  websiteStatus?: string;
  evidenceSource?: string;
}): boolean {
  const mailDomain = emailDomain(input.email);
  const siteDomain = websiteDomain(input.website);
  if (!mailDomain) return false;
  if (siteDomain && (mailDomain === siteDomain || mailDomain.endsWith(`.${siteDomain}`))) return true;
  if (hasDistinctiveCompanyToken(mailDomain, input.companyName)) return true;
  return PUBLIC_EMAIL_DOMAINS.has(mailDomain)
    && input.websiteStatus === "已核验"
    && Boolean(input.evidenceSource?.includes("官网"));
}
