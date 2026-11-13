import { useWorkspaceState } from '@/lib/workspaceState';
import { useCallback, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { Search, Loader, ArrowUp, ArrowDown, Paperclip, SlidersHorizontal } from "lucide-react";
import type { Account, AdvancedSearchQuery, Folder, SearchHit } from "@/lib/api";
import { advancedSearch, deleteMessage, listAccounts, listFolders, searchMessages } from "@/lib/api";
import { useToastStore } from "@/stores/toast.store";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { useUIStore } from "@/stores/ui.store";
import SearchFilters from "./SearchFilters";
import SearchResultItem from "./SearchResultItem";
import MessageDetail from "@/components/MessageDetail";
import { useMailStore } from "@/stores/mail.store";
import SearchFilterDropdown from "@/components/SearchFilterDropdown";
import SearchMessageContextMenu from "./SearchMessageContextMenu";
import { MessageDeletionNavigationContext, useMessageDeletionNavigation } from "@/hooks/useMessageDeletionNavigation";

type SearchSortKey = "date" | "subject" | "attachments";

const emptyFilters: AdvancedSearchQuery = {};

function hasActiveFilters(filters: AdvancedSearchQuery): boolean {
  return !!(
    filters.from ||
    filters.to ||
    filters.subject ||
    filters.text ||
    filters.dateFrom ||
    filters.dateTo ||
    filters.hasAttachment ||
    filters.folderId
  );
}

function readSearchScope() {
  const { activeAccountId, searchScope, searchRange } = useMailStore.getState();
  return { activeAccountId, searchScope, searchRange };
}

export default function SearchView({ isActive = true }: { isActive?: boolean }) {
  const { t } = useTranslation();
  const [query, setQuery] = useWorkspaceState("src/features/search/SearchView.tsx:SearchView:query", "");
  const [scope, setScope] = useWorkspaceState("src/features/search/SearchView.tsx:SearchView:scope", readSearchScope);
  const { activeAccountId, searchScope, searchRange } = scope;
  const pendingSearchFilters = useUIStore((s) => s.pendingSearchFilters);
  const [accounts, setAccounts] = useWorkspaceState<Account[]>("src/features/search/SearchView.tsx:SearchView:accounts", []);
  const [folderNames, setFolderNames] = useWorkspaceState<Record<string, string>>("src/features/search/SearchView.tsx:SearchView:folderNames", {});
  const [folderRoles, setFolderRoles] = useWorkspaceState<Record<string, Folder["role"]>>("src/features/search/SearchView.tsx:SearchView:folderRoles", {});
  const [filters, setFilters] = useWorkspaceState<AdvancedSearchQuery>("src/features/search/SearchView.tsx:SearchView:filters", emptyFilters);
  const [filterOpen, setFilterOpen] = useWorkspaceState("src/features/search/SearchView.tsx:SearchView:filterOpen", false);
  const [searchFocused, setSearchFocused] = useWorkspaceState("src/features/search/SearchView.tsx:SearchView:searchFocused", false);
  const [selectedId, setSelectedId] = useWorkspaceState<string | null>("src/features/search/SearchView.tsx:SearchView:selectedId", null);
  const [messageMenu, setMessageMenu] = useWorkspaceState<{ x: number; y: number; hit: SearchHit } | null>("src/features/search/SearchView.tsx:SearchView:messageMenu", null);
  const [hasSearched, setHasSearched] = useWorkspaceState("src/features/search/SearchView.tsx:SearchView:hasSearched", false);
  const [sort, setSort] = useWorkspaceState<{ key: SearchSortKey; dir: "asc" | "desc" }>("src/features/search/SearchView.tsx:SearchView:sort", { key: "date", dir: "desc" });
  const storeSearchQuery = useUIStore((s) => s.searchQuery);
  const addToast = useToastStore((s) => s.addToast);

  const trimmed = query.trim();
  const filtersActive = hasActiveFilters(filters);
  const searchEnabled = hasSearched && (trimmed.length > 0 || filtersActive);

  useEffect(() => {
    void listAccounts().then((items) => {
      setAccounts(items);
    });
  }, [activeAccountId]);

  useEffect(() => {
    if (accounts.length === 0) return;
    void Promise.all(accounts.map((account) => listFolders(account.id)))
      .then((folderGroups) => {
        const next: Record<string, string> = {};
        const roles: Record<string, Folder["role"]> = {};
        folderGroups.flat().forEach((folder) => { next[folder.id] = folder.name; roles[folder.id] = folder.role; });
        setFolderNames(next);
        setFolderRoles(roles);
      })
      .catch(() => {});
  }, [accounts]);

  // 有效搜索范围：searchRange（内联下拉可切换）> 侧边栏选择 searchScope
  // auto 跟随侧边栏；all = 全部账号（不传 accountId）
  const baseAccountId = searchScope?.accountId ?? activeAccountId ?? undefined;
  const baseFolderId = searchScope?.kind === "folder" ? searchScope.folderId : undefined;
  const isAllRange = searchRange === "all";
  const selectedAccountId = isAllRange ? undefined : baseAccountId;
  const scopedFolderId = isAllRange ? undefined : (searchRange === "account" ? undefined : baseFolderId);
  const effectiveFilters = useMemo(
    () => ({ ...filters, accountId: selectedAccountId, folderId: filters.folderId || scopedFolderId }),
    [filters, scopedFolderId, selectedAccountId],
  );
  const effectiveFiltersActive = filtersActive || Boolean(scopedFolderId);
  const scopeKey = isAllRange ? "all" : searchScope?.kind === "folder" ? `${searchScope.accountId}:${searchScope.folderId}` : searchScope?.accountId || activeAccountId || "all";
  const scopeLabel = isAllRange
    ? t("search.allAccounts", "全部账号")
    : scopedFolderId
      ? `当前文件夹：${folderNames[scopedFolderId] || "当前文件夹"}`
      : selectedAccountId
        ? `当前账号：${accounts.find((account) => account.id === selectedAccountId)?.email || "当前账号"}`
        : t("search.allAccounts", "全部账号");
  const { data: results = [], isLoading: loading, error: queryError, refetch } = useQuery({
    queryKey: ["search", trimmed, effectiveFilters, selectedAccountId, scopeKey],
    queryFn: () => {
      if (effectiveFiltersActive) {
        return advancedSearch({ ...effectiveFilters, text: trimmed || undefined }, 100);
      }
      return searchMessages(trimmed, 100, selectedAccountId);
    },
    enabled: searchEnabled && isActive,
    staleTime: 60_000,
    placeholderData: (prev: SearchHit[] | undefined) => prev,
  });

  const sortedResults = useMemo(() => [...results].sort((a, b) => {
    let comparison = 0;
    if (sort.key === "date") comparison = (a.date ?? 0) - (b.date ?? 0);
    if (sort.key === "subject") comparison = (a.subject ?? "").localeCompare(b.subject ?? "", undefined, { sensitivity: "base" });
    if (sort.key === "attachments") comparison = Number(Boolean(a.has_attachment)) - Number(Boolean(b.has_attachment));
    if (comparison === 0) comparison = (a.subject ?? "").localeCompare(b.subject ?? "", undefined, { sensitivity: "base" });
    return sort.dir === "asc" ? comparison : -comparison;
  }), [results, sort]);
  const prepareDeletion = useMessageDeletionNavigation(sortedResults.map(hit => hit.message_id), {
    selectedId, scopeKey: JSON.stringify([trimmed, effectiveFilters, scopeKey]), onSelect: setSelectedId,
  });

  function toggleSort(key: SearchSortKey) {
    setSort((current) => current.key === key
      ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
      : { key, dir: key === "subject" ? "asc" : "desc" });
  }

  const resultsParentRef = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(0);
  const virtualizer = useVirtualizer({
    useAnimationFrameWithResizeObserver: true,
    count: sortedResults.length,
    getScrollElement: () => resultsParentRef.current,
    estimateSize: () => 76,
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 5,
  });
  useLayoutEffect(() => {
    if (!isActive) return;
    if (resultsParentRef.current) resultsParentRef.current.scrollTop = scrollTop.current;
    virtualizer.measure();
  }, [isActive, virtualizer]);

  const doSearch = useCallback(() => {
    const t = query.trim();
    if (!t && !hasActiveFilters(filters)) {
      setHasSearched(false);
      setSelectedId(null);
      return;
    }
    setHasSearched(true);
    setSelectedId(null);
  }, [query, filters]);

  // Pick up context queries from other views and from this view while mounted.
  const runLocalSearch = useCallback(({ query: q, filters: f }: { query: string; filters: AdvancedSearchQuery }) => {
    setQuery(q);
    setFilters(f);
    setSelectedId(null);
    setHasSearched(true);
  }, []);

  useEffect(() => {
    if (!isActive || !storeSearchQuery) return;
    setScope(readSearchScope());
    setQuery(storeSearchQuery);
    setFilters(pendingSearchFilters ?? emptyFilters);
    setSelectedId(null);
    setHasSearched(true);
    useUIStore.getState().setSearchQuery("");
  }, [storeSearchQuery, isActive]);

  // 内联筛选下拉注入的筛选条件（收件箱/账户页的快捷条件跳转过来时消费）。
  useEffect(() => {
    if (!isActive || !pendingSearchFilters) return;
    setScope(readSearchScope());
    setQuery(storeSearchQuery);
    setFilters(pendingSearchFilters);
    setSelectedId(null);
    setHasSearched(true);
    useUIStore.getState().setPendingSearchFilters(null);
  }, [pendingSearchFilters, isActive]);

  // Auto-search when filters change
  useEffect(() => {
    if (hasActiveFilters(filters) || query.trim()) {
      doSearch();
    }
  }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced type-ahead search (300ms after last keystroke)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (!trimmed && !hasActiveFilters(filters)) return;
    debounceRef.current = setTimeout(() => {
      // A submitted search may already have a selected result; a delayed
      // type-ahead callback must not clear that preview again.
      setHasSearched(true);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    doSearch();
  }

  function handleClearFilters() {
    setFilters(emptyFilters);
  }

  function openFullscreen(messageId: string) {
    useMailStore.getState().setSelectedMessage(messageId);
    useUIStore.getState().setMessageDetailId(messageId);
    useUIStore.getState().navigateToView("messageDetail");
  }

  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" || !selectedId) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true'], select")) return;
      event.preventDefault();
      const id = selectedId;
      const completeDeletion = prepareDeletion([id]);
      void deleteMessage(id).then(() => {
        completeDeletion([id]);
        void refetch();
        addToast({ message: "邮件已移到废纸篓", type: "success" });
      }).catch((error) => {
        completeDeletion([]);
        addToast({ message: `删除失败：${extractErrorMessage(error)}`, type: "error" });
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addToast, refetch, selectedId, prepareDeletion, isActive]);

  return (
    <MessageDeletionNavigationContext.Provider value={prepareDeletion}>
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div className="search-toolbar-wrap">
      <form onSubmit={handleSubmit} className="search-toolbar" style={{ flexWrap: "wrap" }}>
        <div className="search-input-shell" style={{ flex: "1 1 260px" }}>
          <Search size={16} aria-hidden="true" />
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setHasSearched(false); setSelectedId(null); setSearchFocused(true); }}
            placeholder={t("inbox.searchPlaceholder")}
            aria-label={t("search.title", "Search")}
            autoFocus
            className="search-input"
            onFocus={() => setSearchFocused(true)}
            onBlur={() => window.setTimeout(() => setSearchFocused(false), 120)}
          />
        </div>
        <button
          type="submit"
          className="search-toolbar-button search-toolbar-button--primary"
        >
          <Search size={14} aria-hidden="true" />
          {t("search.searchButton")}
        </button>
        <SearchFilterDropdown
          query={query}
          scope={scope}
          onRangeChange={searchRange => { setScope(current => ({ ...current, searchRange })); setSelectedId(null); }}
          onSearch={runLocalSearch}
          onAdvanced={() => setFilterOpen(true)}
        />
      </form>
      <div style={{ padding: "4px 4px 0", color: "var(--color-text-tertiary)", fontSize: "11px" }}>
        搜索范围：{scopeLabel}
      </div>
      {searchFocused && trimmed && !hasSearched && (
        <div className="search-suggestions-menu" role="listbox" aria-label={t("search.quickFilters")}>
          {[
            ["包含", { text: trimmed }],
            ["主题包含", { subject: trimmed }],
            ["邮件正文包含", { text: trimmed }],
            ["发件人包含", { from: trimmed }],
            ["收件人包含", { to: trimmed }],
          ].map(([label, patch]) => (
            <button key={label as string} type="button" className="search-suggestion-item" onMouseDown={(event) => event.preventDefault()} onClick={() => {
              setFilters((current) => ({ ...current, ...(patch as Partial<AdvancedSearchQuery>) }));
              setQuery("");
              setHasSearched(true);
              setSearchFocused(false);
            }}>
              <span>{label as string}</span><strong>{trimmed}</strong>
            </button>
          ))}
          <button type="button" className="search-suggestion-item" onMouseDown={(event) => event.preventDefault()} onClick={() => { setFilterOpen(true); setSearchFocused(false); }}>
            <SlidersHorizontal size={14} /> <span>{t("search.moreFilters", "更多筛选条件")}</span>
          </button>
        </div>
      )}
      {filterOpen && (
        <div className="search-filter-popover">
          <SearchFilters filters={filters} accountId={selectedAccountId} onChange={setFilters} onClear={handleClearFilters} />
        </div>
      )}
      </div>

      {trimmed && (
        <div className="search-smart-suggestions search-smart-suggestions--legacy" aria-label={t("search.quickFilters")}>
          <span className="search-smart-suggestions__label">{t("search.quickFilters")}</span>
          <QuickFilterChip
            label={<>{t("search.quickSubject", "标题包含")} “{trimmed}”</>}
            active={filters.subject === trimmed}
            onApply={() => { setFilters((current) => ({ ...current, subject: trimmed })); setHasSearched(true); }}
            onRemove={() => { setFilters((current) => ({ ...current, subject: undefined })); setHasSearched(true); }}
            removeLabel="取消标题筛选"
          />
          <QuickFilterChip
            label={<><Paperclip size={12} /> {t("search.quickAttachment", "仅看有附件")}</>}
            active={filters.hasAttachment === true}
            onApply={() => { setFilters((current) => ({ ...current, hasAttachment: true })); setHasSearched(true); }}
            onRemove={() => { setFilters((current) => ({ ...current, hasAttachment: undefined })); setHasSearched(true); }}
            removeLabel="取消附件筛选"
          />
          <QuickFilterChip
            label={<>{t("search.quickFrom", "发件人包含")} “{trimmed}”</>}
            active={filters.from === trimmed}
            onApply={() => { setFilters((current) => ({ ...current, from: trimmed })); setHasSearched(true); }}
            onRemove={() => { setFilters((current) => ({ ...current, from: undefined })); setHasSearched(true); }}
            removeLabel="取消发件人筛选"
          />
        </div>
      )}

      {hasSearched && results.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: "6px", padding: "7px 12px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-secondary)", fontSize: "11px" }}>
          <span style={{ marginRight: "3px" }}>排序：</span>
          {(["attachments", "subject", "date"] as SearchSortKey[]).map((key) => {
            const label = key === "date" ? "日期" : key === "subject" ? "主题" : "附件";
            const active = sort.key === key;
            return (
              <SearchSortButton key={key} label={label} icon={key === "attachments" ? <Paperclip size={11} /> : undefined} active={active} dir={active ? sort.dir : null} onClick={() => toggleSort(key)} />
            );
          })}
        </div>
      )}

      {/* Filters panel */}
      {false && (
        <SearchFilters
          filters={filters}
          accountId={selectedAccountId}
          onChange={setFilters}
          onClear={handleClearFilters}
        />
      )}

      {/* Results + Detail split layout */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Results list */}
        <div
          ref={resultsParentRef}
          onScroll={event => { if (isActive) scrollTop.current = event.currentTarget.scrollTop; }}
          className="scroll-region search-results-scroll"
          style={{
            width: selectedId ? "clamp(260px, 32%, 360px)" : "100%",
            flexShrink: 0,
            overflow: "auto",
            borderRight: selectedId ? "1px solid var(--color-border)" : "none",
            transition: "width 0.15s ease",
          }}
        >
          {loading && (
            <div
              className="fade-in"
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "40px",
                color: "var(--color-text-secondary)",
                fontSize: "13px",
                gap: "10px",
              }}
            >
              <Loader size={20} className="spinner" />
              <span>{t("common.loading")}</span>
            </div>
          )}

          {!loading && queryError && (
            <div
              className="fade-in"
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "40px",
                color: "var(--color-text-secondary)",
                fontSize: "14px",
                gap: "8px",
              }}
            >
              <p style={{ color: "var(--color-error, #e53e3e)", margin: 0 }}>
                {t("search.error", "Search failed")}
              </p>
              <p style={{ fontSize: "13px", margin: 0 }}>{queryError?.message}</p>
              <button
                onClick={() => refetch()}
                style={{
                  marginTop: "8px",
                  padding: "6px 16px",
                  borderRadius: "4px",
                  border: "1px solid var(--color-border)",
                  backgroundColor: "transparent",
                  color: "var(--color-accent)",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                {t("common.retry", "Retry")}
              </button>
            </div>
          )}

          {!loading && !queryError && hasSearched && results.length === 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "40px",
                color: "var(--color-text-secondary)",
                fontSize: "14px",
                gap: "8px",
              }}
            >
              <Search size={28} strokeWidth={1.2} />
              {t("search.noResults")}
            </div>
          )}

          {!loading && !hasSearched && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "60px 20px",
                color: "var(--color-text-tertiary)",
                fontSize: "14px",
                gap: "8px",
              }}
            >
              <Search size={32} />
              <span>{t("search.title")}</span>
            </div>
          )}

          {!loading && sortedResults.length > 0 && (
            <div
              role="listbox"
              aria-label={t("search.results", "Search results")}
              style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}
            >
              {virtualizer.getVirtualItems().map((virtualItem) => {
                const hit = sortedResults[virtualItem.index];
                return (
                  <div
                    key={hit.message_id}
                    ref={virtualizer.measureElement}
                    data-index={virtualItem.index}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    <SearchResultItem
                      hit={hit}
                      isSelected={hit.message_id === selectedId}
                      onClick={() => setSelectedId((current) => current === hit.message_id ? null : hit.message_id)}
                      onDoubleClick={() => {
                        openFullscreen(hit.message_id);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setSelectedId(hit.message_id);
                        setMessageMenu({ x: event.clientX, y: event.clientY, hit });
                      }}
                      folderLabel={(hit.folder_ids || []).map((id) => folderNames[id] || id).join(" / ")}
                      query={query}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedId && (
          <div style={{ flex: 1, overflow: "hidden" }}>
            <MessageDetail
              messageId={selectedId}
              onBack={() => setSelectedId(null)}
            />
          </div>
        )}
      </div>
      {isActive && messageMenu && (
        <SearchMessageContextMenu
          x={messageMenu.x}
          y={messageMenu.y}
          messageId={messageMenu.hit.message_id}
          folderIds={messageMenu.hit.folder_ids || []}
          folderRole={(messageMenu.hit.folder_ids || [])
            .map((id) => folderRoles[id])
            .find((role): role is NonNullable<Folder["role"]> => Boolean(role))}
          fallbackLabel={messageMenu.hit.subject || messageMenu.hit.snippet || "邮件"}
          onOpen={() => openFullscreen(messageMenu.hit.message_id)}
          onChanged={() => void refetch()}
          onClose={() => setMessageMenu(null)}
        />
      )}
    </div>
    </MessageDeletionNavigationContext.Provider>
  );
}

function SearchSortButton({ label, icon, active, dir, onClick }: { label: string; icon?: React.ReactNode; active: boolean; dir: "asc" | "desc" | null; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title={`按${label}排序`} style={{ display: "flex", alignItems: "center", gap: 3, padding: "2px 7px", border: "1px solid", borderColor: active ? "var(--color-accent)" : "transparent", borderRadius: 4, background: active ? "color-mix(in srgb, var(--color-accent) 10%, transparent)" : "transparent", color: active ? "var(--color-accent)" : "var(--color-text-secondary)", cursor: "pointer", fontSize: 11 }}>
      {icon}{label}{active && dir && (dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </button>
  );
}

function QuickFilterChip({
  label,
  active,
  onApply,
  onRemove,
  removeLabel,
}: {
  label: React.ReactNode;
  active: boolean;
  onApply: () => void;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 0, borderRadius: 5, background: active ? "color-mix(in srgb, var(--color-accent) 12%, transparent)" : "transparent" }}>
      <button type="button" onClick={onApply} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
        {label}
      </button>
      {active && (
        <button
          type="button"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={(event) => { event.stopPropagation(); onRemove(); }}
          style={{ border: 0, background: "transparent", color: "var(--color-accent)", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "1px 5px 2px 1px" }}
        >
          ×
        </button>
      )}
    </span>
  );
}
