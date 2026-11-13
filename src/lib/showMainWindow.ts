import { getCurrentWindow } from "@tauri-apps/api/window";
import { shouldShowMainWindowOnStartup } from "@/lib/startupVisibility";
import { logStartupTiming } from "@/lib/startupTiming";

export async function showMainWindow(forceVisible = import.meta.env.DEV) {
  if (new URLSearchParams(window.location.search).get('workspaceWindow') === '1') return; // Native handoff reveals only restored content.
  // A developer explicitly starting `tauri dev` needs the test window on
  // screen even when the shared portable profile normally starts to tray.
  // Packaged builds still respect the user's startup preference.
  if (!forceVisible && !shouldShowMainWindowOnStartup()) {
    logStartupTiming("main window left hidden for tray startup");
    return;
  }

  try {
    await getCurrentWindow().show();
    logStartupTiming("main window shown");
  } catch (err) {
    console.warn("Failed to show main window", err);
  }
}
