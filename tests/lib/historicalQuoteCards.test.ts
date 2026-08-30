import { describe, expect, it } from "vitest";
import { decorateHistoricalQuoteCards } from "../../src/lib/historicalQuoteCards";
import { sanitizeHtml } from "../../src/lib/sanitizeHtml";

function decorate(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  decorateHistoricalQuoteCards(root);
  return root;
}

describe("historical reply cards", () => {
  it("cards Outlook reply headers together with the quoted body", () => {
    const root = decorate('<p>New reply</p><hr><div id="divRplyFwdMsg"><b>From:</b> sender<br><b>Sent:</b> today<br><b>To:</b> buyer<br><b>Subject:</b> Re</div><div>Old body</div>');
    const card = root.querySelector(".pebble-history-quote--outlook");
    expect(card?.querySelector(".pebble-history-quote__header")?.textContent).toContain("From:");
    expect(card?.querySelector(".pebble-history-quote__body")?.textContent).toContain("Old body");
  });

  it("still recognizes Outlook markers after the normal email sanitizer", () => {
    const root = decorate(sanitizeHtml('<hr><div id="divRplyFwdMsg"><b>From:</b> sender<br><b>Sent:</b> today<br><b>To:</b> buyer</div><div>Old body</div>'));
    expect(root.querySelector(".pebble-history-quote--outlook")?.textContent).toContain("Old body");
  });

  it("recognizes NetEase and zmail historical formats", () => {
    const root = decorate('<div class="J-reply ntes-mailmaster-quote"><div>原邮件</div><div><table><tr><td>发件人</td></tr></table></div><div>正文</div></div><div class="zmail_extra"><div id="Zm-_Id_-Sgn1">From: sender<br>To: buyer</div><blockquote id="blockquote_zmail">Older</blockquote></div>');
    expect(root.querySelectorAll(".pebble-history-quote")).toHaveLength(2);
    expect(root.querySelectorAll(".pebble-history-quote__header")).toHaveLength(2);
  });

  it("recognizes Gmail and prefixed copies of the generated quote class", () => {
    const root = decorate('<div class="gmail_quote"><div class="gmail_attr">On date sender wrote:</div><blockquote>Old</blockquote></div><blockquote class="x_compose-original-quote">Generated old</blockquote>');
    expect(root.querySelector(".gmail_quote")?.classList.contains("pebble-history-quote")).toBe(true);
    expect(root.querySelector(".x_compose-original-quote")?.classList.contains("pebble-history-quote")).toBe(true);
  });

  it("splits a plain-text original-message section without changing its text", () => {
    const root = decorate('<pre>Current reply\n\n-----Original Message-----\nFrom: sender\nSent: today\nTo: buyer\nSubject: Re\n\nOld body</pre>');
    expect(root.querySelector(".pebble-history-quote--plain .pebble-history-quote__header")?.textContent).toContain("Subject: Re");
    expect(root.querySelector(".pebble-history-quote__body")?.textContent).toBe("Old body");
    expect(root.textContent).toContain("Current reply");
  });
});
