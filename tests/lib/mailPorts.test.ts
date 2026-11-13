import { describe, expect, it } from "vitest";
import { defaultIncomingPort, defaultSmtpPort } from "../../src/lib/mailPorts";

describe("mail connection default ports", () => {
  it("uses the standard IMAP and POP3 ports for each security mode", () => {
    expect(defaultIncomingPort("imap", "tls")).toBe(993);
    expect(defaultIncomingPort("imap", "starttls")).toBe(143);
    expect(defaultIncomingPort("imap", "plain")).toBe(143);
    expect(defaultIncomingPort("pop3", "tls")).toBe(995);
    expect(defaultIncomingPort("pop3", "starttls")).toBe(110);
    expect(defaultIncomingPort("pop3", "plain")).toBe(110);
  });

  it("uses the standard SMTP ports for each security mode", () => {
    expect(defaultSmtpPort("tls")).toBe(465);
    expect(defaultSmtpPort("starttls")).toBe(587);
    expect(defaultSmtpPort("plain")).toBe(25);
  });
});
