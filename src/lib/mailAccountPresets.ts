import type { AddAccountRequest } from "./ipc-types";

type Servers = Pick<AddAccountRequest, "imap_host" | "imap_port" | "imap_security" | "smtp_host" | "smtp_port" | "smtp_security">;

function servers(imapHost: string, smtpHost: string, smtpPort: 465 | 587): Servers {
  return {
    imap_host: imapHost, imap_port: 993, imap_security: "tls",
    smtp_host: smtpHost, smtp_port: smtpPort, smtp_security: smtpPort === 465 ? "tls" : "starttls",
  };
}

export interface MailAccountPreset {
  id: string;
  label: string;
  domains: string[];
  servers: Servers;
}

export const MAIL_ACCOUNT_PRESETS: MailAccountPreset[] = [
  { id: "gmail", label: "Gmail", domains: ["gmail.com", "googlemail.com"], servers: servers("imap.gmail.com", "smtp.gmail.com", 587) },
  { id: "outlook", label: "Outlook", domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"], servers: servers("outlook.office365.com", "smtp.office365.com", 587) },
  { id: "qq", label: "QQ 邮箱", domains: ["qq.com", "foxmail.com"], servers: servers("imap.qq.com", "smtp.qq.com", 465) },
  { id: "163", label: "163 邮箱", domains: ["163.com"], servers: servers("imap.163.com", "smtp.163.com", 465) },
  { id: "cecloud", label: "中国电子云", domains: ["cecloud.com"], servers: servers("imap.cecloud.com", "smtp.cecloud.com", 465) },
  { id: "aliyun", label: "阿里企业邮箱", domains: [], servers: servers("imap.qiye.aliyun.com", "smtp.qiye.aliyun.com", 465) },
  { id: "exmail", label: "腾讯企业邮箱", domains: [], servers: servers("imap.exmail.qq.com", "smtp.exmail.qq.com", 465) },
  { id: "zoho", label: "Zoho Mail（国际站个人）", domains: ["zoho.com", "zohomail.com"], servers: servers("imap.zoho.com", "smtp.zoho.com", 465) },
  { id: "zoho-org", label: "Zoho Mail（国际站企业）", domains: [], servers: servers("imappro.zoho.com", "smtppro.zoho.com", 465) },
];

export function detectMailAccountPreset(email: string) {
  const match = /^[^\s@]+@([^\s@]+)$/.exec(email.trim().toLowerCase());
  return match && MAIL_ACCOUNT_PRESETS.find(preset => preset.domains.includes(match[1]));
}

export function findMailServerPreset(email: string, ...hosts: string[]) {
  const names = hosts.map(host => host.trim().toLowerCase());
  // Hosted business email can use a custom email domain. Only recognize a
  // provider when one of its known server names is already configured.
  return MAIL_ACCOUNT_PRESETS.find(({ servers }) =>
    names.includes(servers.imap_host) || names.includes(servers.smtp_host),
  ) ?? (names.some(name => /^(?:imap|smtp|pop)\d*\.cecloud\.com$/.test(name))
    ? MAIL_ACCOUNT_PRESETS.find(preset => preset.id === "cecloud")
    : detectMailAccountPreset(email) || undefined);
}
