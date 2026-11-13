import { extractErrorMessage } from "./extractErrorMessage";
import i18n from "./i18n";
import type { MailAccountPreset } from "./mailAccountPresets";

export function explainMailConnectionReport(report: string, preset?: MailAccountPreset): string {
  return report.split("\n").map(line => {
    const failure = /(收件|发件 SMTP)：失败 — (.*)$/.exec(line);
    if (!failure) return line;
    const [, direction, detail] = failure;
    let reason: string;
    if (/notvalidforname|cert_cn_no_match|sec_e_wrong_principal|hostname mismatch|not valid for|0x800b010f|0x80090322|目标主体名称|证书名称不匹配|certificate.*does not match/i.test(detail)) {
      reason = i18n.t("accountSetup.certificateNameMismatch", "The certificate does not match the server address.");
    } else if (/certificate.*expir|certexpired|0x800b0101|证书.*过期/i.test(detail)) {
      reason = i18n.t("accountSetup.certificateExpired", "The server certificate has expired. Ask your mail provider to renew it.");
    } else if (/unknownissuer|certificate verify failed|invalid peer certificate|untrustedroot|self.signed|0x800b0109|certificate chain|证书链/i.test(detail)) {
      reason = i18n.t("accountSetup.certificateUntrusted", "The server certificate could not be verified.");
    } else if (/AUTHENTICATIONFAILED|LOGIN failed|(?:permanent error \()?53[45]\b|app.specific password/i.test(detail)) {
      return `${direction}：失败 — ${i18n.t("accountSetup.authenticationFailedHint", "Check your password or use an app password from your mail provider.")}`;
    } else if (/no such host|failed to resolve|host not found|os error 1100[12]|getaddrinfo/i.test(detail)) {
      return `${direction}：失败 — ${i18n.t("accountSetup.dnsFailedHint", "Check the server address and your network connection.")}`;
    } else {
      return line;
    }
    const incoming = direction === "收件";
    const settings = preset?.servers;
    const suggestion = settings && i18n.t("accountSetup.officialServerHint", "Provider settings: {{host}}:{{port}} ({{security}}).", {
      host: incoming ? settings.imap_host : settings.smtp_host,
      port: incoming ? settings.imap_port : settings.smtp_port,
      security: (incoming ? settings.imap_security : settings.smtp_security) === "tls" ? "SSL/TLS" : "STARTTLS",
    });
    return `${direction}：失败 — ${reason}${suggestion ? ` ${suggestion}` : ""}`;
  }).join("\n");
}

/** Run both checks even if one fails, and never call a partial pass a success. */
export async function testBothMailDirections(incoming: () => Promise<string>, outgoing: () => Promise<string>): Promise<string> {
  const results = await Promise.allSettled([incoming(), outgoing()]);
  const report = results.map((r, i) => `${i === 0 ? "收件" : "发件 SMTP"}：${r.status === "fulfilled" ? `通过 — ${r.value}` : `失败 — ${extractErrorMessage(r.reason)}`}`).join("\n");
  if (results.some((r) => r.status === "rejected")) throw new Error(report);
  return report;
}
