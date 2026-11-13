import { describe, expect, it } from "vitest";
import { decorateHistoricalQuoteCards, plainTextEmailToHtml } from "./historicalQuoteCards";
import { sanitizeHtml } from "./sanitizeHtml";

function decorate(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  decorateHistoricalQuoteCards(root);
  return root;
}

describe("historical quote cards", () => {
  it("keeps provider-specific reply containers carded", () => {
    const gmail = decorate('<div class="gmail_quote"><div class="gmail_attr">On Monday wrote:</div><blockquote>Previous reply</blockquote></div>');
    expect(gmail.querySelector(".pebble-history-quote")).not.toBeNull();
    expect(gmail.querySelector(".pebble-history-quote__header")?.textContent).toContain("On Monday");
    expect(gmail.querySelector(".pebble-history-quote__body")?.textContent).toContain("Previous reply");

    const netease = decorate('<div class="ntes-mailmaster-quote"><div>Original Message</div><div>From: sender@example.com</div><p>Previous reply</p></div>');
    expect(netease.querySelector(".pebble-history-quote")).not.toBeNull();
    expect(netease.querySelector(".pebble-history-quote__body")?.textContent).toContain("Previous reply");
  });

  it("normalizes dashed Replied Message headers", () => {
    const root = decorate(`
      <div class="J-reply ntes-mailmaster-quote">
        <div>---- Replied Message ----</div>
        <div><table><tbody><tr><td>From</td><td>sender@example.com</td></tr></tbody></table></div>
        <p>Earlier reply.</p>
      </div>
    `);

    const card = root.querySelector(".pebble-history-quote");
    expect(card?.querySelector(":scope > .pebble-history-quote__title")?.textContent).toBe("Replied Message");
    expect(card?.querySelector(":scope > .pebble-history-quote__header")?.textContent).toContain("sender@example.com");
    expect(card?.querySelector(":scope > .pebble-history-quote__body")?.textContent).toContain("Earlier reply.");
  });

  it("splits the compose quote title from its metadata wrapper", () => {
    const root = decorate(`
      <div class="compose-original-quote">
        <div>
          <div>回复的原邮件</div>
          <table><tbody><tr><td>发件人</td><td>sender@example.com</td></tr></tbody></table>
        </div>
        <div>Earlier reply.</div>
      </div>
    `);

    const card = root.querySelector(".compose-original-quote.pebble-history-quote");
    expect(card?.children[0].classList.contains("pebble-history-quote__title")).toBe(true);
    expect(card?.children[1].classList.contains("pebble-history-quote__header")).toBe(true);
    expect(card?.querySelector(":scope > .pebble-history-quote__body")?.textContent).toContain("Earlier reply.");
  });

  it("ignores compose markers that Outlook copies onto quote table descendants", () => {
    const root = decorate(`
      <div>
        <p>Current reply.</p>
        <div id="divRplyFwdMsg">From: sender@example.com<br>Sent: Monday<br>To: buyer@example.com<br>Subject: Previous topic</div>
        <div class="x_compose-original-quote">回复的原邮件</div>
        <table class="x_compose-original-quote"><tbody>
          <tr>
            <td class="x_compose-original-quote"><div class="x_compose-original-quote">发件人</div></td>
            <td class="x_compose-original-quote"><div class="x_compose-original-quote">sender@example.com</div></td>
          </tr>
          <tr>
            <td class="x_compose-original-quote"><div class="x_compose-original-quote">收件人</div></td>
            <td class="x_compose-original-quote"><div class="x_compose-original-quote">buyer@example.com</div></td>
          </tr>
        </tbody></table>
        <div>Earlier reply.</div>
      </div>
    `);

    const cards = root.querySelectorAll(".pebble-history-quote");
    expect(cards).toHaveLength(1);
    expect(cards[0].classList.contains("pebble-history-quote--outlook")).toBe(true);
    expect(cards[0].querySelectorAll("table.pebble-history-quote, td.pebble-history-quote")).toHaveLength(0);
    expect(cards[0].querySelector(".pebble-history-quote__body")?.textContent).toContain("Earlier reply.");
  });

  it("cards readable reply headers even after a server removes client class/id markers", () => {
    const root = decorate(`
      <div>
        <p>Current reply.</p>
        <div>From: sender@example.com<br>Sent: Monday, 1 September<br>To: me@example.com<br>Subject: Previous topic</div>
        <div>Earlier conversation content.</div>
      </div>
    `);

    const card = root.querySelector(".pebble-history-quote--readable-header");
    expect(card).not.toBeNull();
    expect(card?.querySelector(".pebble-history-quote__header")?.textContent).toContain("Previous topic");
    expect(card?.querySelector(".pebble-history-quote__body")?.textContent).toContain("Earlier conversation content.");
  });

  it("supports common On ... wrote reply leads without a vendor marker", () => {
    const root = decorate('<div><p>Current reply.</p><p>On Monday Alice wrote:</p><blockquote>Earlier conversation content.</blockquote></div>');
    const card = root.querySelector(".pebble-history-quote--readable-header");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Earlier conversation content.");
  });

  it("still recognizes readable headers after the frontend security sanitizer", () => {
    const sanitized = sanitizeHtml(`
      <div><p>Current reply.</p>
      <table class="server-rewritten"><tbody><tr><td>From: sender@example.com<br>Sent: Monday<br>To: me@example.com<br>Subject: Previous topic</td></tr></tbody></table>
      <blockquote type="cite">Earlier conversation content.</blockquote></div>
    `);
    const root = decorate(sanitized);
    expect(root.querySelector(".pebble-history-quote--readable-header")).not.toBeNull();
    expect(root.querySelector(".pebble-history-quote")?.textContent).toContain("Earlier conversation content.");
  });

  it("keeps text-only mail inert while turning a forwarded section into a card", () => {
    const html = plainTextEmailToHtml("Current reply\n\n----- Original Message -----\nFrom: sender@example.com\n\nEarlier text <img src=x>");
    const root = decorate(html);
    expect(root.querySelector(".pebble-history-quote--plain")).not.toBeNull();
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("Earlier text <img src=x>");
  });

  it("cards Zoho-style Original metadata lists and their following message body", () => {
    const root = decorate(`
      <div id="isReplyContent">
        <div>Original:</div>
        <ul><li>From: sales@example.com</li><li>Date: 2026-08-21</li><li>Subject: Previous topic</li></ul>
        <p>Earlier message body.</p>
        <blockquote class="compose-original-quote"><p>2026/8/20 Alice wrote:</p><p>Nested reply.</p></blockquote>
      </div>
    `);

    const card = root.querySelector("#isReplyContent.pebble-history-quote");
    expect(card?.querySelector(":scope > .pebble-history-quote__title")?.textContent).toContain("Original");
    expect(card?.querySelector(":scope > .pebble-history-quote__header")?.textContent).toContain("Previous topic");
    expect(card?.querySelector(":scope > .pebble-history-quote__body")?.textContent).toContain("Earlier message body");
    expect(card?.querySelector(".compose-original-quote.pebble-history-quote")?.textContent).toContain("Nested reply");
  });

  it("cards delimiter-based reply metadata emitted as sibling nodes", () => {
    const root = decorate(`
      <div>Current reply.</div>
      <div>----------------</div>
      <div>To: buyer@example.com;</div>
      <div>Cc: colleague@example.com;</div>
      <div>Subject: Previous topic;</div>
      <div>05.03.2026, 12:00, "sales" &lt;sales@example.com&gt;:</div>
      <blockquote><div>Earlier message body.</div></blockquote>
    `);

    const card = root.querySelector(".pebble-history-quote--delimited");
    expect(card?.querySelector(".pebble-history-quote__header")?.textContent).toContain("Previous topic");
    expect(card?.querySelector(".pebble-history-quote__body")?.textContent).toContain("Earlier message body");
    expect(card?.textContent).not.toContain("Current reply");
  });

  it("cards delimiter-based reply metadata nested in one client container", () => {
    const root = decorate(`
      <div>Current reply.</div>
      <div>----------------
        <div>19.11.2024, 11:12, "sales@example.com" &lt;sales@example.com&gt;:</div>
        <div>To: buyer@example.com;</div>
        <div>Cc: colleague@example.com;</div>
        <div>Subject: Previous topic;</div>
        <blockquote><div>Earlier message body.</div></blockquote>
      </div>
    `);

    const card = root.querySelector(".pebble-history-quote--delimited");
    expect(card?.querySelector(".pebble-history-quote__header")?.textContent).toContain("Previous topic");
    expect(card?.querySelector(".pebble-history-quote__body")?.textContent).toContain("Earlier message body");
  });

  it("does not card decorative or newsletter blockquotes without complete reply metadata", () => {
    const root = decorate(`
      <div>----------------</div>
      <div>Subject: A normal section heading</div>
      <blockquote><p>Impact report content, not a quoted email.</p></blockquote>
    `);

    expect(root.querySelector(".pebble-history-quote--delimited")).toBeNull();
    expect(root.querySelector("blockquote")?.textContent).toContain("Impact report");
  });
});
