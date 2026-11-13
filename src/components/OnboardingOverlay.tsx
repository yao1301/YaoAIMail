import { useCallback, useEffect, useState } from "react";
import { Inbox, FolderOpen, Sparkles, Check, Circle, ChevronLeft, ChevronRight, X, ExternalLink, Copy, FolderSearch } from "lucide-react";
import { useAccountsQuery } from "@/hooks/queries";
import { useUIStore } from "@/stores/ui.store";
import { useToastStore } from "@/stores/toast.store";
import { openDataDir, getDataDir, getTranslateConfig } from "@/lib/api";
import { SHOW_ONBOARDING_EVENT } from "@/lib/onboarding";

const ONBOARDING_KEY = "pebble-onboarding-v2";
const PROGRESS_KEY = "pebble-onboarding-progress";
type AiStatus = "checking" | "ready" | "disabled" | "missing" | "error";
const AI_STATUS_LABEL: Record<AiStatus, string> = {
  checking: "正在检查配置…", ready: "已配置并启用（连接状态请在模型设置中测试）",
  disabled: "尚未启用，请勾选“启用翻译/AI大模型”并保存", missing: "尚未配置，普通收发邮件不受影响", error: "暂时无法读取，请到模型设置中查看",
};

type StepId = "email" | "storage" | "api" | "done";

const STEPS: { id: StepId; icon: React.ReactNode; title: string }[] = [
  { id: "email", icon: <Inbox size={26} />, title: "设置邮箱账号" },
  { id: "storage", icon: <FolderOpen size={26} />, title: "数据保存位置" },
  { id: "api", icon: <Sparkles size={26} />, title: "AI 模型（可选）" },
  { id: "done", icon: <Check size={26} />, title: "准备就绪" },
];

export default function OnboardingOverlay() {
  const [visible, setVisible] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [suspended, setSuspended] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiStatus>("checking");
  const { data: accounts = [] } = useAccountsQuery();
  const setActiveView = useUIStore((s) => s.setActiveView);
  const addToast = useToastStore((s) => s.addToast);

  useEffect(() => {
    const resume = () => {
      setStepIdx(0);
      setSuspended(false);
      setVisible(true);
    };
    window.addEventListener(SHOW_ONBOARDING_EVENT, resume);
    // Also accept requests from detached settings windows.
    let disposed = false;
    let stopListening: (() => void) | undefined;
    if ("__TAURI_INTERNALS__" in window) {
      void import("@tauri-apps/api/event").then(({ listen }) => listen(SHOW_ONBOARDING_EVENT, resume))
        .then(unlisten => { if (disposed) unlisten(); else stopListening = unlisten; }).catch(() => {});
    }
    try {
      if (!localStorage.getItem(ONBOARDING_KEY)) {
        const saved = Number(localStorage.getItem(PROGRESS_KEY) ?? 0);
        if (Number.isInteger(saved) && saved >= 0 && saved < STEPS.length) setStepIdx(saved);
        setVisible(true);
      }
    } catch {
      setVisible(true);
    }
    return () => { disposed = true; stopListening?.(); window.removeEventListener(SHOW_ONBOARDING_EVENT, resume); };
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setAiStatus("checking");
    void getTranslateConfig().then(config => {
      if (cancelled) return;
      if (!config) { setAiStatus("missing"); return; }
      const parsed = JSON.parse(config.config);
      const provider = parsed.providers?.find((p: { id: string }) => p.id === parsed.active_id) ?? parsed.providers?.[0];
      const configured = parsed.type === "llm" && typeof provider?.api_key === "string" && provider.api_key.trim()
        && typeof provider?.model === "string" && provider.model.trim();
      setAiStatus(!configured ? "missing" : config.is_enabled ? "ready" : "disabled");
    }).catch(() => { if (!cancelled) setAiStatus("error"); });
    return () => { cancelled = true; };
  }, [visible]);

  const finish = useCallback(() => {
    try {
      localStorage.setItem(ONBOARDING_KEY, "done");
      localStorage.removeItem(PROGRESS_KEY);
    } catch {
      // ignore
    }
    setVisible(false);
    setSuspended(false);
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
    (tab: "accounts" | "translation" | "general") => {
      try { localStorage.setItem(PROGRESS_KEY, String(stepIdx)); } catch { /* Keep in-memory progress. */ }
      setVisible(false);
      setSuspended(true);
      useUIStore.getState().setSettingsTab(tab);
      setActiveView("settings");
    },
    [stepIdx, setActiveView],
  );

  const handleAddAccount = useCallback(() => {
    openSettingsTab("accounts");
  }, [openSettingsTab]);

  const handleSetupAi = useCallback(() => {
    openSettingsTab("translation");
    addToast({
      message: "选择 AI 模型，填写 API Key 和模型 ID，勾选“启用翻译/AI大模型”后保存；需要代理的模型可单独勾选“使用代理”。",
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

  if (!visible) return suspended ? <button type="button" onClick={() => { setSuspended(false); setVisible(true); }}
    style={{ position: "fixed", right: 24, bottom: 36, zIndex: 9998, border: "1px solid var(--color-border)", borderRadius: 8, padding: "9px 14px", background: "var(--color-bg-primary)", color: "var(--color-accent)", cursor: "pointer", fontSize: 13 }}>
    继续新手引导
  </button> : null;

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
        role="dialog"
        aria-modal="true"
        aria-label="新手引导"
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
            aria-label="关闭新手引导"
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
            <StorageStep path={dataDirPath} onManage={() => openSettingsTab("general")} />
          )}
          {currentStep.id === "api" && (
            <ApiKeyStep onSetup={handleSetupAi} status={aiStatus} />
          )}
          {currentStep.id === "done" && (
            <DoneStep accountCount={accountCount} path={dataDirPath} aiStatus={aiStatus} />
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
              {ready ? "邮箱已添加" : "尚未配置邮箱"}
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

function StorageStep({ path, onManage }: { path: string; onManage: () => void }) {
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
        你的邮件、附件和搜索索引保存在此电脑，下次启动会继续使用。建议定期备份整个数据文件夹；使用 AI 时，必要的邮件和参考内容会交给你配置的服务商处理。
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
          如需更换位置，可到“设置 → 通用”选择空文件夹，完全退出并重新打开软件后生效。
        </p>
        <button type="button" onClick={onManage} style={{ marginTop: 8, border: 0, background: "transparent", color: "var(--color-accent)", cursor: "pointer", fontSize: 12 }}>前往设置保存位置</button>
      </div>
    </div>
  );
}

function ApiKeyStep({ onSetup, status }: { onSetup: () => void; status: AiStatus }) {
  return (
    <div>
      <p style={{ margin: "0 0 14px", fontSize: 13, lineHeight: 1.7, color: "var(--color-text-secondary)" }}>
        AI 写作、翻译和工作台需要配置大模型。填写 API Key 和模型 ID，勾选“启用翻译/AI大模型”并保存。暂不使用 AI 也可以正常收发邮件。
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
          <li>OpenAI</li>
          <li>DeepSeek</li>
          <li>Google Gemini</li>
          <li>任意 OpenAI 兼容接口（自建代理或第三方）</li>
        </ul>
      </div>
      <p style={{ fontSize: 12, lineHeight: 1.7, color: "var(--color-text-secondary)" }}>
        当前状态：{AI_STATUS_LABEL[status]}。需要代理时，在“设置 → 代理”填写地址，再在对应模型下勾选“使用代理”。外部搜索 API 可以稍后配置；DeepSeek 付费搜索默认关闭，需要另行勾选开启。
      </p>
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

function DoneStep({ accountCount, path, aiStatus }: { accountCount: number; path: string; aiStatus: AiStatus }) {
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
        <SummaryRow ok={Boolean(path)} label="数据位置" value={path || "暂时无法读取，请到“设置 → 通用”查看"} />
        <SummaryRow
          ok={aiStatus === "ready"}
          label="AI 模型"
          value={AI_STATUS_LABEL[aiStatus]}
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
      {ok ? <Check size={16} color="#15803d" /> : <Circle size={16} color="var(--color-text-secondary)" />}
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{label}</div>
        <div style={{ fontSize: 13, color: "var(--color-text-primary)", marginTop: 2 }}>{value}</div>
      </div>
    </div>
  );
}
