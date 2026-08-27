import { invoke } from "@tauri-apps/api/core";

// Re-export all IPC types so existing `import { Foo } from "@/lib/api"` keeps working.
export type {
  Account,
  AccountProxyMode,
  AccountProxySetting,
  AddAccountRequest,
  AdvancedSearchQuery,
  AppLogSnapshot,
  Attachment,
  BackupPreview,
  ConnectionSecurity,
  EmailAddress,
  Folder,
  HttpProxyConfig,
  ImapSyncFolderSettings,
  ImportedBackgroundImage,
  KanbanCard,
  KanbanColumnType,
  KnownContact,
  Label,
  Message,
  MessageSummary,
  NotificationStatus,
  PendingMailOp,
  PendingMailOpsSummary,
  PrivacyMode,
  RenderedHtml,
  Rule,
  SearchHit,
  SnoozedMessage,
  ThreadSummary,
  TranslateConfig,
  TranslateResult,
  TrustedSender,
} from "./ipc-types";

import type {
  Account,
  AccountProxyMode,
  AccountProxySetting,
  AddAccountRequest,
  AdvancedSearchQuery,
  AppLogSnapshot,
  Attachment,
  BackupPreview,
  ConnectionSecurity,
  Folder,
  HttpProxyConfig,
  ImapSyncFolderSettings,
  KanbanCard,
  KanbanColumnType,
  KnownContact,
  Label,
  Message,
  MessageSummary,
  NotificationStatus,
  PendingMailOp,
  PendingMailOpsSummary,
  PrivacyMode,
  RenderedHtml,
  Rule,
  SearchHit,
  SnoozedMessage,
  ThreadSummary,
  TranslateConfig,
  TranslateResult,
  TrustedSender,
} from "./ipc-types";

export interface ProfileLocationInfo {
  currentPath: string;
  defaultPath: string;
  isCustom: boolean;
}

export async function getProfileLocation(): Promise<ProfileLocationInfo> {
  return invoke<ProfileLocationInfo>("get_profile_location");
}

export async function openDataDir(): Promise<void> {
  await invoke("open_profile_folder");
}

export async function getDataDir(): Promise<string> {
  const info = await getProfileLocation();
  return info.currentPath;
}

export async function chooseProfileFolder(): Promise<string | null> {
  return invoke<string | null>("choose_profile_folder");
}

export async function scheduleProfileMigration(destination: string): Promise<void> {
  return invoke<void>("schedule_profile_migration", { destination });
}

export interface DashboardData {
  exchangeDate: string | null;
  usdRates: Record<string, number>;
  holidays: Array<{
    date: string;
    localName: string;
    name: string;
    countryCode: string;
  }>;
  warnings: string[];
}

export async function getDashboardData(year = new Date().getFullYear()): Promise<DashboardData> {
  return invoke<DashboardData>("get_dashboard_data", { year });
}

export interface ResearchSource {
  title: string;
  url: string;
  status: "checked" | "no_match" | "unavailable" | "manual_check";
}

export interface PublicCompanyMatch {
  legalName: string;
  country: string;
  city: string;
  address: string;
  registrationStatus: string;
  lei: string;
  sourceUrl: string;
  website?: string;
  description?: string;
  sourceName?: string;
  publicEmails?: string[];
  recommendationReason?: string;
  discoveryBasis?: string[];
  companyIntroduction?: string;
  emailEvidence?: Array<{
    email: string; source: string; sourceUrl: string; confidence?: number;
    verification: string; emailType?: string; person?: string; suitability?: string;
  }>;
  contactStatus?: "可联系" | "待补全" | string;
  websiteStatus?: "已核验" | "待核验" | "无法访问" | "身份不匹配" | string;
  websiteStatusReason?: string;
}

export interface CompanyResearchReport {
  id: string;
  companyName: string;
  website: string;
  country: string;
  websiteTitle: string;
  websiteDescription: string;
  publicEmails: string[];
  legalMatches: PublicCompanyMatch[];
  sources: ResearchSource[];
  warnings: string[];
  analysis: string;
  createdAt: number;
}

export async function researchCompany(
  companyName: string,
  website: string,
  country: string,
): Promise<CompanyResearchReport> {
  return invoke<CompanyResearchReport>("research_company", { companyName, website, country });
}

export async function listCompanyResearch(): Promise<CompanyResearchReport[]> {
  return invoke<CompanyResearchReport[]>("list_company_research");
}

export async function deleteCompanyResearch(id: string): Promise<CompanyResearchReport[]> {
  return invoke<CompanyResearchReport[]>("delete_company_research", { id });
}

export async function saveCompanyResearchAnalysis(id: string, analysis: string): Promise<CompanyResearchReport> {
  return invoke<CompanyResearchReport>("save_company_research_analysis", { id, analysis });
}

export async function searchPublicCompanies(query: string): Promise<PublicCompanyMatch[]> {
  return invoke<PublicCompanyMatch[]>("search_public_companies", { query });
}

export async function aiFindCompanies(
  product: string,
  market: string,
  buyerType: string,
): Promise<PublicCompanyMatch[]> {
  return invoke<PublicCompanyMatch[]>("ai_find_companies", {
    product,
    market,
    buyerType,
  });
}

/** Agent-driven lead discovery (Tool Calling): the model searches the target
 *  market autonomously and returns structured candidates. */
export async function findCompaniesAgent(
  industry: string,
  market: string,
  keywords?: string,
): Promise<Array<Record<string, unknown>>> {
  return invoke<Array<Record<string, unknown>>>("find_companies_agent", {
    industry,
    market,
    keywords,
  });
}

/** Agent-driven deep credit/diligence report (Tool Calling). */
export async function researchCompanyAgent(
  companyName: string,
  website?: string,
): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("research_company_agent", { companyName, website });
}

// ─── Account API ─────────────────────────────────────────────────────────────

export async function healthCheck(): Promise<string> {
  return invoke<string>("health_check");
}

export async function readAppLog(maxBytes: number): Promise<AppLogSnapshot> {
  return invoke<AppLogSnapshot>("read_app_log", { maxBytes });
}

export async function getGlobalProxy(): Promise<HttpProxyConfig | null> {
  return invoke<HttpProxyConfig | null>("get_global_proxy");
}

export async function getAccountProxy(accountId: string): Promise<HttpProxyConfig | null> {
  return invoke<HttpProxyConfig | null>("get_account_proxy", { accountId });
}

export async function getAccountProxySetting(accountId: string): Promise<AccountProxySetting> {
  return invoke<AccountProxySetting>("get_account_proxy_setting", { accountId });
}

export async function updateAccountProxy(
  accountId: string,
  proxyHost?: string,
  proxyPort?: number,
): Promise<void> {
  return invoke<void>("update_account_proxy", { accountId, proxyHost, proxyPort });
}

export async function updateAccountProxySetting(
  accountId: string,
  mode: AccountProxyMode,
  proxyHost?: string,
  proxyPort?: number,
): Promise<void> {
  return invoke<void>("update_account_proxy_setting", { accountId, mode, proxyHost, proxyPort });
}

export async function updateGlobalProxy(
  proxyHost?: string,
  proxyPort?: number,
): Promise<void> {
  return invoke<void>("update_global_proxy", { proxyHost, proxyPort });
}

export async function completeOAuthFlow(
  provider: string,
  email: string,
  displayName: string,
  proxyHost?: string,
  proxyPort?: number,
): Promise<Account> {
  return invoke<Account>("complete_oauth_flow", { provider, email, displayName, proxyHost, proxyPort });
}

export async function getOAuthAccountProxy(accountId: string): Promise<HttpProxyConfig | null> {
  return invoke<HttpProxyConfig | null>("get_oauth_account_proxy", { accountId });
}

export async function getOAuthAccountProxySetting(accountId: string): Promise<AccountProxySetting> {
  return invoke<AccountProxySetting>("get_oauth_account_proxy_setting", { accountId });
}

export async function updateOAuthAccountProxy(
  accountId: string,
  proxyHost?: string,
  proxyPort?: number,
): Promise<void> {
  return invoke<void>("update_oauth_account_proxy", { accountId, proxyHost, proxyPort });
}

export async function updateOAuthAccountProxySetting(
  accountId: string,
  mode: AccountProxyMode,
  proxyHost?: string,
  proxyPort?: number,
): Promise<void> {
  return invoke<void>("update_oauth_account_proxy_setting", { accountId, mode, proxyHost, proxyPort });
}

export async function addAccount(request: AddAccountRequest): Promise<Account> {
  return invoke<Account>("add_account", { request });
}

export async function testAccountConnection(accountId: string): Promise<string> {
  return invoke<string>("test_account_connection", { accountId });
}

export async function testImapConnection(
  imapHost: string,
  imapPort: number,
  imapSecurity: ConnectionSecurity,
  acceptInvalidCerts?: boolean,
  proxyHost?: string,
  proxyPort?: number,
  username?: string,
  password?: string,
  email?: string,
  allowPlaintext?: boolean,
): Promise<string> {
  return invoke<string>("test_imap_connection", {
    request: {
      imap_host: imapHost,
      imap_port: imapPort,
      imap_security: imapSecurity,
      accept_invalid_certs: acceptInvalidCerts,
      proxy_host: proxyHost,
      proxy_port: proxyPort,
      username,
      password,
      email,
      allow_plaintext: allowPlaintext,
    },
  });
}

export async function testPop3Connection(
  pop3Host: string,
  pop3Port: number,
  pop3Security: ConnectionSecurity,
  acceptInvalidCerts?: boolean,
  proxyHost?: string,
  proxyPort?: number,
  username?: string,
  password?: string,
  allowPlaintext?: boolean,
): Promise<string> {
  return invoke<string>("test_pop3_connection", {
    request: {
      pop3_host: pop3Host,
      pop3_port: pop3Port,
      pop3_security: pop3Security,
      accept_invalid_certs: acceptInvalidCerts,
      proxy_host: proxyHost,
      proxy_port: proxyPort,
      username,
      password,
      allow_plaintext: allowPlaintext,
    },
  });
}

export async function listAccounts(): Promise<Account[]> {
  return invoke<Account[]>("list_accounts");
}

export async function updateAccount(
  accountId: string,
  email: string,
  displayName: string,
  password?: string,
  imapHost?: string,
  imapPort?: number,
  smtpHost?: string,
  smtpPort?: number,
  imapSecurity?: ConnectionSecurity,
  smtpSecurity?: ConnectionSecurity,
  acceptInvalidCerts?: boolean,
  proxyHost?: string,
  proxyPort?: number,
  accountColor?: string,
): Promise<void> {
  return invoke<void>("update_account", {
    accountId, email, displayName, password,
    imapHost, imapPort, smtpHost, smtpPort, imapSecurity, smtpSecurity,
    acceptInvalidCerts, proxyHost, proxyPort, accountColor,
  });
}

export async function deleteAccount(accountId: string): Promise<void> {
  return invoke<void>("delete_account", { accountId });
}

export interface AccountDetails {
  email: string;
  displayName: string;
  color: string | null;
  provider: string;
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  imapSecurity: "tls" | "starttls" | "plain";
  imapAcceptInvalidCerts: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  smtpSecurity: "tls" | "starttls" | "plain";
  smtpAcceptInvalidCerts: boolean;
  proxyMode: string;
  proxyHost: string;
  proxyPort: number;
}

export async function getAccountDetails(accountId: string): Promise<AccountDetails> {
  return invoke<AccountDetails>("get_account_details", { accountId });
}

// ─── Folder API ──────────────────────────────────────────────────────────────

export async function listFolders(accountId: string): Promise<Folder[]> {
  return invoke<Folder[]>("list_folders", { accountId });
}

export interface BodyBackfillStat {
  account_id: string;
  remaining: number;
}

/** 各账号正文/附件下载进度（remaining = 还有多少封只有邮件头）。 */
export async function getBodyBackfillStats(): Promise<BodyBackfillStat[]> {
  return invoke<BodyBackfillStat[]>("get_body_backfill_stats");
}

export async function getImapSyncFolders(accountId: string): Promise<ImapSyncFolderSettings> {
  return invoke<ImapSyncFolderSettings>("get_imap_sync_folders", { accountId });
}

export async function updateImapSyncFolders(
  accountId: string,
  selectedRemoteIds: string[],
): Promise<ImapSyncFolderSettings> {
  return invoke<ImapSyncFolderSettings>("update_imap_sync_folders", {
    accountId,
    selectedRemoteIds,
  });
}

export async function createFolder(accountId: string, name: string, parentFolderId?: string | null): Promise<Folder> {
  return invoke<Folder>("create_folder", { accountId, name, parentFolderId: parentFolderId ?? null });
}

/** 拖动文件夹：改变层级（newParentFolderId）与同级顺序（afterFolderId，null=该层最前）。 */
export async function moveFolder(
  accountId: string,
  folderId: string,
  newParentFolderId: string | null,
  afterFolderId: string | null,
): Promise<Folder[]> {
  return invoke<Folder[]>("move_folder", { accountId, folderId, newParentFolderId, afterFolderId });
}

export async function renameFolder(
  accountId: string,
  folderId: string,
  newName: string,
): Promise<Folder> {
  return invoke<Folder>("rename_folder", { accountId, folderId, newName });
}

export async function deleteFolder(accountId: string, folderId: string): Promise<Folder[]> {
  return invoke<Folder[]>("delete_folder", { accountId, folderId });
}

export async function markFolderAllRead(accountId: string, folderId: string): Promise<number> {
  return invoke<number>("mark_folder_all_read", { accountId, folderId });
}

// ─── Message API ─────────────────────────────────────────────────────────────

export async function listMessages(
  folderId: string,
  limit: number,
  offset: number,
  folderIds?: string[],
  cursor?: { date: number; id: string } | null,
): Promise<MessageSummary[]> {
  return invoke<MessageSummary[]>("list_messages", {
    folderId,
    folderIds,
    limit,
    offset,
    cursorDate: cursor?.date ?? null,
    cursorId: cursor?.id ?? null,
  });
}

export async function searchLeadCompanies(
  product: string,
  market: string,
  buyerType: string,
  batchMode: boolean,
): Promise<PublicCompanyMatch[]> {
  return invoke<PublicCompanyMatch[]>("search_lead_companies", {
    product, market, buyerType, batchMode,
  });
}

export async function aiFindCompanyBatch(
  product: string,
  market: string,
  buyerType: string,
  focus: string,
  exclusions: string[],
): Promise<PublicCompanyMatch[]> {
  return invoke<PublicCompanyMatch[]>("ai_find_company_batch", {
    product, market, buyerType, focus, exclusions,
  });
}

export async function enrichLeadCandidate(candidate: PublicCompanyMatch): Promise<PublicCompanyMatch> {
  return invoke<PublicCompanyMatch>("enrich_lead_candidate", { candidate });
}

export async function summarizeLeadCandidates(candidates: PublicCompanyMatch[]): Promise<PublicCompanyMatch[]> {
  return invoke<PublicCompanyMatch[]>("summarize_lead_candidates", { candidates });
}

export interface LeadFinderPersistedData {
  searchSessions: unknown[];
  savedLeads: unknown[];
}

export async function loadLeadFinderData(): Promise<LeadFinderPersistedData | null> {
  return invoke<LeadFinderPersistedData | null>("load_lead_finder_data");
}

export async function saveLeadFinderData(data: LeadFinderPersistedData): Promise<void> {
  return invoke<void>("save_lead_finder_data", { data });
}

/** "所有未读"视图：全部账户的未读邮件。 */
export async function listUnreadMessages(
  limit: number,
  offset: number,
): Promise<MessageSummary[]> {
  return invoke<MessageSummary[]>("list_unread_messages", { limit, offset });
}

export async function listStarredMessages(
  accountId: string,
  limit: number,
  offset: number,
): Promise<MessageSummary[]> {
  return invoke<MessageSummary[]>("list_starred_messages", { accountId, limit, offset });
}

export async function getMessage(messageId: string): Promise<Message | null> {
  return invoke<Message | null>("get_message", { messageId });
}

/** Batch-fetch multiple messages in a single IPC call. */
export async function getMessagesBatch(messageIds: string[]): Promise<Message[]> {
  return invoke<Message[]>("get_messages_batch", { messageIds });
}

export async function getRenderedHtml(
  messageId: string,
  privacyMode: PrivacyMode,
): Promise<RenderedHtml> {
  return invoke<RenderedHtml>("get_rendered_html", { messageId, privacyMode });
}

/** Single IPC call that returns both Message and RenderedHtml. */
export async function getMessageWithHtml(
  messageId: string,
  privacyMode: PrivacyMode,
): Promise<[Message, RenderedHtml] | null> {
  return invoke<[Message, RenderedHtml] | null>("get_message_with_html", { messageId, privacyMode });
}

export async function updateMessageFlags(
  messageId: string,
  isRead?: boolean,
  isStarred?: boolean,
): Promise<void> {
  return invoke<void>("update_message_flags", { messageId, isRead, isStarred });
}

// Rapid-toggle guard: archive_message is toggle-based (archive ⇄ unarchive),
// so a double-click would flip the state back. This Set coalesces concurrent
// calls per-message; it is NOT idempotency — a second click *after* the first
// resolves is intentionally allowed to unarchive.
const archivingIds = new Set<string>();

export async function archiveMessage(messageId: string): Promise<string> {
  if (archivingIds.has(messageId)) {
    return "skipped";
  }
  archivingIds.add(messageId);
  try {
    return await invoke<string>("archive_message", { messageId });
  } finally {
    archivingIds.delete(messageId);
  }
}

export async function deleteMessage(messageId: string): Promise<void> {
  return invoke<void>("delete_message", { messageId });
}

export async function restoreMessage(messageId: string): Promise<void> {
  return invoke<void>("restore_message", { messageId });
}

export async function moveToFolder(messageId: string, targetFolderId: string): Promise<void> {
  return invoke<void>("move_to_folder", { messageId, targetFolderId });
}

export async function emptyTrash(accountId: string): Promise<number> {
  return invoke<number>("empty_trash", { accountId });
}

export async function emptySpam(accountId: string): Promise<number> {
  return invoke<number>("empty_spam", { accountId });
}

export async function emptyDrafts(accountId: string): Promise<number> {
  return invoke<number>("empty_drafts", { accountId });
}

export async function getPendingMailOpsSummary(
  accountId: string | null,
): Promise<PendingMailOpsSummary> {
  return invoke<PendingMailOpsSummary>("get_pending_mail_ops_summary", { accountId });
}

export async function listPendingMailOps(
  accountId: string | null,
  limit = 100,
): Promise<PendingMailOp[]> {
  return invoke<PendingMailOp[]>("list_pending_mail_ops", { accountId, limit });
}

export async function openDefaultMailSettings(): Promise<void> {
  return invoke<void>("open_default_mail_settings");
}

export async function syncTitlebarTheme(theme: string): Promise<void> {
  return invoke<void>("sync_titlebar_theme", { theme });
}

export async function dismissFailedPendingMailOps(
  accountId: string | null,
): Promise<number> {
  return invoke<number>("dismiss_failed_pending_mail_ops", { accountId });
}

// ─── Trusted Senders API ────────────────────────────────────────────────────

export async function listTrustedSenders(accountId: string): Promise<TrustedSender[]> {
  return invoke<TrustedSender[]>("list_trusted_senders", { accountId });
}

export async function removeTrustedSender(accountId: string, email: string): Promise<void> {
  return invoke<void>("remove_trusted_sender", { accountId, email });
}

export async function trustSender(accountId: string, email: string, trustType: "images" | "all"): Promise<void> {
  return invoke<void>("trust_sender", { accountId, email, trustType });
}

export async function isTrustedSender(accountId: string, email: string): Promise<boolean> {
  return invoke<boolean>("is_trusted_sender", { accountId, email });
}

// ─── Search API ──────────────────────────────────────────────────────────────

export async function searchMessages(
  query: string,
  limit?: number,
  accountId?: string,
): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("search_messages", { query, limit, accountId });
}

export async function advancedSearch(
  query: AdvancedSearchQuery,
  limit?: number,
): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("advanced_search", { query, limit });
}

// ─── Sync API ────────────────────────────────────────────────────────────────

export async function startSync(accountId: string, pollIntervalSecs?: number): Promise<string> {
  return invoke<string>("start_sync", { accountId, pollIntervalSecs: pollIntervalSecs ?? null });
}

export async function triggerSync(accountId: string, reason: string): Promise<void> {
  return invoke<void>("trigger_sync", { accountId, reason });
}

export type RealtimePreference = "realtime" | "balanced" | "battery" | "manual";

export async function setRealtimePreference(mode: RealtimePreference): Promise<void> {
  return invoke<void>("set_realtime_preference", { mode });
}

export async function setNotificationsEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("set_notifications_enabled", { enabled });
}

export async function getNotificationStatus(): Promise<NotificationStatus> {
  return invoke<NotificationStatus>("get_notification_status");
}

export async function showTestNotification(): Promise<void> {
  return invoke<void>("show_test_notification");
}

export async function clearNotificationAttention(): Promise<void> {
  return invoke<void>("clear_notification_attention");
}

export async function setTrayMenuLabels(showLabel: string, hideLabel: string, quitLabel: string): Promise<void> {
  return invoke<void>("set_tray_menu_labels", { showLabel, hideLabel, quitLabel });
}

export async function stopSync(accountId: string): Promise<void> {
  return invoke<void>("stop_sync", { accountId });
}

// ─── Attachment API ──────────────────────────────────────────────────────────

export async function listAttachments(messageId: string): Promise<Attachment[]> {
  return invoke<Attachment[]>("list_attachments", { messageId });
}

export async function getAttachmentPath(attachmentId: string): Promise<string | null> {
  return invoke<string | null>("get_attachment_path", { attachmentId });
}

export async function getAttachmentDragIconPath(): Promise<string> {
  return invoke<string>("get_attachment_drag_icon_path");
}

export interface ReadAttachmentFileResult {
  name: string;
  mime_type: string;
  bytes: number[];
}

export async function readAttachmentFile(attachmentId: string): Promise<ReadAttachmentFileResult> {
  return invoke<ReadAttachmentFileResult>("read_attachment_file", { attachmentId });
}

export async function openAttachment(attachmentId: string): Promise<void> {
  return invoke<void>("open_attachment", { attachmentId });
}

export async function downloadAttachment(attachmentId: string, saveTo: string): Promise<string> {
  return invoke<string>("download_attachment", { attachmentId, saveTo });
}

export async function saveAttachmentsAs(attachmentIds: string[]): Promise<string[]> {
  return invoke<string[]>("save_attachments_as", { attachmentIds });
}

export async function copyAttachmentsToClipboard(attachmentIds: string[]): Promise<void> {
  return invoke<void>("copy_attachments_to_clipboard", { attachmentIds });
}

// ─── Kanban API ──────────────────────────────────────────────────────────────

export async function moveToKanban(messageId: string, column: KanbanColumnType, position?: number): Promise<void> {
  return invoke<void>("move_to_kanban", { messageId, column, position });
}

export async function listKanbanCards(column?: KanbanColumnType): Promise<KanbanCard[]> {
  return invoke<KanbanCard[]>("list_kanban_cards", { column });
}

export async function removeFromKanban(messageId: string): Promise<void> {
  return invoke<void>("remove_from_kanban", { messageId });
}

export async function listKanbanContextNotes(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("list_kanban_context_notes");
}

export async function setKanbanContextNote(
  messageId: string,
  note: string,
): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("set_kanban_context_note", { messageId, note });
}

export async function mergeKanbanContextNotes(
  notes: Record<string, string>,
): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("merge_kanban_context_notes", { notes });
}

// ─── Snooze API ──────────────────────────────────────────────────────────────

export async function snoozeMessage(messageId: string, until: number, returnTo: string): Promise<void> {
  return invoke<void>("snooze_message", { messageId, until, returnTo });
}

export async function unsnoozeMessage(messageId: string): Promise<void> {
  return invoke<void>("unsnooze_message", { messageId });
}

export async function listSnoozed(): Promise<SnoozedMessage[]> {
  return invoke<SnoozedMessage[]>("list_snoozed");
}

// ─── Rules API ───────────────────────────────────────────────────────────────

export async function createRule(rule: Rule): Promise<Rule> {
  return invoke<Rule>("create_rule", { rule });
}

export async function listRules(accountId?: string): Promise<Rule[]> {
  return invoke<Rule[]>("list_rules", { accountId: accountId ?? "" });
}

export async function updateRule(rule: Rule): Promise<void> {
  return invoke<void>("update_rule", { rule });
}

export async function deleteRule(ruleId: string): Promise<void> {
  return invoke<void>("delete_rule", { ruleId });
}

/** 手动执行规则：对指定文件夹下的邮件套用规则。现在改为后台执行——命令立即返回，
 * 实际进度通过事件 rules:apply-progress 推送，完成报告通过 rules:apply-done 推送。 */
export async function applyRulesToFolder(
  accountId: string,
  folderId: string,
  ruleIds?: string[],
): Promise<void> {
  await invoke<void>("apply_rules_to_folder", {
    accountId,
    folderId,
    ruleIds: ruleIds ?? null,
  });
}

// ─── Compose API ─────────────────────────────────────────────────────────────

export async function sendEmail(
  accountId: string,
  to: string[],
  cc: string[],
  bcc: string[],
  subject: string,
  bodyText: string,
  bodyHtml?: string,
  inReplyTo?: string,
  attachmentPaths?: string[],
): Promise<void> {
  return invoke<void>("send_email", {
    accountId, to, cc, bcc, subject, bodyText, bodyHtml, inReplyTo, attachmentPaths,
  });
}

export async function stageComposeAttachment(filename: string, bytes: number[]): Promise<string> {
  return invoke<string>("stage_compose_attachment", { filename, bytes });
}

// ─── Batch Operations ───────────────────────────────────────────────────────

export async function batchArchive(messageIds: string[]): Promise<number> {
  return invoke<number>("batch_archive", { messageIds });
}

export async function batchDelete(messageIds: string[]): Promise<number> {
  return invoke<number>("batch_delete", { messageIds });
}

export async function batchMarkRead(messageIds: string[], isRead: boolean): Promise<number> {
  return invoke<number>("batch_mark_read", { messageIds, isRead });
}

export async function batchStar(messageIds: string[], starred: boolean): Promise<number> {
  return invoke<number>("batch_star", { messageIds, starred });
}

// ─── Translate API ───────────────────────────────────────────────────────────

export async function translateText(text: string, fromLang: string, toLang: string): Promise<TranslateResult> {
  return invoke<TranslateResult>("translate_text", { text, fromLang, toLang });
}

export async function getTranslateConfig(): Promise<TranslateConfig | null> {
  return invoke<TranslateConfig | null>("get_translate_config");
}

export async function saveTranslateConfig(providerType: string, config: string, isEnabled: boolean): Promise<void> {
  return invoke<void>("save_translate_config", { providerType, config, isEnabled });
}

export async function testTranslateConnection(config: string): Promise<string> {
  return invoke<string>("test_translate_connection", { config });
}

export interface ExternalServiceKeyStatus {
  tavilyConfigured: boolean;
  braveConfigured: boolean;
  firecrawlConfigured: boolean;
  hunterConfigured: boolean;
  tavilyKeyCount: number;
  braveKeyCount: number;
  firecrawlKeyCount: number;
  hunterKeyCount: number;
}

export interface ExternalServiceUsage {
  provider: "tavily" | "brave" | "firecrawl" | "hunter";
  supported: boolean;
  valid: boolean;
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  unit: string;
  resetAt?: string | null;
  message: string;
  checkedAt: number;
}

export async function validateExternalServiceApiKey(provider: ExternalServiceUsage["provider"], apiKey: string): Promise<ExternalServiceUsage> {
  return invoke<ExternalServiceUsage>("validate_external_service_api_key", { provider, apiKey });
}

export async function getExternalServiceUsage(provider: ExternalServiceUsage["provider"]): Promise<ExternalServiceUsage> {
  return invoke<ExternalServiceUsage>("get_external_service_usage", { provider });
}

export async function getExternalServiceKeyStatus(): Promise<ExternalServiceKeyStatus> {
  return invoke<ExternalServiceKeyStatus>("get_external_service_key_status");
}

export async function saveExternalServiceApiKey(provider: "tavily" | "brave" | "firecrawl" | "hunter", apiKey: string): Promise<ExternalServiceKeyStatus> {
  return invoke<ExternalServiceKeyStatus>("save_external_service_api_key", { provider, apiKey });
}

export async function deleteExternalServiceApiKey(provider: "tavily" | "brave" | "firecrawl" | "hunter"): Promise<ExternalServiceKeyStatus> {
  return invoke<ExternalServiceKeyStatus>("delete_external_service_api_key", { provider });
}

// ─── AI (外贸 AI 邮件客户端) API ────────────────────────────────────────────

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Single-shot AI completion. `system` sets the persona/instructions, `user` is the prompt. */
export async function aiPrompt(system: string, user: string): Promise<string> {
  return invoke<string>("ai_prompt", { system, user });
}

/** Multi-turn AI chat for iterative draft/reply refinement. */
export async function aiChat(turns: ChatTurn[]): Promise<string> {
  return invoke<string>("ai_chat", { turns });
}

/** Agent run with Tool Calling: the model can search the web / fetch pages
 *  / query GLEIF on its own, then continue reasoning. */
export async function agentRun(
  system: string,
  user: string,
): Promise<{ content: string; sources: string[]; toolCalls: number }> {
  return invoke<{ content: string; sources: string[]; toolCalls: number }>("agent_run", {
    system,
    user,
  });
}

// ─── AI 写作风格 (Style Engine) API ────────────────────────────────────────

export interface StyleProfile {
  id: string;
  name: string;
  description: string;
  profile: string;
  isActive: boolean;
  /** null/undefined means shared by all mailbox accounts */
  accountIds?: string[] | null;
  createdAt: number;
  updatedAt: number;
}

export interface StyleSample {
  subject: string;
  body: string;
}

/** List all writing-style profiles. */
export async function listStyleProfiles(): Promise<StyleProfile[]> {
  return invoke<StyleProfile[]>("list_style_profiles");
}

/** Create or update a style profile (upserted by id). */
export async function saveStyleProfile(input: {
  id?: string;
  name: string;
  description: string;
  profile: string;
  isActive?: boolean;
  accountIds?: string[] | null;
}): Promise<StyleProfile> {
  return invoke<StyleProfile>("save_style_profile", { input });
}

/** Delete a style profile; returns the remaining profiles. */
export async function deleteStyleProfile(id: string): Promise<StyleProfile[]> {
  return invoke<StyleProfile[]>("delete_style_profile", { id });
}

/** Collect samples of the user's SENT emails for learning a style. */
export async function getSentSamples(limit: number, accountId?: string | null): Promise<StyleSample[]> {
  return invoke<StyleSample[]>("get_sent_samples", { limit, accountId: accountId ?? null });
}

export interface KnowledgeItem {
  id: string;
  name: string;
  accountId?: string | null;
  /** null/undefined means shared by all mailbox accounts */
  accountIds?: string[] | null;
  sourceType: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  chunks: Array<{ id: string; content: string; locator: string; section: string; ordinal: number }>;
}

export interface KnowledgeSnippet {
  id: string;
  name: string;
  content: string;
  score: number;
  chunkId: string;
  sourceType: string;
  locator: string;
  section: string;
}

export async function listKnowledgeItems(accountId?: string | null): Promise<KnowledgeItem[]> {
  return invoke<KnowledgeItem[]>("list_knowledge_items", { accountId: accountId ?? null });
}

export async function saveKnowledgeItem(input: {
  id?: string;
  name: string;
  accountId?: string | null;
  accountIds?: string[] | null;
  sourceType?: string;
  content: string;
}): Promise<KnowledgeItem> {
  return invoke<KnowledgeItem>("save_knowledge_item", { input });
}

export async function deleteKnowledgeItem(id: string): Promise<void> {
  return invoke<void>("delete_knowledge_item", { id });
}

export async function searchKnowledgeBase(query: string, limit = 3, accountId?: string | null): Promise<KnowledgeSnippet[]> {
  return invoke<KnowledgeSnippet[]>("search_knowledge_base", { query, limit, accountId: accountId ?? null });
}

// ─── 客户记忆 (Customer Memory) API ──────────────────────────────────────────

export interface FollowUpEntry {
  id: string;
  date: number;
  channel: string;
  note: string;
}

export interface FollowUpSequenceStep {
  id: string;
  dayOffset: number;
  title: string;
  instruction: string;
  status: "pending" | "draft_ready" | "completed" | "skipped";
  dueAt: number;
}

export interface CustomerMemory {
  id: string;
  email: string;
  name: string;
  company: string;
  summary: string;
  /** Detailed structured context used as AI grounding when drafting. */
  profile: string;
  messageCount: number;
  contacts: Array<{
    email: string;
    name: string;
    jobTitle: string;
  }>;
  /** Manual tag: where this customer came from (展会/社媒/谷歌开发...). */
  source: string;
  /** Manual tag: current development stage (开发中/已成交...). */
  status: string;
  /** Follow-up stage (mutually exclusive). */
  stage: string;
  /** Characteristic tags (multi-select). */
  tags: string[];
  /** Customer tier: A / B / C. */
  tier: string;
  /** Unix seconds of next scheduled follow-up (0 = none). */
  nextFollowUp: number;
  /** Follow-up timeline. */
  followUps: FollowUpEntry[];
  /** 接触过该客户的账号（生成记忆时从往来邮件记录；空 = 旧数据/未知） */
  accountIds?: string[];
  followUpSequence: FollowUpSequenceStep[];
  followUpSequencePaused: boolean;
  updatedAt: number;
}

/** List all customer memories. */
export async function listCustomerMemories(): Promise<CustomerMemory[]> {
  return invoke<CustomerMemory[]>("list_customer_memories");
}

/** Create or update a customer memory (upserted by id / email). */
export async function saveCustomerMemory(input: {
  id?: string;
  email: string;
  name?: string;
  company?: string;
  summary?: string;
  profile?: string;
  source?: string;
  status?: string;
  stage?: string;
  tags?: string[];
  tier?: string;
  nextFollowUp?: number;
  followUps?: FollowUpEntry[];
  accountIds?: string[];
  followUpSequence?: FollowUpSequenceStep[];
  followUpSequencePaused?: boolean;
}): Promise<CustomerMemory> {
  return invoke<CustomerMemory>("save_customer_memory", { input });
}

/** Delete a customer memory; returns the remaining memories. */
export async function deleteCustomerMemory(id: string): Promise<CustomerMemory[]> {
  return invoke<CustomerMemory[]>("delete_customer_memory", { id });
}

/** Build a temp .eml file for "forward as attachment"; returns file path. */
export async function buildForwardEml(messageId: string): Promise<string> {
  return invoke<string>("build_forward_eml", { messageId });
}

/** Export a message as .eml via save dialog; returns saved path. */
export async function exportMessageEml(messageId: string): Promise<string> {
  return invoke<string>("export_message_eml", { messageId });
}

/** Build / refresh a customer memory from email history with `email`.
 *  `existingProfile` 传入后为增量更新（保留原有画像有效信息，按新邮件补充修正）。 */
export async function buildCustomerMemory(email: string, limit: number, existingProfile?: string): Promise<CustomerMemory> {
  return invoke<CustomerMemory>("build_customer_memory", { email, limit, existingProfile });
}

// ─── 发送防呆 (Send Guard) API ────────────────────────────────────────────────

export type ContactRole =
  | "customer"
  | "supplier"
  /** Freight forwarder, customs broker, certification/inspection body, bank, platform. */
  | "service"
  | "neutral"
  | "unknown";
export type RoleSource = "manual" | "inferred" | "imported";
export type GuardMode = "soft" | "strict";

export interface SendGuardConfig {
  enabled: boolean;
  mode: GuardMode;
}

export interface ContactRoleEntry {
  email: string;
  role: ContactRole;
  source: RoleSource;
  /** 0..1 confidence of the inferred role (1 for manual). */
  confidence?: number;
  /** Short human-readable reasons behind the classification. */
  reasons?: string[];
  /** Unix seconds when this entry was last computed. */
  inferredAt?: number;
}

export interface RecipientRole {
  email: string;
  role: ContactRole;
}

export interface SendGuardVerdict {
  /** "ok" | "warn" | "block" */
  level: string;
  reasons: string[];
  recipients: RecipientRole[];
  /** "customer" | "supplier" | "unknown" — what the draft looks intended for. */
  draftIntent?: string;
}

export async function getSendGuardConfig(): Promise<SendGuardConfig> {
  return invoke<SendGuardConfig>("get_send_guard_config");
}

export async function setSendGuardConfig(config: SendGuardConfig): Promise<SendGuardConfig> {
  return invoke<SendGuardConfig>("set_send_guard_config", { config });
}

export async function listContactRoles(): Promise<ContactRoleEntry[]> {
  return invoke<ContactRoleEntry[]>("list_contact_roles");
}

export async function setContactRole(email: string, role: ContactRole): Promise<ContactRoleEntry[]> {
  return invoke<ContactRoleEntry[]>("set_contact_role", { email, role });
}

export async function deleteContactRole(email: string): Promise<ContactRoleEntry[]> {
  return invoke<ContactRoleEntry[]>("delete_contact_role", { email });
}

export async function inferContactRole(
  accountId: string,
  email: string,
): Promise<ContactRoleEntry> {
  return invoke<ContactRoleEntry>("infer_contact_role", { accountId, email });
}

export async function importCustomerRoles(): Promise<ContactRoleEntry[]> {
  return invoke<ContactRoleEntry[]>("import_customer_roles");
}

/** Lightweight, AI-free classification of ALL contacts from their email addresses. */
export async function autoClassifyContacts(accountId: string): Promise<ContactRoleEntry[]> {
  return invoke<ContactRoleEntry[]>("auto_classify_contacts", { accountId });
}

/** Full multi-dimensional AI inference for ALL contacts (costs API calls). */
export async function inferAllContactRoles(accountId: string): Promise<ContactRoleEntry[]> {
  return invoke<ContactRoleEntry[]>("infer_all_contact_roles", { accountId });
}

export async function checkSendGuard(params: {
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
}): Promise<SendGuardVerdict> {
  return invoke<SendGuardVerdict>("check_send_guard", {
    accountId: params.accountId,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    bodyText: params.bodyText,
  });
}

// ─── Thread API ──────────────────────────────────────────────────────────────

export async function listThreads(
  folderId: string,
  limit: number,
  offset: number,
  folderIds?: string[],
): Promise<ThreadSummary[]> {
  return invoke<ThreadSummary[]>("list_threads", { folderId, folderIds, limit, offset });
}

export async function listThreadMessages(threadId: string): Promise<Message[]> {
  return invoke<Message[]>("list_thread_messages", { threadId });
}

// ─── Labels API ──────────────────────────────────────────────────────────────

export async function getMessageLabels(messageId: string): Promise<Label[]> {
  return invoke<Label[]>("get_message_labels", { messageId });
}

export async function getMessageLabelsBatch(messageIds: string[]): Promise<Record<string, Label[]>> {
  return invoke<Record<string, Label[]>>("get_message_labels_batch", { messageIds });
}

export async function addMessageLabel(messageId: string, labelName: string): Promise<void> {
  return invoke<void>("add_message_label", { messageId, labelName });
}

export async function removeMessageLabel(messageId: string, labelName: string): Promise<void> {
  return invoke<void>("remove_message_label", { messageId, labelName });
}

export async function listLabels(): Promise<Label[]> {
  return invoke<Label[]>("list_labels");
}

// ─── Cloud Sync API ─────────────────────────────────────────────────────────

export async function testWebdavConnection(url: string, username: string, password: string): Promise<string> {
  return invoke<string>("test_webdav_connection", { url, username, password });
}

export async function backupToWebdav(
  url: string,
  username: string,
  password: string,
  secretPassphrase?: string,
): Promise<string> {
  return invoke<string>("backup_to_webdav", { url, username, password, secretPassphrase });
}

export async function previewWebdavBackup(url: string, username: string, password: string): Promise<BackupPreview> {
  return invoke<BackupPreview>("preview_webdav_backup", { url, username, password });
}

export async function exportBackupFile(secretPassphrase?: string): Promise<string> {
  return invoke<string>("export_backup_file", { secretPassphrase });
}

export async function previewBackupFile(data: string): Promise<BackupPreview> {
  return invoke<BackupPreview>("preview_backup_file", { data });
}

export async function importBackupFile(data: string, secretPassphrase?: string): Promise<string> {
  return invoke<string>("import_backup_file", { data, secretPassphrase });
}

export async function restoreFromWebdav(
  url: string,
  username: string,
  password: string,
  secretPassphrase?: string,
): Promise<string> {
  return invoke<string>("restore_from_webdav", { url, username, password, secretPassphrase });
}

// ─── Auto Backup API ────────────────────────────────────────────────────────

export interface AutoBackupConfig {
  url: string;
  username: string;
  password: string;
  secret_passphrase: string | null;
  interval_minutes: number;
  enabled: boolean;
}

export async function saveAutoBackupConfig(config: AutoBackupConfig): Promise<void> {
  return invoke<void>("save_auto_backup_config", { config });
}

export async function loadAutoBackupConfig(): Promise<AutoBackupConfig | null> {
  return invoke<AutoBackupConfig | null>("load_auto_backup_config");
}

export async function deleteAutoBackupConfig(): Promise<void> {
  return invoke<void>("delete_auto_backup_config");
}

// ─── Contacts API ────────────────────────────────────────────────────────────

export async function searchContacts(
  accountId: string,
  query: string,
  limit?: number,
): Promise<KnownContact[]> {
  return invoke<KnownContact[]>("search_contacts", { accountId, query, limit });
}

export interface AddressBookContact {
  id: string;
  email: string;
  name: string;
  company: string;
  jobTitle: string;
  role: ContactRole;
  notes: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  /** 归属账号（从该账号的往来邮件导入时记录；null = 未归属/手动添加） */
  accountId?: string | null;
}

export async function listAddressBookContacts(): Promise<AddressBookContact[]> {
  return invoke<AddressBookContact[]>("list_address_book_contacts");
}

export async function saveAddressBookContact(input: {
  id?: string;
  email: string;
  name?: string;
  company?: string;
  jobTitle?: string;
  role?: ContactRole;
  notes?: string;
  tags?: string[];
  accountId?: string | null;
}): Promise<AddressBookContact> {
  return invoke<AddressBookContact>("save_address_book_contact", { input });
}

export async function deleteAddressBookContact(id: string): Promise<void> {
  return invoke<void>("delete_address_book_contact", { id });
}

export async function importMailContactsToAddressBook(accountId: string): Promise<number> {
  return invoke<number>("import_mail_contacts_to_address_book", { accountId });
}

// ─── Drafts API ──────────────────────────────────────────────────────────────

/** 在独立窗口中打开写信界面（多窗口模式）。prefill 会序列化传给新窗口。 */
export async function openComposeWindow(prefill?: {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
}): Promise<void> {
  const json = prefill ? JSON.stringify(prefill) : undefined;
  await invoke("open_compose_window", { prefill: json });
}

export async function saveDraft(args: {
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  inReplyTo?: string;
  existingDraftId?: string;
  attachmentPaths?: string[];
}): Promise<string> {
  return invoke("save_draft", {
    accountId: args.accountId,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    bodyText: args.bodyText,
    bodyHtml: args.bodyHtml ?? null,
    inReplyTo: args.inReplyTo ?? null,
    existingDraftId: args.existingDraftId ?? null,
    attachmentPaths: args.attachmentPaths ?? null,
  });
}

export async function deleteDraft(accountId: string, draftId: string): Promise<void> {
  return invoke("delete_draft", { accountId, draftId });
}

// ─── Folder Counts API ───────────────────────────────────────────────────────

export async function getFolderUnreadCounts(accountId: string): Promise<Record<string, number>> {
  return invoke("get_folder_unread_counts", { accountId });
}

// ─── Autostart API ───────────────────────────────────────────────────────────

/** Whether Pebble is registered to launch when the user logs in. */
export async function getAutostartEnabled(): Promise<boolean> {
  return invoke<boolean>("get_autostart_enabled");
}

/** Enable or disable launching Pebble when the user logs in. */
export async function setAutostartEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("set_autostart_enabled", { enabled });
}
