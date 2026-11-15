import { describe, expect, it, vi } from "vitest";
import { merge, type Snapshot } from "../src/model";
import {
  type PluginMemory,
  type PluginMemoryStore,
  PluginSync,
} from "../src/plugins";

type Sdk = ConstructorParameters<typeof PluginSync>[0];
const commit = "a".repeat(40);
const source = `git:https://github.com/example/plugin.git@${commit}`;
const spec = { source, enabled: true };
function fixture(
  initial: {
    id: string;
    enabled: boolean;
    source?: string;
    provenance?: string;
  }[] = [],
) {
  const plugins = initial.map((p) => ({
    source,
    provenance: "direct",
    version: "1.0.0",
    ...p,
  }));
  let saved: PluginMemory | null = null;
  const store: PluginMemoryStore = {
    load: async () => structuredClone(saved),
    save: async (value) => {
      saved = structuredClone(value);
    },
  };
  const jobs = new Map<
    string,
    { id: string; state: string; plugin?: unknown; target?: unknown }
  >();
  const enable = vi.fn(async ({ pluginId }: { pluginId: string }) => {
    const p = plugins.find((p) => p.id === pluginId)!;
    p.enabled = true;
    return p;
  });
  const disable = vi.fn(async ({ pluginId }: { pluginId: string }) => {
    const p = plugins.find((p) => p.id === pluginId)!;
    p.enabled = false;
    return p;
  });
  const start = vi.fn(async () => {
    const plugin = {
      id: "demo",
      enabled: true,
      source,
      provenance: "direct",
      version: "1.0.0",
    };
    plugins.push(plugin);
    const job = { id: "job1", state: "succeeded", plugin };
    jobs.set(job.id, job);
    return job;
  });
  const getSource = vi.fn(async () => ({
    requested: "git:https://github.com/example/plugin.git@semver:demo/:^1.0.0",
    subdirectory: "plugins/demo",
    history: [{ version: commit, activatedAt: 1 }],
  }));
  const sdk = {
    plugins: {
      list: async () => ({ plugins: structuredClone(plugins) }),
      getSource,
      enable,
      disable,
      startInstall: start,
      installJobs: {
        list: async () => [...jobs.values()],
        get: async ({ jobId }: { jobId: string }) => jobs.get(jobId),
      },
    },
  } as unknown as Sdk;
  const create = (signal?: AbortSignal) => new PluginSync(sdk, store, signal);
  return {
    plugins,
    sdk,
    store,
    create,
    enable,
    disable,
    start,
    getSource,
    jobs,
    saved: () => saved,
  };
}

describe("portable plugin sync", () => {
  it("exports pinned sources and monorepo selections without paths, settings or secrets", async () => {
    const f = fixture([
      { id: "demo", enabled: true },
      { id: "bb-sync", enabled: true, source: "path:/Users/private/sync" },
      { id: "local", enabled: true, source: "path:/Users/private/local" },
      {
        id: "builtin",
        enabled: false,
        source: "builtin:builtin",
        provenance: "builtin",
      },
    ]);
    const capture = await f.create().capture();
    expect(capture).toEqual({
      "plugins/demo": { ...spec, subdirectory: "plugins/demo" },
      "plugins/builtin": { source: "builtin:builtin", enabled: false },
    });
    expect(f.getSource).toHaveBeenCalledTimes(1);
  });
  it("rejects credential-bearing sources and never exports their URL", async () => {
    const f = fixture([{ id: "demo", enabled: true }]);
    f.getSource.mockResolvedValue({
      requested: "git:https://secret:token@github.com/example/plugin.git@main",
      subdirectory: "plugins/demo",
      history: [{ version: commit, activatedAt: 1 }],
    });
    expect(await f.create().capture()).toEqual({});
  });
  it("installs a missing plugin and applies its disabled state", async () => {
    const f = fixture();
    const sync = f.create();
    await sync.capture();
    await sync.apply({ "plugins/demo": { ...spec, enabled: false } }, {});
    expect(f.start).toHaveBeenCalledWith({ source });
    expect(f.disable).toHaveBeenCalledWith({ pluginId: "demo" });
    expect((await sync.capture())["plugins/demo"]).toEqual({
      ...spec,
      enabled: false,
    });
  });
  it("keeps extra plugins, and changes existing enabled state without reinstalling", async () => {
    const f = fixture([
      { id: "demo", enabled: false },
      { id: "extra", enabled: true },
    ]);
    const sync = f.create();
    const before = await sync.capture();
    await sync.apply({ "plugins/demo": spec }, before);
    expect(f.enable).toHaveBeenCalledWith({ pluginId: "demo" });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.plugins.find((p) => p.id === "extra")?.enabled).toBe(true);
  });
  it("remembers deliberate local removals across restart and never republishes deletion", async () => {
    const f = fixture([{ id: "demo", enabled: true }]);
    const original = await f.create().capture();
    f.plugins.splice(0);
    const restarted = f.create();
    expect(await restarted.capture()).toEqual(original);
    const target = { "plugins/demo": { ...spec, enabled: false } };
    await restarted.apply(target, original);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.disable).not.toHaveBeenCalled();
    expect(await f.create().capture()).toEqual(target);
  });
  it("recognizes a later manual reinstall and publishes its enabled state", async () => {
    const f = fixture([{ id: "demo", enabled: true }]);
    const sync = f.create();
    await sync.capture();
    const p = f.plugins.shift()!;
    await sync.capture();
    f.plugins.push({ ...p, enabled: false });
    expect((await sync.capture())["plugins/demo"]).toMatchObject({
      enabled: false,
    });
  });
  it("keeps the install source stable when an existing plugin is updated locally", async () => {
    const f = fixture([{ id: "demo", enabled: true }]);
    const sync = f.create();
    const first = await sync.capture();
    f.plugins[0]!.version = "2.0.0";
    f.getSource.mockRejectedValue(
      new Error("source metadata should be cached"),
    );
    expect(await sync.capture()).toEqual(first);
  });
  it("does not replace a local path installation with a managed source", async () => {
    const f = fixture([
      { id: "demo", enabled: false, source: "path:/private/local" },
    ]);
    const sync = f.create();
    await sync.capture();
    expect(sync.supports("plugins/demo")).toBe(false);
    await sync.apply({ "plugins/demo": spec }, {});
    expect(f.start).not.toHaveBeenCalled();
    expect(f.enable).not.toHaveBeenCalled();
  });
  it("does not activate a malformed source or unsafe subdirectory", async () => {
    const f = fixture();
    const sync = f.create();
    await sync.capture();
    for (const value of [
      { source: "path:/private/local", enabled: true },
      { source, enabled: true, subdirectory: "../escape" },
      {
        source: `git:https://user:secret@github.com/x/y.git@${commit}`,
        enabled: true,
      },
      { source: "builtin:another", enabled: true },
    ] as Snapshot[string][])
      await expect(sync.prepare({ "plugins/demo": value })).rejects.toThrow();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("stops on an absent bundled plugin before applying any changes", async () => {
    const sync = fixture().create();
    await sync.capture();
    await expect(
      sync.prepare({
        "plugins/new-builtin": { source: "builtin:new-builtin", enabled: true },
      }),
    ).rejects.toThrow("Обнови BB");
  });
  it("accepts an already applied enabled-state change during recovery", async () => {
    const f = fixture([{ id: "demo", enabled: false }]);
    const sync = f.create();
    const before = await sync.capture();
    // A previously applied value is accepted, including crash recovery.
    f.plugins[0]!.enabled = true;
    await sync.apply({ "plugins/demo": spec }, before);
    expect(f.enable).not.toHaveBeenCalled();
  });
  it("resumes a persisted installation job instead of starting it twice", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.start.mockImplementation(async () => {
      const job = { id: "job1", state: "running" };
      f.jobs.set(job.id, job);
      controller.abort();
      return job as Awaited<ReturnType<typeof f.start>>;
    });
    const sync = f.create(controller.signal);
    await sync.capture();
    await expect(sync.apply({ "plugins/demo": spec }, {})).rejects.toThrow();
    expect(f.saved()?.jobs.demo).toBe("job1");
    const plugin = {
      id: "demo",
      enabled: true,
      source,
      provenance: "direct",
      version: "1.0.0",
    };
    f.jobs.set("job1", { id: "job1", state: "succeeded", plugin });
    // Job completion can be observed before the installed inventory refresh.
    const restarted = f.create();
    await restarted.capture();
    await restarted.apply({ "plugins/demo": spec }, {});
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.saved()?.jobs).toEqual({});
  });
  it("records failed installs for safe retry without forgetting the shared target", async () => {
    const f = fixture();
    f.start.mockImplementation(async () => {
      const job = { id: "job1", state: "failed" };
      f.jobs.set(job.id, job);
      return job as Awaited<ReturnType<typeof f.start>>;
    });
    const sync = f.create();
    await sync.capture();
    await expect(sync.apply({ "plugins/demo": spec }, {})).rejects.toThrow(
      "Не удалось установить demo",
    );
    expect(f.saved()?.known).toEqual({});
    expect(f.saved()?.jobs).toEqual({});
  });
});

describe("additive shared plugin manifest", () => {
  it("unions missing plugins on first connection without treating absence as a reset", () => {
    expect(
      merge(null, { "plugins/demo": spec }, { "plugins/other": spec }),
    ).toEqual({
      settings: { "plugins/demo": spec, "plugins/other": spec },
      conflicts: [],
    });
  });
  it("retains entries when an older laptop or a remote edit omits them", () => {
    const base: Snapshot = { "plugins/demo": spec };
    expect(merge(base, {}, base).settings).toEqual(base);
    expect(merge(base, base, {}).settings).toEqual(base);
    expect(merge(base, {}, {}).settings).toEqual(base);
  });
  it("still asks for an explicit enabled-state choice on first connection", () => {
    const plan = merge(
      null,
      { "plugins/demo": spec },
      { "plugins/demo": { ...spec, enabled: false } },
    );
    expect(plan.conflicts.map((c) => c.key)).toEqual(["plugins/demo"]);
  });
});

// Exercise the real merge, durable journal and inventory together as separate devices.
import { Engine, emptyState, type State } from "../src/engine";
import type { Preferences } from "../src/preferences";

function device(
  f: ReturnType<typeof fixture>,
  remote: {
    values: Snapshot;
    read(): Promise<{ sha: string; settings: Snapshot }>;
    write(values: Snapshot): Promise<string>;
  },
) {
  const inventory = f.create();
  let persisted: State | null = null;
  const preferences: Preferences = {
    capture: () => inventory.capture(),
    supports: (key) => inventory.supports(key),
    prepare: async (target) => {
      await inventory.prepare(target);
    },
    apply: (target, before) => inventory.apply(target, before),
  };
  const store = {
    load: async () => structuredClone(persisted),
    save: async (value: State) => {
      persisted = structuredClone(value);
    },
  };
  return { engine: new Engine(preferences, remote, store), store };
}
function repository(values: Snapshot) {
  return {
    values,
    async read() {
      return { sha: "head", settings: structuredClone(this.values) };
    },
    async write(values: Snapshot) {
      this.values = structuredClone(values);
      return "next";
    },
  };
}
describe("plugin sync between devices", () => {
  it("installs on a new laptop, keeps a local uninstall, and still transfers later toggles", async () => {
    const remote = repository({});
    const a = fixture([{ id: "demo", enabled: true }]);
    const laptopA = device(a, remote);
    expect((await laptopA.engine.sync()).phase).toBe("synced");
    const b = fixture();
    const laptopB = device(b, remote);
    expect((await laptopB.engine.sync()).phase).toBe("synced");
    expect(b.plugins[0]?.id).toBe("demo");
    a.plugins.splice(0);
    expect((await laptopA.engine.sync()).phase).toBe("synced");
    expect(a.start).not.toHaveBeenCalled();
    expect(remote.values["plugins/demo"]).toMatchObject({ enabled: true });
    b.plugins[0]!.enabled = false;
    expect((await laptopB.engine.sync()).phase).toBe("synced");
    expect((await laptopA.engine.sync()).phase).toBe("synced");
    expect(a.plugins).toHaveLength(0);
    expect(a.start).not.toHaveBeenCalled();
    const c = fixture();
    expect((await device(c, remote).engine.sync()).phase).toBe("synced");
    expect(c.plugins[0]?.enabled).toBe(false);
  });
  it("retains and completes the engine journal after an installation failure", async () => {
    const remote = repository({ "plugins/demo": spec });
    const f = fixture();
    f.start.mockImplementationOnce(
      async () =>
        ({ id: "failed", state: "failed" }) as Awaited<
          ReturnType<typeof f.start>
        >,
    );
    const laptop = device(f, remote);
    expect((await laptop.engine.sync()).phase).toBe("recovery");
    expect((await laptop.store.load())?.journal?.target).toEqual(remote.values);
    expect((await laptop.engine.sync()).phase).toBe("synced");
    expect((await laptop.store.load())?.journal).toBeNull();
    expect(f.plugins[0]?.id).toBe("demo");
  });
});

import { BbPreferences } from "../src/preferences";

describe("plugin dependencies in preferences", () => {
  it.each([false, true])(
    "installs or enables a theme plugin before applying its theme (present: %s)",
    async (present) => {
      const f = fixture(present ? [{ id: "demo", enabled: false }] : []);
      const appearance = { themeId: "default", faviconColor: "default" };
      const sdk = {
        ...f.sdk,
        system: {
          config: async () => ({
            appearance: { ...appearance },
            defaultKeybindings: [],
            keybindingOverrides: [],
          }),
        },
        theme: {
          resolve: async () => ({
            themeId: f.plugins.some((p) => p.id === "demo" && p.enabled)
              ? "demo/dark"
              : "default",
          }),
          get: async () => ({ ...appearance }),
          set: async (value: typeof appearance) => {
            Object.assign(appearance, value);
          },
        },
      } as unknown as Sdk;
      const preferences = new BbPreferences(
        sdk,
        { appearance: true, keyboard: false, interface: false, plugins: true },
        undefined,
        f.create(),
      );
      const before = await preferences.capture();
      const target: Snapshot = {
        "appearance/themeId": "demo/dark",
        "appearance/faviconColor": "default",
        "plugins/demo": spec,
      };
      await preferences.prepare(target);
      await preferences.apply(target, before);
      expect(appearance.themeId).toBe("demo/dark");
      expect(f.plugins[0]?.enabled).toBe(true);
    },
  );
});

describe("explicit portable sources for local plugins", () => {
  it("exports an explicitly published local plugin without changing its installed source", async () => {
    const f = fixture([
      { id: "demo", enabled: false, source: "path:/private/local" },
    ]);
    const sync = f.create();
    expect(await sync.capture()).toEqual({});
    await sync.registerSources({ demo: spec });
    expect(await sync.capture()).toEqual({
      "plugins/demo": { ...spec, enabled: false },
    });
    expect(f.plugins[0]?.source).toBe("path:/private/local");
    expect(f.start).not.toHaveBeenCalled();
    const restarted = f.create();
    const before = await restarted.capture();
    expect(restarted.supports("plugins/demo")).toBe(true);
    await restarted.apply({ "plugins/demo": spec }, before);
    expect(f.enable).toHaveBeenCalledWith({ pluginId: "demo" });
    expect(f.plugins[0]?.source).toBe("path:/private/local");
  });
  it("validates every registration before persisting any mapping", async () => {
    const f = fixture([
      { id: "demo", enabled: true, source: "path:/private/local" },
    ]);
    const sync = f.create();
    await expect(
      sync.registerSources({ demo: spec, absent: spec }),
    ).rejects.toThrow("Сначала установи");
    expect(f.saved()?.sources ?? {}).toEqual({});
    expect(await sync.capture()).toEqual({});
    await expect(
      sync.registerSources({ demo: { source: "builtin:demo", enabled: true } }),
    ).rejects.toThrow("Недопустимый");
  });
  it("keeps a later removal of a registered local plugin local across restarts", async () => {
    const f = fixture([
      { id: "demo", enabled: true, source: "path:/private/local" },
    ]);
    await f.create().registerSources({ demo: spec });
    f.plugins.splice(0);
    const restarted = f.create();
    expect(await restarted.capture()).toEqual({ "plugins/demo": spec });
    await restarted.apply(
      { "plugins/demo": { ...spec, enabled: false } },
      { "plugins/demo": spec },
    );
    expect(f.start).not.toHaveBeenCalled();
    expect(await restarted.capture()).toEqual({
      "plugins/demo": { ...spec, enabled: false },
    });
  });
  it("installs the published copy on the receiving laptop and transfers later enablement", async () => {
    const remote = repository({});
    const a = fixture([
      { id: "demo", enabled: true, source: "path:/private/local" },
    ]);
    await a.create().registerSources({ demo: spec });
    const laptopA = device(a, remote);
    expect((await laptopA.engine.sync()).phase).toBe("synced");
    const b = fixture();
    const laptopB = device(b, remote);
    expect((await laptopB.engine.sync()).phase).toBe("synced");
    expect(b.start).toHaveBeenCalledWith({ source });
    a.plugins[0]!.enabled = false;
    expect((await laptopA.engine.sync()).phase).toBe("synced");
    expect((await laptopB.engine.sync()).phase).toBe("synced");
    expect(b.plugins[0]?.enabled).toBe(false);
    expect(a.plugins[0]?.source).toBe("path:/private/local");
  });
});

describe("previously unavailable plugin shortcuts", () => {
  it("applies shared shortcuts after installation without publishing a reset from an older baseline", async () => {
    const f = fixture();
    const binding = {
      alt: false,
      control: false,
      key: "S",
      meta: false,
      mod: true,
      shift: false,
    };
    const key = "keyboard/plugin%3Ademo%2Fopen-fresh/mac";
    const config = {
      defaultKeybindings: [],
      keybindingOverrides: [] as unknown[],
    };
    const sdk = {
      ...f.sdk,
      system: {
        config: async () => structuredClone(config),
        updateKeyboardSettings: async (bindings: unknown[]) => {
          config.keybindingOverrides = structuredClone(bindings);
        },
      },
    } as unknown as Sdk;
    const preferences = new BbPreferences(
      sdk,
      { appearance: false, interface: false, keyboard: true, plugins: true },
      undefined,
      f.create(),
    );
    const remote = repository({ "plugins/demo": spec, [key]: binding });
    let persisted: State = { ...emptyState(), base: { [key]: binding } };
    const engine = new Engine(preferences, remote, {
      load: async () => structuredClone(persisted),
      save: async (state) => {
        persisted = structuredClone(state);
      },
    });
    expect((await engine.sync()).phase).toBe("synced");
    expect(remote.values[key]).toEqual(binding);
    expect(config.keybindingOverrides).toEqual([
      { command: "plugin:demo/open-fresh", platform: "mac", shortcut: binding },
    ]);
    expect(engine.getStatus().unsupported).toEqual([]);
    expect((await engine.sync()).phase).toBe("synced");
    expect(remote.values[key]).toEqual(binding);
  });
});
