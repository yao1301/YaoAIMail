import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Message } from "@/lib/api";
import { useBilingualTranslation } from "@/hooks/useBilingualTranslation";
import { setTranslationTargetLanguage } from "@/lib/translationPreferences";
import { profileLocalStorage } from "@/lib/profileStorage";

const { translateText } = vi.hoisted(() => ({ translateText: vi.fn() }));
vi.mock("@/lib/api", () => ({ translateText }));

beforeEach(() => {
  localStorage.clear();
  translateText.mockReset();
});

it("translates an entire message to the selected language independently of the UI", async () => {
  profileLocalStorage.setItem("pebble-language", "en");
  setTranslationTargetLanguage("vi");
  translateText.mockResolvedValue({ translated: "Vui lòng xác nhận đơn hàng.", segments: [] });
  const message = { body_text: "Merci de confirmer la commande." } as Message;
  const { result } = renderHook(() => useBilingualTranslation("multilingual-mail", null, message));
  await act(async () => { await result.current.handleBilingualToggle(); });

  expect(translateText).toHaveBeenCalledWith(message.body_text, "auto", "vi");
  expect(result.current.bilingualResult?.translated).toBe("Vui lòng xác nhận đơn hàng.");

  act(() => setTranslationTargetLanguage("ar"));
  expect(result.current.bilingualResult).toBeNull();
  translateText.mockResolvedValue({ translated: "يرجى تأكيد الطلب.", segments: [] });
  await act(async () => { await result.current.handleBilingualToggle(); });
  expect(translateText).toHaveBeenLastCalledWith(message.body_text, "auto", "ar");
  expect(result.current.bilingualResult?.translated).toBe("يرجى تأكيد الطلب.");
});
