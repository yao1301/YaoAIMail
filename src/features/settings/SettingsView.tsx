import { useTranslation } from "react-i18next";
import { useUIStore, type SettingsTab } from "@/stores/ui.store";
import AccountsTab from "./AccountsTab";
import GeneralTab from "./GeneralTab";
import ProxyTab from "./ProxyTab";
import AppearanceTab from "./AppearanceTab";
import CloudSyncTab from "./CloudSyncTab";
import RulesTab from "./RulesTab";
import PendingOpsTab from "./PendingOpsTab";
import ShortcutsTab from "./ShortcutsTab";
import TranslateTab from "./TranslateTab";
import AiWritingTab from "./AiWritingTab";
import KnowledgeBaseTab from "./KnowledgeBaseTab";
import SendGuardTab from "./SendGuardTab";
import ExternalServicesTab from "./ExternalServicesTab";
import PrivacyTab from "./PrivacyTab";
import AboutTab from "./AboutTab";
import WorkRoleTab from "./WorkRoleTab";

const TAB_IDS = ["accounts", "general", "proxy", "appearance", "privacy", "rules", "remoteWrites", "translation", "aiWriting", "workRole", "knowledgeBase", "externalServices", "sendGuard", "shortcuts", "cloudSync", "about"] as const;

const TAB_LABEL_KEYS: Record<string, string> = {
  accounts: "settings.accounts",
  general: "settings.general",
  proxy: "settings.proxy",
  appearance: "settings.appearance",
  privacy: "settings.privacy",
  rules: "settings.rules",
  remoteWrites: "settings.remoteWrites",
  translation: "settings.translation",
  aiWriting: "settings.aiWriting",
  workRole: "settings.workRole",
  knowledgeBase: "settings.knowledgeBase",
  externalServices: "settings.externalServices",
  sendGuard: "settings.sendGuard",
  shortcuts: "settings.shortcuts",
  cloudSync: "settings.cloudSync",
  about: "settings.about",
};

// Explain only ambiguous destinations; keep the page's existing field help.
const TAB_HELP: Partial<Record<SettingsTab, string>> = {
  translation: "配置翻译和 AI 功能使用的模型、接口及密钥。写作风格在“AI 写作”设置中调整。",
  aiWriting: "管理写作风格模板和学习设置。要生成邮件，请使用写信窗口或右侧的 AI 写作面板。",
  workRole: "设置你的工作身份和业务范围，供 AI 理解指令。这些资料不是客户画像。",
  knowledgeBase: "管理供 AI 参考的产品和业务资料。加入资料库不会自动把文件附到邮件中。",
  externalServices: "配置联网搜索、网页读取和邮箱验证服务。DeepSeek 付费搜索需另外勾选开启。",
  remoteWrites: "查看邮件操作和发送任务的处理状态，并处理暂停或失败的任务。",
};

export default function SettingsView() {
  const { t } = useTranslation();
  const activeTab = useUIStore((s) => s.settingsTab);
  const setSettingsTab = useUIStore((s) => s.setSettingsTab);

  function handleTabChange(id: SettingsTab) {
    setSettingsTab(id);
  }

  return (
    <div style={{ display: "flex", height: "100%" }}>
      {/* Tab sidebar */}
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label={t("settings.tabs", "Settings tabs")}
        style={{
          width: "180px",
          borderRight: "1px solid var(--color-border)",
          padding: "16px 0",
          flexShrink: 0,
        }}
      >
        {TAB_IDS.map((id, index) => (
          <button
            key={id}
            id={`settings-tab-${id}`}
            role="tab"
            aria-selected={activeTab === id}
            aria-controls={`settings-tabpanel-${id}`}
            title={TAB_HELP[id]}
            tabIndex={activeTab === id ? 0 : -1}
            onClick={() => handleTabChange(id)}
            onKeyDown={(e) => {
              let nextIndex = index;
              if (e.key === "ArrowDown") { nextIndex = (index + 1) % TAB_IDS.length; }
              else if (e.key === "ArrowUp") { nextIndex = (index - 1 + TAB_IDS.length) % TAB_IDS.length; }
              else if (e.key === "Home") { nextIndex = 0; }
              else if (e.key === "End") { nextIndex = TAB_IDS.length - 1; }
              else { return; }
              e.preventDefault();
              handleTabChange(TAB_IDS[nextIndex]);
              document.getElementById(`settings-tab-${TAB_IDS[nextIndex]}`)?.focus();
            }}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "8px 20px",
              border: "none",
              background: activeTab === id ? "var(--color-bg-hover)" : "none",
              color: activeTab === id ? "var(--color-text-primary)" : "var(--color-text-secondary)",
              fontWeight: activeTab === id ? 600 : 400,
              fontSize: "13px",
              cursor: "pointer",
              borderRight: activeTab === id ? "2px solid var(--color-accent)" : "2px solid transparent",
              transition: "background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease",
            }}
          >
            {id === "knowledgeBase" ? "产品与资料中心" : id === "externalServices" ? "外部数据源 API" : t(TAB_LABEL_KEYS[id])}
          </button>
        ))}
      </div>
      {/* Tab content */}
      <div
        id={`settings-tabpanel-${activeTab}`}
        className="scroll-region settings-panel-scroll"
        role="tabpanel"
        aria-labelledby={`settings-tab-${activeTab}`}
        style={{
          flex: 1,
          minWidth: 0,
          padding: "32px",
          maxWidth: activeTab === "remoteWrites" ? "980px" : "640px",
          boxSizing: "border-box",
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        {activeTab === "accounts" && <AccountsTab />}
        {activeTab === "general" && <GeneralTab />}
        {activeTab === "proxy" && <ProxyTab />}
        {activeTab === "appearance" && <AppearanceTab />}
        {activeTab === "rules" && <RulesTab />}
        {activeTab === "remoteWrites" && <PendingOpsTab />}
        {activeTab === "translation" && <TranslateTab />}
        {activeTab === "aiWriting" && <AiWritingTab />}
        {activeTab === "workRole" && <WorkRoleTab />}
        {activeTab === "knowledgeBase" && <KnowledgeBaseTab />}
        {activeTab === "externalServices" && <ExternalServicesTab />}
        {activeTab === "sendGuard" && <SendGuardTab />}
        {activeTab === "shortcuts" && <ShortcutsTab />}
        {activeTab === "privacy" && <PrivacyTab />}
        {activeTab === "cloudSync" && <CloudSyncTab />}
        {activeTab === "about" && <AboutTab />}
      </div>
    </div>
  );
}
