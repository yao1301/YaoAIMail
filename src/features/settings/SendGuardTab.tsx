import { useWorkspaceState, useWorkspaceInitEffect } from '@/lib/workspaceState';
import { getSendGuardConfig, setSendGuardConfig, type GuardMode, type SendGuardConfig } from "@/lib/api";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { useUIStore } from "@/stores/ui.store";
import { SettingsFeedback, type SettingsNotice } from "./SettingsFeedback";

export default function SendGuardTab() {
  const [config, setConfig] = useWorkspaceState<SendGuardConfig>("src/features/settings/SendGuardTab.tsx:SendGuardTab:config", { enabled: false, mode: "soft" });
  const [saving, setSaving] = useWorkspaceState("src/features/settings/SendGuardTab.tsx:SendGuardTab:saving", false);
  const [feedback, setFeedback] = useWorkspaceState<(SettingsNotice & { field: "enabled" | "mode" }) | null>("src/features/settings/SendGuardTab.tsx:SendGuardTab:feedback", null);

  useWorkspaceInitEffect("src/features/settings/SendGuardTab.tsx:", () => {
    void getSendGuardConfig().then(setConfig).catch(() => {});
  }, []);

  async function persist(next: SendGuardConfig, field: "enabled" | "mode") {
    setSaving(true);
    setFeedback(null);
    try {
      setConfig(await setSendGuardConfig(next));
    } catch (error) {
      setFeedback({
        message: `保存发送防呆设置失败：${extractErrorMessage(error)}`,
        kind: "error",
        field,
      });
    } finally {
      setSaving(false);
    }
  }

  function setMode(mode: GuardMode) {
    void persist({ ...config, mode }, "mode");
  }

  const buttonStyle: React.CSSProperties = {
    padding: "8px 16px", border: "none", borderRadius: "6px", cursor: "pointer", font: "inherit",
  };

  return (
    <div>
      <h2 style={{ fontSize: "18px", margin: "0 0 8px" }}>发送防呆</h2>
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "0 0 22px" }}>
        发信前检查“把客户邮件误发给工厂、把工厂邮件误发给客户”等高风险错误。
      </p>

      <section style={{ paddingBottom: "20px", borderBottom: "1px solid var(--color-border)", marginBottom: "22px" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "10px", fontWeight: 600 }}>
          <input
            type="checkbox"
            checked={config.enabled}
            disabled={saving}
            onChange={() => void persist({ ...config, enabled: !config.enabled }, "enabled")}
          />
          启用发送防呆
        </label>
        <SettingsFeedback notice={feedback?.field === "enabled" ? feedback : null} />
        <p style={{ margin: "6px 0 0 24px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          联系人类型不在这里重复维护，统一读取地址本中的角色标签。
        </p>
      </section>

      <section style={{ paddingBottom: "20px", borderBottom: "1px solid var(--color-border)", marginBottom: "22px" }}>
        <h3 style={{ fontSize: "14px", margin: "0 0 10px" }}>提醒强度</h3>
        <div style={{ display: "flex", gap: "8px" }}>
          <button type="button" disabled={saving} onClick={() => setMode("soft")} style={{ ...buttonStyle, background: config.mode === "soft" ? "var(--color-accent)" : "var(--color-bg-hover)", color: config.mode === "soft" ? "#fff" : "var(--color-text-primary)" }}>
            温和提醒
          </button>
          <button type="button" disabled={saving} onClick={() => setMode("strict")} style={{ ...buttonStyle, background: config.mode === "strict" ? "var(--color-accent)" : "var(--color-bg-hover)", color: config.mode === "strict" ? "#fff" : "var(--color-text-primary)" }}>
            严格检查
          </button>
        </div>
        <SettingsFeedback notice={feedback?.field === "mode" ? feedback : null} />
      </section>

      <section>
        <h3 style={{ fontSize: "14px", margin: "0 0 8px" }}>联系人角色管理</h3>
        <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 10px" }}>
          客户、工厂/供应商、物流/服务商和内部同事等标签已经移动到地址本，避免两处数据不一致。
        </p>
        <button
          type="button"
          onClick={() => useUIStore.getState().setActiveView("addressBook")}
          style={{ ...buttonStyle, background: "var(--color-accent)", color: "#fff" }}
        >
          打开地址本
        </button>
      </section>
    </div>
  );
}
