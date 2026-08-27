import { useCallback, useEffect, useState } from "react";
import { Inbox, FolderOpen, Sparkles, Check, ChevronLeft, ChevronRight, X, ExternalLink, Copy, FolderSearch } from "lucide-react";
import { useAccountsQuery } from "@/hooks/queries";
import { useUIStore } from "@/stores/ui.store";
import { useToastStore } from "@/stores/toast.store";
import { openDataDir, getDataDir } from "@/lib/api";

const ONBOARDING_KEY = "pebble-onboarding-v2";

type StepId = "email" | "storage" | "api" | "done";

const STEPS: { id: StepId; icon: React.ReactNode; title: string }[] = [
  { id: "email", icon: <Inbox size={26} />, title: "设置邮箱账号" },
  { id: "storage", icon: <FolderOpen size={26} />, title: "数据保存位置" },
  { id: "api", icon: <Sparkles size={26} />, title: "AI 模型 API Key" },
  { id: "done", icon: <Check size={26} />, title: "准备就绪" },
];

export default function OnboardingOverlay() {
  const [visible, setVisible] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const { data: accounts = [] } = useAccountsQuery();
  const setActiveView = useUIStore((s) => s.setActiveView);
  const addToast = useToastStore((s) => s.addToast);

  useEffect(() => {
    try {
      if (!localStorage.getItem(ONBOARDING_KEY)) {
        setVisible(true);
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  const finish = useCallback(() => {
    try {
      localStorage.setItem(ONBOARDING_KEY, "done");
    } catch {
      // ignore
    }
    setVisible(false);
  }, []);

  const skipAll = useCallback(() => {
    finish();
  }, [finish]);

  const goPrev = useCallback(() => {
    setStepIdx((v) => Math.max(0, v - 1));
  }, []);

  const goNext = useCallback(() => {
    setStepIdx((v) => Math.min(STEPS.length - 1, v + 1));
  }, []);

  const openSettingsTab = useCallback(
    (tab: "accounts" | "translation") => {
      finish();
      setActiveView("settings");
      requestAnimationFrame(() => {
        useUIStore.getState().setSettingsTab(tab);
        window.dispatchEvent(new CustomEvent(`pebble:focus-${tab}`));
      });
    },
    [finish, setActiveView],
  );

  const handleAddAccount = useCallback(() => {
    openSettingsTab("accounts");
  }, [openSettingsTab]);

  const handleSetupAi = useCallback(() => {
    openSettingsTab("translation");
    addToast({
      message: "在「翻译 → 服务商 → AI 模型」里添加 Provider 并填入 API Key",
      type: "info",
    });
  }, [openSettingsTab, addToast]);

  const currentStep = STEPS[stepIdx];
  const isFirst = stepIdx === 0;
  const isLast = stepIdx === STEPS.length - 1;
  const accountCount = accounts.length;

  const [dataDirPath, setDataDirPath] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const path = await getDataDir();
        if (!cancelled) setDataDirPath(path);
      } catch {
        // ignore — fallback text shown
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(10,14,20,0.55)",
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        style={{
          width: "min(520px, 92vw)",
          maxHeight: "88vh",
          overflow: "auto",
          borderRadius: 14,
          background: "var(--color-bg-primary, #fff)",
          color: "var(--color-text-primary, #222)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
          padding: "24px 26px 18px",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 46,
                height: 46,
                borderRadius: 11,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                background: "linear-gradient(135deg, #2563eb, #7c3aed)",
              }}
            >
              {currentStep.icon}
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 2 }}>
                首次使用 YaoAIMail · 第 {stepIdx + 1} / {STEPS.length} 步
              </div>
              <h2 style={{ margin: 0, fontSize: 17 }}>{currentStep.title}</h2>
            </div>
          </div>
          <button
            type="button"
            onClick={skipAll}
            title="跳过引导（之后可在设置中再次查看）"
            style={{
              padding: 6,
              border: 0,
              background: "transparent",
              color: "var(--color-text-secondary)",
              cursor: "pointer",
              borderRadius: 6,
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Step body */}
        <div style={{ minHeight: 200, marginBottom: 14 }}>
          {currentStep.id === "email" && (
            <EmailStep accountCount={accountCount} onAdd={handleAddAccount} />
          )}
          {currentStep.id === "storage" && (
            <StorageStep path={dataDirPath} />
          )}
          {currentStep.id === "api" && (
            <ApiKeyStep onSetup={handleSetupAi} />
          )}
          {currentStep.id === "done" && (
            <DoneStep accountCount={accountCount} />
          )}
        </div>

        {/* Progress dots */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "0 0 14px", justifyContent: "center" }}>
          {STEPS.map((_, i) => (
            <span
              key={i}
              style={{
                width: i === stepIdx ? 20 : 8,
                height: 8,
                borderRadius: 4,
                background:
                  i === stepIdx
                    ? "var(--color-accent, #2563eb)"
                    : i < stepIdx
                      ? "var(--color-accent, #2563eb)"
                      : "var(--color-border, #ccc)",
                opacity: i < stepIdx ? 0.5 : 1,
                transition: "all .2s",
              }}
            />
          ))}
        </div>

        {/* Footer buttons */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
          <button
            type="button"
            onClick={goPrev}
            disabled={isFirst}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "8px 12px",
              borderRadius: 7,
              border: "1px solid var(--color-border, #ccc)",
              background: "transparent",
              color: "var(--color-text-primary)",
              cursor: isFirst ? "not-allowed" : "pointer",
              opacity: isFirst ? 0.4 : 1,
              fontSize: 13,
            }}
          >
            <ChevronLeft size={14} /> 上一步
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={skipAll}
              style={{
                padding: "8px 14px",
                borderRadius: 7,
                border: "1px solid var(--color-border, #ccc)",
                background: "transparent",
                color: "var(--color-text-secondary)",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              跳过引导
            </button>
            {isLast ? (
              <button
                type="button"
                onClick={finish}
                style={{
                  padding: "8px 22px",
                  borderRadius: 7,
                  border: 0,
                  background: "var(--color-accent, #2563eb)",
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                开始使用
              </button>
            ) : (
              <button
                type="button"
                onClick={goNext}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "8px 18px",
                  borderRadius: 7,
                  border: 0,
                  background: "var(--color-accent, #2563eb)",
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                下一步 <ChevronRight size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmailStep({ accountCount, onAdd }: { accountCount: number; onAdd: () => void }) {
  const ready = accountCount > 0;
  return (
    <div>
      <p style={{ margin: "0 0 14px", fontSize: 13, lineHeight: 1.7, color: "var(--color-text-secondary)" }}>
        {ready
          ? `已配置 ${accountCount} 个邮箱账号。可以继续下一步，或返回添加更多账号。`
          : "添加至少一个邮箱账号后即可开始收发邮件。支持 IMAP / SMTP（如 QQ 邮箱、阿里云邮箱、Outlook、Gmail 等）。"}
      </p>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 16px",
          borderRadius: 9,
          border: `1px solid ${ready ? "var(--color-accent, #2563eb)" : "var(--color-border, #ccc)"}`,
          background: ready ? "rgba(37,99,235,0.06)" : "var(--color-bg-secondary)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {ready ? (
            <Check size={18} color="var(--color-accent, #2563eb)" />
          ) : (
            <Inbox size={18} color="var(--color-text-secondary)" />
          )}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {ready ? "邮箱已就绪" : "尚未配置邮箱"}
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>
              {ready ? `共 ${accountCount} 个账号` : "点右侧按钮添加第一个账号"}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onAdd}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "7px 14px",
            borderRadius: 6,
            border: 0,
            background: "var(--color-accent, #2563eb)",
            color: "#fff",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          <ExternalLink size={12} /> {ready ? "管理账号" : "添加邮箱"}
        </button>
      </div>
    </div>
  );
}

function StorageStep({ path }: { path: string }) {
  const addToast = useToastStore((s) => s.addToast);
  const [opening, setOpening] = useState(false);

  const copyPath = useCallback(async () => {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      addToast({ message: "已复制完整路径到剪贴板", type: "success" });
    } catch {
      addToast({ message: "复制失败，请手动选择路径文本", type: "error" });
    }
  }, [path, addToast]);

  const openFolder = useCallback(async () => {
    if (!path) return;
    setOpening(true);
    try {
      await openDataDir();
      addToast({ message: "已在文件管理器中打开", type: "success" });
    } catch (err) {
      addToast({
        message: `打开失败：${err instanceof Error ? err.message : String(err)}`,
        type: "error",
      });
    } finally {
      setOpening(false);
    }
  }, [path, addToast]);

  return (
    <div>
      <p style={{ margin: "0 0 14px", fontSize: 13, lineHeight: 1.7, color: "var(--color-text-secondary)" }}>
        你的邮件、附件、搜索索引都保存在本地。下次启动会继续显示，无需担心隐私。
      </p>
      <div
        style={{
          padding: "14px 16px",
          borderRadius: 9,
          border: "1px solid var(--color-border, #ccc)",
          background: "var(--color-bg-secondary)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>当前完整路径</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={copyPath}
              disabled={!path}
              title="复制完整路径"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 9px",
                borderRadius: 5,
                border: "1px solid var(--color-border, #ccc)",
                background: "var(--color-bg-primary)",
                color: "var(--color-text-primary)",
                cursor: path ? "pointer" : "not-allowed",
                fontSize: 11,
                opacity: path ? 1 : 0.5,
              }}
            >
              <Copy size={11} /> 复制
            </button>
            <button
              type="button"
              onClick={openFolder}
              disabled={!path || opening}
              title="在文件管理器中打开"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 10px",
                borderRadius: 5,
                border: 0,
                background: "var(--color-accent, #2563eb)",
                color: "#fff",
                cursor: !path || opening ? "not-allowed" : "pointer",
                fontSize: 11,
                fontWeight: 600,
                opacity: !path || opening ? 0.6 : 1,
              }}
            >
              <FolderSearch size={11} /> {opening ? "打开中…" : "打开文件夹"}
            </button>
          </div>
        </div>
        <code
          style={{
            display: "block",
            fontSize: 12,
            padding: "9px 11px",
            borderRadius: 6,
            background: "var(--color-bg-primary)",
            border: "1px solid var(--color-border, #ccc)",
            color: "var(--color-text-primary)",
            wordBreak: "break-all",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          {path || "正在获取路径…"}
        </code>
        <p style={{ margin: "10px 0 0", fontSize: 11, lineHeight: 1.6, color: "var(--color-text-secondary)" }}>
          想换成其他位置（便携模式、网盘同步、外接硬盘等）？在启动 YaoAIMail 之前设置环境变量 <code>PEBBLE_PROFILE_DIR</code> 为目标完整路径即可。
        </p>
      </div>
    </div>
  );
}

function ApiKeyStep({ onSetup }: { onSetup: () => void }) {
  return (
    <div>
      <p style={{ margin: "0 0 14px", fontSize: 13, lineHeight: 1.7, color: "var(--color-text-secondary)" }}>
        AI 写作、智能翻译、AI 业务助手都依赖大模型 API Key。至少配置一个 Provider，才能让 AI 功能正常工作。
      </p>
      <div
        style={{
          padding: "14px 16px",
          borderRadius: 9,
          border: "1px solid var(--color-border, #ccc)",
          background: "var(--color-bg-secondary)",
          marginBottom: 14,
        }}
      >
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6 }}>支持的服务商</div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.8, color: "var(--color-text-primary)" }}>
          <li>OpenAI（含 GPT-4o、GPT-5 系列）</li>
          <li>DeepSeek（国内直连、价格友好）</li>
          <li>Google Gemini</li>
          <li>任意 OpenAI 兼容接口（自建代理或第三方）</li>
        </ul>
      </div>
      <button
        type="button"
        onClick={onSetup}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "9px 18px",
          borderRadius: 7,
          border: 0,
          background: "var(--color-accent, #2563eb)",
          color: "#fff",
          cursor: "pointer",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        <ExternalLink size={13} /> 前往设置 AI 模型
      </button>
    </div>
  );
}

function DoneStep({ accountCount }: { accountCount: number }) {
  return (
    <div>
      <p style={{ margin: "0 0 14px", fontSize: 13, lineHeight: 1.7, color: "var(--color-text-secondary)" }}>
        以下是引导中提到的配置。任意一项都可以在「设置」中继续修改。
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SummaryRow
          ok={accountCount > 0}
          label="邮箱账号"
          value={accountCount > 0 ? `已配置 ${accountCount} 个` : "未配置（稍后在「设置 → 账号」添加）"}
        />
        <SummaryRow ok={true} label="数据位置" value="已使用默认（Windows: %APPDATA%\\com.qingj01.pebble）" />
        <SummaryRow
          ok={true}
          label="AI 模型"
          value={"在「设置 → 翻译 → AI 模型」中配置"}
        />
      </div>
    </div>
  );
}

function SummaryRow({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        borderRadius: 7,
        border: "1px solid var(--color-border, #ccc)",
        background: ok ? "rgba(34,197,94,0.06)" : "var(--color-bg-secondary)",
      }}
    >
      <Check size={16} color={ok ? "#15803d" : "var(--color-text-secondary)"} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{label}</div>
        <div style={{ fontSize: 13, color: "var(--color-text-primary)", marginTop: 2 }}>{value}</div>
      </div>
    </div>
  );
}
