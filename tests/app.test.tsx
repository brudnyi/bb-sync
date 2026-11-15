// @vitest-environment jsdom

import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicStatus } from "../server";

afterEach(cleanup);
const base = (): PublicStatus => ({
  configured: true,
  hasBaseline: true,
  needsReview: false,
  options: {
    appearance: true,
    keyboard: true,
    interface: true,
    plugins: false,
    intervalSeconds: 60,
  },
  enabled: false,
  repository: "owner/preferences",
  configurationError: null,
  status: {
    phase: "synced",
    message: "Все настройки синхронизированы",
    lastSync: null,
    backupAt: null,
    planId: null,
    conflicts: [],
    unsupported: [],
  },
});
describe("bb-sync page", () => {
  it("continues to storage selection after device login completes", async () => {
    const value = {
      ...base(),
      configured: false,
      hasBaseline: false,
      repository: "",
      status: null,
    };
    let loads = 0;
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          status: () => value,
          setup_load: async () => {
            loads++;
            await Promise.resolve();
            return {
              account: loads > 1 ? { login: "owner", name: null } : null,
              auth: {
                phase: loads > 1 ? "connected" : "idle",
                code: null,
                url: null,
                message: null,
              },
              error: null,
            };
          },
          auth_start: () => ({
            phase: "waiting",
            code: "ABCD-1234",
            url: "https://github.com/login/device",
            message: null,
          }),
          auth_status: () => ({
            phase: "connected",
            code: null,
            url: null,
            message: null,
          }),
          repositories: () => ({ repositories: [], more: false }),
        },
      },
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Подключить GitHub" }),
    );
    await slot.findByText("Где хранить настройки?", {}, { timeout: 4000 });
    expect(slot.getByRole("button", { name: "Продолжить" })).toBeTruthy();
    slot.lifecycle.unmount();
  });
  it("starts with one GitHub connection action for a fresh installation", async () => {
    const value = {
      ...base(),
      configured: false,
      hasBaseline: false,
      repository: "",
      status: null,
    };
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          status: () => value,
          setup_load: () => ({
            account: null,
            auth: { phase: "idle", code: null, url: null, message: null },
            error: null,
          }),
          auth_start: () => ({
            phase: "waiting",
            code: "ABCD-1234",
            url: "https://github.com/login/device",
            message: null,
          }),
        },
      },
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Подключить GitHub" }),
    );
    await slot.findByText("ABCD-1234");
    expect(slot.getByRole("button", { name: "Открыть GitHub" })).toBeTruthy();
    slot.lifecycle.unmount();
  });
  it("lets a second laptop apply GitHub settings in one confirmed action", async () => {
    const value = { ...base(), hasBaseline: false };
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          status: () => value,
          preview: () => ({
            planId: "a".repeat(64),
            firstConnection: true,
            remoteExists: true,
            localCount: 1,
            unsupported: [],
            changes: [
              {
                key: "appearance/themeId",
                base: null,
                basePresent: false,
                local: "light",
                localPresent: true,
                remote: "dark",
                remotePresent: true,
                conflicting: true,
              },
            ],
          }),
          setup_finish: () => base(),
        },
      },
    );
    expect(
      slot.inspection.rpcCalls.some((c) => c.method === "setup_finish"),
    ).toBe(false);
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Использовать настройки из GitHub",
      }),
    );
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some((c) => c.method === "setup_finish"),
      ).toBe(true),
    );
    const call = slot.inspection.rpcCalls.find(
      (c) => c.method === "setup_finish",
    );
    expect(call?.input).toMatchObject({
      choices: { "appearance/themeId": "remote" },
    });
    slot.lifecycle.unmount();
  });
  it("keeps waiting while a plugin installation runs in the background", async () => {
    let running = false;
    const value = { ...base(), hasBaseline: false };
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          status: () => (running ? base() : value),
          preview: () => ({
            planId: "a".repeat(64),
            firstConnection: true,
            remoteExists: true,
            localCount: 0,
            unsupported: [],
            changes: [
              {
                key: "plugins/demo",
                base: null,
                basePresent: false,
                local: null,
                localPresent: false,
                remote: {
                  enabled: true,
                  source: `git:https://github.com/example/plugin.git@${"a".repeat(40)}`,
                },
                remotePresent: true,
                conflicting: false,
              },
            ],
          }),
          setup_finish: () => {
            running = true;
            return {
              ...value,
              status: {
                ...base().status!,
                phase: "syncing",
                message: "Установка плагина demo…",
              },
            };
          },
        },
      },
    );
    await slot.findByText("Перенос плагинов");
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Использовать настройки из GitHub",
      }),
    );
    await slot.findByText("Установка плагина demo…");
    await slot.findByText("Синхронизация на паузе", {}, { timeout: 3000 });
    expect(slot.queryByRole("alert")).toBeNull();
    slot.lifecycle.unmount();
  });
  it("creates the recommended private store through the setup flow", async () => {
    const value = {
      ...base(),
      configured: false,
      hasBaseline: false,
      repository: "",
      status: null,
    };
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          status: () => value,
          setup_load: () => ({
            account: { login: "owner", name: null },
            auth: { phase: "connected", code: null, url: null, message: null },
            error: null,
          }),
          repositories: () => ({ repositories: [], more: false }),
          setup_prepare: () => ({ ...base(), hasBaseline: false }),
          preview: () => ({
            planId: "a".repeat(64),
            firstConnection: true,
            remoteExists: false,
            localCount: 4,
            unsupported: [],
            changes: [],
          }),
        },
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Продолжить" }));
    await slot.findByText("Всё готово к первому запуску");
    const call = slot.inspection.rpcCalls.find(
      (c) => c.method === "setup_prepare",
    );
    expect(call?.input).toMatchObject({
      create: true,
      repository: "bb-sync-settings",
      scope: {
        appearance: true,
        keyboard: true,
        interface: true,
        plugins: false,
      },
    });
    slot.lifecycle.unmount();
  });
  it("loads the registered page and syncs on request", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: { status: () => base(), sync: () => base() } },
    );
    await slot.findByRole("link", { name: "owner/preferences" });
    fireEvent.click(slot.getByRole("button", { name: "Синхронизировать" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.some((c) => c.method === "sync")).toBe(
        true,
      ),
    );
    slot.lifecycle.unmount();
  });
  it("requires an explicit choice for each conflicting field", async () => {
    const value = base();
    value.status = {
      ...value.status!,
      phase: "conflict",
      planId: "a".repeat(64),
      conflicts: [
        {
          key: "appearance/themeId",
          base: "default",
          local: "dark",
          remote: "light",
          basePresent: true,
          localPresent: true,
          remotePresent: true,
        },
      ],
    };
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: { status: () => value, resolve: () => base() } },
    );
    await slot.findByText("Выбери значения");
    const button = slot.getByRole("button", {
      name: "Применить выбор",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(slot.getByRole("radio", { name: /GitHub/ }));
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.some((c) => c.method === "resolve")).toBe(
        true,
      ),
    );
    slot.lifecycle.unmount();
  });
  it("requires confirmation before local snapshot restoration", async () => {
    const value = base();
    value.status!.backupAt = new Date().toISOString();
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: { status: () => value, restore: () => base() } },
    );
    await slot.findByText("Восстановить предыдущие настройки");
    fireEvent.click(slot.getByText("Восстановить предыдущие настройки"));
    const restore = await slot.findByRole("button", {
      name: "Восстановить снимок",
    });
    fireEvent.click(restore);
    expect(slot.inspection.rpcCalls.some((c) => c.method === "restore")).toBe(
      false,
    );
    fireEvent.click(
      slot.getByRole("button", { name: "Восстановить и приостановить" }),
    );
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.some((c) => c.method === "restore")).toBe(
        true,
      ),
    );
    slot.lifecycle.unmount();
  });
});
