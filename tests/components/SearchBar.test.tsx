import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SearchBar from "../../src/components/SearchBar";

const mocks = vi.hoisted(() => ({
  setActiveView: vi.fn(),
  setSearchQuery: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock("../../src/stores/ui.store", () => {
  const state = {
    setActiveView: mocks.setActiveView,
    setSearchQuery: mocks.setSearchQuery,
  };
  const useUIStore = (selector: (current: typeof state) => unknown) => selector(state);
  useUIStore.getState = () => state;
  return { useUIStore };
});

describe("SearchBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the inline advanced filter from the shared inbox toolbar", () => {
    render(<SearchBar onSearch={vi.fn()} onClear={vi.fn()} />);

    const advancedButton = screen.getByRole("button", { name: "筛选" });

    expect(advancedButton.className).toContain("search-toolbar-button");

    fireEvent.click(advancedButton);

    expect(advancedButton.getAttribute("aria-expanded")).toBe("true");
  });
});
