import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { equal, type Snapshot } from "./model";

type Sdk = BbPluginApi["sdk"];
type Bindings = Parameters<Sdk["system"]["updateKeyboardSettings"]>[0];
const colors = z.enum([
  "default",
  "blue",
  "green",
  "orange",
  "pink",
  "purple",
  "red",
  "teal",
  "yellow",
]);
const shortcut = z
  .object({
    alt: z.boolean(),
    control: z.boolean(),
    key: z.string().min(1).max(80),
    meta: z.boolean(),
    mod: z.boolean(),
    shift: z.boolean(),
  })
  .strict()
  .nullable();
const generalSchemas = {
  showKeyboardHints: z.boolean(),
  confirmThreadArchive: z.boolean(),
  steerActiveThreadOnEnter: z.boolean(),
  summarizeShellCommands: z.boolean(),
  terminalCopyOnSelect: z.boolean(),
  streamerMode: z.boolean(),
};
const uiSchemas = {
  "sidebar.footerOrder": z.array(z.string().max(200)).max(150),
  "sidebar.hiddenFooterItems": z.array(z.string().max(200)).max(150),
  "sidebar.pluginPanelOrder": z.array(z.string().max(200)).max(150),
  "sidebar.visiblePluginPanels": z
    .array(z.string().max(200))
    .max(150)
    .nullable(),
  "sidebar.navigationProvider": z.string().min(1).max(200),
  "sidebar.threadListProvider": z.string().min(1).max(200),
  "composer.provider": z.string().min(1).max(200),
  "infoPanel.collapsedSections": z.array(z.string().max(200)).max(150),
  "threadContextCard.pinned": z.boolean(),
};
export type Scope = {
  appearance: boolean;
  keyboard: boolean;
  interface: boolean;
};
const bindingKey = (binding: Bindings[number]) =>
  `keyboard/${encodeURIComponent(binding.command)}/${binding.platform ?? "all"}`;
function bindingIdentity(key: string) {
  const match = /^keyboard\/([^/]+)\/(all|mac|windows|linux)$/.exec(key);
  if (!match) return null;
  let command: string;
  try {
    command = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  if (command.length > 250 || encodeURIComponent(command) !== match[1])
    return null;
  return {
    command,
    ...(match[2] === "all"
      ? {}
      : { platform: match[2] as "mac" | "windows" | "linux" }),
  };
}
export interface Preferences {
  capture(): Promise<Snapshot>;
  supports(key: string): boolean;
  prepare(target: Snapshot): Promise<void>;
  apply(target: Snapshot, before: Snapshot): Promise<void>;
}
export class BbPreferences implements Preferences {
  private commands = new Set<string>();
  private plugins = new Set<string>();
  constructor(
    private sdk: Sdk,
    private scope: Scope,
    private signal?: AbortSignal,
  ) {}
  supports(key: string): boolean {
    if (key.startsWith("appearance/"))
      return (
        this.scope.appearance &&
        ["appearance/themeId", "appearance/faviconColor"].includes(key)
      );
    if (key.startsWith("general/"))
      return (
        this.scope.interface && Object.hasOwn(generalSchemas, key.slice(8))
      );
    if (key.startsWith("ui/"))
      return this.scope.interface && Object.hasOwn(uiSchemas, key.slice(3));
    const binding = bindingIdentity(key);
    if (!binding || !this.scope.keyboard) return false;
    if (this.commands.has(binding.command)) return true;
    const plugin = /^plugin:([^/]+)\/.+/.exec(binding.command)?.[1];
    return plugin !== undefined && this.plugins.has(plugin);
  }
  async capture(): Promise<Snapshot> {
    this.signal?.throwIfAborted();
    const config = await this.sdk.system.config();
    const result: Snapshot = Object.create(null);
    this.commands = new Set(
      [...config.defaultKeybindings, ...config.keybindingOverrides].map(
        (b) => b.command,
      ),
    );
    if (this.scope.keyboard || this.scope.interface) {
      const { plugins } = await this.sdk.plugins.list();
      this.plugins = new Set(plugins.map((p) => p.id));
    }
    if (this.scope.appearance) {
      result["appearance/themeId"] = config.appearance.themeId;
      result["appearance/faviconColor"] = config.appearance.faviconColor;
    }
    if (this.scope.keyboard)
      for (const b of config.keybindingOverrides)
        result[bindingKey(b)] = b.shortcut;
    if (this.scope.interface) {
      for (const name of Object.keys(
        generalSchemas,
      ) as (keyof typeof generalSchemas)[])
        result[`general/${name}`] = config.generalSettings[name];
      const { preferences } = await this.sdk.system.uiPreferences.list();
      for (const name of Object.keys(uiSchemas) as (keyof typeof uiSchemas)[])
        result[`ui/${name}`] = preferences[name].value;
    }
    return result;
  }
  async prepare(target: Snapshot): Promise<void> {
    this.signal?.throwIfAborted();
    if (
      this.scope.appearance &&
      (!Object.hasOwn(target, "appearance/themeId") ||
        !Object.hasOwn(target, "appearance/faviconColor"))
    ) {
      throw new Error(
        "В файле отсутствует тема или цвет значка. При первом подключении сохраните локальное значение для отсутствующих полей.",
      );
    }
    if (this.scope.interface) {
      for (const key of [
        ...Object.keys(generalSchemas).map((k) => `general/${k}`),
        ...Object.keys(uiSchemas).map((k) => `ui/${k}`),
      ]) {
        if (!Object.hasOwn(target, key))
          throw new Error(
            `В файле отсутствует ${key}. Сохраните локальное значение для этого поля.`,
          );
      }
    }
    for (const [key, value] of Object.entries(target)) {
      if (!this.supports(key)) continue;
      if (key.startsWith("keyboard/")) shortcut.parse(value);
      else if (key === "appearance/themeId") {
        const themeId = z.string().min(1).max(200).parse(value);
        const resolved = await this.sdk.theme.resolve({ themeId });
        if (resolved.themeId !== themeId)
          throw new Error(
            `Install theme ${themeId} on this computer before syncing.`,
          );
      } else if (key === "appearance/faviconColor") colors.parse(value);
      else if (key.startsWith("general/"))
        generalSchemas[key.slice(8) as keyof typeof generalSchemas].parse(
          value,
        );
      else if (key.startsWith("ui/")) {
        const name = key.slice(3) as keyof typeof uiSchemas;
        uiSchemas[name].parse(value);
        if (
          [
            "sidebar.navigationProvider",
            "sidebar.threadListProvider",
            "composer.provider",
          ].includes(name) &&
          typeof value === "string" &&
          value !== "__automatic__"
        ) {
          if (!this.plugins.has(value.split("/")[0]!))
            throw new Error(
              `Install ${value.split("/")[0]} before selecting its interface.`,
            );
        }
      }
    }
  }
  async apply(target: Snapshot, before: Snapshot): Promise<void> {
    // Recovery accepts either the old or already-applied value, never a third edit.
    const assertUnchanged = (current: Snapshot) => {
      for (const key of new Set([
        ...Object.keys(before),
        ...Object.keys(target),
      ])) {
        if (!this.supports(key) || equal(before[key], target[key])) continue;
        if (
          !equal(current[key], before[key]) &&
          !equal(current[key], target[key])
        ) {
          throw new Error(
            `Local setting changed while syncing: ${key}. Restore the snapshot or retry after reviewing your edit.`,
          );
        }
      }
    };
    let current = await this.capture();
    assertUnchanged(current);
    await this.prepare(target);
    for (const key of new Set([
      ...Object.keys(before),
      ...Object.keys(target),
    ])) {
      if (
        !this.supports(key) ||
        equal(before[key], target[key]) ||
        equal(current[key], target[key])
      )
        continue;
      current = await this.capture();
      assertUnchanged(current);
      const value = target[key];
      if (key.startsWith("appearance/")) {
        // Theme and favicon use one SDK update; preserve either unsynced field.
        const theme = await this.sdk.theme.get();
        await this.sdk.theme.set({
          themeId: equal(
            before["appearance/themeId"],
            target["appearance/themeId"],
          )
            ? theme.themeId
            : z.string().parse(target["appearance/themeId"]),
          faviconColor: colors.parse(
            equal(
              before["appearance/faviconColor"],
              target["appearance/faviconColor"],
            )
              ? theme.faviconColor
              : target["appearance/faviconColor"],
          ),
        });
      } else if (key.startsWith("general/")) {
        if (value === undefined)
          throw new Error(`Required setting is missing: ${key}`);
        const config = await this.sdk.system.config();
        // This SDK endpoint accepts a complete general-settings object. Start
        // from a fresh local read so unrelated and newly added fields survive.
        await this.sdk.system.updateGeneralSettings({
          ...config.generalSettings,
          [key.slice(8)]: z.boolean().parse(value),
        });
      } else if (key.startsWith("ui/")) {
        const name = key.slice(3) as keyof typeof uiSchemas;
        if (value === undefined)
          throw new Error(`Required setting is missing: ${key}`);
        const prefs = await this.sdk.system.uiPreferences.list();
        const parsed = uiSchemas[name].parse(value);
        await this.sdk.system.uiPreferences.set({
          key: name,
          expectedRevision: prefs.preferences[name].revision,
          value: parsed,
        });
      } else {
        const binding = bindingIdentity(key)!;
        const config = await this.sdk.system.config();
        const bindings = config.keybindingOverrides.filter(
          (b) => bindingKey(b) !== key,
        );
        if (value !== undefined) {
          // supports() bounds commands to the current SDK/server and installed plugins.
          bindings.push({
            ...binding,
            shortcut: shortcut.parse(value),
          } as Bindings[number]);
        }
        await this.sdk.system.updateKeyboardSettings(bindings);
      }
      current = await this.capture();
    }
    const after = await this.capture();
    for (const key of new Set([
      ...Object.keys(before),
      ...Object.keys(target),
    ])) {
      if (
        this.supports(key) &&
        !equal(before[key], target[key]) &&
        !equal(after[key], target[key])
      )
        throw new Error(`Could not verify applied setting: ${key}`);
    }
  }
}
