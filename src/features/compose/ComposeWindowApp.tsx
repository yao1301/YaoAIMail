import { useEffect, useState } from "react";
import ComposeView from "@/features/compose/ComposeView";
import TitleBar from "@/components/TitleBar";
import ToastContainer from "@/components/ToastContainer";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useComposeStore, type ComposePrefill } from "@/stores/compose.store";
import { useUIStore } from "@/stores/ui.store";
import { useConfirmStore } from "@/stores/confirm.store";

/** 全局确认弹窗（与主布局 Layout 中的 GlobalConfirmDialog 等价）。 */
function ComposeWindowConfirm() {
  const { isOpen, title, message, destructive, confirmLabel, cancelLabel, handleConfirm, handleCancel } = useConfirmStore();
  if (!isOpen) return null;
  return (
    <ConfirmDialog
      title={title}
      message={message}
      destructive={destructive}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  );
}

/**
 * 独立写信窗口（多窗口模式）。
 *
 * 主窗口通过 open_compose_window 命令打开新窗口，URL 形如
 *   index.html?compose=1&prefill=<base64(ComposePrefill JSON)>
 * 本组件解析 prefill → 初始化 compose store → 渲染无侧边栏的写信界面。
 */
function decodePrefill(raw: string | null): ComposePrefill | undefined {
  if (!raw) return undefined;
  try {
    const json = decodeURIComponent(atob(raw.replace(/-/g, "+").replace(/_/g, "/")));
    const parsed = JSON.parse(json) as ComposePrefill;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export default function ComposeWindowApp() {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const raw = params.get("prefill");
      const prefill = decodePrefill(raw);
      // 初始化写信表单（与主窗口 openCompose 的 store 语义一致）
      useComposeStore.getState().openCompose("new", null, prefill ?? {});
      // 独立窗口不显示右侧 AI 面板/侧边栏
      useUIStore.setState({ rightPanelOpen: false });
      setReady(true);
    } catch (err) {
      console.error("[ComposeWindow] init failed", err);
      setFailed(true);
    }
  }, []);

  if (failed) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", gap: 12, fontFamily: "sans-serif" }}>
        <div>写信窗口初始化失败，请关闭重试</div>
      </div>
    );
  }

  if (!ready) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <TitleBar />
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <ComposeView />
      </div>
      <ToastContainer />
      <ComposeWindowConfirm />
    </div>
  );
}
