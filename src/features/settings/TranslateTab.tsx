import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  getTranslateConfig,
  saveTranslateConfig,
  testTranslateConnection,
} from "../../lib/api";
import { useToastStore } from "@/stores/toast.store";
import { extractErrorMessage } from "../../lib/extractErrorMessage";
import { getPreset } from "../../lib/llmPresets";
import {
  getTranslationTargetLanguage,
  setTranslationTargetLanguage,
  TRANSLATION_TARGET_LANGUAGES,
} from "@/lib/translationPreferences";

type LlmProviderKind = "openai" | "deepseek" | "gemini" | "custom";

interface LlmProvider {
  id: string;
  name: string;
  kind: LlmProviderKind;
  base_url: string;
  chat_path: string;
  api_key: string;
  model: string;
  mode: "completions" | "responses";
}

type ProviderType = "deeplx" | "deepl" | "generic_api" | "llm";

const PROVIDER_OPTIONS: { value: ProviderType; label: string }[] = [
  { value: "deeplx", label: "DeepLX" },
  { value: "deepl", label: "DeepL" },
  { value: "generic_api", label: "Generic API" },
  { value: "llm", label: "AI 模型 (LLM)" },
];

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 500,
  color: "var(--color-text-secondary)",
  marginBottom: "4px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: "13px",
  border: "1px solid var(--color-border)",
  borderRadius: "6px",
  background: "var(--color-bg-secondary)",
  color: "var(--color-text-primary)",
  boxSizing: "border-box",
};

const fieldGroupStyle: React.CSSProperties = {
  marginBottom: "14px",
};

const buttonStyle: React.CSSProperties = {
  padding: "8px 18px",
  fontSize: "13px",
  fontWeight: 500,
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
};

export default function TranslateTab() {
  const { t } = useTranslation();
  const [providerType, setProviderType] = useState<ProviderType>("deeplx");
  const [isEnabled, setIsEnabled] = useState(false);

  // DeepLX fields
  const [deeplxEndpoint, setDeeplxEndpoint] = useState("");

  // DeepL fields
  const [deeplApiKey, setDeeplApiKey] = useState("");
  const [deeplUseFree, setDeeplUseFree] = useState(false);

  // Generic API fields
  const [genericEndpoint, setGenericEndpoint] = useState("");
  const [genericApiKey, setGenericApiKey] = useState("");
  const [genericSourceLangParam, setGenericSourceLangParam] = useState("source_lang");
  const [genericTargetLangParam, setGenericTargetLangParam] = useState("target_lang");
  const [genericTextParam, setGenericTextParam] = useState("text");
  const [genericResultPath, setGenericResultPath] = useState("data");

  // LLM providers (multiple: presets + custom)
  const [llmProviders, setLlmProviders] = useState<LlmProvider[]>([]);
  const [llmActiveId, setLlmActiveId] = useState("");

  const [statusMsg, setStatusMsg] = useState("");
  const [statusType, setStatusType] = useState<"success" | "error" | "">("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [translationTargetLanguage, setTranslationTargetLanguageState] = useState(
    getTranslationTargetLanguage,
  );

  useEffect(() => {
    loadConfig();
  }, []);

  async function loadConfig() {
    try {
      const cfg = await getTranslateConfig();
      if (!cfg) return;

      setProviderType(cfg.provider_type as ProviderType);
      setIsEnabled(cfg.is_enabled);

      const parsed = JSON.parse(cfg.config);
      switch (parsed.type) {
        case "deeplx":
          setDeeplxEndpoint(parsed.endpoint || "");
          break;
        case "deepl":
          setDeeplApiKey(parsed.api_key || "");
          setDeeplUseFree(parsed.use_free_api ?? false);
          break;
        case "generic_api":
          setGenericEndpoint(parsed.endpoint || "");
          setGenericApiKey(parsed.api_key || "");
          setGenericSourceLangParam(parsed.source_lang_param || "source_lang");
          setGenericTargetLangParam(parsed.target_lang_param || "target_lang");
          setGenericTextParam(parsed.text_param || "text");
          setGenericResultPath(parsed.result_path || "data");
          break;
        case "llm":
          if (parsed.providers && Array.isArray(parsed.providers)) {
            setLlmProviders(parsed.providers);
            const requestedId = typeof parsed.active_id === "string" ? parsed.active_id : "";
            setLlmActiveId(parsed.providers.some((provider: LlmProvider) => provider.id === requestedId)
              ? requestedId
              : (parsed.providers[0]?.id || ""));
          }
          break;
      }
    } catch (err) {
      console.error("Failed to load translate config:", err);
    }
  }

  function buildConfigJson(): string {
    switch (providerType) {
      case "deeplx":
        return JSON.stringify({ type: "deeplx", endpoint: deeplxEndpoint });
      case "deepl":
        return JSON.stringify({ type: "deepl", api_key: deeplApiKey, use_free_api: deeplUseFree });
      case "generic_api":
        return JSON.stringify({
          type: "generic_api",
          endpoint: genericEndpoint,
          api_key: genericApiKey || null,
          method: null,
          source_lang_param: genericSourceLangParam,
          target_lang_param: genericTargetLangParam,
          text_param: genericTextParam,
          result_path: genericResultPath,
        });
      case "llm":
        return JSON.stringify({
          type: "llm",
          providers: llmProviders,
          active_id: llmActiveId,
        });
    }
  }

  async function handleSave() {
    setSaving(true);
    setStatusMsg("");
    try {
      const configJson = buildConfigJson();
      await saveTranslateConfig(providerType, configJson, isEnabled);
      setStatusMsg(t("translate.configSaved"));
      setStatusType("success");
    } catch (err: unknown) {
      const errMsg = extractErrorMessage(err);
      setStatusMsg(t("translate.saveFailed", { error: errMsg }));
      setStatusType("error");
      useToastStore.getState().addToast({
        message: t("translate.saveFailed", { error: errMsg }),
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setStatusMsg("");
    try {
      const configJson = buildConfigJson();
      const result = await testTranslateConnection(configJson);
      setStatusMsg(t("translate.connectionOk", { result }));
      setStatusType("success");
    } catch (err: unknown) {
      const errMsg = extractErrorMessage(err);
      setStatusMsg(t("translate.testFailed", { error: errMsg }));
      setStatusType("error");
      useToastStore.getState().addToast({
        message: t("translate.testFailed", { error: errMsg }),
        type: "error",
      });
    } finally {
      setTesting(false);
    }
  }

  function addProvider(kind: LlmProviderKind) {
    const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    if (kind === "custom") {
      setLlmProviders((prev) => [
        ...prev,
        {
          id,
          name: "自定义模型",
          kind: "custom",
          base_url: "",
          chat_path: "/chat/completions",
          api_key: "",
          model: "",
          mode: "completions",
        },
      ]);
    } else {
      const preset = getPreset(kind);
      if (!preset) return;
      setLlmProviders((prev) => [
        ...prev,
        {
          id,
          name: preset.label,
          kind: preset.kind,
          base_url: preset.baseUrl,
          chat_path: preset.chatPath,
          api_key: "",
          model: preset.models[0],
          mode: "completions",
        },
      ]);
    }
    setLlmActiveId(id);
  }

  function updateProvider(id: string, patch: Partial<LlmProvider>) {
    setLlmProviders((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function removeProvider(id: string) {
    setLlmProviders((prev) => {
      const next = prev.filter((p) => p.id !== id);
      if (llmActiveId === id) setLlmActiveId(next[0]?.id || "");
      return next;
    });
  }

  function renderLlmProviderManager() {
    const selected = llmProviders.find((provider) => provider.id === llmActiveId) || llmProviders[0];
    const preset = selected?.kind !== "custom" ? getPreset(selected?.kind || "custom") : undefined;
    return (
      <>
        <div style={fieldGroupStyle}>
          <label style={labelStyle}>当前大模型</label>
          <select
            id="llm-active-provider"
            style={inputStyle}
            value={selected?.id || ""}
            onChange={(event) => {
              const value = event.target.value;
              if (value.startsWith("__add_")) addProvider(value.slice(6) as LlmProviderKind);
              else setLlmActiveId(value);
            }}
          >
            {!selected && <option value="">请选择或添加大模型</option>}
            {llmProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.name || provider.model || "未命名模型"}</option>
            ))}
            <option disabled>──────── 添加 ────────</option>
            <option value="__add_openai">＋ OpenAI</option>
            <option value="__add_deepseek">＋ DeepSeek</option>
            <option value="__add_gemini">＋ Google Gemini</option>
            <option value="__add_custom">＋ 自定义</option>
          </select>
        </div>
        <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: 0, marginBottom: "12px" }}>
          下拉框中选中的模型就是当前默认模型；下方只编辑这一项。
        </p>
        {!selected && (
          <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
            请从下拉框添加一个服务商或自定义模型。
          </div>
        )}
        {selected && (
          <div style={{ border: "1px solid var(--color-border)", borderRadius: 8, padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
                <input
                  style={{ ...inputStyle, flex: 1 }}
                  value={selected.name}
                  onChange={(e) => updateProvider(selected.id, { name: e.target.value })}
                  placeholder="名称"
                  autoComplete="off"
                />
                <button
                  type="button"
                  style={{ ...buttonStyle, background: "rgba(220,53,69,0.12)", color: "#dc3545" }}
                  onClick={() => removeProvider(selected.id)}
                >
                  删除
                </button>
              </div>
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>模型</label>
                {preset ? (
                  <select
                    style={inputStyle}
                    value={selected.model}
                    onChange={(e) => updateProvider(selected.id, { model: e.target.value })}
                  >
                    {preset.models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    style={inputStyle}
                    value={selected.model}
                    onChange={(e) => updateProvider(selected.id, { model: e.target.value })}
                    placeholder="模型 ID，如 gpt-4o-mini"
                    autoComplete="off"
                  />
                )}
              </div>
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>API Key（必填）</label>
                <input
                  style={inputStyle}
                  type="password"
                  value={selected.api_key}
                  onChange={(e) => updateProvider(selected.id, { api_key: e.target.value })}
                  placeholder="sk-..."
                  autoComplete="current-password"
                />
              </div>
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>接口地址</label>
                <input
                  style={{ ...inputStyle, opacity: preset ? 0.7 : 1 }}
                  value={selected.base_url}
                  onChange={(e) => updateProvider(selected.id, { base_url: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                  readOnly={!!preset}
                  autoComplete="off"
                />
              </div>
              {selected.kind === "custom" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 150px", gap: 10 }}>
                  <div style={fieldGroupStyle}>
                    <label style={labelStyle}>请求路径</label>
                    <input style={inputStyle} value={selected.chat_path} onChange={(e) => updateProvider(selected.id, { chat_path: e.target.value })} placeholder="/chat/completions" autoComplete="off" />
                  </div>
                  <div style={fieldGroupStyle}>
                    <label style={labelStyle}>接口协议</label>
                    <select style={inputStyle} value={selected.mode} onChange={(e) => updateProvider(selected.id, { mode: e.target.value as LlmProvider["mode"] })}>
                      <option value="completions">Chat Completions</option>
                      <option value="responses">Responses</option>
                    </select>
                  </div>
                </div>
              )}
          </div>
        )}
      </>
    );
  }

  function renderProviderFields() {
    switch (providerType) {
      case "deeplx":
        return (
          <div style={fieldGroupStyle}>
            <label htmlFor="translate-deeplx-endpoint" style={labelStyle}>{t("translate.endpointUrl")}</label>
            <input
              id="translate-deeplx-endpoint"
              name="deeplx_endpoint"
              type="url"
              style={inputStyle}
              value={deeplxEndpoint}
              onChange={(e) => setDeeplxEndpoint(e.target.value)}
              placeholder="http://localhost:1188/translate"
              autoComplete="off"
            />
          </div>
        );

      case "deepl":
        return (
          <>
            <div style={fieldGroupStyle}>
              <label htmlFor="translate-deepl-api-key" style={labelStyle}>{t("translate.apiKey")}</label>
              <input
                id="translate-deepl-api-key"
                name="deepl_api_key"
                style={inputStyle}
                type="password"
                value={deeplApiKey}
                onChange={(e) => setDeeplApiKey(e.target.value)}
                placeholder="your-deepl-api-key"
                autoComplete="current-password"
              />
            </div>
            <div style={{ ...fieldGroupStyle, display: "flex", alignItems: "center", gap: "8px" }}>
              <input
                type="checkbox"
                checked={deeplUseFree}
                onChange={(e) => setDeeplUseFree(e.target.checked)}
                id="deepl-free"
              />
              <label htmlFor="deepl-free" style={{ fontSize: "13px", color: "var(--color-text-primary)", cursor: "pointer" }}>
                {t("translate.useFreeApi")}
              </label>
            </div>
          </>
        );

      case "generic_api":
        return (
          <>
            <div style={fieldGroupStyle}>
              <label htmlFor="translate-generic-endpoint" style={labelStyle}>{t("translate.endpoint")}</label>
              <input
                id="translate-generic-endpoint"
                name="generic_endpoint"
                type="url"
                style={inputStyle}
                value={genericEndpoint}
                onChange={(e) => setGenericEndpoint(e.target.value)}
                placeholder="https://api.example.com/translate"
                autoComplete="off"
              />
            </div>
            <div style={fieldGroupStyle}>
              <label htmlFor="translate-generic-api-key" style={labelStyle}>{t("translate.apiKeyOptional")}</label>
              <input
                id="translate-generic-api-key"
                name="generic_api_key"
                style={inputStyle}
                type="password"
                value={genericApiKey}
                onChange={(e) => setGenericApiKey(e.target.value)}
                placeholder={t("translate.apiKeyOptional")}
                autoComplete="current-password"
              />
            </div>
            <div style={fieldGroupStyle}>
              <label htmlFor="translate-generic-source-param" style={labelStyle}>{t("translate.sourceLangParam")}</label>
              <input
                id="translate-generic-source-param"
                name="generic_source_lang_param"
                style={inputStyle}
                value={genericSourceLangParam}
                onChange={(e) => setGenericSourceLangParam(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div style={fieldGroupStyle}>
              <label htmlFor="translate-generic-target-param" style={labelStyle}>{t("translate.targetLangParam")}</label>
              <input
                id="translate-generic-target-param"
                name="generic_target_lang_param"
                style={inputStyle}
                value={genericTargetLangParam}
                onChange={(e) => setGenericTargetLangParam(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div style={fieldGroupStyle}>
              <label htmlFor="translate-generic-text-param" style={labelStyle}>{t("translate.textParam")}</label>
              <input
                id="translate-generic-text-param"
                name="generic_text_param"
                style={inputStyle}
                value={genericTextParam}
                onChange={(e) => setGenericTextParam(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div style={fieldGroupStyle}>
              <label htmlFor="translate-generic-result-path" style={labelStyle}>{t("translate.resultPath")}</label>
              <input
                id="translate-generic-result-path"
                name="generic_result_path"
                style={inputStyle}
                value={genericResultPath}
                onChange={(e) => setGenericResultPath(e.target.value)}
                autoComplete="off"
              />
            </div>
          </>
        );

      case "llm":
        return renderLlmProviderManager();
    }
  }

  return (
    <div>
      <h2 style={{ fontSize: "18px", fontWeight: 600, color: "var(--color-text-primary)", marginTop: 0, marginBottom: "20px" }}>
        {t("translate.engineTitle")}
      </h2>

      <div style={fieldGroupStyle}>
        <label htmlFor="translation-default-target" style={labelStyle}>选中文字后的默认翻译语言</label>
        <select
          id="translation-default-target"
          style={inputStyle}
          value={translationTargetLanguage}
          onChange={(event) => {
            const language = event.target.value;
            setTranslationTargetLanguageState(language);
            setTranslationTargetLanguage(language);
          }}
        >
          {TRANSLATION_TARGET_LANGUAGES.map((language) => (
            <option key={language.value} value={language.value}>{language.label}</option>
          ))}
        </select>
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-text-secondary)" }}>
          来源语言自动识别。默认翻译成中文，也可以在翻译浮窗中临时切换。
        </p>
      </div>

      {/* Enable toggle */}
      <div style={{ ...fieldGroupStyle, display: "flex", alignItems: "center", gap: "8px" }}>
        <input
          type="checkbox"
          checked={isEnabled}
          onChange={(e) => setIsEnabled(e.target.checked)}
          id="translate-enabled"
        />
        <label htmlFor="translate-enabled" style={{ fontSize: "13px", color: "var(--color-text-primary)", cursor: "pointer" }}>
          {t("translate.enableTranslation")}
        </label>
      </div>

      {/* Provider selector */}
      <div style={fieldGroupStyle}>
        <label htmlFor="translate-provider" style={labelStyle}>{t("translate.provider")}</label>
        <select
          id="translate-provider"
          name="translate_provider"
          style={inputStyle}
          value={providerType}
          onChange={(e) => setProviderType(e.target.value as ProviderType)}
        >
          {PROVIDER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Dynamic provider fields */}
      {renderProviderFields()}

      {/* Actions */}
      <div style={{ display: "flex", gap: "10px", marginTop: "20px" }}>
        <button
          style={{
            ...buttonStyle,
            background: "var(--color-accent)",
            color: "#fff",
            opacity: saving ? 0.6 : 1,
          }}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
        <button
          style={{
            ...buttonStyle,
            background: "var(--color-bg-hover)",
            color: "var(--color-text-primary)",
            opacity: testing ? 0.6 : 1,
          }}
          onClick={handleTest}
          disabled={testing}
        >
          {testing ? t("common.testing") : t("translate.testConnection")}
        </button>
      </div>

      {/* Status message */}
      {statusMsg && (
        <div
          role={statusType === "error" ? "alert" : "status"}
          aria-live="polite"
          style={{
            marginTop: "14px",
            padding: "10px 14px",
            borderRadius: "6px",
            fontSize: "13px",
            background: statusType === "success" ? "var(--color-bg-hover)" : "rgba(220, 53, 69, 0.1)",
            color: statusType === "success" ? "var(--color-text-primary)" : "#dc3545",
            border: `1px solid ${statusType === "success" ? "var(--color-border)" : "rgba(220, 53, 69, 0.3)"}`,
          }}
        >
          {statusMsg}
        </div>
      )}
    </div>
  );
}
