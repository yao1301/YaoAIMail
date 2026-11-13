import DetachableTab, { detachTab } from './DetachableTab';
import { X, FilePenLine, Mail, XCircle, ChevronsLeft, ChevronsRight, Layers, Folder, LayoutGrid, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { openMailWindow } from "@/lib/api";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { useToastStore } from "@/stores/toast.store";
import { shouldDetachMailTab, type Point, type TabStripBounds } from "./mailTabDrag";
import { useMessageQuery } from "@/hooks/queries";
import { useComposeStore, type ComposeTab } from "@/stores/compose.store";
import { useMailStore } from "@/stores/mail.store";
import { useUIStore } from "@/stores/ui.store";
import type { ActiveView } from "@/stores/ui.store";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import { isComposeWorkspaceTabActive, isMessageWorkspaceTabActive } from "./workspaceTabActivity";
import { isMailReferenceDrag, readMailReference, revealComposeAiContext } from "@/lib/mailReferenceDrag";
import { confirmComposeLeave } from '@/features/compose/draftPersistence';

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
async function closeTabsByRule(anchorKey: string, rule: "right" | "left" | "other" | "all") {
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
  const closeSet = new Set(order.filter(id => !keepSet.has(id)));
  const draftsToClose = useComposeStore.getState().tabs.filter(tab => closeSet.has(tab.id)).map(tab => tab.id);
  if (!await confirmComposeLeave(draftsToClose)) return;
  const ui = useUIStore.getState();
  const mail = useMailStore.getState();
  const compose = useComposeStore.getState();
  ui.setNavTabs(ui.navTabs.filter((tab) => !closeSet.has(tab.key)));
  for (const id of mail.openMessageIds) {
    if (closeSet.has(id)) mail.closeMessageTab(id);
  }
  for (const tab of compose.tabs) {
    if (closeSet.has(tab.id)) useComposeStore.getState().forceCloseCompose(tab.id);
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
  const movable = useUIStore.getState().navTabs.find(tab => tab.key === anchorKey) ?? useComposeStore.getState().tabsById?.[anchorKey];
  const items: ContextMenuItem[] = movable ? [{ label: '在独立窗口打开', icon: <ExternalLink size={14} />, onClick: () => detachTab(movable) }, { separator: true }] : [];
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
  const gesture = useRef<{ start: Point; strip: TabStripBounds; pointerId: number } | null>(null);
  const detaching = useRef(false);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") { gesture.current = null; setDragging(false); } };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);

  async function detach() {
    if (detaching.current) return;
    detaching.current = true;
    try {
      await openMailWindow(messageId);
      closeMessageTab(messageId); // Only remove the original after native success.
      const ui = useUIStore.getState();
      if (ui.activeView === "messageDetail" && ui.messageDetailId === messageId) {
        const next = useMailStore.getState().selectedMessageId;
        ui.setMessageDetailId(next);
        if (!next) {
          // Do not reveal a stale account scope and start a paid overview
          // merely because the last mail was moved to another window.
          useMailStore.getState().setSearchScope(null);
          ui.navigateToView("inbox");
        }
      }
    } catch (cause) {
      useToastStore.getState().addToast({type:"error",message:`无法打开独立邮件窗口：${extractErrorMessage(cause)}。原标签仍保留。`});
    } finally { detaching.current = false; }
  }

  return (
    <>
    <button
      className="workspace-tab"
      type="button"
      aria-current={active ? "page" : undefined}
      data-active={active ? "true" : undefined}
      onPointerDown={event => {
        if (event.button !== 0 || (event.target as HTMLElement).closest('[role="button"]')) return;
        suppressClick.current = false;
        const strip = event.currentTarget.closest('[data-workspace-tabs]')?.getBoundingClientRect();
        if (!strip) return;
        gesture.current = {start:{x:event.clientX,y:event.clientY},strip,pointerId:event.pointerId};
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={event => {
        const drag = gesture.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (Math.hypot(event.clientX-drag.start.x,event.clientY-drag.start.y) >= 12) {
          suppressClick.current = true; setDragging(true); event.preventDefault();
        }
      }}
      onPointerUp={event => {
        const drag = gesture.current;
        gesture.current = null; setDragging(false);
        if (drag && drag.pointerId === event.pointerId && shouldDetachMailTab(drag.start,{x:event.clientX,y:event.clientY},drag.strip)) {
          suppressClick.current = true; void detach();
        }
      }}
      onPointerCancel={() => { gesture.current = null; setDragging(false); }}
      onLostPointerCapture={() => { gesture.current = null; setDragging(false); }}
      onClick={() => {
        if (suppressClick.current) { suppressClick.current = false; return; }
        useMailStore.getState().setSelectedMessage(messageId);
        useUIStore.getState().setMessageDetailId(messageId);
        useUIStore.getState().navigateToView("messageDetail");
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      title={`${message?.subject || "邮件"}（按住标签拖出标签栏，可在独立窗口打开）`}
      style={{
        display: "flex", alignItems: "center", gap: "6px", minWidth: "120px", maxWidth: "220px",
        padding: "7px 8px", border: "none", borderRight: "1px solid var(--color-border)",
        ...activeTabStyle(active), cursor: dragging ? "grabbing" : "pointer", userSelect: "none", touchAction: "none",
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
    {dragging && <span role="status" style={{position:"fixed",top:90,left:"50%",zIndex:1000,padding:"8px 14px",background:"var(--color-bg)",border:"1px solid var(--color-accent)",borderRadius:6,fontSize:12,pointerEvents:"none"}}>拖出标签栏后松开，在独立窗口打开 · Esc 取消</span>}
    {menu && (
      <ContextMenu x={menu.x} y={menu.y} items={[
        {label:"在独立窗口打开",icon:<ExternalLink size={14}/>,onClick:()=>void detach()},
        {separator:true},...buildTabMenu(messageId, true, () => closeMessageTab(messageId))]} onClose={() => setMenu(null)} />
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
  const dragHover = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  function cancelDragHover() {
    if (dragHover.current) clearTimeout(dragHover.current.timer);
    dragHover.current = null;
  }
  useEffect(() => {
    window.addEventListener("dragend", cancelDragHover);
    window.addEventListener("drop", cancelDragHover);
    return () => {
      cancelDragHover();
      window.removeEventListener("dragend", cancelDragHover);
      window.removeEventListener("drop", cancelDragHover);
    };
  }, []);
  if (openMessageIds.length === 0 && composeTabs.length === 0 && !hasNav) return null;

  function activateComposeForReference(tabId: string) {
    if (!useComposeStore.getState().tabsById[tabId]) return;
    useComposeStore.getState().activateComposeTab(tabId);
    useUIStore.getState().setActiveView("compose");
    revealComposeAiContext(tabId);
  }

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
    <div data-workspace-tabs className="scroll-region" style={{ display: "flex", flex: "0 0 auto", overflowX: "auto", minHeight: "35px", borderBottom: "1px solid var(--color-border)", background: "var(--color-bg-secondary)" }}>
      {navTabs.map((tab) => {
        const active = tab.kind === "folder" ? activeView === "inbox" : activeView === tab.view;
        return (
          <DetachableTab tab={tab}
            className="workspace-tab"
            key={tab.key}
            type="button"
            aria-current={active ? "page" : undefined}
            data-active={active ? "true" : undefined}
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
            <span
              role="button"
              tabIndex={0}
              aria-label={`关闭${tab.label}标签`}
              title={`关闭${tab.label}标签`}
              onClick={(event) => {
                event.stopPropagation();
                useUIStore.getState().removeNavTab(tab.key);
                if (activeView === tab.view) useUIStore.getState().setActiveView("inbox");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.stopPropagation();
                  useUIStore.getState().removeNavTab(tab.key);
                  if (activeView === tab.view) useUIStore.getState().setActiveView("inbox");
                }
              }}
              style={{ display: "flex", padding: "2px", borderRadius: "3px" }}
            >
              <X size={12} />
            </span>
          </DetachableTab>
        );
      })}
      {openMessageIds.map((messageId) => <MessageTab key={messageId} messageId={messageId} />)}
      {composeTabs.map((tab) => {
        const active = isComposeWorkspaceTabActive(activeView, activeComposeTabId, tab.id);
        return (
          <DetachableTab tab={tab}
            className="workspace-tab"
            key={tab.id}
            type="button"
            aria-current={active ? "page" : undefined}
            data-active={active ? "true" : undefined}
            onDragOver={event => {
              if (!isMailReferenceDrag(event.dataTransfer)) return;
              event.preventDefault(); event.stopPropagation();
              event.dataTransfer.dropEffect = "copy";
              if (dragHover.current?.id === tab.id) return;
              cancelDragHover();
              dragHover.current = { id: tab.id, timer: setTimeout(() => activateComposeForReference(tab.id), 450) };
            }}
            onDragLeave={event => {
              if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) cancelDragHover();
            }}
            onDrop={event => {
              const reference = readMailReference(event.dataTransfer);
              if (!reference) return;
              event.preventDefault(); event.stopPropagation(); cancelDragHover();
              useComposeStore.getState().queueAiReference(tab.id, reference);
              activateComposeForReference(tab.id);
            }}
            onClick={() => {
              useComposeStore.getState().activateComposeTab(tab.id);
              useUIStore.getState().setActiveView("compose");
              // AI results are queued on their originating draft, never whichever tab is clicked next.
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, anchorKey: tab.id, canCloseSelf: true });
            }}
            title={`${composeTabTitle(tab)}（可拖入邮件作为 AI 参考；悬停切换到草稿）`}
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
            {active && aiBgTask?.running && aiBgTask.source === "compose" && aiBgTask.targetTabId === tab.id && (
              <span className="spinner" style={{ width: 12, height: 12, border: "2px solid var(--color-border)", borderTopColor: "var(--color-accent)", borderRadius: "50%", display: "inline-block" }} title="AI 生成中…" />
            )}
            {active && aiBgTask && !aiBgTask.running && aiBgTask.source === "compose" && aiBgTask.targetTabId === tab.id && aiBgTask.result && (
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
          </DetachableTab>
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
