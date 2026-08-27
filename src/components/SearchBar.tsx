import { useState } from "react";
import { Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "@/stores/ui.store";
import SearchFilterDropdown from "./SearchFilterDropdown";
import type { AdvancedSearchQuery } from "@/lib/api";

interface Props {
  onSearch: (query: string) => void;
  onClear: () => void;
}

export default function SearchBar({ onSearch, onClear }: Props) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const setActiveView = useUIStore((s) => s.setActiveView);

  /** 跳转搜索页：query + 可选筛选条件一起带过去。 */
  function navigateToSearch(query: string, filters: AdvancedSearchQuery = {}) {
    useUIStore.getState().setSearchQuery(query);
    useUIStore.getState().setPendingSearchFilters(filters);
    setActiveView("search");
  }

  function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (value.trim()) {
      onSearch(value.trim());
      navigateToSearch(value.trim());
    }
  }

  function handleClear() {
    setValue("");
    onClear();
  }

  return (
    <form onSubmit={handleSubmit} className="search-toolbar">
      <div className="search-input-shell">
        <Search size={15} aria-hidden="true" />
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("inbox.searchPlaceholder", "Search messages...")}
          aria-label={t("search.title", "Search")}
          className="search-input"
        />
      </div>
      {value && (
        <button
          type="button"
          onClick={handleClear}
          aria-label={t("search.clearFilters", "Clear filters")}
          className="search-toolbar-button search-toolbar-icon-button"
        >
          <X size={14} />
        </button>
      )}
      {/* 内联筛选下拉：范围切换 + 快捷条件，点一下立即搜索 */}
      <SearchFilterDropdown
        query={value}
        onSearch={({ query, filters }) => navigateToSearch(query, filters)}
      />
    </form>
  );
}
