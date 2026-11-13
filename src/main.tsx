import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { initializeProfileStorageNamespace } from "@/lib/profileStorage";
import { logStartupTiming } from "@/lib/startupTiming";
import { safeErrorMessage } from "@/lib/appErrors";
import "./styles/index.css";

async function bootstrap() {
  logStartupTiming("frontend entry loaded");
  await initializeProfileStorageNamespace();
  await import("@/lib/i18n");
  const [{ default: App }, { showMainWindow }] = await Promise.all([
    import("./App"),
    import("@/lib/showMainWindow"),
  ]);
  const { startWindowSettingsSync } = await import("@/lib/windowSettingsSync");
  const stopSettingsSync = startWindowSettingsSync();
  import.meta.hot?.dispose(stopSettingsSync);

  void showMainWindow();

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void bootstrap().catch((error) => {
  document.getElementById("splash")?.remove();
  createRoot(document.getElementById("root")!).render(
    <div role="alert" style={{ padding: 32 }}>
      <h2>应用启动失败</h2><p>{safeErrorMessage(error)}</p>
      <button onClick={() => window.location.reload()}>重新加载</button>
    </div>,
  );
});
