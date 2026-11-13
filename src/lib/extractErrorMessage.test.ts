import { describe, expect, it } from "vitest";
import { extractErrorMessage } from "./extractErrorMessage";

describe("extractErrorMessage", () => {
  it("unwraps nested Tauri and provider errors instead of rendering object Object", () => {
    expect(extractErrorMessage({
      kind: "Translate",
      message: { error: { message: "Model is not available for this API key" } },
    })).toBe("Model is not available for this API key");
  });

  it("keeps ordinary errors readable", () => {
    expect(extractErrorMessage(new Error("Connection timed out"))).toBe("Connection timed out");
  });
});
