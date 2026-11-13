# Changelog

All notable changes to YaoAIMail are documented in this file. YaoAIMail is a
Windows desktop mail client for cross-border B2B sellers, developed as a fork of
[QingJ01/Pebble](https://github.com/QingJ01/Pebble) and released under
[AGPL-3.0](./LICENSE).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses semantic version tags.

Chinese version: [CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md).

## [Unreleased]

## [1.1.43] - 2026-11-13

### Reading

- Links in a message body now show their target site first and let you choose: open in your default browser, or preview inside the app. Keyboard activation, middle-click and the link context menu all use the same path. Address links still start a new message, and a body link can never navigate a mail window to an address belonging to the app itself.
- The in-app preview runs in its own titled window with separate browser data and no access to mail-window permissions, and it blocks third-party sub-windows and downloads. Sites that need a login or a download, and intranet addresses, open in the default browser instead.

### Mail reliability

- Downloaded mail now stays in its original folder. The auto-created "Local History" folder from earlier versions is migrated on startup: messages return to their own folder, or to a normal archive folder when that folder no longer exists, keeping body, attachments and deletion state. Folders you created yourself are never matched by display name.
- A message that is absent from the server's current UID list keeps its local copy, body and attachments; only its server identifier is retired. An incomplete or missing list is never used as proof of deletion, and the link is restored only after the same identifier reappears under the same account, folder and UIDVALIDITY.
- Read and star changes now apply locally when a message has no verified server identifier yet, instead of failing immediately and retrying in the background. Obsolete retries are finished at startup and current local flags are kept; a local id recorded earlier is never replayed against a server id the message later receives.

### Settings

- Preferences saved in a detached settings window now reach the main, reading and compose windows: theme, fonts, font size, background image, language, receive mode, notifications, tray behaviour, unread count, shortcuts and mail image privacy. A compose window follows the AI writing defaults while keeping options you picked by hand for the current draft.
- Account, sync-folder, filter-rule, trusted-sender and backup-restore changes refresh in every window. Refresh messages carry only a change marker; configuration values, keys and mail are never broadcast between windows.

### Work roles and About

- The work role settings now offer ready-made examples for general foreign trade, customer development, order follow-up and trade management, each pre-filled with a job title, responsibilities and writing preferences that you can adjust.
- The About page now describes the product as a mail and order follow-up, multilingual AI writing, customer development and customer management client. It keeps the privacy note and the Pebble / AGPL-3.0 credit, drops the old in-app GitHub update check, and the update button opens the official download page at https://yaowaimao.com/zh/ai-mail#download.

## [1.1.42] - 2026-11-08

Personal edition. Commercial account and credit integration is archived and is
not part of this build: the app uses the providers you configure yourself, with
no YaoAI account, credits or unlock required.

### Added

- Account matters overview: a single-round summary built from local evidence, with background refresh when the app starts.
- DeepSeek Search and Fetch support in lead development and company research, with an explicit consent step before a paid authorization is used.
- A lightweight logistics query module in the foreign-trade toolbox.
- Rotating startup tips, and an AI privacy note on the About page.

### Fixed

- New-mail notifications are attributed to the right account, and no longer reappear briefly after a filter archives the message.
- Single-record deletion of an externally configured API no longer fails, and the onboarding flow is complete.

### Changed

- Dead entries in the foreign-trade toolbox are fixed; logistics querying was audited and consolidated into one module instead of several inconsistent entry points.

## [1.1.41] - 2026-11-03

### Mail and draft reliability

- Separate the internal account nickname from the outward sender name. Queued messages retain their original sender identity and pause with a clear warning if the configured identity no longer matches.
- Improve draft saving, save-and-close behavior and delivery of generated AI content to the correct draft.
- Repair IMAP selected-folder cache handling behind UIDVALIDITY, message-size and body-fetch errors; reconcile missing-body jobs that were incorrectly marked complete.

### AI and workspace windows

- Support multiple model IDs under one custom provider configuration, with optional model-list discovery and manual entry as a fallback.
- Improve detaching lead research, credit research and compose tabs into windows, including progress feedback and safer background-task handoff.
- Fix the startup failure caused by accessing `lazy` before initialization.

### Distribution

- Provide a six-file Windows share ZIP and the exact modified source archive separately. Neither package includes mailbox data, API credentials, attachments, logs, private input history or the personal portable `data` directory.
- No test email was sent and the personal portable installation was not replaced.

## [1.1.40] - 2026-11-01

### Mail reliability

- Persist outgoing mail before SMTP submission. A send is complete only after provider acceptance and local filing stages finish.
- Retry only local filing, rules and indexing after provider acceptance; pause uncertain sends instead of resubmitting them automatically.
- Add account-scoped handling for confirmed sent records and clearer account attribution for pending-mail errors.
- Prevent a slow SMTP QUIT response from turning an already accepted message into a misleading send failure.
- Repair small remote-history gaps and partial-folder sync handling while preserving local history outside the server-visible range.

### Usability

- Allow dragging an existing message into a draft AI instruction field as context; unify reference-file processing and errors.
- Improve draft status, next-message navigation after deletion, retained search tabs, account ordering and folder boundaries.
- Show which account an email-operation error belongs to.

### Distribution

- Supply the binary package with its exact modified source archive. The package excludes personal mail, attachments, credentials, browser data, logs and input history.
- New send protections do not resend older messages. Previously confirmed queue records were handled separately in the local profile.

## [1.1.39] - 2026-10-27

### Customer profile

- Separate public-company research from customer correspondence so recent email volume no longer crowds out business details.
- Read bounded passages from longer pages and directories. Model citations resolve to the actual passage reviewed by the app.
- Keep the previous detailed profile when a refresh fails or would discard substantially more information. A saved historical profile is not presented as newly verified.

### Mail and AI workspace

- Advance to the next message after deleting the current one, and preserve search results when switching tabs.
- Use one file-reading path across the home workbench, AI writing and message instructions. Added or dropped files provide extracted contents to the model, with clear errors for unreadable or out-of-range files.
- Refine the reference-file control in the message instruction panel.

### Distribution

- Ship the binary and its exact modified source archive together. The public package excludes private mail, API credentials, personal input history and user data.
- Profile and public-search results still depend on accessible sources and the configured model. A citation provides traceability, not independent verification.

## [1.1.38] - 2026-10-25

### Added and improved

- Confirmable workbench actions for extracting drafts, organizing selected mail and scheduling saved drafts while the application is running online.
- Shared document reading through the existing three AI instruction inputs; preserve reply headers and isolate late results across messages and accounts.
- Unified customer profile refresh from scoped correspondence and public sources, with visible CRM status, characteristics and follow-up plans.
- Prospect email prechecks, optional manual verification, evidence and correspondence feedback; simpler saved search conditions. Cross-industry quality and full result pages remain subject to source and model limitations.
- Per-model proxy choice using one shared proxy configuration, clearer connection tests and visible held-send failures.
- Single and batch draft sending with shared validation, confirmation and duplicate protection, preserving HTML tables and attachments. Draft status appears only in list rows; toolbar actions use consistent icons.
- Removed redundant document-draft buttons and retained historical quote-card rendering and sent-message editing fixes.

## [1.1.37] - 2026-10-18

### Added and improved

- Multi-source, multilingual company research with evidence-grounded follow-up, registry records, complete reports, retained snapshots and explicit coverage boundaries.
- Compact prospect deliveries, reusable task context and concise native progress; improved assistant intent handling, account overviews and model configuration.
- Preserve historical quote cards and the accumulated mail rendering and editing improvements.

### Release safety

- Anonymized regression fixtures and prevented release builds from implicitly embedding local dotenv settings. User profiles, credentials, mail and input history are not distributed.
- Removed a legacy fallback's fixed industry relevance vocabulary; it now uses the current task's product and requested buyer-role terms, with cross-industry regression coverage.
- Unavailable sources and incomplete screening remain explicit; limited name screening is not comprehensive credit or compliance clearance.

## [1.1.36] - 2026-09-22

### Fixed

- Fixed Outlook replies copying the generated quote marker onto tables, cells and text blocks, which made sender and recipient fields render as multiple oversized rounded cards. Only structurally valid outer quote containers are now carded; existing messages recover when reopened without rewriting the mail database.

## [1.1.35] - 2026-09-21

### Fixed

- Fixed system folders (Sent, Drafts, Junk, Trash) being wrongly nested under Inbox for accounts whose server uses the INBOX.-prefixed naming (e.g. INBOX.Sent). Wrongly nested folders heal automatically on the next sync; user-created folder hierarchies are unaffected.

### Changed

- Customer profile detail now grows with its content: long profiles are laid out in full instead of scrolling many screens inside a small fixed-height box.
- The settings shortcuts page now lists previously hidden fixed global shortcuts: compose new mail (Ctrl+N), reply (Ctrl+R), reply all (Ctrl+Shift+R), forward (Ctrl+F), focus search (Ctrl+K), open settings (Ctrl+,).
- New compose-window shortcut Ctrl+Enter sends the current email immediately, using the same validation as the send button.

### Removed

- Removed the "Competitor Watch" feature from company research.

## [1.1.34] - 2026-09-14

### Fixed

- Fixed inline images (signature logos, embedded pictures) from the original message being lost or broken in reply, reply-all and forward quotes. References are now resolved to local data before the compose editor opens; all three paths are covered.
- Fixed embedded images such as pasted screenshots not rendering in some receiving clients (Outlook, Gmail): outgoing HTML data URIs are converted to standard inline MIME parts with Content-ID on send.
- Fixed inline images missing in the local "Sent" folder: the local archive now matches what was actually sent, keeping all embedded images viewable.

## [1.1.33] - 2026-09-13

### Fixed

- Fixed packaged builds stripping all sender styling from email bodies (tables, colors, fonts, alignment falling back to plain browser defaults while the Dev build looked correct). Tauri's build-time CSP modification injected a nonce into style-src, which per the CSP specification disables 'unsafe-inline', so inline styles inside the email Shadow DOM were blocked entirely. `dangerousDisableAssetCspModification: ["style-src"]` is now set; all other CSP directives are unchanged.

## [1.1.32] - 2026-09-13

### Changed

- Historical reply content from Outlook, NetEase, Zoho, Gmail, Yahoo and other standard business email formats is normalized into consistent cards inside the final email Shadow DOM. Fixed-width notification layouts and oversized images are constrained to the reading area without rewriting stored mail.
- WPS/Excel clipboard ranges are pasted as editable HTML tables instead of local-only images. Cell colors, fonts, borders, alignment, merged cells, fixed layout and source column widths survive the compose editor and outgoing HTML.
- Account editing shows the saved IMAP/POP3/SMTP host, username, security and port values. Standard ports update automatically when protocol or transport security changes; saved passwords remain hidden and unchanged unless replaced.
- "Send new mail to the same recipients" now copies the original To, Cc and Bcc fields, with case-insensitive de-duplication across roles.

### Fixed

- Fixed WPS tables with empty cells or style-only spacer rows being rejected so that paste appeared to do nothing. The paste path now falls back to basic HTML or safe plain text instead of silently swallowing clipboard content.
- Preserved the complete historical-message card presentation in production builds, including nested original-message headers, metadata sections, body padding, borders and image-size limits.

## [1.1.31] - 2026-09-09

Personal portable edition; no public share ZIP was issued for this version.

### Added

- Portable personal mode: when the profile folder contains a `portable-key` file, account credentials, API keys, model settings and other encrypted user data use a key stored inside that folder, so the application and its `data` directory can be copied to another machine as one folder. The public build keeps using the Windows credential store and is unchanged.
- WebView2 data (local storage, session storage, cache and interface preferences) is now bound to an absolute folder inside the profile, so a moved installation no longer depends on paths from the original computer.

### Fixed

- The account dialog now fills standard ports automatically: IMAP 993/143, POP3 995/110, SMTP 465/587/25, following the protocol and the selected transport security.
- Editing an existing account shows the saved IMAP / POP3 / SMTP host, port, login user name, security mode, certificate policy and proxy settings again, instead of appearing empty. A failed read is reported in the dialog rather than silently shown as blank fields, and saved passwords stay hidden and unchanged unless replaced.

## [1.1.30] - 2026-09-06

### Added

- "Send new mail to the same recipients" from the message context menu now copies the original To, Cc and Bcc fields, de-duplicating addresses across all three roles.

## [1.1.29] - 2026-09-03

### Fixed

- Zoho `Original:` blocks (`isReplyContent`) that keep the title, the From/Date/To/Subject metadata list and the following body inside one wrapper are now split into a card title, a metadata header and a body, with nested original quotes recognized as nested cards. A `compose-original-quote` also takes its leading "date + wrote" line as the header instead of rendering an outer frame with no padding.
- Dash-delimited reply headers, common in Foxmail and mobile clients, are recognized only when at least five hyphens, sender and recipient fields, a subject and a date or address, and a following quote block are all present. This covers real missed cases without carding ordinary system notifications.

### Changed

- Images are limited to the reading width and to `min(70vh, 720px)` in height. Trusted widths are kept, height-only small images keep their height, and images without reliable dimensions scale proportionally.

### Notes

- Audited all 5,294 non-deleted messages in a local mailbox: 1,369 carry reply relations with quote signals across Outlook, NetEase, Gmail, Zoho, Yahoo, `isReplyContent`, `compose-original-quote`, standard cite blocks and dash-delimited headers. Five remaining candidates were reviewed one by one; three were genuine misses and two were correctly left uncarded.

## [1.1.28] - 2026-09-03

### Fixed

- Historical quote cards were detected but rendered with a transparent background, 0px border, 0px padding and 0px margin in packaged builds. Styles were previously applied to a detached tree and then serialized to HTML, and the production WebView2 discarded them during that `innerHTML` parse. Card borders, background, spacing and colours are now written directly to the final nodes inside the live Shadow DOM, with `!important`, after the HTML has been inserted. Stored mail in the server or the local database is still not rewritten.

## [1.1.27] - 2026-09-02

### Fixed

- Inline card styles were added to the generated card HTML. The cards became visible in the Dev build but still rendered as plain text in packaged builds; see 1.1.28 for the root cause and the final fix.

## [1.1.26] - 2026-09-02

### Fixed

- Packaged builds did not show historical quote cards even though the same code worked in development. The production WebView can reorganize complex Outlook, NetEase and Zoho tables and nested nodes while inserting mail HTML, which happened before the carding function ran. Carding and common wrapper-table detection now complete in a detached DOM first, and the finished HTML is written into the Shadow DOM once.

## [1.1.25] - 2026-09-02

### Added

- "Re-download message": fetch the full original MIME again and rebuild the body, HTML, attachments and search index for one message.

### Fixed

- Historical reply recognition no longer depends on Outlook, NetEase, Zoho, Gmail or Yahoo class and id markers, which are often lost when mail is re-synced or sanitized. A generic From/Sent/To/Subject header, the `On … wrote:` and `在…写道：` forms, `blockquote[type=cite]` and the client-specific structures are all recognized, so cards work across folders, accounts and sender domains. Plain-text mail is always wrapped with `textContent` and is never interpreted as executable HTML.
- Large IMAP messages whose parts arrive separately no longer lose their attachments or mark the download as complete too early.
- Non-image files with a Content-ID, such as PDFs, are no longer treated as inline content and are shown and downloadable as real attachments.
- The "All unread" count now covers inbox, archive and custom folders and excludes junk mail, and the tab can be closed directly.

### Changed

- Custom model providers take a full Chat Completions endpoint, and old root-address configurations keep working. Nested provider errors are shown as readable messages and B.AI request parameters are supplied.

## [1.1.24] - 2026-09-01

### Changed

- Address book multi-select works by clicking the name, e-mail or company text itself. Batch commands appear only while contacts are selected and stay pinned under the filter area, so long lists can be handled without scrolling back up.
- An AI-generated new message takes its subject from the title bar, and a reply no longer generates or overwrites the subject. Send and cancel are moved closer to the writing area.
- AI drafts use your default signature first, keep its formatting and appear only once. Generated text is converted to mail rich text, so raw Markdown markers such as `**` and `##` are no longer visible.
- The model dropdown separates built-in providers from your custom models, and custom models can be added without a limit.

## [1.1.23] - 2026-08-29

### Fixed

- Default send-cancellation countdown is now 5 seconds and continues while switching workspace tabs.
- Batch mail selection no longer shows duplicate per-row checkboxes; Ctrl can remove the first message from a Shift-selected range.
- WPS/Excel formatted-table paste keeps the original visual preview instead of falling back to a simplified table.

### Removed

- Dropped the leftover "Snoozed" (稍后提醒) pseudo-folder. It was an early experimental local view, not a real IMAP folder; the sidebar entry and page route are gone, and old navigation state now falls back to the inbox instead of showing a folder with no way in. Existing database rows are kept only for backward compatibility.

## [1.1.22] - 2026-08-29

### Added

- Home AI workbench "foreign-trade Skills": seven read-only capabilities — company background research, company email verification, research-based outreach writing, reply strategy, follow-up planning, daily foreign-trade briefing, and thread summary. Routed automatically from the instruction or picked manually; every Skill is analysis-only or draft-only and can never send mail, edit customers, or create calendar entries.
- Per-address right-click menu on the sender, each To address and each Cc address: write to this address, copy address, add/edit contact, search mail with this address, create a filter from it, or open the customer profile.
- Create the target folder inline while editing a "move to folder" mail rule — no need to leave the rule dialog and create it on the server first.
- Safe undo-send countdown before SMTP submission (default 10 seconds; configurable as off / 5 / 10 / 15 / 30 s). Cancelling keeps the draft, recipients, body and attachments intact.
- Scheduled sending: pick a local date and time, the message is stored in the outbox and only submitted when the time arrives; a restart before then does not lose the schedule.
- EML/MBOX batch migration (Settings → General): multi-select files or recursively scan a folder, preserving subject, addresses, Cc/Bcc, original date, plain text, HTML, reply relations, inline images and attachments, with live progress, duplicate detection, a failure list and cancellation.
- Complete MIME EML export: "forward as attachment" and "export EML" now keep plain text + HTML, To/Cc/Bcc, Message-ID, In-Reply-To, References, original date, inline image CIDs and all attachments instead of rebuilding a plain-text-only copy.
- Customizable reference-currency list in the foreign-trade toolbox: add/remove currencies, edit the conversion quantity, Chinese currency names, and USD-based full exchange rates so newly added currencies get real values.
- Carrier tracking-number detection for one-key logistics lookup.

### Changed

- "Send new mail to the same recipients" now always uses the original To list, regardless of whether the message sits in Sent, Inbox or a custom folder (previously it used the From address for received mail, which was really "reply to sender").
- Historical reply/forward quotes render as one unified card (grey header + white body) when reading: Outlook, NetEase, Zoho, Gmail, Yahoo, cite-blockquotes and early in-app quote structures are all recognized. Only the reading view changes — server mail and the local database are never rewritten.
- Pasted WPS and Excel tables keep the original visual preview (cell colors, borders, merged cells) as a single image instead of being flattened by the editor.
- Compose distinguishes between dropping a file as an attachment and dropping it as AI context.

### Fixed

- Restored the per-row batch-selection checkbox on message rows and the select-all control in the batch toolbar.
- Restored the Snoozed navigation entry that existed in the backend and page but had fallen out of the route and sidebar types.
- Multi-account sidebar now creates a group for every account even when that account has not synced any folders yet.
- Inline images are rendered at a sane size instead of being blown up.
- Full Vitest baseline restored: 100 test files / 388 assertions passing, zero unhandled errors.

## [1.1.21] - 2026-08-26

### Added

- Attachment copy and drag-out: drag attachments straight into Windows Explorer (multiple selection supported); right-click "Copy" and the copy button now use the native Windows Shell file clipboard so they paste correctly, including long-path compatibility. Ctrl+C after selecting attachments works too.

### Fixed

- Historical attachments no longer fail to open after the data directory was moved. Open, save-as, batch save, copy and "send to AI" now resolve the current attachment directory and auto-correct the path when it can be confirmed.

### Added

- Tool-calling agent infrastructure: `complete_chat_with_tools` with OpenAI-compatible tools, an agent loop (`run_agent`) with `web_search` / `fetch_url` / `gleif_company` tools, automatic fallback to plain chat when the model does not support function calling, and a forced final-answer round when the model gets stuck in a tool loop.
- Customer management (renamed from customer profiles): follow-up stage (待开发→已成交/流失), multi-select characteristic tags, A/B/C tier, next-follow-up date, and a follow-up timeline. Profile generation now runs as a background task (survives page switches), searches the web autonomously, and auto-inserts a mail follow-up entry derived from the correspondence with that customer.
- Lead discovery (renamed from AI find customers): agent-driven search returns structured candidates (company, website, country, customer type, reason, public emails, source); one-click "add to customer management" and one-click AI-generated outreach email that opens pre-filled in the compose window.
- Credit research (renamed from background research): agent-driven deep-diligence button producing a structured report (profile, capability, supply-chain clues, risk signals, verification items, verdict, sources).
- Message context-menu actions: edit any message (not only drafts), forward as .eml attachment, new mail to the same correspondent (sender for inbox / recipient for sent), create filter pre-filled from the message sender/recipient, export as .eml, and print.
- Local `.eml` export backend (`build_forward_eml`, `export_message_eml`) and `open_local_file` for opening draft attachments with the default app.
- Draft improvements: Cc/Bcc fields expanded by default; draft attachments clickable to inspect.

### Changed

- Initial/incremental sync now fetches at most 6 messages per batch (was 50), fixing `Initial sync failed: UID FETCH collect timed out`.
- History backfill: page size 6 with 3-message fallback, failed sub-pages are skipped instead of aborting the whole folder, body-fetch timeout reduced to 45s, and a dedicated 120s backfill ticker so large folders keep progressing between 15-minute reconciles.
- Sidebar labels renamed: 开发客户 / 资信调研 / 客户管理.
- Inputs for lead discovery, credit research, and customer management persist across page switches.
- Contact auto-classification states clearly when it only had an address to judge (no mail corpus yet) and advises re-running after sync completes.

### Fixed

- Customer profile generation returned empty content when the agent exhausted its turn budget on tool calls (picked the last assistant message with non-empty content and forces a final answer).
- Agent lead search got stuck in a 24-tool-call loop without emitting the final JSON (tool-call budget enforced in the prompt, turn limit raised, forced final round).
- Draft attachments could not be opened (`open_external_url` rejected `file://`); now uses `open_local_file`.

## [1.1.20] - 2026-08-26

### Changed

- All manual and automatic outreach emails were rewritten against real outbound data principles: one evidence-backed angle, no invented pain points or social proof, a single low-pressure call to action, and strict separation of fact, inference and suggestion.

### Fixed

- Sidebar unread counts no longer disappear.
- Automatically developed campaigns no longer collapse the whole message into a single line (plain-text send formatting).
- Pending-sync operations that used to keep failing are now retried and reported correctly.
- Customer emails and companies in lead discovery are strictly attributed to the right company, so an address found on one page is never attached to a different candidate.

## [1.1.19] - 2026-08-25

### Added

- Search sessions now store the context used for that search (dropped files, referenced mail, knowledge-base items). Outreach emails — both manually generated and auto-developed — inherit exactly that material, including after switching pages or restarting the app, so a letter is never written without the source it was researched from.
- The outreach AI instruction box accepts dragged files and can reference knowledge-base items, matching the other AI inputs.
- Search sessions that carry material show a marker in the session list, and reopening one restores its knowledge-base references.

### Fixed

- Email completion no longer gets stuck showing "searching…" forever. Statuses frozen as running by an interrupted session are reset to pending on startup, a batch "complete emails" button resumes unfinished candidates, and every unfinished row gets its own retry that also works for rows previously marked as not found.

## [1.1.18] - 2026-08-25

### Added

- Lead discovery works without any paid search API: Bing, DuckDuckGo and Mojeek public search run in parallel and are merged and de-duplicated. Brave, Tavily, Hunter and Firecrawl remain optional enhancements.
- Progressive results: public-search companies appear first while AI candidate batches keep filling in; a slow or timing-out batch no longer blanks results that were already shown.
- Candidate cards use a consistent Chinese three-part layout (company intro, why it was recommended, evidence it was found on) instead of raw foreign text or code dumps.
- Broader email discovery: official homepage, contact/team/legal pages, sitemaps, PDF catalogs and public web indexes, including Cloudflare-protected addresses and obfuscated forms such as `[dot]`.
- An email only counts as "contactable" when it carries a real source page URL; otherwise the row is explicitly marked as needing completion, so no address is ever invented.
- Website verification status: only an identity-checked site is labelled as a verified official site, preventing addresses from another company's page being attached to the wrong candidate.
- Initial/incremental sync limits and history backfill were made resilient (smaller batches, skipping failed sub-pages, dedicated backfill ticker) so large folders keep progressing.

### Changed

- Industry associations, chambers of commerce, exhibition sites and media directories no longer pose as candidate companies; they are only used as sources for discovering companies.
- "Exclude China-based companies" was upgraded from a prompt preference to a hard rule with three layers of filtering: search terms, AI candidates and the final list.
- The AI model setting became a single dropdown for easier custom models.

### Fixed

- A crash caused by a text-truncation error while parsing Chinese web pages. A crash log was added that records technical information only — never mail or input content.
- Clicking a candidate website did nothing; protocol-less URLs now open as https.
- Sent mail now moves into the configured custom folder immediately instead of requiring a manual "get mail" click.
- Custom IMAP folders now update the sidebar unread count and raise system notifications, not just the inbox.

### Security

- Outbound web reads were hardened: private/internal addresses are blocked and redirects and download sizes are limited, so a malicious site cannot use search to probe the local network.

## [1.1.17] - 2026-08-23

### Security

- Release binaries no longer leak the development machine. Rust path remapping (`--remap-path-prefix`) removes developer usernames and project absolute paths from dependency diagnostics; `strip=true` alone never removed `file!()` style paths.
- The OAuth fallback that looked for an `.env` in the source tree is now compiled only in debug builds, so `CARGO_MANIFEST_DIR` cannot leak the build directory into a release EXE. Release builds still read `.env` from the run directory and its parents.
- `打包流程和避坑.txt` was updated: formal packages must use path remapping, scan binaries for absolute paths, and guard compile-time constants such as `CARGO_MANIFEST_DIR`.

## [1.1.16] - 2026-08-22

### Fixed

- Credit-research results added to a customer profile no longer show raw Markdown symbols. AI profile text cleanup was extracted into a shared `formatProfileText` used by both entry points; it handles headings, bold/italic/strikethrough, code markers, quotes, lists, links, images, HTML, dividers and Markdown tables while keeping link addresses and code content readable.
- The first-run wizard referred to the data-directory environment variable as `PEBBLE_DATA_DIR`; the code actually uses `PEBBLE_PROFILE_DIR`.

## [1.1.1] - 2026-08-05

### Added

- Added a persistent right-side AI writing and foreign-trade tools panel.
- Added an address book with company, job title, contact-role labels, tags, and mail-history import.
- Added company-level customer profiles with multiple contacts and roles.
- Added local knowledge-base parsing for DOCX, XLS/XLSX, PDF, and common text formats.
- Added email and compose workspace tabs, attachment opening, and clipboard-file attachment paste.
- Added custom data-location, themes, fonts, and font-size controls.
- Added a homepage with local unread-mail actions, exchange rates, world clocks, holidays, and the business follow-up board.
- Added independent customer-research and lead-finder pages with website evidence, GLEIF legal-entity matches, official verification sources, and locally saved research reports.
- Added current-HS guidance, logistics/vessel/air-cargo tracking entrances, and a container-loading calculator.
- Added multi-turn AI writing and address-book integration for public company-research results.

### Changed

- Mail lists now load additional pages automatically when scrolling.
- Initial IMAP sync prioritizes Inbox and Sent history before low-priority Spam/Trash work, so a slow Spam folder cannot prevent mailbox backfill.
- AI writing can use the active email thread or active compose draft with explicit user authorization.
- AI writing can now accept multiple dragged emails and multiple local PDF, DOCX, XLS/XLSX, or text files as one-turn context. The selected items are shown before generation and require per-operation confirmation before being sent through the currently configured AI provider (including DeepSeek).
- New installations default to a `data` folder beside the executable when that directory is writable; existing profiles stay in place until the user chooses an empty destination folder.
- Switching away from a compose tab keeps the draft open; the discard prompt appears only when the compose tab is closed.

### Fixed

- Reconnect after Windows/Chinese remote-host-forced-close IMAP errors instead of stopping folder polling.
- Keep Sent and other server folders in the default all-folder synchronization scope.
- Preserve reply recipients when AI inserts only a body, and insert the selected account's configured signature without duplicating it.

### Known limitations

- AI summarization of private unread mail remains local-only and does not upload the whole inbox. AI use of dragged private files/emails is limited to the explicitly selected items and requires confirmation for each context selection.
- The first lead-finder implementation uses public legal-entity and trade-data sources. Direct-person enrichment requires a user-provided licensed search/customs/enrichment API.
- DeepSeek is used as the analysis model; real-time search and email verification providers are intentionally not connected until the user authorizes the specific destination and supplies its API key.

## [0.1.3] - 2026-07-01

### Added

- Added an option to launch Pebble automatically when you sign in to your computer, under General settings → Startup Behavior (#64).
- Added a per-account option to allow unencrypted (plaintext) IMAP/SMTP connections for legacy servers that only support plaintext, shown as an explicit opt-in with a security warning when a connection's security is set to "None" (#70).

### Changed

- Updated the desktop release metadata to version 0.1.3.

### Fixed

- Fixed some email links being shown with a literal `&amp;` (for example in password-reset URLs) by no longer double-escaping ampersands when auto-linking plain-text URLs (#68).
- Fixed the account connection test reporting a false "passed" for accounts with a blank username: it now performs a real authenticated login, so authentication failures surface during testing instead of only after the account is added (#60).
- Fixed the startup window background color and title-bar theme so the window matches the active theme immediately on launch.

## [0.1.2] - 2026-06-15

### Changed

- Updated the desktop release metadata to version 0.1.2.

### Fixed

- Fixed DeepL and DeepLX translation always failing with a `400 "source_lang not supported"` error by omitting the source language field when auto-detection is requested (#65).
- Fixed adding Outlook/Hotmail accounts: the username field is no longer required, and a blank username now defaults to the account email so app-password logins connect (#60).
- Prevented duplicate messages from appearing in the destination mailbox when a move operation is retried after a partial COPY/EXPUNGE failure.
- Prevented duplicate message rows from accumulating after a soft-delete followed by a re-sync, via a unique index on live `(account_id, remote_id)` rows.
- Prevented newly-arrived messages from being permanently missing from search results due to a race between the startup background reindex and concurrent sync.
- Preserved attachment filenames that were being altered on download and forwarding.
- Registered Pebble as the Windows mail client in the registry before opening the default-apps settings so "set as default" works reliably.
- Improved POP3 connectivity for legacy servers with a rustls→native-tls TLS backend fallback and optional TLS 1.0.
- Synced the native window background color with the active theme on macOS.

## [0.1.1] - 2026-06-03

### Added

- Added a tray preference to start Pebble hidden in the system tray at launch.
- Added native macOS traffic-light window controls in the title bar for a platform-idiomatic close/minimize/maximize experience.
- Added translation keyboard shortcuts, automatic settings backup, a default mail client preference, and a lightweight mode for the tray.
- Added local settings backup file export/import for cross-platform migration without WebDAV.
- Added optional encrypted WebDAV backup and restore for account passwords, OAuth tokens, and translation API keys.

### Changed

- Updated the desktop release metadata to version 0.1.1.

### Fixed

- Honored IMAP special-use folder attributes so the Trash, Sent, Drafts, Junk, and Archive flags reported by servers map to the expected local folders.
- Preserved email HTML container styles (such as `html`, `body`, and wrapper element rules) so sanitized messages keep their original layout.
- Stripped HTML and CSS from email preview snippets so list rows show clean plain-text previews instead of markup.
- Stopped retrying permanent authentication errors for pending mail operations, surfaced clearer status, and allowed dismissing failed operations from settings.
- Added missing English and Chinese translations for the new automatic backup, default mail client, and pending operations controls.
- Surfaced translation keyboard shortcuts in the settings page and fixed the wallpaper mode settings background rendering.

## [0.1.0] - 2026-05-28

### Added

- Added POP3 account support, including account setup, sync, provider dispatch, folder/message operations, and backup/restore metadata handling.
- Added an account-level option to allow invalid TLS certificates for IMAP and SMTP connections, including connection testing and settings UI support.

### Changed

- Updated the desktop release metadata to version 0.1.0.

### Fixed

- Recovered from invalid stored data-encryption keys by replacing malformed keyring entries instead of failing startup.
- Avoided repeated IMAP incremental fetches by checking UIDNEXT and searching for UIDs newer than the local cursor before fetching message bodies.
- Fixed TLS certificate policy localization in English and Chinese.
- Disabled WebKitGTK accelerated compositing for Linux AppImage launches when the user has not set `WEBKIT_DISABLE_COMPOSITING_MODE`, working around Wayland/Hyprland repaint stalls where the UI only updates after resizing.

## [0.0.9] - 2026-05-23

### Added

- Added Pebble Web self-hosted edition information to the public site and README documentation.
- Added Arch Linux AUR installation instructions.

### Changed

- Expanded release automation to build and upload Windows, macOS, and Linux packages from tagged releases.
- Improved Linux package build handling and form focus-visible styling.

### Fixed

- Added `native-tls` fallback for IMAP TLS and STARTTLS connections when servers only offer DHE cipher suites unsupported by `rustls`, including `imap.sina.cn`.
- Improved email CSS rendering by preserving embedded styles in relaxed mode and allowing remote stylesheets in unrestricted or trusted-sender modes.
- Removed an overly strict home-directory check that could block attachment downloads.
- Hid the compose floating action button while reading message details.
- Fixed sidebar view switching so repeated navigation cannot get stuck on stale UI state.

## [0.0.8] - 2026-05-16

### Added

- Added configurable custom background images with fit, contain, tile, and opacity controls.

### Fixed

- Displayed recipients in sent-mail message lists instead of showing the sender as the current account.
- Fixed Gmail history sync handling and modal backdrop behavior.
- Routed translation requests through the configured global proxy.

## [0.0.7] - 2026-05-09

### Added

- Added image paste support in the compose editor so clipboard images can be staged and sent as attachments.

### Fixed

- Updated Outlook local remote IDs after Graph API folder moves, including batch archive and delete paths, so follow-up actions no longer use stale message IDs.
- Enabled TLS 1.2 support for IMAP and SMTP connections to improve compatibility with older mail servers.
- Treated rustls unexpected EOF and missing TLS `close_notify` disconnects during IMAP polling as retryable connection interruptions.
- Improved IMAP compatibility for Tencent enterprise mail and other Coremail-based providers that require IMAP ID before login.
- Displayed the actual translate settings save and test error instead of a generic object string.
- Prevented modal dialogs from closing when text selection drags finish outside the window.

## [0.0.6] - 2026-05-05

### Added

- Added the receiving account to the message detail header so all-account views show which mailbox received the selected email.

### Changed

- Polished the compose leave confirmation flow.
- Simplified unread row indicators while keeping unread messages visually distinct.

### Fixed

- Fixed notification clicks so they route directly to the target message.
- Improved mail sync reliability, including IMAP realtime polling fallback handling for empty Inbox baselines, UIDVALIDITY resets, same-count mailbox changes, sync failures, and local UID baselines.
- Refreshed folder unread counts immediately after read-state changes, message moves, batch actions, secondary message actions, command read changes, and sync completion events.
- Made unread message and thread rows more visible in dark mode.
- Preserved sanitized HTML email layouts and stabilized Shadow DOM rendering so full-height wrappers, gray canvases, and delayed layout jumps do not obscure message content.
- Preserved hidden email preheader clipping styles so preview text remains hidden instead of rendering as one character per line.
- Honored fully trusted senders in privacy rendering so trusted senders can load images and tracker resources according to the selected trust level.
- Stabilized the sidebar bottom navigation so Snoozed, Kanban, and Settings remain clickable when wide message content is visible.

## [0.0.5] - 2026-05-04

### Added

- Added `mailto:` deep-link support so email links can open Pebble compose with parsed recipients, subject, and body.
- Linkified plain-text URLs and email addresses in rendered message bodies.
- Added Linux AppImage packaging, Ubuntu CI package builds, tagged-release AppImage uploads, and Linux native credential storage support.

### Changed

- Improved desktop notification setup and status reporting, including Windows toast environment handling and development loading behavior.
- Refined the sidebar account selector width, alignment, and spacing.

### Fixed

- Fixed sending compose messages while contact recipient selection is still pending.
- Fixed opening links from rendered email bodies, including browser links and email-address links.
- Kept the new-notification red dot on the tray icon only.
- Clarified invalid WebDAV backup errors when a server returns an empty or HTML response instead of a Pebble backup file.
- Fixed CI issues that blocked Linux AppImage artifact generation.

## [0.0.4] - 2026-05-01

### Added

- Added global mail proxy settings for account connectivity.
- Added OAuth account proxy controls so Google and Microsoft account flows can use account-specific proxy settings.
- Added account color presets and automatic default colors for newly added accounts.
- Added account color markers in the all-accounts message list when multiple accounts are visible.
- Added first-launch language detection: Chinese system locales start in Chinese, and other locales start in English.

### Changed

- Reorganized proxy settings into clearer global and per-account sections.
- Refined the compose editor layout with a single compact toolbar, a full-height editor surface, and consistent rich text, Markdown, and HTML mode controls.
- Replies now open with a clean editable reply area while the original message is shown as a collapsed read-only quote; the quote is still appended when the reply is sent.
- Unified sidebar system folder ordering across all-accounts and single-account views so folders no longer jump when switching accounts.

### Fixed

- Persisted automatically assigned default account colors.
- Preserved existing account colors when restoring older WebDAV backups that do not contain color metadata.
- Fixed OAuth account editing so disabled/custom proxy mode is preserved correctly.
- Prevented account proxy settings from temporarily losing account metadata while settings are loading.
- Hid account color markers when a single account is selected or only one account exists.

### Documentation

- Documented the macOS quarantine workaround command `sudo xattr -cr` for users who need to run unsigned builds.

## [0.0.3] - 2026-04-30

### Added

- Added unsigned macOS app and DMG build scripts, current-platform desktop build routing, macOS CI packaging, and tagged release DMG artifact uploads.
- Added the macOS `.icns` bundle icon required by Tauri's macOS application bundle.

### Changed

- WebDAV restore now replaces local rules and Kanban cards/notes while merging account metadata from the backup, and restore previews disclose Kanban note counts.

### Fixed

- Enabled the native macOS Keychain backend for local credential encryption.
- Made search over subject, sender, and recipient short fields case-insensitive for Latin text, and trigger a search index rebuild for older case-sensitive indexes.
- Indexed locally saved sent and queued outgoing messages so they appear in search results.
- Moved compose drafts, templates, and signatures out of frontend `localStorage` and into encrypted backend secure storage.
- Protected in-progress compose content from being overwritten when account, signature, or language-dependent defaults change.
- Added retry scheduling, exponential backoff, and a maximum attempt limit for pending mail operations.
- Aligned offline batch mail operations with single-message optimistic local commit behavior.
- Staged compose attachments through the backend so valid selected files no longer depend on fragile frontend path handling.
- Moved Kanban context notes out of frontend `localStorage` and into encrypted backend secure storage, with one-time legacy note migration.
- Hardened HTML email CSS sanitization against escaped `url()` tokens that could trigger remote loads in strict privacy mode.
- Prevented duplicate same-account sync workers by keeping the startup placeholder lock alive until the real worker replaces it.
- Report realtime restart failures back to the UI instead of silently accepting preference changes after all or part of sync restart failed.

## [0.0.2] - 2026-04-29

### Added

- Added tray and background-running controls so Pebble can close to the system tray, restore from the tray menu, and keep the close-to-background preference in app state.
- Added localized tray menu labels and status bar copy for background sync behavior.
- Added public privacy policy and terms of service pages for Google OAuth app verification.
- Added English and Chinese language switching for the privacy policy and terms pages.
- Added Cloudflare Workers site deployment configuration for the public site.
- Added the LINUX DO friend link to the English and Chinese README files.

### Changed

- Themed native form controls and focus-visible styling so inputs, selects, textareas, and buttons fit the dark UI.

### Fixed

- Improved attachment download reliability by saving duplicate target filenames with a unique suffix instead of failing.
- Staged local draft, outbox, and sent-message attachments into Pebble's app data directory so downloads no longer depend on the original selected file path.
- Persisted IMAP attachments before notifying the frontend about newly synced messages.
- Refined Gmail attachment parsing so large body parts are not shown as attachments and inline content-ID images stay out of the download list.
- Added clearer attachment download failure messages and backend download logging.
- Fixed the Cloudflare Worker site target and migrated the site config to the JSONC Workers format.

## [0.0.1] - 2026-04-27

### Initial Release

Pebble 0.0.1 is the first public test release.

This release includes:

- Gmail, IMAP, and experimental Outlook account support.
- Aggregated mailbox views across connected accounts.
- Local mail storage, search indexing, attachments, rules, trusted senders, and application settings.
- Message reading, compose, drafts, sent mail persistence, local outbox fallback, and pending remote write retries.
- Realtime and near-realtime sync infrastructure for Gmail, IMAP, and Outlook.
- Inbox, search, starred, snoozed, kanban, settings, diagnostics, and pending remote writes views.
- Privacy controls for remote images, trusted senders, tracker blocking, sanitized HTML rendering, and safer attachment filenames.
- Desktop notifications with click navigation.
- Custom title bar with consistent app logo rendering on Windows.
- OAuth client secrets are included in release builds when configured.
- English and Chinese README documentation.
- GitHub Actions CI and tag-driven Windows NSIS installer packaging with SHA256 checksum files.

### Notes

- Windows installers are not code-signed yet, so Windows SmartScreen may show a warning.
- Outlook support is still experimental and depends on Microsoft Graph permissions configured by the user.

[Unreleased]: https://github.com/QingJ01/Pebble/compare/v1.1.40...HEAD
[1.1.40]: https://github.com/QingJ01/Pebble/compare/v1.1.39...v1.1.40
[1.1.39]: https://github.com/QingJ01/Pebble/compare/v1.1.38...v1.1.39
[1.1.38]: https://github.com/QingJ01/Pebble/compare/v1.1.37...v1.1.38
[1.1.37]: https://github.com/QingJ01/Pebble/compare/v1.1.36...v1.1.37
[1.1.36]: https://github.com/QingJ01/Pebble/compare/v1.1.35...v1.1.36
[1.1.35]: https://github.com/QingJ01/Pebble/compare/v1.1.34...v1.1.35
[1.1.34]: https://github.com/QingJ01/Pebble/compare/v1.1.33...v1.1.34
[1.1.33]: https://github.com/QingJ01/Pebble/compare/v1.1.32...v1.1.33
[1.1.32]: https://github.com/QingJ01/Pebble/compare/v1.1.23...v1.1.32
[1.1.21]: https://github.com/QingJ01/Pebble/compare/v1.1.1...v1.1.21
[1.1.1]: https://github.com/QingJ01/Pebble/compare/v0.1.3...v1.1.1
[0.1.3]: https://github.com/QingJ01/Pebble/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/QingJ01/Pebble/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/QingJ01/Pebble/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/QingJ01/Pebble/compare/v0.0.9...v0.1.0
[0.0.9]: https://github.com/QingJ01/Pebble/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/QingJ01/Pebble/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/QingJ01/Pebble/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/QingJ01/Pebble/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/QingJ01/Pebble/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/QingJ01/Pebble/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/QingJ01/Pebble/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/QingJ01/Pebble/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/QingJ01/Pebble/releases/tag/v0.0.1
