import type { ConnectionSecurity } from "./api";

/** Standard incoming-mail ports for the selected protocol and security mode. */
export function defaultIncomingPort(
  protocol: "imap" | "pop3",
  security: ConnectionSecurity,
): number {
  if (protocol === "pop3") {
    return security === "tls" ? 995 : 110;
  }
  return security === "tls" ? 993 : 143;
}

/** Standard SMTP port for the selected security mode. */
export function defaultSmtpPort(security: ConnectionSecurity): number {
  if (security === "tls") return 465;
  return security === "starttls" ? 587 : 25;
}
