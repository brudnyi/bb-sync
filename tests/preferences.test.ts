import { describe, expect, it } from "vitest";
import type { Snapshot } from "../src/model";
import { BbPreferences } from "../src/preferences";

type Sdk = ConstructorParameters<typeof BbPreferences>[0];
function environment() {
  const calls: Record<string, unknown[]> = {
    general: [],
    keyboard: [],
    theme: [],
    ui: [],
  };
  const config = {
    appearance: { themeId: "default", faviconColor: "default" },
    generalSettings: {
      showKeyboardHints: true,
      confirmThreadArchive: true,
      steerActiveThreadOnEnter: true,
      summarizeShellCommands: true,
      terminalCopyOnSelect: false,
      streamerMode: false,
      machineServerUrl: "https://local-only.example",
      futureSetting: "preserve locally",
    },
    defaultKeybindings: [
      { command: "panel.close" },
      { command: "palette.open" },
    ],
    keybindingOverrides: [] as {
      command: string;
      platform?: string;
      shortcut: unknown;
    }[],
  };
  const preferences: Record<string, { revision: number; value: unknown }> = {
    "sidebar.footerOrder": { revision: 0, value: [] },
    "sidebar.hiddenFooterItems": { revision: 0, value: [] },
    "sidebar.pluginPanelOrder": { revision: 0, value: [] },
    "sidebar.visiblePluginPanels": { revision: 0, value: null },
    "sidebar.navigationProvider": { revision: 0, value: "__automatic__" },
    "sidebar.threadListProvider": { revision: 0, value: "__automatic__" },
    "composer.provider": { revision: 0, value: "__automatic__" },
    "infoPanel.collapsedSections": { revision: 0, value: [] },
    "threadContextCard.pinned": { revision: 0, value: false },
  };
  const sdk = {
    system: {
      config: async () => structuredClone(config),
      updateGeneralSettings: async (value: typeof config.generalSettings) => {
        calls.general!.push(value);
        Object.assign(config.generalSettings, value);
      },
      updateKeyboardSettings: async (
        value: typeof config.keybindingOverrides,
      ) => {
        calls.keyboard!.push(value);
        config.keybindingOverrides = value;
      },
      uiPreferences: {
        list: async () => ({ preferences: structuredClone(preferences) }),
        set: async (input: {
          key: string;
          expectedRevision: number;
          value: unknown;
        }) => {
          if (preferences[input.key]!.revision !== input.expectedRevision)
            throw new Error("Revision mismatch");
          calls.ui!.push(input);
          preferences[input.key] = {
            revision: input.expectedRevision + 1,
            value: input.value,
          };
        },
      },
    },
    plugins: { list: async () => ({ plugins: [{ id: "installed" }] }) },
    theme: {
      get: async () => structuredClone(config.appearance),
      resolve: async ({ themeId }: { themeId: string }) => ({
        themeId: themeId === "missing" ? "default" : themeId,
      }),
      set: async (value: typeof config.appearance) => {
        calls.theme!.push(value);
        Object.assign(config.appearance, value);
      },
    },
  } as unknown as Sdk;
  return { config, preferences, calls, sdk };
}
const key = {
  alt: false,
  control: false,
  key: "K",
  meta: false,
  mod: true,
  shift: true,
};
describe("BB SDK preference adapter", () => {
  it("captures only allowlisted settings, without machine-local config", async () => {
    const x = environment();
    const adapter = new BbPreferences(x.sdk, {
      appearance: true,
      keyboard: true,
      interface: true,
    });
    const snapshot = await adapter.capture();
    expect(snapshot["general/showKeyboardHints"]).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("local-only.example");
    expect(JSON.stringify(snapshot)).not.toContain("futureSetting");
  });
  it("reads fresh full general settings at apply time and preserves unsynced fields", async () => {
    const x = environment();
    const adapter = new BbPreferences(x.sdk, {
      appearance: false,
      keyboard: false,
      interface: true,
    });
    const before = await adapter.capture();
    x.config.generalSettings.futureSetting = "new local value";
    await adapter.apply(
      { ...before, "general/showKeyboardHints": false },
      before,
    );
    expect(x.config.generalSettings.showKeyboardHints).toBe(false);
    expect(x.config.generalSettings.futureSetting).toBe("new local value");
    expect(x.config.generalSettings.machineServerUrl).toBe(
      "https://local-only.example",
    );
  });
  it("keeps platform-specific overrides separate and applies reset without clearing others", async () => {
    const x = environment();
    x.config.keybindingOverrides = [
      { command: "panel.close", platform: "mac", shortcut: key },
      { command: "panel.close", platform: "linux", shortcut: null },
    ];
    const adapter = new BbPreferences(x.sdk, {
      appearance: false,
      keyboard: true,
      interface: false,
    });
    const before = await adapter.capture();
    const target: Snapshot = { ...before };
    delete target["keyboard/panel.close/mac"];
    await adapter.apply(target, before);
    expect(x.config.keybindingOverrides).toEqual([
      { command: "panel.close", platform: "linux", shortcut: null },
    ]);
  });
  it("validates an entire plan before any local mutation", async () => {
    const x = environment();
    const adapter = new BbPreferences(x.sdk, {
      appearance: true,
      keyboard: false,
      interface: false,
    });
    const before = await adapter.capture();
    await expect(
      adapter.apply(
        {
          ...before,
          "appearance/themeId": "missing",
          "appearance/faviconColor": "blue",
        },
        before,
      ),
    ).rejects.toThrow("Install theme");
    expect(x.calls.theme).toEqual([]);
  });
  it("preserves a concurrent edit made after a plan was captured", async () => {
    const x = environment();
    const adapter = new BbPreferences(x.sdk, {
      appearance: true,
      keyboard: false,
      interface: false,
    });
    const before = await adapter.capture();
    x.config.appearance.themeId = "third-theme";
    await expect(
      adapter.apply({ ...before, "appearance/themeId": "dark" }, before),
    ).rejects.toThrow("changed while syncing");
    expect(x.config.appearance.themeId).toBe("third-theme");
  });
  it("preserves a concurrent edit to a field outside the planned patch", async () => {
    const x = environment();
    const adapter = new BbPreferences(x.sdk, {
      appearance: true,
      keyboard: false,
      interface: false,
    });
    const before = await adapter.capture();
    // Another window changes the theme while GitHub changes only the favicon.
    x.config.appearance.themeId = "new-local-theme";
    await adapter.apply(
      { ...before, "appearance/faviconColor": "blue" },
      before,
    );
    expect(x.config.appearance).toEqual({
      themeId: "new-local-theme",
      faviconColor: "blue",
    });
  });
  it("checks preference revision when applying sidebar changes", async () => {
    const x = environment();
    const adapter = new BbPreferences(x.sdk, {
      appearance: false,
      keyboard: false,
      interface: true,
    });
    const before = await adapter.capture();
    await adapter.apply(
      {
        ...before,
        "sidebar/not-a-real-key": false,
        "ui/threadContextCard.pinned": true,
      },
      before,
    );
    expect(x.calls.ui).toEqual([
      { key: "threadContextCard.pinned", expectedRevision: 0, value: true },
    ]);
  });
  it("does not apply unknown commands or bindings from missing plugins", async () => {
    const x = environment();
    const adapter = new BbPreferences(x.sdk, {
      appearance: false,
      keyboard: true,
      interface: false,
    });
    await adapter.capture();
    expect(adapter.supports("keyboard/new.unknown/all")).toBe(false);
    expect(adapter.supports("keyboard/plugin%3Amissing%2Fcommand/all")).toBe(
      false,
    );
    expect(adapter.supports("keyboard/plugin%3Ainstalled%2Fcommand/all")).toBe(
      true,
    );
    expect(adapter.supports("keyboard/%ZZ/all")).toBe(false);
  });
  it("stops applying when the plugin lifecycle aborts", async () => {
    const x = environment(),
      controller = new AbortController();
    const adapter = new BbPreferences(
      x.sdk,
      { appearance: true, keyboard: false, interface: false },
      controller.signal,
    );
    const before = await adapter.capture();
    controller.abort();
    await expect(
      adapter.apply({ ...before, "appearance/themeId": "dark" }, before),
    ).rejects.toThrow();
    expect(x.calls.theme).toEqual([]);
  });
});
