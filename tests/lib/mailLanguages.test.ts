import { beforeEach, expect, it } from "vitest";
import { writingLanguageInstruction } from "@/lib/mailLanguages";
import { getWritingPreferences, saveWritingPreferences } from "@/lib/writingPreferences";

beforeEach(() => localStorage.clear());

it("restores prior language settings and sends an unambiguous instruction for the new targets", () => {
  for (const [saved, code, name] of [
    ["简体中文", "zh", "Simplified Chinese"],
    ["English", "en", "English"],
    ["Português", "pt", "Portuguese"],
    ["العربية", "ar", "Arabic"],
    ["pt-BR", "pt-BR", "Brazilian Portuguese"],
    ["vi", "vi", "Vietnamese"],
  ]) {
    saveWritingPreferences("fixture", { language: saved });
    const setting = getWritingPreferences("fixture");
    expect(setting.language).toBe(code);
    expect(writingLanguageInstruction(setting.language)).toContain(name);
  }
});
