// @vitest-environment jsdom

import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicStatus } from "../server";

afterEach(cleanup);
const base = (): PublicStatus => ({
  configured: true,
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
  it("loads the registered page and syncs on request", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: { status: () => base(), sync: () => base() } },
    );
    await slot.findByText("owner/preferences");
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
