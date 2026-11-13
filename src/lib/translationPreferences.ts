import { useSyncExternalStore } from "react";
import { profileLocalStorage, subscribeProfileLocalStorage } from "@/lib/profileStorage";
import { findMailLanguage } from "@/lib/mailLanguages";
export { MAIL_LANGUAGES as TRANSLATION_TARGET_LANGUAGES } from "@/lib/mailLanguages";

export const TRANSLATION_TARGET_LANGUAGE_KEY = "yao-translation-target-language";

export function getTranslationTargetLanguage(): string {
  const saved = profileLocalStorage.getItem(TRANSLATION_TARGET_LANGUAGE_KEY);
  return findMailLanguage(saved ?? "")?.value ?? "zh";
}

export function setTranslationTargetLanguage(language: string) {
  profileLocalStorage.setItem(TRANSLATION_TARGET_LANGUAGE_KEY, findMailLanguage(language)?.value ?? "zh");
}

function subscribe(listener: () => void) {
  return subscribeProfileLocalStorage((key) => {
    if (key === null || key === TRANSLATION_TARGET_LANGUAGE_KEY) listener();
  }, true);
}

export function useTranslationTargetLanguage() {
  return useSyncExternalStore(subscribe, getTranslationTargetLanguage);
}
