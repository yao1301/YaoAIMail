export const SHOW_ONBOARDING_EVENT = "pebble:show-onboarding";

/** Detached settings must open the guide in the main app, where setup navigation lives. */
export async function showOnboardingGuide() {
  if (new URLSearchParams(window.location.search).get("workspaceWindow") !== "1") {
    window.dispatchEvent(new CustomEvent(SHOW_ONBOARDING_EVENT));
    return;
  }
  const { Window } = await import("@tauri-apps/api/window");
  const main = await Window.getByLabel("main");
  if (!main) throw new Error("请先打开软件主窗口，再查看新手引导。");
  await main.emitTo("main", SHOW_ONBOARDING_EVENT);
  await main.show();
  await main.setFocus();
}
