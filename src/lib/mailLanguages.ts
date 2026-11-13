export const MAIL_LANGUAGES = [
  { value: "zh", label: "简体中文", name: "Simplified Chinese" },
  { value: "zh-Hant", label: "繁體中文", name: "Traditional Chinese" },
  { value: "en", label: "English", name: "English" },
  { value: "ja", label: "日本語", name: "Japanese" },
  { value: "ko", label: "한국어", name: "Korean" },
  { value: "fr", label: "Français", name: "French" },
  { value: "de", label: "Deutsch", name: "German" },
  { value: "es", label: "Español", name: "Spanish" },
  { value: "pt", label: "Português", name: "Portuguese" },
  { value: "pt-BR", label: "Português (Brasil)", name: "Brazilian Portuguese" },
  { value: "it", label: "Italiano", name: "Italian" },
  { value: "nl", label: "Nederlands", name: "Dutch" },
  { value: "pl", label: "Polski", name: "Polish" },
  { value: "cs", label: "Čeština", name: "Czech" },
  { value: "ro", label: "Română", name: "Romanian" },
  { value: "sv", label: "Svenska", name: "Swedish" },
  { value: "el", label: "Ελληνικά", name: "Greek" },
  { value: "tr", label: "Türkçe", name: "Turkish" },
  { value: "ru", label: "Русский", name: "Russian" },
  { value: "uk", label: "Українська", name: "Ukrainian" },
  { value: "ar", label: "العربية", name: "Arabic" },
  { value: "he", label: "עברית", name: "Hebrew" },
  { value: "hi", label: "हिन्दी", name: "Hindi" },
  { value: "id", label: "Bahasa Indonesia", name: "Indonesian" },
  { value: "ms", label: "Bahasa Melayu", name: "Malay" },
  { value: "th", label: "ไทย", name: "Thai" },
  { value: "vi", label: "Tiếng Việt", name: "Vietnamese" },
] as const;

export function findMailLanguage(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "中文" || normalized === "zh-cn" || normalized === "zh-hans") return MAIL_LANGUAGES[0];
  if (normalized === "zh-tw" || normalized === "繁体中文") return MAIL_LANGUAGES[1];
  return MAIL_LANGUAGES.find((language) =>
    [language.value, language.label, language.name].some((alias) => alias.toLowerCase() === normalized),
  );
}

export function writingLanguageInstruction(value: string): string {
  const selected = findMailLanguage(value);
  const priority = selected
    ? `用户本次指令明确指定语言时按指令，否则使用所选语言 ${selected.name}（${selected.label}）。`
    : "用户本次指令明确指定语言时按指令。回复时沿用当前来信最新正文的语言，忽略旧引用、签名和界面语言。续写时沿用当前草稿正文语言。新邮件根据明确的联系人语言习惯或本次业务语境判断，缺少依据时使用英文。";
  return `【邮件语言】${priority} 主题（如需生成）和正文使用相同语言。保留必要的姓名、公司名、型号、专有名词和原文引用；除非用户要求双语，正文使用一种语言。`;
}
