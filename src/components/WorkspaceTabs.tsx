import { X, FilePenLine, Mail, XCircle, ChevronsLeft, ChevronsRight, Layers, Folder, LayoutGrid } from "lucide-react";
import { useState } from "react";
import { useMessageQuery } from "@/hooks/queries";
import { useComposeStore, type ComposeTab } from "@/stores/compose.store";
import { useMailStore } from "@/stores/mail.store";
import { useUIStore } from "@/stores/ui.store";
import type { ActiveView } from "@/stores/ui.store";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import { isComposeWorkspaceTabActive, isMessageWorkspaceTabActive } from "./workspaceTabActivity";

function activeTabStyle(active: boolean) {
  return {
    borderBottom: active ? "3px solid var(--color-accent)" : "3px solid transparent",
    background: active ? "color-mix(in srgb, var(--color-accent) 9%, var(--color-bg))" : "var(--color-bg-secondary)",
    color: active ? "var(--color-accent)" : "var(--color-text-primary)",
    fontWeight: active ? 650 : 400,
    boxShadow: active ? "inset 0 -1px 0 var(--color-accent)" : "none",
  } as const;
}

/** 写信标签标题：回复/转发带原主题，新建显示固定文案。 */
function composeTabTitle(tab: ComposeTab): string {
  const subject = tab.replyTo?.subject?.replace(/^(Re:\s*|Fwd:\s*)+/i, "");
  if (subject) {
    if (tab.mode === "reply" || tab.mode === "reply-all") return `回复: ${subject}`;
    if (tab.mode === "forward") return `转发: ${subject}`;
  }
  if (tab.prefill?.subject) return tab.prefill.subject;
  return tab.mode === "new" ? "写新邮件" : "写邮件";
}

/** 当前标签栏顺序：文件夹/功能标签 + 邮件标签 + 写信标签。 */
function getTabOrder(): string[] {
  const ui = useUIStore.getState();
  const mail = useMailStore.getState();
  const compose = useComposeStore.getState();
  return [
    ...ui.navTabs.map((tab) => tab.key),
    ...mail.openMessageIds,
    ...compose.tabs.map((tab) => tab.id),
  ];
}

/** 跨类型关闭：关闭本标签右侧/左侧/其他/所有标签（含文件夹、功能、邮件、写邮件）。 */
function closeTabsByRule(anchorKey: string, rule: "right" | "left" | "other" | "all") {
  const order = getTabOrder();
  const idx = order.indexOf(anchorKey);
  if (rule !== "all" && idx < 0) return;
  const keep = rule === "all"
    ? []
    : rule === "right"
      ? order.slice(0, idx + 1)
      : rule === "left"
        ? order.slice(idx)
        : [anchorKey];
  const keepSet = new Set(keep);
  const ui = useUIStore.getState();
  const mail = useMailStore.getState();
  const compose = useComposeStore.getState();
  ui.setNavTabs(ui.navTabs.filter((tab) => keepSet.has(tab.key)));
  for (const id of mail.openMessageIds) {
    if (!keepSet.has(id)) mail.closeMessageTab(id);
  }
  for (const tab of compose.tabs) {
    if (!keepSet.has(tab.id)) useComposeStore.getState().forceCloseCompose(tab.id);
  }
  // 视图修正：当前激活的标签被关闭时，回收件箱
  const view = ui.activeView;
  const stillOpen =
    view === "inbox"
      ? true
      : view === "messageDetail"
        ? !!mail.selectedMessageId && keepSet.has(mail.selectedMessageId)
        : view === "compose"
          ? !!compose.activeTabId && keepSet.has(compose.activeTabId)
          : ui.navTabs.some((tab) => tab.key === `feature:${view}`);
  if (!stillOpen) ui.setActiveView("inbox");
}

/** 标签通用右键菜单。 */
function buildTabMenu(anchorKey: string, canCloseSelf: boolean, onCloseSelf: () => void): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (canCloseSelf) {
    items.push({ label: "关闭标签", icon: <XCircle size={14} />, onClick: onCloseSelf });
    items.push({ separator: true });
  }
  items.push(
    {
      label: "关闭右侧所有标签",
      icon: <ChevronsRight size={14} />,
      onClick: () => closeTabsByRule(anchorKey, "right"),
    },
    {
      label: "关闭左侧所有标签",
      icon: <ChevronsLeft size={14} />,
      onClick: () => closeTabsByRule(anchorKey, "left"),
    },
    {
      label: "关闭其他标签",
      icon: <Layers size={14} />,
      onClick: () => closeTabsByRule(anchorKey, "other"),
    },
    { separator: true },
    {
      label: "关闭所有标签",
      icon: <XCircle size={14} />,
      onClick: () => closeTabsByRule(anchorKey, "all"),
    },
  );
  return items;
}

function MessageTab({ messageId }: { messageId: string }) {
  const { data: message } = useMessageQuery(messageId);
  const closeMessageTab = useMailStore((state) => state.closeMessageTab);
  const activeView = useUIStore((state) => state.activeView);
  const messageDetailId = useUIStore((state) => state.messageDetailId);
  const active = isMessageWorkspaceTabActive(activeView, messageDetailId, messageId);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <>
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => {
        useMailStore.getState().setSelectedMessage(messageId);
        // 全屏标签（双击/右键打开）点击后回到详情视图；普通标签回列表视图。
        if (useUIStore.getState().messageDetailId === messageId) {
          useUIStore.getState().navigateToView("messageDetail");
        } else {
          useUIStore.getState().navigateToView("inbox");
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      title={message?.subject || "邮件"}
      style={{
        display: "flex", alignItems: "center", gap: "6px", minWidth: "120px", maxWidth: "220px",
        padding: "7px 8px", border: "none", borderRight: "1px solid var(--color-border)",
        ...activeTabStyle(active), cursor: "pointer",
      }}
    >
      <Mail size={13} />
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
        {message?.subject || "正在读取…"}
      </span>
      <span
        role="button"
        tabIndex={0}
        onClick={(event) => { event.stopPropagation(); closeMessageTab(messageId); }}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.stopPropagation(); closeMessageTab(messageId); }
        }}
        style={{ display: "flex", padding: "2px", borderRadius: "3px" }}
      >
        <X size={12} />
      </span>
    </button>
    {menu && (
      <ContextMenu x={menu.x} y={menu.y} items={buildTabMenu(messageId, true, () => closeMessageTab(messageId))} onClose={() => setMenu(null)} />
    )}
    </>
  );
}

export default function WorkspaceTabs() {
  const openMessageIds = useMailStore((state) => state.openMessageIds);
  const composeTabs = useComposeStore((state) => state.tabs);
  const activeComposeTabId = useComposeStore((state) => state.activeTabId);
  const activeView = useUIStore((state) => state.activeView);
  const aiBgTask = useUIStore((state) => state.aiBgTask);
  const navTabs = useUIStore((state) => state.navTabs);
  const [menu, setMenu] = useState<{ x: number; y: number; anchorKey: string; canCloseSelf: boolean } | null>(null);
  const hasNav = navTabs.length > 0;
  if (openMessageIds.length === 0 && composeTabs.length === 0 && !hasNav) return null;

  function activateTab(tab: { view: ActiveView; kind: "folder" | "feature"; folderId?: string | null; accountId?: string | null }) {
    // Keep the view and the mail folder in one synchronous navigation action.
    // This prevents the tab label changing while Layout still renders the previous view.
    const ui = useUIStore.getState();
    const mail = useMailStore.getState();
    if (tab.kind === "folder" && tab.folderId) {
      if (tab.accountId) {
        mail.setActiveAccountId(tab.accountId);
      }
      mail.setActiveFolderId(tab.folderId);
    }
    ui.navigateToView(tab.view);
  }

  return (
    <div className="scroll-region" style={{ display: "flex", flex: "0 0 auto", overflowX: "auto", minHeight: "35px", borderBottom: "1px solid var(--color-border)", background: "var(--color-bg-secondary)" }}>
      {navTabs.map((tab) => {
        const active = tab.kind === "folder" ? activeView === "inbox" : activeView === tab.view;
        return (
          <button
            key={tab.key}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => {
              activateTab(tab);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, anchorKey: tab.key, canCloseSelf: true });
            }}
            title={tab.label}
            style={{
              display: "flex", alignItems: "center", gap: "6px", minWidth: "90px", maxWidth: "200px",
              padding: "7px 8px", border: "none", borderRight: "1px solid var(--color-border)",
              ...activeTabStyle(active), cursor: "pointer",
            }}
          >
            {tab.kind === "folder" ? <Folder size={13} /> : <LayoutGrid size={13} />}
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
              {tab.label}
            </span>
            {tab.kind === "feature" && (
              <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  useUIStore.getState().removeNavTab(tab.key);
                  if (activeView === tab.view) useUIStore.getState().setActiveView("inbox");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.stopPropagation(); useUIStore.getState().removeNavTab(tab.key); }
                }}
                style={{ display: "flex", padding: "2px", borderRadius: "3px" }}
              >
                <X size={12} />
              </span>
            )}
          </button>
        );
      })}
      {openMessageIds.map((messageId) => <MessageTab key={messageId} messageId={messageId} />)}
      {composeTabs.map((tab) => {
        const active = isComposeWorkspaceTabActive(activeView, activeComposeTabId, tab.id);
        return (
          <button
            key={tab.id}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => {
              useComposeStore.getState().activateComposeTab(tab.id);
              useUIStore.getState().setActiveView("compose");
              // 切回写信页时若 AI 后台已完成，自动应用结果
              const task = useUIStore.getState().aiBgTask;
              if (task && !task.running && task.result) {
                useUIStore.getState().setPendingAiDraft(task.result);
                useUIStore.getState().setAiBgTask(null);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, anchorKey: tab.id, canCloseSelf: true });
            }}
            title={composeTabTitle(tab)}
            style={{
              display: "flex", alignItems: "center", gap: "6px", minWidth: "130px", maxWidth: "220px",
              padding: "7px 8px", border: "none", borderRight: "1px solid var(--color-border)",
              ...activeTabStyle(active), cursor: "pointer",
            }}
          >
            <FilePenLine size={13} />
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
              {composeTabTitle(tab)}
            </span>
            {active && aiBgTask?.running && aiBgTask.source === "compose" && (
              <span className="spinner" style={{ width: 12, height: 12, border: "2px solid var(--color-border)", borderTopColor: "var(--color-accent)", borderRadius: "50%", display: "inline-block" }} title="AI 生成中…" />
            )}
            {active && aiBgTask && !aiBgTask.running && aiBgTask.source === "compose" && aiBgTask.result && (
              <span style={{ fontSize: 10, color: "#22c55e", fontWeight: 600 }} title="AI 生成完成，点击返回写信页查看">AI✓</span>
            )}
            <span
              role="button"
              tabIndex={0}
              onClick={(event) => { event.stopPropagation(); useComposeStore.getState().closeCompose(tab.id); }}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.stopPropagation(); useComposeStore.getState().closeCompose(tab.id); }
              }}
              style={{ display: "flex", padding: "2px", borderRadius: "3px" }}
            >
              <X size={12} />
            </span>
          </button>
        );
      })}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildTabMenu(
            menu.anchorKey,
            menu.canCloseSelf,
            () => {
              if (menu.anchorKey.startsWith("compose-")) {
                useComposeStore.getState().closeCompose(menu.anchorKey);
              } else if (menu.anchorKey.startsWith("feature:") || menu.anchorKey === "folder") {
                useUIStore.getState().removeNavTab(menu.anchorKey);
                if (menu.anchorKey === "folder" && useUIStore.getState().activeView === "inbox") {
                  // 文件夹标签关闭后回收件箱视图但无标签，点击文件夹可重建
                }
              } else {
                useMailStore.getState().closeMessageTab(menu.anchorKey);
              }
            },
          )}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
