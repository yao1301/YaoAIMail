import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SlidersHorizontal } from "lucide-react";
import { useMailStore, type SearchRange } from "@/stores/mail.store";
import type { AdvancedSearchQuery } from "@/lib/api";

interface Props {
  /** 当前搜索输入框的关键词（用于"主题包含 xxx"等快捷条件）。 */
  query: string;
  /** 触发搜索（调用方负责跳转 SearchView）。 */
  onSearch: (params: { query: string; filters: AdvancedSearchQuery }) => void;
  /** 高级筛选入口（SearchView 里展开完整筛选面板）。 */
  onAdvanced?: () => void;
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}
function startOfWeek(): number {
  const d = new Date();
  const day = d.getDay() || 7; // 周一=1 … 周日=7
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (day - 1));
  return Math.floor(d.getTime() / 1000);
}
function startOfMonth(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return Math.floor(d.getTime() / 1000);
}

const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: "var(--color-text-tertiary)",
  padding: "2px 12px", textTransform: "uppercase", letterSpacing: "0.4px",
};

const itemStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, width: "100%",
  padding: "8px 12px", border: "none", background: "transparent",
  color: "var(--color-text-primary)", fontSize: 13, textAlign: "left",
  cursor: "pointer", borderRadius: 0,
};
const itemDisabledStyle: React.CSSProperties = { ...itemStyle, color: "var(--color-text-tertiary)", cursor: "default", opacity: 0.55 };

/**
 * 内联搜索筛选下拉：点击按钮立即展开。
 * - 搜索范围：当前文件夹 / 当前账号 / 全部账号，点一下即切换（auto 跟随侧边栏）
 * - 快速筛选：主题/发件人/收件人/正文包含关键词、仅看有附件、今天/本周/本月
 * 点条件即执行搜索（调用方跳 SearchView），无需二次确认。
 */
export default function SearchFilterDropdown({ query, onSearch, onAdvanced }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const searchScope = useMailStore((s) => s.searchScope);
  const searchRange = useMailStore((s) => s.searchRange);
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const q = query.trim();

  // 当前生效范围（与 SearchView 计算一致）
  const effectiveKind: "folder" | "account" | "all" =
    searchRange === "folder" ? "folder"
      : searchRange === "account" ? "account"
        : searchRange === "all" ? "all"
          : searchScope?.kind === "folder" ? "folder"
            : searchScope?.kind === "account" ? "account"
              : activeAccountId ? "account"
                : "all";

  function setRange(range: SearchRange) {
    useMailStore.getState().setSearchRange(range);
    // 范围是"预设"：SearchView 的查询键包含范围，切过去/输入后搜索自然用新范围。
  }

  function searchWith(filters: AdvancedSearchQuery, nextQuery: string) {
    setOpen(false);
    onSearch({ query: nextQuery, filters });
  }

  function toggle() {
    setOpen((current) => !current);
  }

  function rangeButton(kind: "folder" | "account" | "all", label: string, onClick: () => void) {
    const active = effectiveKind === kind;
    return (
      <button
        type="button"
        onClick={onClick}
        style={{
          flex: 1, padding: "5px 8px", border: "1px solid",
          borderColor: active ? "var(--color-accent)" : "var(--color-border)",
          borderRadius: 5, background: active ? "color-mix(in srgb, var(--color-accent) 10%, transparent)" : "transparent",
          color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
          fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t("search.filters", "筛选")}
        aria-label={t("search.filters", "筛选")}
        className="search-toolbar-button"
        style={{ color: open ? "var(--color-accent)" : undefined }}
      >
        <SlidersHorizontal size={14} />
      </button>

      {open && (
        <>
          {/* 点击外部关闭 */}
          <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
          <div
            role="menu"
            style={{
              position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 50,
              width: 260, padding: "6px 0",
              background: "var(--color-bg)", border: "1px solid var(--color-border)",
              borderRadius: 8, boxShadow: "0 10px 26px rgba(0,0,0,0.15)",
              display: "flex", flexDirection: "column", gap: 1,
            }}
          >
            {/* 搜索范围 */}
            <div style={labelStyle}>搜索范围</div>
            <div style={{ display: "flex", gap: 4, padding: "4px 12px 6px" }}>
              {searchScope?.kind === "folder" && rangeButton("folder", "当前文件夹", () => setRange("folder"))}
              {rangeButton("account", "当前账号", () => setRange("account"))}
              {rangeButton("all", "全部账号", () => setRange("all"))}
            </div>

            <div style={{ height: 1, background: "var(--color-border)", margin: "4px 0" }} />

            {/* 快速筛选 */}
            <div style={labelStyle}>快速筛选</div>
            {q ? (
              <>
                <button type="button" role="menuitem" style={itemStyle} onClick={() => searchWith({ subject: q }, "")}>
                  主题包含 “{q}”
                </button>
                <button type="button" role="menuitem" style={itemStyle} onClick={() => searchWith({ from: q }, "")}>
                  发件人包含 “{q}”
                </button>
                <button type="button" role="menuitem" style={itemStyle} onClick={() => searchWith({ to: q }, "")}>
                  收件人包含 “{q}”
                </button>
                <button type="button" role="menuitem" style={itemStyle} onClick={() => searchWith({}, q)}>
                  正文包含 “{q}”
                </button>
              </>
            ) : (
              <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", padding: "6px 12px" }}>
                先输入关键词，可按主题 / 发件人 / 收件人 / 正文精确筛选
              </div>
            )}

            <div style={{ height: 1, background: "var(--color-border)", margin: "4px 0" }} />

            <button
              type="button"
              role="menuitem"
              style={q ? itemStyle : itemDisabledStyle}
              disabled={!q}
              onClick={() => searchWith({ hasAttachment: true }, q)}
            >
              仅看有附件
            </button>

            <div style={{ display: "flex", gap: 4, padding: "4px 12px" }}>
              <button type="button" style={{ ...itemStyle, flex: 1, textAlign: "center", padding: "6px 4px" }} onClick={() => searchWith({ dateFrom: startOfToday() }, q)}>
                今天
              </button>
              <button type="button" style={{ ...itemStyle, flex: 1, textAlign: "center", padding: "6px 4px" }} onClick={() => searchWith({ dateFrom: startOfWeek() }, q)}>
                本周
              </button>
              <button type="button" style={{ ...itemStyle, flex: 1, textAlign: "center", padding: "6px 4px" }} onClick={() => searchWith({ dateFrom: startOfMonth() }, q)}>
                本月
              </button>
            </div>

            {onAdvanced && (
              <>
                <div style={{ height: 1, background: "var(--color-border)", margin: "4px 0" }} />
                <button
                  type="button"
                  role="menuitem"
                  style={itemStyle}
                  onClick={() => { setOpen(false); onAdvanced(); }}
                >
                  高级筛选…
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
