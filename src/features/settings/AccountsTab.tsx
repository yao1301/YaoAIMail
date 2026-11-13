import { useWorkspaceState, useWorkspaceInitEffect } from '@/lib/workspaceState';
import { useEffect, useMemo, useRef } from "react";
import { Plus, Trash2, Mail, Pencil, Plug, RefreshCw } from "lucide-react";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  deleteAccount,
  getAccountDetails,
  getImapSyncFolders,
  getOAuthAccountProxySetting,
  testAccountConnection,
  triggerSync,
  updateAccount,
  updateImapSyncFolders,
  updateOAuthAccountProxySetting,
} from "@/lib/api";
import type {
  Account,
  AccountProxyMode,
  ConnectionSecurity,
  ImapSyncFolderSettings,
} from "@/lib/api";
import { useAccountsQuery, accountsQueryKey } from "@/hooks/queries";
import { useMailStore } from "@/stores/mail.store";
import { useUIStore, type RealtimeStatus } from "@/stores/ui.store";
import { useToastStore } from "@/stores/toast.store";
import AccountSetup from "@/components/AccountSetup";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { listEmailSignatures, saveEmailSignature, deleteEmailSignature, setDefaultEmailSignature, type EmailSignature } from "@/lib/signatures";
import SignatureEditor from "./SignatureEditor";
import { ACCOUNT_COLOR_PRESETS, assignAccountColors, getAccountColor } from "@/lib/accountColors";
import { inputStyle, labelStyle } from "../../styles/form";
import { defaultIncomingPort, defaultSmtpPort } from "@/lib/mailPorts";
import { findMailServerPreset } from "@/lib/mailAccountPresets";
import { explainMailConnectionReport } from "@/lib/mailConnectionTest";
import {
  getAccountSyncPreference,
  setAccountSyncPreference,
  type AccountSyncPreference,
} from "@/lib/accountSyncPreferences";

const ACCOUNT_SYNC_OPTIONS: Array<{ value: AccountSyncPreference; label: string }> = [
  { value: "realtime", label: "实时（约 3 秒）" },
  { value: "balanced", label: "平衡（15 秒）" },
  { value: "battery", label: "省电（60 秒）" },
  { value: "manual", label: "仅手动收取" },
];

export default function AccountsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: accounts = [] } = useAccountsQuery();
  const accountColorsById = useMemo(() => assignAccountColors(accounts), [accounts]);
  const realtimeStatusByAccount = useUIStore((state) => state.realtimeStatusByAccount);
  const globalRealtimeMode = useUIStore((state) => state.realtimeMode);
  const focusAccountId = useUIStore((s) => s.focusAccountId);
  const setFocusAccountId = useUIStore((s) => s.setFocusAccountId);
  const [showSetup, setShowSetup] = useWorkspaceState("src/features/settings/AccountsTab.tsx:AccountsTab:showSetup", false);
  const [editingAccount, setEditingAccount] = useWorkspaceState<Account | null>("src/features/settings/AccountsTab.tsx:AccountsTab:editingAccount", null);
  const [deleteTarget, setDeleteTarget] = useWorkspaceState<{ id: string; email: string } | null>("src/features/settings/AccountsTab.tsx:AccountsTab:deleteTarget", null);
  const [accountTests, setAccountTests] = useWorkspaceState<Record<string, { ok: boolean; message: string } | "testing" | undefined>>("src/features/settings/AccountsTab.tsx:AccountsTab:accountTests", {});
  const [changingSyncId, setChangingSyncId] = useWorkspaceState<string | null>("src/features/settings/AccountsTab.tsx:AccountsTab:changingSyncId", null);
  const [, setSyncPreferenceVersion] = useWorkspaceState("src/features/settings/AccountsTab.tsx:AccountsTab:setSyncPreferenceVersion", 0);

  // When the sidebar's account context menu picks "账户设置", open the edit
  // dialog directly for that account.
  useEffect(() => {
    if (!focusAccountId) return;
    const target = accounts.find((a) => a.id === focusAccountId);
    if (target) {
      setEditingAccount(target);
    }
    setFocusAccountId(null);
  }, [focusAccountId, accounts, setFocusAccountId]);

  async function doTestConnection(accountId: string) {
    setAccountTests((current) => ({ ...current, [accountId]: "testing" }));
    try {
      const report = await testAccountConnection(accountId);
      setAccountTests((current) => ({ ...current, [accountId]: { ok: true, message: report } }));
    } catch (err) {
      const msg = extractErrorMessage(err);
      const details = await getAccountDetails(accountId).catch(() => null);
      const preset = details && details.provider === "imap"
        ? findMailServerPreset(details.email, details.imapHost, details.smtpHost)
        : undefined;
      setAccountTests((current) => ({ ...current, [accountId]: { ok: false, message: explainMailConnectionReport(msg, preset) } }));
    }
  }

  async function doDelete(accountId: string) {
    try {
      await deleteAccount(accountId);
      if (useMailStore.getState().activeAccountId === accountId) {
        useMailStore.getState().setActiveAccountId(null);
      }
      await queryClient.invalidateQueries({ queryKey: accountsQueryKey });
      useToastStore.getState().addToast({
        message: t("settings.deleteAccountSuccess", "Account removed"),
        type: "success",
      });
    } catch (err) {
      const msg = extractErrorMessage(err);
      useToastStore.getState().addToast({
        message: t("settings.deleteAccountFailed", "Failed to remove account: {{error}}", { error: msg }),
        type: "error",
      });
    }
  }

  async function changeAccountSyncPreference(accountId: string, preference: AccountSyncPreference) {
    setChangingSyncId(accountId);
    try {
      setAccountSyncPreference(accountId, preference);
      setSyncPreferenceVersion((version) => version + 1);
      useToastStore.getState().addToast({
        message: preference === "manual" ? "已改为仅手动收取" : `已设置为${ACCOUNT_SYNC_OPTIONS.find((item) => item.value === preference)?.label}`,
        type: "success",
      });
    } catch (err) {
      useToastStore.getState().addToast({
        message: `修改同步频率失败：${extractErrorMessage(err)}`,
        type: "error",
      });
    } finally {
      setChangingSyncId(null);
    }
  }

  return (
        <div>
      {/* Section header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "20px",
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: "16px",
            fontWeight: 600,
            color: "var(--color-text-primary)",
          }}
        >
          {t("settings.emailAccounts")}
        </h2>
        <button
          onClick={() => setShowSetup(true)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "7px 14px",
            borderRadius: "6px",
            border: "none",
            backgroundColor: "var(--color-accent)",
            color: "#fff",
            fontSize: "13px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          <Plus size={14} />
          {t("settings.addAccount")}
        </button>
      </div>

      {/* Empty state */}
      {accounts.length === 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "12px",
            padding: "48px 0",
            color: "var(--color-text-secondary)",
          }}
        >
          <Mail size={40} strokeWidth={1.5} />
          <p style={{ margin: 0, fontSize: "14px" }}>{t("settings.noAccounts")}</p>
          <button
            onClick={() => setShowSetup(true)}
            style={{
              marginTop: "4px",
              padding: "8px 18px",
              borderRadius: "6px",
              border: "1px solid var(--color-border)",
              backgroundColor: "transparent",
              color: "var(--color-text-primary)",
              fontSize: "13px",
              cursor: "pointer",
            }}
          >
            {t("settings.addFirstAccount")}
          </button>
        </div>
      ) : (
        /* Account list */
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "1px",
            borderRadius: "8px",
            overflow: "hidden",
            border: "1px solid var(--color-border)",
          }}
        >
          {accounts.map((account, index) => {
            const realtimeStatus = realtimeStatusByAccount[account.id];
            const realtimeLabel = getAccountRealtimeStatusText(realtimeStatus, t);
            const accountColor = accountColorsById.get(account.id) ?? getAccountColor(account);
            const testResult = accountTests[account.id];
            const testing = testResult === "testing";

            return (
              <div
                key={account.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  padding: "14px 16px",
                  backgroundColor: "var(--color-bg)",
                  borderTop: index > 0 ? "1px solid var(--color-border)" : "none",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        width: "8px",
                        height: "8px",
                        borderRadius: "50%",
                        backgroundColor: accountColor,
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontSize: "13px", fontWeight: 500 }}>
                      {account.display_name}
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: "12px",
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    {account.email}
                  </span>
                  <span
                    style={{
                      fontSize: "11px",
                      color: "var(--color-text-secondary)",
                      textTransform: "capitalize",
                    }}
                  >
                    {account.provider}
                  </span>
                  {realtimeLabel && (
                    <span
                      aria-label={realtimeLabel}
                      title={realtimeStatus?.message ?? realtimeLabel}
                      style={{
                        fontSize: "11px",
                        color: "var(--color-text-secondary)",
                      }}
                    >
                      {realtimeLabel}
                    </span>
                  )}
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "4px", fontSize: "11px", color: "var(--color-text-secondary)" }}>
                    <span>本账号同步频率</span>
                    <select
                      aria-label={`${account.display_name}同步频率`}
                      value={getAccountSyncPreference(account.id) ?? (globalRealtimeMode === "manual" ? "manual" : globalRealtimeMode)}
                      disabled={changingSyncId === account.id}
                      onChange={(event) => void changeAccountSyncPreference(account.id, event.target.value as AccountSyncPreference)}
                      style={{ padding: "2px 5px", border: "1px solid var(--color-border)", borderRadius: "4px", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "11px" }}
                    >
                      {ACCOUNT_SYNC_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                </div>
                <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                  <button
                    onClick={() => doTestConnection(account.id)}
                    disabled={testing}
                    title={t("accountSetup.testConnection", "Test Connection")}
                    aria-label={t("accountSetup.testConnection", "Test Connection")}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      padding: "6px",
                      borderRadius: "6px",
                      border: "none",
                      backgroundColor: "transparent",
                      color: testing ? "var(--color-accent)" : "var(--color-text-secondary)",
                      cursor: testing ? "wait" : "pointer",
                      opacity: testing ? 0.6 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (!testing) {
                        e.currentTarget.style.color = "var(--color-accent)";
                        e.currentTarget.style.backgroundColor = "var(--color-bg-hover)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!testing) {
                        e.currentTarget.style.color = "var(--color-text-secondary)";
                        e.currentTarget.style.backgroundColor = "transparent";
                      }
                    }}
                  >
                    <Plug size={15} />
                  </button>
                  <button
                    onClick={() => setEditingAccount(account)}
                    title={t("settings.editAccount", "Edit account")}
                    aria-label={t("settings.editAccount", "Edit account")}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      padding: "6px",
                      borderRadius: "6px",
                      border: "none",
                      backgroundColor: "transparent",
                      color: "var(--color-text-secondary)",
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "var(--color-accent)";
                      e.currentTarget.style.backgroundColor = "var(--color-bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = "var(--color-text-secondary)";
                      e.currentTarget.style.backgroundColor = "transparent";
                    }}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    onClick={() => setDeleteTarget({ id: account.id, email: account.email })}
                    title={t("settings.removeAccount")}
                    aria-label={t("settings.removeAccount")}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      padding: "6px",
                      borderRadius: "6px",
                      border: "none",
                      backgroundColor: "transparent",
                      color: "var(--color-text-secondary)",
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "#ef4444";
                      e.currentTarget.style.backgroundColor = "rgba(239,68,68,0.08)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = "var(--color-text-secondary)";
                      e.currentTarget.style.backgroundColor = "transparent";
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                {testResult && testResult !== "testing" && (
                  <div role={testResult.ok ? "status" : "alert"} style={{
                    flex: "0 0 100%",
                    boxSizing: "border-box",
                    marginTop: "8px",
                    padding: "8px 11px",
                    borderRadius: "6px",
                    backgroundColor: testResult.ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                    color: testResult.ok ? "var(--color-text-primary)" : "var(--color-error, #dc2626)",
                    fontSize: "12px",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    lineHeight: 1.5,
                  }}>
                    {testResult.message}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <ConfirmDialog
          title={t("settings.removeAccount", "Remove Account")}
          message={t("settings.confirmDeleteAccount", { email: deleteTarget.email })}
          destructive
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            doDelete(deleteTarget.id);
            setDeleteTarget(null);
          }}
        />
      )}

      {/* AccountSetup modal */}
      {showSetup && <AccountSetup onClose={() => setShowSetup(false)} />}

      {/* Edit account modal */}
      {editingAccount && (
        <EditAccountModal
          account={editingAccount}
          initialColor={accountColorsById.get(editingAccount.id) ?? getAccountColor(editingAccount)}
          onClose={() => setEditingAccount(null)}
          onSaved={async () => {
            setEditingAccount(null);
            await queryClient.invalidateQueries({ queryKey: accountsQueryKey });
          }}
        />
      )}
    </div>
  );
}

function getAccountRealtimeStatusText(
  status: RealtimeStatus | undefined,
  t: TFunction,
) {
  if (!status) return null;

  if (status.message) {
    return status.message;
  }

  switch (status.mode) {
    case "realtime":
      return t("status.realtimeConnected", "Realtime connected");
    case "polling":
      return t("status.realtimePolling", "Polling");
    case "manual":
      return t("status.realtimeManual", "Manual only");
    case "backoff":
      return t("status.realtimeBackoff", "Retrying");
    case "auth_required":
      return t("status.realtimeAuthRequired", "Reconnect required");
    case "offline":
      return t("status.offline", "Offline");
    case "error":
      return t("status.realtimeError", "Realtime error");
  }
}

function EditAccountModal({ account, initialColor, onClose, onSaved }: {
  account: Account;
  initialColor: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDivElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const [displayName, setDisplayName] = useWorkspaceState("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":displayName", account.display_name);
  const [senderName, setSenderName] = useWorkspaceState<string | null>("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":senderName", null);
  const [email, setEmail] = useWorkspaceState("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":email", account.email);
  const [accountColor, setAccountColor] = useWorkspaceState("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":accountColor", initialColor);
  const [password, setPassword] = useWorkspaceState("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":password", "");
  const [passwordConfigured, setPasswordConfigured] = useWorkspaceState("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":passwordConfigured", false);
  const [imapHost, setImapHost] = useWorkspaceState("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":imapHost", "");
  const [imapPort, setImapPort] = useWorkspaceState("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":imapPort", "");
  const [imapUsername, setImapUsername] = useWorkspaceState("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":imapUsername", "");
  const [smtpHost, setSmtpHost] = useWorkspaceState("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":smtpHost", "");
  const [smtpPort, setSmtpPort] = useWorkspaceState("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":smtpPort", "");
  const [smtpUsername, setSmtpUsername] = useWorkspaceState("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":smtpUsername", "");
  const [imapSecurity, setImapSecurity] = useWorkspaceState<ConnectionSecurity | "">("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":imapSecurity", "");
  const [smtpSecurity, setSmtpSecurity] = useWorkspaceState<ConnectionSecurity | "">("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":smtpSecurity", "");
  const stateKey = "src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":";
  const [incomingException, setIncomingException] = useWorkspaceState(stateKey + "incomingException", false);
  const [outgoingException, setOutgoingException] = useWorkspaceState(stateKey + "outgoingException", false);
  const [savedExceptions, setSavedExceptions] = useWorkspaceState(stateKey + "savedExceptions", { incoming: false, outgoing: false });
  const [savedConnection, setSavedConnection] = useWorkspaceState(stateKey + "savedConnection", "");
  const [advancedOpen, setAdvancedOpen] = useWorkspaceState(stateKey + "advancedConnection", false);
  const [strictTesting, setStrictTesting] = useWorkspaceState(stateKey + "testing", false);
  const [strictResult, setStrictResult] = useWorkspaceState<{ ok: boolean; message: string } | null>(stateKey + "strictResult", null);
  const [oauthProxyMode, setOauthProxyMode] = useWorkspaceState<AccountProxyMode>("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":oauthProxyMode", "inherit");
  const [proxyHost, setProxyHost] = useWorkspaceState("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":proxyHost", "");
  const [proxyPort, setProxyPort] = useWorkspaceState("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":proxyPort", "");
  const [signatures, setSignatures] = useWorkspaceState<EmailSignature[]>("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":signatures", []);
  const [editingSigId, setEditingSigId] = useWorkspaceState<string | null>("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":editingSigId", null);
  const [editingSigName, setEditingSigName] = useWorkspaceState("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":editingSigName", "");
  const [editingSigContent, setEditingSigContent] = useWorkspaceState("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":editingSigContent", "");
  const [savingSig, setSavingSig] = useWorkspaceState("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":savingSig", false);
  const [imapFolderSettings, setImapFolderSettings] = useWorkspaceState<ImapSyncFolderSettings | null>("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":imapFolderSettings", null);
  const [selectedImapFolderIds, setSelectedImapFolderIds] = useWorkspaceState<Set<string>>("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":selectedImapFolderIds", new Set());
  const [folderLoading, setFolderLoading] = useWorkspaceState("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":folderLoading", false);
  const [folderError, setFolderError] = useWorkspaceState<string | null>("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":folderError", null);
  const [loading, setLoading] = useWorkspaceState("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":loading", false);
  const [error, setError] = useWorkspaceState<string | null>("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":error", null);
  const [detailsLoadError, setDetailsLoadError] = useWorkspaceState<string | null>("src/features/settings/AccountsTab.tsx:EditAccountModal:" + account.id + ":detailsLoadError", null);
  const isOAuth = account.provider === "gmail" || account.provider === "outlook";
  const isImap = account.provider === "imap";
  const isPop3 = account.provider === "pop3";
  const incomingHostLabel = isPop3
    ? t("accountSetup.pop3Host", "POP3 host")
    : t("accountSetup.imapHost", "IMAP host");
  const incomingPortLabel = isPop3
    ? t("accountSetup.pop3Port", "POP3 port")
    : t("accountSetup.imapPort", "IMAP port");

  useWorkspaceInitEffect("src/features/settings/AccountsTab.tsx:" + 'EditAccountModal:' + account.id + ':', () => {
    let cancelled = false;
    listEmailSignatures(account.id)
      .then((list) => {
        if (!cancelled) setSignatures(list);
      })
      .catch((err) => {
        console.warn("Failed to load signatures:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [account.id]);

  // Prefill every editable field from the persisted account config so the user
  // can see what is currently set. Password is intentionally left empty — the
  // user only needs to type a new one to change it.
  useEffect(() => {
    // A detached editor can inherit the fields before the request completes.
    // Fetch again only if it has not received the persisted settings yet.
    if (senderName !== null) return;
    let cancelled = false;
    setDetailsLoadError(null);
    getAccountDetails(account.id)
      .then((details) => {
        if (cancelled) return;
        setSenderName(details.senderName ?? account.display_name);
        setImapHost(details.imapHost);
        setImapPort(details.imapPort ? String(details.imapPort) : "");
        setImapUsername(details.imapUsername);
        setImapSecurity(details.imapSecurity || "");
        setIncomingException(details.imapAcceptInvalidCerts);
        setOutgoingException(details.smtpAcceptInvalidCerts);
        setSavedExceptions({ incoming: details.imapAcceptInvalidCerts, outgoing: details.smtpAcceptInvalidCerts });
        setSavedConnection(JSON.stringify([
          account.email, details.imapHost, String(details.imapPort || ""), details.imapSecurity || "", details.imapUsername,
          details.smtpHost, String(details.smtpPort || ""), details.smtpSecurity || "", details.smtpUsername,
          details.proxyHost, String(details.proxyPort || ""),
        ]));
        setSmtpHost(details.smtpHost);
        setSmtpPort(details.smtpPort ? String(details.smtpPort) : "");
        setSmtpUsername(details.smtpUsername);
        setSmtpSecurity(details.smtpSecurity || "");
        setPasswordConfigured(details.passwordConfigured);
        setProxyHost(details.proxyHost);
        setProxyPort(details.proxyPort ? String(details.proxyPort) : "");
        setOauthProxyMode((details.proxyMode as AccountProxyMode) || "inherit");
      })
      .catch((err) => {
        const message = extractErrorMessage(err);
        console.warn("Failed to load account details:", message);
        if (!cancelled) setDetailsLoadError(`读取当前账号设置失败：${message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [account.id, account.display_name, senderName]);

  useWorkspaceInitEffect("src/features/settings/AccountsTab.tsx:" + 'EditAccountModal:' + account.id + ':', () => {
    if (!isOAuth) return;
    let cancelled = false;
    getOAuthAccountProxySetting(account.id)
      .then((setting) => {
        if (cancelled) return;
        setOauthProxyMode(setting.mode);
        setProxyHost(setting.proxy?.host ?? "");
        setProxyPort(setting.proxy?.port ? String(setting.proxy.port) : "");
      })
      .catch((err) => {
        console.warn("Failed to load OAuth proxy:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [account.id, isOAuth]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    emailInputRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "Tab" && dialogRef.current) {
        const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
        )).filter(element => !element.matches(":disabled") && (!element.closest("details:not([open])") || element.matches("summary")));
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  async function loadImapFolders() {
    setFolderLoading(true);
    setFolderError(null);
    try {
      const settings = await getImapSyncFolders(account.id);
      setImapFolderSettings(settings);
      setSelectedImapFolderIds(new Set(settings.selected_remote_ids));
    } catch (err) {
      setFolderError(extractErrorMessage(err));
    } finally {
      setFolderLoading(false);
    }
  }

  const connectionMatchesSaved = !password && savedConnection === JSON.stringify([
    email, imapHost, imapPort, imapSecurity, imapUsername, smtpHost, smtpPort, smtpSecurity, smtpUsername, proxyHost, proxyPort,
  ]);
  const restoreIncoming = incomingException && Boolean(strictResult && (strictResult.ok || /收件：通过(?:\s|$)/.test(strictResult.message)));
  const restoreOutgoing = outgoingException && Boolean(strictResult && (strictResult.ok || /发件 SMTP：通过(?:\s|$)/.test(strictResult.message)));

  useEffect(() => {
    if (!connectionMatchesSaved) setStrictResult(null);
  }, [connectionMatchesSaved]);

  async function testStrictCertificates() {
    setStrictTesting(true);
    setStrictResult(null);
    try {
      const message = await testAccountConnection(account.id, true);
      setStrictResult({ ok: true, message });
    } catch (cause) {
      const preset = isImap ? findMailServerPreset(email, imapHost, smtpHost) : undefined;
      setStrictResult({ ok: false, message: explainMailConnectionReport(extractErrorMessage(cause), preset) });
    } finally {
      setStrictTesting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (senderName === null || strictTesting || loading) return;
    setLoading(true);
    setError(null);
    try {
      if (isOAuth) {
        await updateAccount(
          account.id,
          email,
          displayName,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          accountColor,
          undefined,
          undefined,
          senderName,
        );
        const trimmedProxyHost = proxyHost.trim();
        const trimmedProxyPort = proxyPort.trim();
        const hasCustomProxyDraft = !!trimmedProxyHost || !!trimmedProxyPort;
        const nextProxyMode: AccountProxyMode = hasCustomProxyDraft
          ? "custom"
          : oauthProxyMode === "disabled"
            ? "disabled"
            : "inherit";
        await updateOAuthAccountProxySetting(
          account.id,
          nextProxyMode,
          nextProxyMode === "custom" ? trimmedProxyHost || undefined : undefined,
          nextProxyMode === "custom" && trimmedProxyPort ? parseInt(trimmedProxyPort, 10) : undefined,
        );
      } else {
        await updateAccount(
          account.id,
          email,
          displayName,
          password || undefined,
          imapHost || undefined,
          imapPort ? parseInt(imapPort, 10) : undefined,
          smtpHost || undefined,
          smtpPort ? parseInt(smtpPort, 10) : undefined,
          imapSecurity || undefined,
          smtpSecurity || undefined,
          undefined,
          proxyHost.trim() || undefined,
          proxyPort ? parseInt(proxyPort, 10) : undefined,
          accountColor,
          imapUsername.trim() || undefined,
          smtpUsername.trim() || undefined,
          senderName,
          {
            incoming: incomingException !== savedExceptions.incoming ? incomingException : undefined,
            outgoing: outgoingException !== savedExceptions.outgoing ? outgoingException : undefined,
          },
        );
      }

      if (isImap && imapFolderSettings) {
        const updatedSettings = await updateImapSyncFolders(
          account.id,
          Array.from(selectedImapFolderIds),
        );
        setImapFolderSettings(updatedSettings);
        setSelectedImapFolderIds(new Set(updatedSettings.selected_remote_ids));
        try {
          await triggerSync(account.id, "manual");
        } catch (err) {
          console.warn("Failed to trigger sync after updating IMAP folders:", err);
        }
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["folders", account.id] }),
          queryClient.invalidateQueries({ queryKey: ["messages"] }),
          queryClient.invalidateQueries({ queryKey: ["threads"] }),
          queryClient.invalidateQueries({ queryKey: ["folder-unread-counts", account.id] }),
          queryClient.invalidateQueries({ queryKey: ["starred-messages", account.id] }),
        ]);
      }

      // 签名已改为多签名即时保存（见下方“邮件签名”区），这里不再处理。

      onSaved();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  const fieldStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
  };
  function handleImapSecurityChange(value: ConnectionSecurity | "") {
    setImapSecurity(value);
    setIncomingException(false);
    if (value) setImapPort(String(defaultIncomingPort(isPop3 ? "pop3" : "imap", value)));
  }
  function handleSmtpSecurityChange(value: ConnectionSecurity | "") {
    setSmtpSecurity(value);
    setOutgoingException(false);
    if (value) setSmtpPort(String(defaultSmtpPort(value)));
  }
  const signatureSmallButton = (background: string, color: string): React.CSSProperties => ({
    padding: "5px 12px",
    fontSize: "12px",
    border: "none",
    borderRadius: "6px",
    background,
    color,
    cursor: "pointer",
  });
  const colorInputValue = /^#[0-9a-fA-F]{6}$/.test(accountColor) ? accountColor : initialColor;
  const advancedToggle = (
    <button type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(!advancedOpen)}
      style={{ alignSelf: "flex-start", border: 0, padding: 0, background: "transparent", color: "var(--color-accent)", cursor: "pointer", fontSize: 13 }}>
      {t("accountSetup.advancedConnection", "Advanced connection settings")}
    </button>
  );
  const proxyFields = (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "12px" }}>
      <div style={fieldStyle}>
        <label style={labelStyle}>{t("accountSetup.proxyHost", "SOCKS5 Proxy")} <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>({t("settings.optional", "optional")})</span></label>
        <input aria-label={t("accountSetup.proxyHost", "SOCKS5 Proxy")} style={inputStyle} type="text" value={proxyHost} onChange={(e) => setProxyHost(e.target.value)} placeholder="127.0.0.1" />
      </div>
      <div style={fieldStyle}>
        <label style={labelStyle}>{t("accountSetup.proxyPort", "Port")}</label>
        <input aria-label={t("accountSetup.proxyPort", "Port")} style={{ ...inputStyle, width: "80px" }} type="number" value={proxyPort} onChange={(e) => setProxyPort(e.target.value)} placeholder="7890" />
      </div>
    </div>
  );

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-account-title"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          width: "480px",
          backgroundColor: "var(--color-bg)",
          borderRadius: "10px",
          boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
          display: "flex",
          flexDirection: "column",
          maxHeight: "90vh",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--color-border)",
          }}
        >
          <h2 id="edit-account-title" style={{ margin: 0, fontSize: "15px", fontWeight: 600, color: "var(--color-text-primary)" }}>
            {t("settings.editAccount", "Edit Account")}
          </h2>
          <button
            onClick={onClose}
            aria-label={t("common.close")}
            style={{ backgroundColor: "transparent", backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M18 6 6 18'/%3E%3Cpath d='m6 6 12 12'/%3E%3C/svg%3E\")", backgroundPosition: "center", backgroundRepeat: "no-repeat", backgroundSize: "18px 18px", border: "none", cursor: "pointer", padding: "4px", borderRadius: "4px", color: "var(--color-text-secondary)", display: "flex", fontSize: 0 }}
          >
            ×
          </button>
        </div>

        <div className="scroll-region edit-account-scroll" style={{ overflowY: "auto", padding: "20px" }}>
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={fieldStyle}>
              <label style={labelStyle}>{t("settings.accountNickname", "账号昵称（仅自己可见）")}</label>
              <input aria-label={t("settings.accountNickname", "账号昵称（仅自己可见）")} style={inputStyle} type="text" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle}>{t("settings.senderName", "对外发件人名称")}</label>
              {account.provider === "outlook" ? <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{t("settings.outlookSenderManaged", "由 Microsoft 账户资料决定")}</span> : <input aria-label={t("settings.senderName", "对外发件人名称")} disabled={senderName === null} style={inputStyle} value={senderName ?? ""} onChange={e => setSenderName(e.target.value)} />}
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle}>{t("accountSetup.emailAddress")}</label>
              <input aria-label={t("accountSetup.emailAddress")} ref={emailInputRef} style={inputStyle} type="email" required readOnly={isOAuth} value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div style={fieldStyle}>
              <label htmlFor="account-color" style={labelStyle}>{t("settings.accountColor", "Account color")}</label>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <input
                  id="account-color"
                  aria-label={t("settings.accountColor", "Account color")}
                  type="color"
                  value={colorInputValue}
                  onChange={(e) => setAccountColor(e.target.value)}
                  style={{
                    width: "38px",
                    height: "32px",
                    padding: "2px",
                    border: "1px solid var(--color-border)",
                    borderRadius: "6px",
                    backgroundColor: "var(--color-bg)",
                    cursor: "pointer",
                  }}
                />
                <input
                  aria-label={t("settings.accountColorHex", "Account color hex")}
                  style={{ ...inputStyle, width: "96px", fontFamily: "monospace" }}
                  value={accountColor}
                  onChange={(e) => {
                    const value = e.target.value;
                    setAccountColor(value.startsWith("#") ? value : `#${value}`);
                  }}
                  pattern="^#[0-9a-fA-F]{6}$"
                  maxLength={7}
                />
              </div>
              <div
                aria-label={t("settings.accountColorPresets", "Color presets")}
                role="group"
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "6px",
                  marginTop: "8px",
                }}
              >
                {ACCOUNT_COLOR_PRESETS.map((preset) => {
                  const presetLabel = `${t("settings.useAccountColorPreset", "Use color")} ${preset.color}`;
                  const selected = accountColor.toLowerCase() === preset.color;
                  return (
                    <button
                      key={preset.color}
                      type="button"
                      aria-label={presetLabel}
                      aria-pressed={selected}
                      title={presetLabel}
                      onClick={() => setAccountColor(preset.color)}
                      style={{
                        width: "22px",
                        height: "22px",
                        borderRadius: "50%",
                        border: selected ? "2px solid var(--color-text-primary)" : "1px solid var(--color-border)",
                        backgroundColor: preset.color,
                        cursor: "pointer",
                        padding: 0,
                        boxShadow: selected ? `0 0 0 2px ${preset.color}33` : "none",
                      }}
                    />
                  );
                })}
              </div>
            </div>
            {isOAuth ? (
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: "6px",
                  backgroundColor: "rgba(59,130,246,0.08)",
                  border: "1px solid rgba(59,130,246,0.25)",
                  color: "var(--color-text-secondary)",
                  fontSize: "12px",
                  lineHeight: 1.5,
                }}
              >
                {t(
                  "settings.oauthAccountNote",
                  "This account uses OAuth. Provider sign-in, password, and IMAP/SMTP settings are managed by the provider. Leave the proxy blank to inherit the global SOCKS5 proxy."
                )}
              </div>
            ) : (
              <>
                {detailsLoadError && (
                  <div role="alert" style={{ color: "#ef4444", fontSize: "12px", lineHeight: 1.5 }}>
                    {detailsLoadError}
                  </div>
                )}
                <div style={fieldStyle}>
                  <label style={labelStyle}>{t("accountSetup.password")} <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>({passwordConfigured ? "已保存；不会显示原文，留空保持不变" : "尚未保存"})</span></label>
                  <input aria-label={t("accountSetup.password")} style={inputStyle} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={passwordConfigured ? "已保存（如需更改请重新输入）" : "请输入密码或应用专用密码"} />
                </div>

                {(savedExceptions.incoming || savedExceptions.outgoing) && (
                  <div style={{ border: "1px solid var(--color-border)", borderRadius: 6, padding: 10, fontSize: 12, lineHeight: 1.5 }}>
                    <div>{savedExceptions.incoming && savedExceptions.outgoing
                      ? t("accountSetup.bothCertificateExceptions", "Certificate verification is disabled for incoming and outgoing mail.")
                      : savedExceptions.incoming
                        ? t("accountSetup.incomingCertificateExceptionActive", "Certificate verification is disabled for incoming mail.")
                        : t("accountSetup.outgoingCertificateExceptionActive", "Certificate verification is disabled for outgoing mail.")}</div>
                    <button type="button" onClick={() => void testStrictCertificates()} disabled={strictTesting || loading || !connectionMatchesSaved}
                      style={{ ...signatureSmallButton("var(--color-bg-secondary)", "var(--color-text-primary)"), marginTop: 6 }}>
                      {strictTesting ? t("accountSetup.testing", "Testing...") : t("accountSetup.testStrictCertificates", "Test with certificate verification")}
                    </button>
                    {!connectionMatchesSaved && (
                      <div style={{ color: "var(--color-text-secondary)" }}>
                        {t("accountSetup.saveBeforeStrictTest", "Save your connection changes before testing again.")}
                      </div>
                    )}
                    {strictResult && connectionMatchesSaved && <div role={strictResult.ok ? "status" : "alert"} style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                      {strictResult.message}
                    </div>}
                    {connectionMatchesSaved && (restoreIncoming || restoreOutgoing) && (
                      <button type="button" onClick={() => {
                        if (restoreIncoming) setIncomingException(false);
                        if (restoreOutgoing) setOutgoingException(false);
                      }}
                        style={{ ...signatureSmallButton("var(--color-accent)", "#fff"), marginTop: 6 }}>
                        {t("accountSetup.restoreCertificateVerification", "Restore certificate verification")}
                      </button>
                    )}
                    {((savedExceptions.incoming && !incomingException) || (savedExceptions.outgoing && !outgoingException)) && (
                      <div>{t("accountSetup.restoreCertificateVerificationOnSave", "Save to apply certificate verification.")}</div>
                    )}
                  </div>
                )}
                {advancedToggle}
                {advancedOpen && <>
                <div style={fieldStyle}>
                  <label style={labelStyle}>{incomingHostLabel} 登录用户名</label>
                  <input aria-label={`${incomingHostLabel} 登录用户名`} style={inputStyle} type="text" autoComplete="username" value={imapUsername} onChange={(e) => setImapUsername(e.target.value)} placeholder="默认使用邮箱地址" />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "12px" }}>
                  <div style={fieldStyle}>
                    <label style={labelStyle}>{incomingHostLabel} <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>({t("settings.optional", "optional")})</span></label>
                    <input aria-label={incomingHostLabel} style={inputStyle} type="text" value={imapHost} onChange={(e) => { setImapHost(e.target.value); if (e.target.value.trim()) setIncomingException(false); }} placeholder={t("settings.leaveEmptyKeep")} />
                  </div>
                  <div style={fieldStyle}>
                    <label style={labelStyle}>{incomingPortLabel}</label>
                    <input aria-label={incomingPortLabel} style={{ ...inputStyle, width: "70px" }} type="number" value={imapPort} onChange={(e) => { setImapPort(e.target.value); if (e.target.value) setIncomingException(false); }} />
                  </div>
                  <div style={fieldStyle}>
                    <label htmlFor="accountsetup-imap-security" style={labelStyle}>{t("accountSetup.security", "Security")}</label>
                    <select id="accountsetup-imap-security" value={imapSecurity} onChange={(e) => handleImapSecurityChange(e.target.value as ConnectionSecurity | "")} style={{ ...inputStyle, width: "110px" }}>
                      <option value="">{t("settings.leaveEmptyKeep", "keep current")}</option>
                      <option value="tls">{t("accountSetup.securityTls", "SSL/TLS")}</option>
                      <option value="starttls">{t("accountSetup.securityStarttls", "STARTTLS")}</option>
                      <option value="plain">{t("accountSetup.securityPlain", "None")}</option>
                    </select>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "12px" }}>
                  <div style={fieldStyle}>
                    <label style={labelStyle}>{t("accountSetup.smtpHost")} <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>({t("settings.optional", "optional")})</span></label>
                    <input aria-label={t("accountSetup.smtpHost")} style={inputStyle} type="text" value={smtpHost} onChange={(e) => { setSmtpHost(e.target.value); if (e.target.value.trim()) setOutgoingException(false); }} placeholder={t("settings.leaveEmptyKeep")} />
                  </div>
                  <div style={fieldStyle}>
                    <label style={labelStyle}>{t("accountSetup.smtpPort")}</label>
                    <input aria-label={t("accountSetup.smtpPort")} style={{ ...inputStyle, width: "70px" }} type="number" value={smtpPort} onChange={(e) => { setSmtpPort(e.target.value); if (e.target.value) setOutgoingException(false); }} />
                  </div>
                  <div style={fieldStyle}>
                    <label htmlFor="accountsetup-smtp-security" style={labelStyle}>{t("accountSetup.security", "Security")}</label>
                    <select id="accountsetup-smtp-security" value={smtpSecurity} onChange={(e) => handleSmtpSecurityChange(e.target.value as ConnectionSecurity | "")} style={{ ...inputStyle, width: "110px" }}>
                      <option value="">{t("settings.leaveEmptyKeep", "keep current")}</option>
                      <option value="tls">{t("accountSetup.securityTls", "SSL/TLS")}</option>
                      <option value="starttls">{t("accountSetup.securityStarttls", "STARTTLS")}</option>
                      <option value="plain">{t("accountSetup.securityPlain", "None")}</option>
                    </select>
                  </div>
                </div>

                <div style={fieldStyle}>
                  <label style={labelStyle}>{t("accountSetup.smtpHost")} 登录用户名</label>
                  <input aria-label={`${t("accountSetup.smtpHost")} 登录用户名`} style={inputStyle} type="text" autoComplete="username" value={smtpUsername} onChange={(e) => setSmtpUsername(e.target.value)} placeholder="默认使用邮箱地址" />
                </div>

                <details>
                  <summary style={{ cursor: "pointer", fontSize: 13 }}>{t("accountSetup.certificateExceptions", "Certificate exceptions")}</summary>
                  <p style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{t("accountSetup.certificateExceptionHelp", "Only enable an exception after your mail administrator verifies the server. The app will skip its identity check for that connection.")}</p>
                  <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
                    <input type="checkbox" checked={incomingException} disabled={imapSecurity === "plain"} onChange={event => setIncomingException(event.target.checked)} />
                    {" "}{t("accountSetup.allowIncomingCertificate", "Skip certificate verification for incoming mail")}
                  </label>
                  <label style={{ display: "block", fontSize: 13 }}>
                    <input type="checkbox" checked={outgoingException} disabled={smtpSecurity === "plain"} onChange={event => setOutgoingException(event.target.checked)} />
                    {" "}{t("accountSetup.allowOutgoingCertificate", "Skip certificate verification for outgoing mail")}
                  </label>
                </details>
                </>}
              </>
            )}

            {isOAuth && advancedToggle}
            {advancedOpen && proxyFields}

            {isImap && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                  padding: "12px",
                  border: "1px solid var(--color-border)",
                  borderRadius: "8px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
                  <div>
                    <div style={{ ...labelStyle, marginBottom: "3px" }}>
                      {t("settings.syncFolders", "Folders to sync")}
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.45 }}>
                      {t(
                        "settings.syncFoldersDesc",
                        "Inbox is always synced. Choose any additional IMAP folders to keep locally.",
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={loadImapFolders}
                    disabled={folderLoading || loading}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "7px 10px",
                      borderRadius: "6px",
                      border: "1px solid var(--color-border)",
                      backgroundColor: "var(--color-bg)",
                      color: "var(--color-text-primary)",
                      fontSize: "12px",
                      cursor: folderLoading || loading ? "wait" : "pointer",
                      opacity: folderLoading || loading ? 0.7 : 1,
                      flexShrink: 0,
                    }}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    {folderLoading
                      ? t("settings.loadingFolders", "Loading...")
                      : imapFolderSettings
                        ? t("settings.refreshFolders", "Refresh folders")
                        : t("settings.chooseFolders", "Choose folders")}
                  </button>
                </div>

                {folderError && (
                  <div role="alert" style={{ color: "#ef4444", fontSize: "12px" }}>
                    {t("settings.folderListFailed", "Failed to list IMAP folders: {{error}}", {
                      error: folderError,
                    })}
                  </div>
                )}

                {imapFolderSettings && (
                  <>
                    <div
                      role="group"
                      aria-label={t("settings.syncFolders", "Folders to sync")}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "7px",
                        maxHeight: "180px",
                        overflowY: "auto",
                        padding: "9px",
                        borderRadius: "6px",
                        backgroundColor: "var(--color-bg-secondary, var(--color-bg-hover))",
                      }}
                    >
                      {imapFolderSettings.folders.map((folder) => {
                        const isInboxFolder =
                          folder.role === "inbox" || folder.remote_id.toUpperCase() === "INBOX";
                        return (
                          <label
                            key={folder.remote_id}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                              color: "var(--color-text-primary)",
                              fontSize: "12px",
                              cursor: isInboxFolder ? "default" : "pointer",
                            }}
                          >
                            <input
                              type="checkbox"
                              aria-label={folder.name}
                              checked={isInboxFolder || selectedImapFolderIds.has(folder.remote_id)}
                              disabled={isInboxFolder}
                              onChange={(event) => {
                                setSelectedImapFolderIds((current) => {
                                  const next = new Set(current);
                                  if (event.target.checked) {
                                    next.add(folder.remote_id);
                                  } else {
                                    next.delete(folder.remote_id);
                                  }
                                  return next;
                                });
                              }}
                            />
                            <span>{folder.name}</span>
                            {isInboxFolder && (
                              <span style={{ color: "var(--color-text-secondary)", marginLeft: "auto" }}>
                                {t("settings.alwaysSynced", "Always synced")}
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                    <div style={{ color: "var(--color-text-secondary)", fontSize: "11px", lineHeight: 1.45 }}>
                      {t(
                        "settings.syncFoldersCleanupWarning",
                        "Saving removes locally stored data for folders you uncheck. It does not delete mail from the server.",
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Signature（多签名管理） */}
            <div style={fieldStyle}>
              <label style={labelStyle}>邮件签名 <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>（每个邮箱可设置多个；AI 写作默认使用“默认”签名）</span></label>
              {signatures.length === 0 && (
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8 }}>尚未设置签名，可在下方新增。</div>
              )}
              {signatures.map((sig) => {
                const isEditing = editingSigId === sig.id;
                const isCurrentDefault = sig.is_default;
                return (
                  <div key={sig.id} style={{ border: "1px solid var(--color-border)", borderRadius: 6, padding: 8, marginBottom: 8, background: "var(--color-bg-secondary)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                      <strong style={{ fontSize: 12 }}>{sig.name}</strong>
                      {isCurrentDefault && (
                        <span style={{ fontSize: 10, color: "#22c55e", border: "1px solid #22c55e", borderRadius: 8, padding: "0 6px" }}>默认</span>
                      )}
                    </div>
                    {isEditing ? (
                      <>
                        <input
                          style={{ ...inputStyle, marginBottom: 6 }}
                          value={editingSigName}
                          onChange={(e) => setEditingSigName(e.target.value)}
                          placeholder="签名名称（如：正式版 / 简洁版）"
                        />
                        <SignatureEditor value={editingSigContent} onChange={setEditingSigContent} />
                        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                          <button
                            type="button"
                            disabled={savingSig}
                            onClick={async () => {
                              setSavingSig(true);
                              try {
                                const next = await saveEmailSignature(account.id, sig.id, editingSigName, editingSigContent);
                                setSignatures(next);
                                setEditingSigId(null);
                                useToastStore.getState().addToast({ message: "签名已保存", type: "success" });
                              } catch (err) {
                                useToastStore.getState().addToast({ message: `保存签名失败：${extractErrorMessage(err)}`, type: "error" });
                              } finally {
                                setSavingSig(false);
                              }
                            }}
                            style={signatureSmallButton("var(--color-accent)", "#fff")}
                          >
                            保存
                          </button>
                          <button type="button" onClick={() => setEditingSigId(null)} style={signatureSmallButton("var(--color-bg-hover)", "var(--color-text-primary)")}>
                            取消
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", whiteSpace: "pre-wrap", maxHeight: 90, overflow: "auto", marginBottom: 6 }}>
                          {sig.content || "（空）"}
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            type="button"
                            onClick={() => { setEditingSigId(sig.id); setEditingSigName(sig.name); setEditingSigContent(sig.content); }}
                            style={signatureSmallButton("var(--color-bg-hover)", "var(--color-text-primary)")}
                          >
                            编辑
                          </button>
                          {!isCurrentDefault && (
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  const next = await setDefaultEmailSignature(account.id, sig.id);
                                  setSignatures(next);
                                  useToastStore.getState().addToast({ message: "已设为默认签名", type: "success" });
                                } catch (err) {
                                  useToastStore.getState().addToast({ message: `设置默认失败：${extractErrorMessage(err)}`, type: "error" });
                                }
                              }}
                              style={signatureSmallButton("var(--color-bg-hover)", "var(--color-text-primary)")}
                            >
                              设为默认
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const next = await deleteEmailSignature(account.id, sig.id);
                                setSignatures(next);
                                if (editingSigId === sig.id) setEditingSigId(null);
                              } catch (err) {
                                useToastStore.getState().addToast({ message: `删除签名失败：${extractErrorMessage(err)}`, type: "error" });
                              }
                            }}
                            style={signatureSmallButton("var(--color-bg-hover)", "#dc3545")}
                          >
                            删除
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
              {editingSigId === "__new__" ? (
                <div style={{ border: "1px dashed var(--color-accent)", borderRadius: 6, padding: 8, marginBottom: 8, background: "var(--color-bg-secondary)" }}>
                  <input
                    style={{ ...inputStyle, marginBottom: 6 }}
                    value={editingSigName}
                    onChange={(e) => setEditingSigName(e.target.value)}
                    placeholder="签名名称（如：正式版 / 简洁版）"
                  />
                  <SignatureEditor value={editingSigContent} onChange={setEditingSigContent} />
                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    <button
                      type="button"
                      disabled={savingSig}
                      onClick={async () => {
                        if (!editingSigName.trim()) {
                          useToastStore.getState().addToast({ message: "请填写签名名称", type: "error" });
                          return;
                        }
                        setSavingSig(true);
                        try {
                          const next = await saveEmailSignature(account.id, null, editingSigName, editingSigContent);
                          setSignatures(next);
                          setEditingSigId(null);
                          useToastStore.getState().addToast({ message: "签名已添加", type: "success" });
                        } catch (err) {
                          useToastStore.getState().addToast({ message: `添加签名失败：${extractErrorMessage(err)}`, type: "error" });
                        } finally {
                          setSavingSig(false);
                        }
                      }}
                      style={signatureSmallButton("var(--color-accent)", "#fff")}
                    >
                      保存
                    </button>
                    <button type="button" onClick={() => setEditingSigId(null)} style={signatureSmallButton("var(--color-bg-hover)", "var(--color-text-primary)")}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => { setEditingSigId("__new__"); setEditingSigName(""); setEditingSigContent(""); }}
                  style={signatureSmallButton("var(--color-bg-hover)", "var(--color-accent)")}
                >
                  + 新增签名
                </button>
              )}
            </div>

            {error && (
              <div role="alert" aria-live="assertive" style={{ padding: "10px 12px", borderRadius: "6px", backgroundColor: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#ef4444", fontSize: "13px" }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || folderLoading || senderName === null}
              style={{
                padding: "9px 16px",
                borderRadius: "6px",
                border: "none",
                backgroundColor: "var(--color-accent)",
                color: "#fff",
                fontSize: "13px",
                fontWeight: 600,
                cursor: loading || folderLoading ? "not-allowed" : "pointer",
                opacity: loading || folderLoading ? 0.7 : 1,
                marginTop: "4px",
              }}
            >
              {loading ? t("common.saving") : t("common.save")}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
