import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  showTestNotification,
  openDefaultMailSettings,
  getAutostartEnabled,
  setAutostartEnabled,
  getProfileLocation,
  chooseProfileFolder,
  scheduleProfileMigration,
  type ProfileLocationInfo,
} from "@/lib/api";
import { useToastStore } from "@/stores/toast.store";
import { useUIStore, type RealtimePreference } from "@/stores/ui.store";
import {
  readUndoSendDelay,
  UNDO_SEND_DELAY_OPTIONS,
  writeUndoSendDelay,
  type UndoSendDelaySeconds,
} from "@/features/compose/undoSend";
import MailImportSection from "./MailImportSection";

const REALTIME_OPTIONS: Array<{
  mode: RealtimePreference;
  labelKey: string;
  fallback: string;
  descriptionKey: string;
  descriptionFallback: string;
}> = [
  {
    mode: "realtime",
    labelKey: "settings.realtimeModeRealtime",
    fallback: "Realtime (recommended)",
    descriptionKey: "settings.realtimeModeRealtimeDesc",
    descriptionFallback: "IMAP uses IDLE push when supported. Other providers check about every 3 seconds while you are active.",
  },
  {
    mode: "balanced",
    labelKey: "settings.realtimeModeBalanced",
    fallback: "Balanced",
    descriptionKey: "settings.realtimeModeBalancedDesc",
    descriptionFallback: "Checks about every 15 seconds while you are active.",
  },
  {
    mode: "battery",
    labelKey: "settings.realtimeModeBattery",
    fallback: "Battery saver",
    descriptionKey: "settings.realtimeModeBatteryDesc",
    descriptionFallback: "Checks about every 60 seconds while you are active and slows down in the background.",
  },
  {
    mode: "manual",
    labelKey: "settings.realtimeModeManual",
    fallback: "Manual only",
    descriptionKey: "settings.realtimeModeManualDesc",
    descriptionFallback: "Stops background checks. Use Sync now to run a single pass.",
  },
];

export default function GeneralTab() {
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const [testingNotification, setTestingNotification] = useState(false);
  const [profileLocation, setProfileLocation] = useState<ProfileLocationInfo | null>(null);
  const [schedulingMigration, setSchedulingMigration] = useState(false);
  const [undoSendDelay, setUndoSendDelay] = useState<UndoSendDelaySeconds>(() => readUndoSendDelay());
  const realtimeMode = useUIStore((s) => s.realtimeMode);
  const setRealtimeMode = useUIStore((s) => s.setRealtimeMode);
  const notificationsEnabled = useUIStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useUIStore((s) => s.setNotificationsEnabled);
  const keepRunningInBackground = useUIStore((s) => s.keepRunningInBackground);
  const setKeepRunningInBackground = useUIStore((s) => s.setKeepRunningInBackground);
  const startHiddenToTray = useUIStore((s) => s.startHiddenToTray);
  const setStartHiddenToTray = useUIStore((s) => s.setStartHiddenToTray);

  const toggleNotifications = useCallback(() => {
    setNotificationsEnabled(!notificationsEnabled);
  }, [notificationsEnabled, setNotificationsEnabled]);

  const handleTestNotification = useCallback(async () => {
    setTestingNotification(true);
    try {
      await showTestNotification();
      addToast({
        message: t("settings.testNotificationSent", "Test notification sent"),
        type: "success",
      });
    } catch {
      addToast({
        message: t("settings.testNotificationFailed", "Failed to send test notification"),
        type: "error",
      });
    } finally {
      setTestingNotification(false);
    }
  }, [addToast, t]);

  const quitOnClose = !keepRunningInBackground;
  const toggleQuitOnClose = useCallback(() => {
    setKeepRunningInBackground(quitOnClose);
  }, [quitOnClose, setKeepRunningInBackground]);

  const toggleStartHiddenToTray = useCallback(() => {
    setStartHiddenToTray(!startHiddenToTray);
  }, [setStartHiddenToTray, startHiddenToTray]);

  // Launch-at-startup state lives in the OS (registry / LaunchAgent / .desktop),
  // not in app storage, so read the real value from the backend on mount.
  const [launchAtStartup, setLaunchAtStartup] = useState(false);

  useEffect(() => {
    let active = true;
    getAutostartEnabled()
      .then((enabled) => {
        if (active) setLaunchAtStartup(enabled);
      })
      .catch((err) => {
        console.warn("Failed to read launch-at-startup state", err);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (typeof getProfileLocation === "function") {
      getProfileLocation()
        .then(setProfileLocation)
        .catch((err) => console.warn("Failed to read profile location", err));
    }
  }, []);

  const handleChooseProfileLocation = useCallback(async () => {
    setSchedulingMigration(true);
    try {
      const destination = await chooseProfileFolder();
      if (!destination) return;
      await scheduleProfileMigration(destination);
      addToast({
        message: `已选择 ${destination}。请完全退出软件后重新打开，数据会自动迁移并切换到新位置。`,
        type: "success",
        duration: 12_000,
      });
    } catch (err) {
      addToast({
        message: `无法更改数据位置：${err instanceof Error ? err.message : String(err)}`,
        type: "error",
        duration: 10_000,
      });
    } finally {
      setSchedulingMigration(false);
    }
  }, [addToast]);

  const toggleLaunchAtStartup = useCallback(async () => {
    const next = !launchAtStartup;
    setLaunchAtStartup(next); // optimistic; revert below if the OS rejects it
    try {
      await setAutostartEnabled(next);
    } catch {
      setLaunchAtStartup(!next);
      addToast({
        message: t("settings.autostartFailed", "Failed to update launch at startup"),
        type: "error",
      });
    }
  }, [launchAtStartup, addToast, t]);

  const showUnreadCount = useUIStore((s) => s.showFolderUnreadCount);
  const setShowUnreadCount = useUIStore((s) => s.setShowFolderUnreadCount);

  const toggleUnreadCount = useCallback(() => {
    setShowUnreadCount(!showUnreadCount);
  }, [showUnreadCount, setShowUnreadCount]);

  return (
    <div>
      <h3 style={{ fontSize: "14px", fontWeight: 600, marginBottom: "8px" }}>
        用户数据存放位置
      </h3>
      <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 8px" }}>
        邮件、附件、搜索索引、账号配置和 AI 风格档案都保存在这里。建议放到非系统盘并定期备份。
      </p>
      <div style={{ padding: "10px 12px", border: "1px solid var(--color-border)", borderRadius: "6px", background: "var(--color-bg-secondary)", fontSize: "12px", wordBreak: "break-all", marginBottom: "10px" }}>
        当前：{profileLocation?.currentPath ?? "正在读取…"}
        {profileLocation?.isCustom ? "（自定义位置）" : "（系统默认位置）"}
      </div>
      <button
        type="button"
        disabled={schedulingMigration}
        onClick={handleChooseProfileLocation}
        style={{ padding: "8px 14px", border: "none", borderRadius: "6px", background: "var(--color-accent)", color: "#fff", cursor: "pointer", opacity: schedulingMigration ? 0.6 : 1 }}
      >
        {schedulingMigration ? "正在准备…" : "修改保存位置…"}
      </button>
      <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "8px 0 28px" }}>
        为防止数据库损坏，实际复制会在下次启动、数据库尚未打开时进行。目标必须是空文件夹；旧数据不会自动删除，可确认新位置正常后自行备份或删除。
      </p>

      <MailImportSection />

      <h3 style={{ fontSize: "14px", fontWeight: 600, marginBottom: "8px" }}>
        默认同步频率（未单独设置账号时）
      </h3>
      <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "12px", marginTop: 0 }}>
        这里是所有邮箱账号的默认值。若在“设置 → 邮箱账户”中单独设置了某个账号，则该账号优先使用自己的同步频率。
      </p>
      <div
        role="group"
        aria-label={t("settings.realtimeMode", "Realtime Mode")}
        style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}
      >
        {REALTIME_OPTIONS.map((option) => {
          const selected = realtimeMode === option.mode;
          const label = t(option.labelKey, option.fallback);
          return (
            <button
              key={option.mode}
              type="button"
              aria-label={label}
              aria-pressed={selected}
              onClick={() => setRealtimeMode(option.mode)}
              style={{
                flex: "1 1 180px",
                minWidth: 0,
                padding: "8px 10px",
                borderRadius: "6px",
                border: selected ? "2px solid var(--color-accent)" : "1px solid var(--color-border)",
                backgroundColor: selected ? "var(--color-bg-hover)" : "transparent",
                cursor: "pointer",
                textAlign: "left",
                color: "var(--color-text-primary)",
              }}
            >
              <span style={{ display: "block", fontSize: "13px", fontWeight: selected ? 600 : 500, lineHeight: 1.3 }}>
                {label}
              </span>
              <span style={{ display: "block", marginTop: "4px", fontSize: "12px", lineHeight: 1.35, color: "var(--color-text-secondary)" }}>
                {t(option.descriptionKey, option.descriptionFallback)}
              </span>
            </button>
          );
        })}
      </div>

      <h3 style={{ fontSize: "14px", fontWeight: 600, marginBottom: "16px", marginTop: "32px" }}>
        {t("settings.notifications")}
      </h3>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          cursor: "pointer",
          fontSize: "13px",
          color: "var(--color-text-primary)",
        }}
      >
        <input type="checkbox" checked={notificationsEnabled} onChange={toggleNotifications} />
        <span>{t("settings.enableNotifications")}</span>
      </label>
      <button
        type="button"
        aria-label={t("settings.testNotification", "Send test notification")}
        onClick={handleTestNotification}
        disabled={!notificationsEnabled || testingNotification}
        style={{
          marginTop: "12px",
          padding: "8px 12px",
          borderRadius: "6px",
          border: "1px solid var(--color-border)",
          backgroundColor: notificationsEnabled ? "var(--color-bg)" : "var(--color-bg-hover)",
          color: notificationsEnabled ? "var(--color-text-primary)" : "var(--color-text-secondary)",
          cursor: notificationsEnabled && !testingNotification ? "pointer" : "not-allowed",
          fontSize: "13px",
        }}
      >
        {testingNotification
          ? t("settings.testNotificationSending", "Sending test notification...")
          : t("settings.testNotification", "Send test notification")}
      </button>

      <h3 style={{ fontSize: "14px", fontWeight: 600, marginBottom: "16px", marginTop: "32px" }}>
        {t("settings.startupBehavior", "Startup Behavior")}
      </h3>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          cursor: "pointer",
          fontSize: "13px",
          color: "var(--color-text-primary)",
          marginBottom: "10px",
        }}
      >
        <input
          type="checkbox"
          checked={launchAtStartup}
          onChange={toggleLaunchAtStartup}
        />
        <span>{t("settings.launchAtStartup", "Launch Pebble at system startup")}</span>
      </label>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          cursor: "pointer",
          fontSize: "13px",
          color: "var(--color-text-primary)",
        }}
      >
        <input
          type="checkbox"
          checked={startHiddenToTray}
          onChange={toggleStartHiddenToTray}
        />
        <span>{t("settings.startHiddenToTray", "Start hidden to tray")}</span>
      </label>

      <h3 style={{ fontSize: "14px", fontWeight: 600, marginBottom: "16px", marginTop: "32px" }}>
        {t("settings.closeBehavior", "Close Behavior")}
      </h3>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          cursor: "pointer",
          fontSize: "13px",
          color: "var(--color-text-primary)",
        }}
      >
        <input
          type="checkbox"
          checked={quitOnClose}
          onChange={toggleQuitOnClose}
        />
        <span>{t("settings.quitOnClose", "Quit app when window is closed")}</span>
      </label>

      <h3 style={{ fontSize: "14px", fontWeight: 600, marginBottom: "16px", marginTop: "32px" }}>
        发送前撤销
      </h3>
      <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 10px" }}>
        点击发送后先在本机倒计时，期间可取消并继续编辑。倒计时结束、提交到邮箱服务器后便无法保证撤回。
      </p>
      <div role="group" aria-label="发送前撤销时间" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        {UNDO_SEND_DELAY_OPTIONS.map((seconds) => {
          const selected = undoSendDelay === seconds;
          return (
            <button
              key={seconds}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setUndoSendDelay(seconds);
                writeUndoSendDelay(seconds);
              }}
              style={{
                padding: "7px 13px",
                borderRadius: "6px",
                border: selected ? "2px solid var(--color-accent)" : "1px solid var(--color-border)",
                background: selected ? "var(--color-bg-hover)" : "var(--color-bg)",
                color: "var(--color-text-primary)",
                cursor: "pointer",
                fontWeight: selected ? 600 : 400,
              }}
            >
              {seconds === 0 ? "关闭" : `${seconds} 秒`}
            </button>
          );
        })}
      </div>

      <h3 style={{ fontSize: "14px", fontWeight: 600, marginBottom: "16px", marginTop: "32px" }}>
        {t("settings.folderCounts", "Folder Counts")}
      </h3>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          cursor: "pointer",
          fontSize: "13px",
          color: "var(--color-text-primary)",
        }}
      >
        <input
          type="checkbox"
          checked={showUnreadCount}
          onChange={toggleUnreadCount}
        />
        <span>{t("settings.showUnreadCount", "Show unread count badges in sidebar")}</span>
      </label>

      {navigator.userAgent.includes("Windows") && (
        <>
          <h3 style={{ fontSize: "14px", fontWeight: 600, marginBottom: "16px", marginTop: "32px" }}>
            {t("settings.defaultMailClient", "Default Email Client")}
          </h3>
          <button
            type="button"
            onClick={() => openDefaultMailSettings()}
            style={{
              padding: "8px 18px",
              fontSize: "13px",
              fontWeight: 500,
              border: "1px solid var(--color-border)",
              borderRadius: "6px",
              cursor: "pointer",
              background: "var(--color-bg-secondary)",
              color: "var(--color-text-primary)",
            }}
          >
            {t("settings.setDefaultMailClient", "Set Pebble as default email app")}
          </button>
          <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "6px" }}>
            {t("settings.setDefaultMailClientHint", "Opens Windows Default Apps settings where you can select Pebble for email.")}
          </p>
        </>
      )}
    </div>
  );
}
