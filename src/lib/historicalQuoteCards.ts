const CARD_CLASS = "pebble-history-quote";
const HEADER_CLASS = "pebble-history-quote__header";
const BODY_CLASS = "pebble-history-quote__body";
const COMPOSE_QUOTE_SELECTOR = '[class*="compose-original-quote"]';
const TABLE_STRUCTURE_TAGS = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH", "COLGROUP", "COL"]);

/** Convert text-only mail to inert markup for the display-only card pipeline. */
export function plainTextEmailToHtml(text: string): string {
  const pre = document.createElement("pre");
  pre.textContent = text;
  return pre.outerHTML;
}

function addClass(element: Element | null, className: string) {
  if (element instanceof HTMLElement) element.classList.add(className);
}

const CARD_TITLE_PATTERN = /^(?:original|original message|forwarded message|replied message|原始邮件|原邮件|回复的原邮件)\s*[:：]?$/i;

function normalizeCardTitle(element: Element | null) {
  if (!(element instanceof HTMLElement)) return;
  const text = (element.textContent || "").replace(/\s+/g, " ").trim();
  const dashedTitle = text.match(/^-{2,}\s*(original message|forwarded message|replied message)\s*-{2,}$/i);
  if (dashedTitle) element.textContent = dashedTitle[1];
  element.classList.add("pebble-history-quote__title");
}

function moveFollowingChildrenIntoBody(container: HTMLElement, after: Element | null) {
  const body = document.createElement("div");
  body.className = BODY_CLASS;
  let cursor = after ? after.nextSibling : container.firstChild;
  while (cursor) {
    const next = cursor.nextSibling;
    body.appendChild(cursor);
    cursor = next;
  }
  if (body.childNodes.length) container.appendChild(body);
}

/**
 * Outlook can copy the class from our generated quote wrapper onto every
 * descendant while rewriting a reply (table, cells and text divs included).
 * Those copies are markers, not standalone quote containers.  Only accept a
 * node that still has a container shape; Outlook's reply wrapper/readable
 * header fallback will card the rewritten version as one historical message.
 */
function isComposeQuoteContainer(element: HTMLElement): boolean {
  if (TABLE_STRUCTURE_TAGS.has(element.tagName)) return false;

  const markerAncestor = element.parentElement?.closest<HTMLElement>(COMPOSE_QUOTE_SELECTOR);
  if (markerAncestor) return false;

  // Quoted-message blockquotes are already semantic containers, including
  // prefixed copies such as Outlook's x_compose-original-quote.
  if (element.tagName === "BLOCKQUOTE") return true;

  const first = element.firstElementChild;
  const hasGeneratedHeader = first
    ? Array.from(first.children).some((child) => CARD_TITLE_PATTERN.test(
      (child.textContent || "").replace(/\s+/g, " ").trim(),
    )) && Array.from(first.children).some((child) => child.tagName === "TABLE")
    : false;
  const firstText = (first?.textContent || "").replace(/\s+/g, " ").trim();
  const hasGenericHeaderAndBody = element.children.length >= 2
    && firstText.length > 0
    && firstText.length <= 1000
    && /(?:wrote\s*[:：]?|写道\s*[:：]?|^\d{4}[\/.\-年]\d{1,2})/i.test(firstText);

  // The native generated quote has a metadata wrapper and a body. Generic
  // provider-preserved variants likewise need at least header + body nodes.
  return hasGeneratedHeader || hasGenericHeaderAndBody;
}

function cardKnownContainers(root: ParentNode) {
  const selectors = [
    COMPOSE_QUOTE_SELECTOR,
    '[class*="ntes-mailmaster-quote"]',
    '.gmail_quote',
    '.yahoo_quoted',
    '[class*="zmail_extra"]',
    '[id*="isReplyContent"]',
  ];
  root.querySelectorAll<HTMLElement>(selectors.join(",")).forEach((element) => {
    if (element.matches(COMPOSE_QUOTE_SELECTOR) && !isComposeQuoteContainer(element)) return;
    element.classList.add(CARD_CLASS);
    if (element.matches('[id*="isReplyContent"]')) {
      const title = element.firstElementChild;
      const header = title?.nextElementSibling ?? null;
      if (title && CARD_TITLE_PATTERN.test((title.textContent || "").replace(/\s+/g, " ").trim())) {
        normalizeCardTitle(title);
        if (header) addClass(header, HEADER_CLASS);
        moveFollowingChildrenIntoBody(element, header ?? title);
      } else {
        moveFollowingChildrenIntoBody(element, null);
      }
    }
    if (element.matches('[class*="ntes-mailmaster-quote"]')) {
      element.classList.add("pebble-history-quote--netease");
      normalizeCardTitle(element.children.item(0));
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
    if (element.matches(COMPOSE_QUOTE_SELECTOR)) {
      const first = element.firstElementChild;
      const firstText = (first?.textContent || "").replace(/\s+/g, " ").trim();
      const nestedTitle = first
        ? Array.from(first.children).find((child) => CARD_TITLE_PATTERN.test(
          (child.textContent || "").replace(/\s+/g, " ").trim(),
        )) ?? null
        : null;
      const nestedHeaderTable = first
        ? Array.from(first.children).find((child) => child.tagName === "TABLE") ?? null
        : null;
      if (first instanceof HTMLElement && nestedTitle && nestedHeaderTable) {
        // The compose view stores the title and metadata table inside one
        // styled wrapper. Pull the title up one level so every card uses the
        // same title/header/body structure, regardless of who created it.
        element.insertBefore(nestedTitle, first);
        normalizeCardTitle(nestedTitle);
        first.classList.add(HEADER_CLASS);
        moveFollowingChildrenIntoBody(element, first);
        return;
      }
      const looksLikeHeader = firstText.length > 0 && firstText.length <= 1000
        && /(?:wrote\s*[:：]?|写道\s*[:：]?|^\d{4}[\/.\-年]\d{1,2})/i.test(firstText);
      if (looksLikeHeader) addClass(first, HEADER_CLASS);
      moveFollowingChildrenIntoBody(element, looksLikeHeader ? first : null);
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

function directText(element: Element): string {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent || "")
    .join(" ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function isDelimitedReplyMetadata(text: string): boolean {
  const normalized = text.replace(/\u00a0/g, " ");
  const hasRecipients = /(?:^|\s)(?:from|to|cc|发件人|收件人|抄送)\s*[:：]/i.test(normalized);
  const hasSubject = /(?:^|\s)(?:subject|主题)\s*[:：]/i.test(normalized);
  const hasDateOrSender = /(?:\d{1,4}[./\-]\d{1,2}[./\-]\d{1,4}|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i.test(normalized);
  return normalized.length <= 2500 && hasRecipients && hasSubject && hasDateOrSender;
}

/**
 * Foxmail and a few mobile clients emit no vendor class at all. Their stable
 * shape is a dashed separator, To/Cc/Subject/date metadata, then a blockquote.
 * Require the complete shape so decorative separators and newsletter
 * blockquotes are not mistaken for message history.
 */
function cardDelimitedReplies(root: ParentNode) {
  const separators = Array.from(root.querySelectorAll<HTMLElement>("div, p"))
    .filter((element) => !element.closest(`.${CARD_CLASS}`))
    .filter((element) => /^-{5,}$/.test(directText(element)));

  for (const separator of separators) {
    const directQuote = Array.from(separator.children).find((child) => child.tagName === "BLOCKQUOTE") ?? null;
    if (directQuote) {
      const nodesBeforeQuote: ChildNode[] = [];
      let cursor = separator.firstChild;
      while (cursor && cursor !== directQuote) {
        nodesBeforeQuote.push(cursor);
        cursor = cursor.nextSibling;
      }
      const metadata = nodesBeforeQuote.map((node) => node.textContent || "").join(" ");
      if (!isDelimitedReplyMetadata(metadata)) continue;

      separator.classList.add(CARD_CLASS, "pebble-history-quote--delimited");
      const header = document.createElement("div");
      header.className = HEADER_CLASS;
      nodesBeforeQuote.forEach((node) => header.appendChild(node));
      separator.insertBefore(header, directQuote);
      moveFollowingChildrenIntoBody(separator, header);
      continue;
    }

    const following: Element[] = [];
    let cursor = separator.nextElementSibling;
    while (cursor && following.length < 12) {
      following.push(cursor);
      if (cursor.tagName === "BLOCKQUOTE") break;
      cursor = cursor.nextElementSibling;
    }
    const quoteIndex = following.findIndex((element) => element.tagName === "BLOCKQUOTE");
    if (quoteIndex < 0) continue;
    const metadataNodes = following.slice(0, quoteIndex);
    const metadata = metadataNodes.map((node) => node.textContent || "").join(" ");
    if (!isDelimitedReplyMetadata(metadata)) continue;

    const parent = separator.parentElement;
    if (!parent) continue;
    const card = document.createElement("div");
    card.className = `${CARD_CLASS} pebble-history-quote--delimited`;
    parent.insertBefore(card, separator);
    const header = document.createElement("div");
    header.className = HEADER_CLASS;
    header.appendChild(separator);
    metadataNodes.forEach((node) => header.appendChild(node));
    card.appendChild(header);
    const body = document.createElement("div");
    body.className = BODY_CLASS;
    let bodyCursor = card.nextSibling;
    while (bodyCursor) {
      const next = bodyCursor.nextSibling;
      body.appendChild(bodyCursor);
      bodyCursor = next;
    }
    if (body.childNodes.length) card.appendChild(body);
  }
}

/**
 * Some IMAP servers normalize the original client HTML while storing or
 * re-hydrating history.  In that case class/id markers (for example Outlook's
 * divRplyFwdMsg) disappear, but the human-readable reply header survives.
 * Treat that header as the stable signal, without touching stored HTML.
 */
function cardReadableReplyHeaders(root: ParentNode) {
  const headerStart = /^(?:from|发件人|寄件人|寄件者)\s*[:：]/im;
  const headerFields = /(?:sent|date|日期|发送时间|to|收件人|subject|主题)\s*[:：]/i;
  const replyLead = /^(?:on\s+.+\s+wrote\s*[:：]|在.+写道\s*[:：])/im;
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(
    "div, p, table, span, font, blockquote, pre",
  ))
    .filter((element) => !element.closest(`.${CARD_CLASS}`))
    .filter((element) => {
      const text = (element.textContent || "").replace(/\u00a0/g, " ").trim();
      // A header is intentionally short.  This prevents an outer email
      // container that happens to include a quoted reply from swallowing the
      // whole current message into a card.
      return text.length > 0 && text.length <= 1200
        && ((headerStart.test(text) && headerFields.test(text)) || replyLead.test(text));
    });

  const leafCandidates = candidates.filter(
    (element) => !candidates.some((other) => other !== element && element.contains(other)),
  );
  for (const header of leafCandidates) {
    const parent = header.parentElement;
    if (!parent || parent.closest(`.${CARD_CLASS}`)) continue;

    const body = header.nextElementSibling;
    const hasQuotedBody = body?.matches("blockquote, div, table, pre")
      || parent.nextElementSibling?.matches("blockquote, div, table, pre");
    if (!hasQuotedBody) continue;

    // Remember the following nodes before moving the header into the card.
    // Once appended, `header.nextElementSibling` would point inside the new
    // card and the historical body would be left behind in the original mail.
    const following: Element[] = [];
    let cursor: Element | null = header.nextElementSibling;
    while (cursor) {
      following.push(cursor);
      cursor = cursor.nextElementSibling;
    }

    const card = document.createElement("div");
    card.className = `${CARD_CLASS} pebble-history-quote--readable-header`;
    header.parentNode?.insertBefore(card, header);
    header.classList.add(HEADER_CLASS);
    card.appendChild(header);

    const bodyContainer = document.createElement("div");
    bodyContainer.className = BODY_CLASS;
    following.forEach((element) => bodyContainer.appendChild(element));
    if (bodyContainer.childNodes.length) card.appendChild(bodyContainer);
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
  cardDelimitedReplies(root);
  cardReadableReplyHeaders(root);
  cardStandaloneBlockquotes(root);
  cardPlainTextReplies(root);
}
