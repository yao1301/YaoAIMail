import { beforeEach, describe, expect, it } from "vitest";
import { useComposeStore } from "../../src/stores/compose.store";
import { useUIStore } from "../../src/stores/ui.store";

describe("ComposeStore", () => {
  beforeEach(() => {
    useUIStore.setState({
      activeView: "inbox",
      previousView: "inbox",
    });
    useComposeStore.setState({
      tabs: [], tabsById: {}, activeTabId: null,
      composeMode: null,
      composeReplyTo: null,
      composeDirty: false,
      showComposeLeaveConfirm: false,
      pendingView: null,
      composePrefill: null,
      composeKey: 0,
    });
  });

  it('protects legacy standalone drafts and closes only after confirmation', () => {
    useComposeStore.setState({ composeMode: 'new' });
    useComposeStore.getState().setComposeDirty(true);
    useComposeStore.getState().closeCompose();
    expect(useComposeStore.getState().showComposeLeaveConfirm).toBe(true);
    expect(useComposeStore.getState().composeMode).toBe('new');
    useComposeStore.getState().cancelCloseCompose();
    expect(useComposeStore.getState().composeDirty).toBe(true);
    useComposeStore.getState().closeCompose();
    useComposeStore.getState().confirmCloseCompose();
    expect(useComposeStore.getState().composeMode).toBeNull();
  });

  it("opens a new compose with mailto prefill data", () => {
    useComposeStore.getState().openCompose("new", null, {
      to: ["alice@example.com"],
      cc: ["carol@example.com"],
      bcc: [],
      subject: "Hello",
      body: "Line one",
    });

    const compose = useComposeStore.getState();
    expect(useUIStore.getState().activeView).toBe("compose");
    expect(compose.composeMode).toBe("new");
    expect(compose.composePrefill).toEqual({
      to: ["alice@example.com"],
      cc: ["carol@example.com"],
      bcc: [],
      subject: "Hello",
      body: "Line one",
    });
    expect(compose.composeKey).toBe(1);
  });
});
