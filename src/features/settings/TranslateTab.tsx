import { useWorkspaceState, useWorkspaceInitEffect } from '@/lib/workspaceState';
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  getTranslateConfig,
  getGlobalProxy,
  saveTranslateConfig,
  testTranslateConnection,
} from "../../lib/api";
import { useToastStore } from "@/stores/toast.store";
import { extractErrorMessage } from "../../lib/extractErrorMessage";
import { getPreset, LLM_PRESETS } from "../../lib/llmPresets";
import { providerModelIds } from '@/lib/providerModels';
import { Pencil, Check, X, Plus } from 'lucide-react';
import ModelDiscovery from './ModelDiscovery';
import {
  useTranslationTargetLanguage,
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
  models?: string[];
  mode: "completions" | "responses";
  use_proxy?: boolean;
}

/** Built-ins are available directly; never discard saved profiles or keys. */
function withBuiltInProviders(saved: LlmProvider[]): LlmProvider[] {
  const providers = [...saved];
  for (const preset of LLM_PRESETS) {
    if (providers.some((provider) => provider.kind === preset.kind)) continue;
    let id = `preset_${preset.kind}`;
    while (providers.some((provider) => provider.id === id)) id += "_";
    providers.push({
      id,
      name: preset.label,
      kind: preset.kind,
      base_url: preset.baseUrl,
      chat_path: preset.chatPath,
      api_key: "",
      model: preset.models[0],
      mode: "completions",
      use_proxy: false,
    });
  }
  return providers;
}

/** Convert legacy “base URL + request path” settings to one complete endpoint. */
function completeCustomEndpoint(provider: LlmProvider): string {
  const base = provider.base_url.trim().replace(/\/+$/, "");
  if (!base) return "";
  if (/\/(chat\/completions|responses)$/i.test(base)) return base;
  const path = provider.mode === "responses" ? "/responses" : "/chat/completions";
  return `${base}${path}`;
}

function normalizeCustomProvider(provider: LlmProvider): LlmProvider {
  if (provider.kind !== "custom") return provider;
  const baseUrl = completeCustomEndpoint(provider);
  return {
    ...provider,
    model: provider.model.trim(),
    models: providerModelIds(provider.model, provider.models),
    base_url: baseUrl,
    chat_path: "",
    mode: /\/responses$/i.test(baseUrl) ? "responses" : "completions",
  };
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

function CustomModelIds({ provider, onChange, onEditingChange }: { provider: LlmProvider; onChange: (patch: Partial<LlmProvider>) => void; onEditingChange: (editing: boolean) => void }) {
  const { t } = useTranslation();
  const ids = providerModelIds(provider.model, provider.models);
  const [editing, setEditing] = useWorkspaceState<'add' | 'edit' | null>("src/features/settings/TranslateTab.tsx:CustomModelIds:" + provider.id + ":editing", ids.length ? null : 'add');
  const [input, setInput] = useWorkspaceState("src/features/settings/TranslateTab.tsx:CustomModelIds:" + provider.id + ":input", '');
  useEffect(() => { onEditingChange(editing !== null); return () => onEditingChange(false); }, [editing, onEditingChange]);
  const trimmed = input.trim();
  const duplicate = ids.includes(trimmed) && !(editing === 'edit' && trimmed === provider.model);
  const iconStyle: React.CSSProperties = { ...buttonStyle, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 8, background: 'transparent', color: 'var(--color-text-secondary)', flexShrink: 0 };
  function apply() {
    if (!trimmed || duplicate) return;
    const next = editing === 'edit' ? ids.map(id => id === provider.model ? trimmed : id) : [...ids, trimmed];
    onChange({ model: trimmed, models: providerModelIds(trimmed, next) });
    setEditing(null); setInput('');
  }
  return <>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <select id="llm-model-id" style={{ ...inputStyle, flex: 1, minWidth: 0 }} value={provider.model} aria-describedby="llm-model-id-help"
        onChange={event => {
          if (event.target.value === '__add_model_id') { setEditing('add'); setInput(''); }
          else { onChange({ model: event.target.value }); setEditing(null); }
        }}>
        {!provider.model && <option value="">{t('translate.chooseModelId')}</option>}
        {ids.map(id => <option key={id} value={id}>{id}</option>)}
        <option value="__add_model_id">{t('translate.addModelId')}</option>
      </select>
      <button type="button" style={iconStyle} disabled={!provider.model} title={t('translate.editModelId')} aria-label={t('translate.editModelId')}
        onClick={() => { setEditing('edit'); setInput(provider.model); }}><Pencil size={14} /></button>
      <button type="button" style={iconStyle} title={t('translate.addModelId')} aria-label={t('translate.addModelId')} onClick={() => { setEditing('add'); setInput(''); }}><Plus size={15} /></button>
    </div>
    {editing && <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input aria-label={t(editing === 'add' ? 'translate.newModelId' : 'translate.editModelId')} autoFocus style={{ ...inputStyle, flex: 1, minWidth: 0 }}
          value={input} autoComplete="off" spellCheck={false} placeholder={t('translate.modelIdPlaceholder')}
          onChange={event => setInput(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); apply(); }
            if (event.key === 'Escape') { event.preventDefault(); setEditing(null); }
          }} />
        <button type="button" style={{ ...iconStyle, gap: 4, whiteSpace: 'nowrap' }} disabled={!trimmed || duplicate} title={t('common.confirm')} aria-label={t('translate.confirmModelId')} onClick={apply}><Check size={14} />{t(editing === 'add' ? 'translate.addModelIdAction' : 'common.confirm')}</button>
        <button type="button" style={iconStyle} title={t('common.cancel')} aria-label={t('translate.cancelModelId')} onClick={() => setEditing(null)}><X size={16} /></button>
      </div>
      {duplicate && <p role="alert" style={{ color: '#dc3545', fontSize: 12, margin: '5px 0 0' }}>{t('translate.duplicateModelId')}</p>}
    </div>}
    <p id="llm-model-id-help" style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('translate.sharedModelIdsHelp')}</p>
    <div style={{ marginTop: 8 }}><ModelDiscovery provider={provider} onChange={patch => { onChange(patch); setEditing(null); setInput(''); }} /></div>
  </>;
}

export default function TranslateTab() {
  const { t } = useTranslation();
  const [providerType, setProviderType] = useWorkspaceState<ProviderType>("src/features/settings/TranslateTab.tsx:TranslateTab:providerType", "deeplx");
  const [isEnabled, setIsEnabled] = useWorkspaceState("src/features/settings/TranslateTab.tsx:TranslateTab:isEnabled", false);

  // DeepLX fields
  const [deeplxEndpoint, setDeeplxEndpoint] = useWorkspaceState("src/features/settings/TranslateTab.tsx:TranslateTab:deeplxEndpoint", "");

  // DeepL fields
  const [deeplApiKey, setDeeplApiKey] = useWorkspaceState("src/features/settings/TranslateTab.tsx:TranslateTab:deeplApiKey", "");
  const [deeplUseFree, setDeeplUseFree] = useWorkspaceState("src/features/settings/TranslateTab.tsx:TranslateTab:deeplUseFree", false);

  // Generic API fields
  const [genericEndpoint, setGenericEndpoint] = useWorkspaceState("src/features/settings/TranslateTab.tsx:TranslateTab:genericEndpoint", "");
  const [genericApiKey, setGenericApiKey] = useWorkspaceState("src/features/settings/TranslateTab.tsx:TranslateTab:genericApiKey", "");
  const [genericSourceLangParam, setGenericSourceLangParam] = useWorkspaceState("src/features/settings/TranslateTab.tsx:TranslateTab:genericSourceLangParam", "source_lang");
  const [genericTargetLangParam, setGenericTargetLangParam] = useWorkspaceState("src/features/settings/TranslateTab.tsx:TranslateTab:genericTargetLangParam", "target_lang");
  const [genericTextParam, setGenericTextParam] = useWorkspaceState("src/features/settings/TranslateTab.tsx:TranslateTab:genericTextParam", "text");
  const [genericResultPath, setGenericResultPath] = useWorkspaceState("src/features/settings/TranslateTab.tsx:TranslateTab:genericResultPath", "data");

  // LLM providers: built-in presets and the user's unlimited custom entries.
  const [llmProviders, setLlmProviders] = useWorkspaceState<LlmProvider[]>("src/features/settings/TranslateTab.tsx:TranslateTab:llmProviders", () => withBuiltInProviders([]));
  const [llmActiveId, setLlmActiveId] = useWorkspaceState("src/features/settings/TranslateTab.tsx:TranslateTab:llmActiveId", () => `preset_${LLM_PRESETS[0].kind}`);

  const [statusMsg, setStatusMsg] = useWorkspaceState("src/features/settings/TranslateTab.tsx:TranslateTab:statusMsg", "");
  const [statusType, setStatusType] = useWorkspaceState<"success" | "error" | "">("src/features/settings/TranslateTab.tsx:TranslateTab:statusType", "");
  const [saving, setSaving] = useWorkspaceState("src/features/settings/TranslateTab.tsx:TranslateTab:saving", false);
  const [testing, setTesting] = useWorkspaceState("src/features/settings/TranslateTab.tsx:TranslateTab:testing", false);
  const [modelIdEditing, setModelIdEditing] = useWorkspaceState("src/features/settings/TranslateTab.tsx:TranslateTab:modelIdEditing", false);
  const translationTargetLanguage = useTranslationTargetLanguage();

  useWorkspaceInitEffect("src/features/settings/TranslateTab.tsx:", () => {
    loadConfig();
  }, []);

  async function loadConfig() {
    try {
      const [cfg, sharedProxy] = await Promise.all([getTranslateConfig(), getGlobalProxy()]);
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
            const providers = withBuiltInProviders(parsed.providers.map((provider: LlmProvider) => normalizeCustomProvider({ ...provider, use_proxy: provider.use_proxy ?? Boolean(sharedProxy) })));
            setLlmProviders(providers);
            const requestedId = typeof parsed.active_id === "string" ? parsed.active_id : "";
            setLlmActiveId(providers.some((provider: LlmProvider) => provider.id === requestedId)
              ? requestedId
              : (providers[0]?.id || ""));
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
          // Custom providers always persist a complete endpoint. `chat_path`
          // remains in the stored schema only for backward compatibility.
          providers: llmProviders.map(normalizeCustomProvider),
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
      await testTranslateConnection(configJson);
      setStatusMsg(t("translate.connectionOk"));
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

  function addCustomProvider() {
    const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setLlmProviders((prev) => [
      ...prev,
      {
        id,
        name: "自定义模型",
        kind: "custom",
        base_url: "",
        chat_path: "",
        api_key: "",
        model: "",
        mode: "completions",
        use_proxy: false,
      },
    ]);
    setLlmActiveId(id);
  }

  function updateProvider(id: string, patch: Partial<LlmProvider>) {
    setStatusMsg(""); setStatusType("");
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
          <label htmlFor="llm-active-provider" style={labelStyle}>当前大模型</label>
          <select
            id="llm-active-provider"
            style={inputStyle}
            value={selected?.id || ""}
            onChange={(event) => {
              setStatusMsg(""); setStatusType("");
              const value = event.target.value;
              if (value === "__add_custom") addCustomProvider();
              else setLlmActiveId(value);
            }}
          >
            {!selected && <option value="">请选择大模型</option>}
            <optgroup label="预设服务商">
              {llmProviders.filter((provider) => provider.kind !== "custom").map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name || provider.model || "未命名模型"}</option>
              ))}
            </optgroup>
            <optgroup label="我的自定义模型">
              {llmProviders.filter((provider) => provider.kind === "custom").map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name || provider.model || "未命名自定义模型"}</option>
              ))}
              <option value="__add_custom">＋ 新增自定义模型</option>
            </optgroup>
          </select>
        </div>
        <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: 0, marginBottom: "12px" }}>
          预设服务商可以直接选择和配置，模型 ID 可选择预设值，也可自行输入。“我的自定义模型”支持继续新增其他接口。
        </p>
        {!selected && (
          <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
            请选择一个预设服务商，或新增自定义模型。
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
                {(selected.kind === "custom" || llmProviders.filter((provider) => provider.kind === selected.kind).length > 1) && <button
                  type="button"
                  style={{ ...buttonStyle, background: "rgba(220,53,69,0.12)", color: "#dc3545" }}
                  onClick={() => removeProvider(selected.id)}
                >
                  删除
                </button>}
              </div>
              <div style={fieldGroupStyle}>
                <label htmlFor="llm-model-id" style={labelStyle}>模型 ID</label>
                {selected.kind === 'custom' ? <CustomModelIds key={selected.id} provider={selected} onChange={patch => updateProvider(selected.id, patch)} onEditingChange={setModelIdEditing} /> : <><input
                  id="llm-model-id"
                  type="text"
                  list={preset ? "llm-model-suggestions" : undefined}
                  style={inputStyle}
                  value={selected.model}
                  onChange={(e) => updateProvider(selected.id, { model: e.target.value })}
                  placeholder="输入服务商提供的模型 ID"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="llm-model-id-help"
                />
                {preset && <datalist id="llm-model-suggestions">
                  {preset.models.map((model) => <option key={model} value={model} />)}
                </datalist>}
                <p id="llm-model-id-help" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-text-secondary)" }}>
                  可直接输入或修改模型 ID；预设建议不会限制你使用服务商的新模型。
                </p></>}
              </div>
              <div style={fieldGroupStyle}>
                <label htmlFor="llm-api-key" style={labelStyle}>API Key（必填）</label>
                <input
                  id="llm-api-key"
                  style={inputStyle}
                  type="password"
                  value={selected.api_key}
                  onChange={(e) => updateProvider(selected.id, { api_key: e.target.value })}
                  placeholder="sk-..."
                  autoComplete="current-password"
                />
              </div>
              <div style={fieldGroupStyle}>
                <label htmlFor="llm-endpoint" style={labelStyle}>完整接口地址</label>
                <input
                  id="llm-endpoint"
                  style={{ ...inputStyle, opacity: preset ? 0.7 : 1 }}
                  value={selected.base_url}
                  onChange={(e) => updateProvider(selected.id, { base_url: e.target.value })}
                  placeholder="https://api.example.com/v1/chat/completions"
                  readOnly={!!preset}
                  autoComplete="off"
                />
                {selected.kind === "custom" && (
                  <div style={{ color: "var(--text-tertiary)", fontSize: 12, marginTop: 5, lineHeight: 1.45 }}>
                    请填写完整的 Chat Completions 地址，例如 https://api.example.com/v1/chat/completions。
                    本机和私有局域网也支持 HTTP；公网接口必须使用 HTTPS。
                  </div>
                )}
                {selected.base_url.trim().toLowerCase().startsWith("http://") && (
                  <p role="note" style={{ color: "#b45309", fontSize: 12 }}>HTTP 不加密，API Key、提示词和邮件内容将以明文传输。仅在您信任的本机或局域网使用。</p>
                )}
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <input type="checkbox" checked={selected.use_proxy ?? false}
                  onChange={(e) => updateProvider(selected.id, { use_proxy: e.target.checked })} />
                使用代理
              </label>
              <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-text-secondary)" }}>
                勾选后，此模型使用“设置 → 代理”中的地址；不勾选则直接连接。
              </p>
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
        <label htmlFor="translation-default-target" style={labelStyle}>{t("translate.defaultTarget", "Default translation language")}</label>
        <select
          id="translation-default-target"
          style={inputStyle}
          value={translationTargetLanguage}
          onChange={(event) => setTranslationTargetLanguage(event.target.value)}
        >
          {TRANSLATION_TARGET_LANGUAGES.map((language) => (
            <option key={language.value} value={language.value}>{language.label}</option>
          ))}
        </select>
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-text-secondary)" }}>
          {t("translate.defaultTargetHelp", "Applies to whole emails and selected text. The source language is detected automatically. Available languages depend on your translation service.")}
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
          disabled={saving || testing}
        >
          {PROVIDER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Dynamic provider fields */}
      <fieldset disabled={saving || testing} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        {renderProviderFields()}
      </fieldset>

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
          disabled={saving || testing || modelIdEditing}
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
        <button
          title="使用当前填写的配置发起一次实际请求，并遵循该模型的代理选择。测试不会自动保存配置，可能消耗服务商额度。"
          style={{
            ...buttonStyle,
            background: "var(--color-bg-hover)",
            color: "var(--color-text-primary)",
            opacity: testing ? 0.6 : 1,
          }}
          onClick={handleTest}
          disabled={testing || saving || modelIdEditing}
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
