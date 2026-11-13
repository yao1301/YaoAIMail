import { Component, type ErrorInfo, type ReactNode, useEffect, lazy, Suspense } from "react";
import i18next from "i18next";
import OnboardingOverlay from "./components/OnboardingOverlay";
import { logStartupTiming } from "@/lib/startupTiming";
import AppErrorNotifications from "@/components/AppErrorNotifications";
import { reportAppError } from "@/lib/appErrors";

const WorkspaceWindowApp = lazy(() => import("./app/WorkspaceWindowApp"));
const Layout = lazy(() => import("./app/Layout"));
const ComposeWindowApp = lazy(() => import("./features/compose/ComposeWindowApp"));
const MessageWindowApp = lazy(() => import("./features/inbox/MessageWindowApp"));

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportAppError(error, "界面加载失败");
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", height: "100vh", gap: 16, padding: 24,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          color: "var(--color-text-primary, #333)",
          backgroundColor: "var(--color-bg, #fff)",
        }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{i18next.t("errorBoundary.title", "Something went wrong")}</h2>
          <p style={{ margin: 0, fontSize: 14, color: "var(--color-text-secondary, #666)" }}>
            {i18next.t("errorBoundary.description", "Please try refreshing the application.")}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 8, padding: "8px 20px", cursor: "pointer",
              backgroundColor: "var(--color-accent, #2563eb)", color: "#fff",
              border: "none", borderRadius: 6, fontSize: 14, fontWeight: 600,
            }}
          >
            {i18next.t("errorBoundary.refresh", "Refresh")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  // 独立写信窗口（?compose=1）：只渲染写信界面，不加载主布局
  const isComposeWindow = new URLSearchParams(window.location.search).get("compose") === "1";
  const isMailWindow = new URLSearchParams(window.location.search).get("mailWindow") === "1";

  const isWorkspaceWindow = new URLSearchParams(window.location.search).get('workspaceWindow') === '1';
  useEffect(() => {
    if (isComposeWindow || isMailWindow || isWorkspaceWindow) return; // 独立窗口不播放主界面启动动画
    logStartupTiming("react app mounted");
    const splash = document.getElementById("splash");
    if (!splash) return;
    // Ensure the full animation plays (draw 1.2s + fill 0.8s delay + 0.6s)
    const splashStart = (window as unknown as Record<string, number>).__splashStart || Date.now();
    const minDisplay = 2200;
    const elapsed = Date.now() - splashStart;
    const remaining = Math.max(0, minDisplay - elapsed);
    setTimeout(() => {
      logStartupTiming("splash fade started");
      splash.classList.add("fade-out");
      setTimeout(() => {
        splash.remove();
        document.getElementById("splash-style")?.remove();
        logStartupTiming("splash removed");
      }, 500);
    }, remaining);
  }, [isComposeWindow, isMailWindow, isWorkspaceWindow]);

  if (isWorkspaceWindow) return <ErrorBoundary><AppErrorNotifications /><Suspense fallback={null}><WorkspaceWindowApp /></Suspense></ErrorBoundary>;
  if (isMailWindow) return <ErrorBoundary><AppErrorNotifications /><Suspense fallback={null}><MessageWindowApp /></Suspense></ErrorBoundary>;

  if (isComposeWindow) {
    return (
      <ErrorBoundary>
        <AppErrorNotifications />
        <Suspense fallback={null}><ComposeWindowApp /></Suspense>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <AppErrorNotifications />
      <Suspense fallback={null}><Layout /></Suspense>
      <OnboardingOverlay />
    </ErrorBoundary>
  );
}
