// Built-in LLM provider presets for the 外贸邮 (Waimaoyou) AI client.
// Addresses and model IDs are kept current with each provider's official docs.
// Last verified: 2026-08-04.

export type ProviderKind = "openai" | "deepseek" | "gemini" | "custom";

export interface LlmPreset {
  kind: Exclude<ProviderKind, "custom">;
  label: string;
  baseUrl: string;
  chatPath: string;
  models: string[];
  docUrl: string;
}

export const LLM_PRESETS: LlmPreset[] = [
  {
    kind: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    chatPath: "/chat/completions",
    models: [
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4o",
      "gpt-4o-mini",
      "o3",
      "o4-mini",
    ],
    docUrl: "https://platform.openai.com/docs/models",
  },
  {
    kind: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    chatPath: "/chat/completions",
    models: [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner",
    ],
    docUrl: "https://api-docs.deepseek.com/",
  },
  {
    kind: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    chatPath: "/chat/completions",
    models: [
      "gemini-3.6-flash",
      "gemini-3.1-pro",
      "gemini-3.1-flash-lite",
      "gemini-3-flash",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ],
    docUrl: "https://ai.google.dev/gemini-api/docs/openai",
  },
];

export function getPreset(kind: ProviderKind): LlmPreset | undefined {
  return LLM_PRESETS.find((p) => p.kind === kind);
}
