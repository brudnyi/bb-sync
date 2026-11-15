import { setTimeout as sleep } from "node:timers/promises";
import { type BbPluginApi, defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { Engine, type State, stateSchema, statusSchema } from "./src/engine";
import { GitHub, targetSchema } from "./src/github";
import { fingerprint } from "./src/model";
import { BbPreferences } from "./src/preferences";

const publicSchema = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  repository: z.string(),
  configurationError: z.string().nullable(),
  status: statusSchema.nullable(),
});
export type PublicStatus = z.infer<typeof publicSchema>;
export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: publicSchema },
  sync: { input: z.null(), output: publicSchema },
  resolve: {
    input: z
      .object({
        planId: z.string().length(64),
        choices: z.record(z.string(), z.enum(["local", "remote"])),
      })
      .strict(),
    output: publicSchema,
  },
  restore: { input: z.null(), output: publicSchema },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    repository: {
      type: "string",
      label: "Приватный репозиторий настроек (owner/repository)",
      default: "",
    },
    token: {
      type: "string",
      label: "GitHub token — Contents: read and write",
      secret: true,
    },
    branch: { type: "string", label: "Ветка", default: "main" },
    path: { type: "string", label: "Файл настроек", default: "bb-sync.json" },
    enabled: {
      type: "boolean",
      label: "Автоматическая синхронизация",
      default: false,
    },
    appearance: { type: "boolean", label: "Тема и цвет значка", default: true },
    keyboard: { type: "boolean", label: "Шорткаты", default: true },
    interface: {
      type: "boolean",
      label: "Интерфейс и навигация",
      default: true,
    },
    intervalSeconds: {
      type: "number",
      label: "Проверять GitHub каждые (секунд)",
      default: 60,
      experimental_schema: z.number().int().min(30).max(3600),
    },
  });
  const database = bb.storage.database();
  bb.storage.migrate(database, [
    "CREATE TABLE sync_state (target TEXT PRIMARY KEY, value TEXT NOT NULL)",
  ]);
  const lifecycle = new AbortController();
  type Runtime = {
    engine: Engine;
    preferences: BbPreferences;
    controller: AbortController;
    key: string;
  };
  let runtime: Runtime | null = null;
  let initializing: Promise<Runtime> | null = null;
  const publish = () => {
    if (!lifecycle.signal.aborted) bb.realtime.publish("changed", null);
  };
  async function getRuntime(): Promise<Runtime> {
    if (initializing) return initializing;
    initializing = (async () => {
      lifecycle.signal.throwIfAborted();
      const config = await settings.get();
      const target = targetSchema.parse({
        repository: config.repository.trim(),
        branch: config.branch,
        path: config.path,
      });
      if (!config.token)
        throw new Error("Добавьте GitHub token в настройках плагина.");
      const scope = {
        appearance: config.appearance,
        keyboard: config.keyboard,
        interface: config.interface,
      };
      if (!Object.values(scope).some(Boolean))
        throw new Error("Выберите хотя бы одну группу настроек.");
      const id = fingerprint({ target, scope });
      const key = fingerprint({ id, token: config.token });
      if (runtime?.key === key) return runtime;
      runtime?.controller.abort();
      await runtime?.engine.drain();
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, lifecycle.signal]);
      const preferences = new BbPreferences(bb.sdk, scope, signal);
      const remote = new GitHub(target, config.token, signal);
      const engine = new Engine(
        preferences,
        remote,
        {
          async load() {
            signal.throwIfAborted();
            const row = database
              .prepare("SELECT value FROM sync_state WHERE target = ?")
              .get(id) as { value: string } | undefined;
            return row ? stateSchema.parse(JSON.parse(row.value)) : null;
          },
          async save(state: State) {
            signal.throwIfAborted();
            database
              .prepare(
                "INSERT INTO sync_state(target, value) VALUES (?, ?) ON CONFLICT(target) DO UPDATE SET value=excluded.value",
              )
              .run(id, JSON.stringify(state));
          },
        },
        publish,
      );
      await engine.initialize();
      runtime = { engine, preferences, controller, key };
      return runtime;
    })();
    try {
      return await initializing;
    } finally {
      initializing = null;
    }
  }
  async function publicStatus(): Promise<PublicStatus> {
    const config = await settings.get();
    try {
      const r = await getRuntime();
      return {
        configured: true,
        enabled: config.enabled,
        repository: config.repository,
        configurationError: null,
        status: r.engine.getStatus(),
      };
    } catch (error) {
      return {
        configured: false,
        enabled: config.enabled,
        repository: config.repository,
        configurationError:
          error instanceof z.ZodError
            ? error.issues.map((i) => i.message).join("; ")
            : error instanceof Error
              ? error.message
              : "Проверьте настройки подключения",
        status: null,
      };
    }
  }
  async function sync(
    resolution?: Parameters<Engine["sync"]>[0],
  ): Promise<PublicStatus> {
    const r = await getRuntime();
    await r.engine.sync(resolution);
    return publicStatus();
  }
  async function restore(): Promise<PublicStatus> {
    // Pause first so the next background pass cannot republish the restored snapshot.
    await settings.experimental_set({ enabled: false });
    const r = await getRuntime();
    await r.engine.restore();
    publish();
    return publicStatus();
  }
  bb.rpc.register(rpcContract, {
    status: publicStatus,
    sync: () => sync(),
    resolve: (input) => sync(input),
    restore,
  });
  bb.cli.register({
    name: "sync",
    summary: "Sync BB preferences through GitHub",
    commands: [
      {
        name: "status",
        summary: "Show sync status",
        usage: "bb sync status [--json]",
      },
      { name: "now", summary: "Sync once", usage: "bb sync now [--json]" },
      {
        name: "restore",
        summary: "Restore local snapshot and pause auto-sync",
        usage: "bb sync restore [--json]",
      },
    ],
    async run(argv) {
      const args = argv.filter((a) => a !== "--json");
      if (
        args.length !== 1 ||
        !["status", "now", "restore"].includes(args[0]!)
      ) {
        return {
          exitCode: args.includes("--help") || args.length === 0 ? 0 : 1,
          stdout: "bb sync status|now|restore [--json]",
        };
      }
      try {
        const result =
          args[0] === "now"
            ? await sync()
            : args[0] === "restore"
              ? await restore()
              : await publicStatus();
        return {
          exitCode:
            !result.configured ||
            ["error", "conflict", "recovery"].includes(
              result.status?.phase ?? "",
            )
              ? 1
              : 0,
          stdout: argv.includes("--json")
            ? JSON.stringify(result)
            : (result.configurationError ??
              result.status?.message ??
              "Не настроено"),
        };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : "Sync failed",
        };
      }
    },
  });
  settings.onChange(() => {
    publish();
  });
  bb.background.service("sync", {
    async start(signal) {
      const combined = AbortSignal.any([signal, lifecycle.signal]);
      let lastRemote = 0,
        seen = "",
        settled = "",
        failures = 0;
      while (!combined.aborted) {
        try {
          const config = await settings.get();
          if (config.enabled) {
            const r = await getRuntime();
            const local = fingerprint(await r.preferences.capture());
            const observation = `${r.key}:${local}`;
            const due =
              Date.now() - lastRemote >=
              Math.max(
                config.intervalSeconds * 1000,
                Math.min(900_000, 30_000 * 2 ** failures),
              );
            const changed = observation === seen && observation !== settled;
            seen = observation;
            // Conflicts are checked again only after a local edit or the next remote poll.
            if (due || changed) {
              const result = await r.engine.sync();
              lastRemote = Date.now();
              settled = `${r.key}:${fingerprint(await r.preferences.capture())}`;
              failures =
                result.phase === "error" || result.phase === "recovery"
                  ? Math.min(5, failures + 1)
                  : 0;
            }
          }
        } catch {
          if (combined.aborted) break;
          // Status RPC exposes configuration errors; never log credentials or full responses.
          failures = Math.min(5, failures + 1);
        }
        try {
          await sleep(3000, undefined, { signal: combined });
        } catch {
          break;
        }
      }
    },
  });
  bb.onDispose(async () => {
    lifecycle.abort();
    runtime?.controller.abort();
    await runtime?.engine.drain();
  });
}
