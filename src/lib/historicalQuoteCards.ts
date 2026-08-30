const CARD_CLASS = "pebble-history-quote";
const HEADER_CLASS = "pebble-history-quote__header";
const BODY_CLASS = "pebble-history-quote__body";

function addClass(element: Element | null, className: string) {
  if (element instanceof HTMLElement) element.classList.add(className);
}

function cardKnownContainers(root: ParentNode) {
  const selectors = [
    '[class*="compose-original-quote"]',
    '[class*="ntes-mailmaster-quote"]',
    '.gmail_quote',
    '.yahoo_quoted',
    '[class*="zmail_extra"]',
  ];
  root.querySelectorAll<HTMLElement>(selectors.join(",")).forEach((element) => {
    element.classList.add(CARD_CLASS);
    if (element.matches('[class*="ntes-mailmaster-quote"]')) {
      element.classList.add("pebble-history-quote--netease");
      addClass(element.children.item(0), "pebble-history-quote__title");
      addClass(element.children.item(1), HEADER_CLASS);
      const body = document.createElement("div");
      body.className = BODY_CLASS;
      while (element.children.length > 2) body.appendChild(element.children.item(2)!);
      if (body.childNodes.length) element.appendChild(body);
    }
    if (element.matches(".gmail_quote")) {
      addClass(element.querySelector(".gmail_attr"), HEADER_CLASS);
      addClass(element.querySelector("blockquote"), BODY_CLASS);
    }
    if (element.matches('[class*="zmail_extra"]')) {
      addClass(element.querySelector('[id*="Zm-_Id_-Sgn"], [id*="Sgn1"]'), HEADER_CLASS);
      addClass(element.querySelector('blockquote[id*="blockquote_zmail"], blockquote'), BODY_CLASS);
    }
  });
}

function cardOutlookReplies(root: ParentNode) {
  const headers = Array.from(root.querySelectorAll<HTMLElement>('[id*="divRplyFwdMsg"]')).reverse();
  for (const header of headers) {
    if (header.parentElement?.classList.contains(CARD_CLASS)) continue;
    const parent = header.parentElement;
    if (!parent) continue;
    const card = document.createElement("div");
    card.className = `${CARD_CLASS} pebble-history-quote--outlook`;
    parent.insertBefore(card, header);
    let cursor: ChildNode | null = header.nextSibling;
    header.classList.add(HEADER_CLASS);
    card.appendChild(header);
    const body = document.createElement("div");
    body.className = BODY_CLASS;
    while (cursor) {
      const next: ChildNode | null = cursor.nextSibling;
      body.appendChild(cursor);
      cursor = next;
    }
    if (body.childNodes.length) card.appendChild(body);
    const previous = card.previousElementSibling;
    if (previous?.tagName === "HR") previous.classList.add("pebble-history-quote__separator");
  }
}

function cardStandaloneBlockquotes(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('blockquote[type="cite"], blockquote[id*="blockquote_zmail"]').forEach((element) => {
    if (!element.closest(`.${CARD_CLASS}`)) element.classList.add(CARD_CLASS, BODY_CLASS);
  });
}

function cardPlainTextReplies(root: ParentNode) {
  const pattern = /(?:-{2,}\s*(?:Original Message|Forwarded message|回复的原邮件|原始邮件)\s*-{2,}|(?:^|\n)(?:From|发件人)\s*[:：])/i;
  root.querySelectorAll<HTMLPreElement>("pre").forEach((pre) => {
    if (pre.closest(`.${CARD_CLASS}`)) return;
    const text = pre.textContent || "";
    const match = pattern.exec(text);
    if (!match || match.index <= 0) return;
    const before = text.slice(0, match.index).trimEnd();
    const quoted = text.slice(match.index).trim();
    const headerEnd = /\n\s*\n/.exec(quoted);
    const headerText = headerEnd ? quoted.slice(0, headerEnd.index) : quoted.split("\n").slice(0, 6).join("\n");
    const bodyText = headerEnd ? quoted.slice(headerEnd.index).trim() : quoted.slice(headerText.length).trim();
    const fragment = document.createDocumentFragment();
    if (before) {
      const current = document.createElement("pre");
      current.textContent = before;
      fragment.appendChild(current);
    }
    const card = document.createElement("div");
    card.className = `${CARD_CLASS} pebble-history-quote--plain`;
    const header = document.createElement("pre");
    header.className = HEADER_CLASS;
    header.textContent = headerText;
    card.appendChild(header);
    if (bodyText) {
      const body = document.createElement("pre");
      body.className = BODY_CLASS;
      body.textContent = bodyText;
      card.appendChild(body);
    }
    fragment.appendChild(card);
    pre.replaceWith(fragment);
  });
}

/** Normalize common historical reply formats at display time only.
 * The stored message HTML is never rewritten. */
export function decorateHistoricalQuoteCards(root: ParentNode) {
  cardKnownContainers(root);
  cardOutlookReplies(root);
  cardStandaloneBlockquotes(root);
  cardPlainTextReplies(root);
}
