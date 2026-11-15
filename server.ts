import { setTimeout as sleep } from "node:timers/promises";
import { type BbPluginApi, defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  Engine,
  previewSchema,
  type State,
  stateSchema,
  statusSchema,
} from "./src/engine";
import { GitHub, targetSchema } from "./src/github";
import { fingerprint } from "./src/model";
import {
  accountSchema,
  authSchema,
  GitHubAccount,
  GitHubLogin,
  repositorySchema,
} from "./src/onboarding";
import { PluginSync, pluginMemorySchema } from "./src/plugins";
import { BbPreferences } from "./src/preferences";

const publicSchema = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  repository: z.string(),
  configurationError: z.string().nullable(),
  status: statusSchema.nullable(),
  hasBaseline: z.boolean(),
  needsReview: z.boolean(),
  options: z.object({
    appearance: z.boolean(),
    keyboard: z.boolean(),
    interface: z.boolean(),
    plugins: z.boolean(),
    intervalSeconds: z.number(),
  }),
});
const choiceInput = z
  .object({
    planId: z.string().length(64),
    choices: z.record(z.string(), z.enum(["local", "remote"])),
  })
  .strict();
const scopeInput = z
  .object({
    appearance: z.boolean(),
    keyboard: z.boolean(),
    interface: z.boolean(),
    plugins: z.boolean(),
  })
  .refine(
    (v) => Object.values(v).some(Boolean),
    "Выбери хотя бы одну группу настроек.",
  );
const setupSchema = z.object({
  account: accountSchema.nullable(),
  auth: authSchema,
  error: z.string().nullable(),
});
export type SetupState = z.infer<typeof setupSchema>;
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
  preview: { input: z.null(), output: previewSchema },
  setup_load: { input: z.null(), output: setupSchema },
  auth_start: { input: z.null(), output: authSchema },
  auth_restart: { input: z.null(), output: authSchema },
  auth_status: { input: z.null(), output: authSchema },
  auth_cancel: { input: z.null(), output: authSchema },
  repositories: {
    input: z.object({ page: z.number().int().min(1).max(100) }),
    output: z.object({
      repositories: z.array(repositorySchema),
      more: z.boolean(),
    }),
  },
  setup_prepare: {
    input: z
      .object({
        create: z.boolean(),
        repository: z.string().max(250),
        scope: scopeInput,
      })
      .strict(),
    output: publicSchema,
  },
  setup_finish: { input: choiceInput, output: publicSchema },
  options: {
    input: z
      .object({
        enabled: z.boolean().optional(),
        appearance: z.boolean().optional(),
        keyboard: z.boolean().optional(),
        interface: z.boolean().optional(),
        plugins: z.boolean().optional(),
        intervalSeconds: z.number().int().min(30).max(3600).optional(),
      })
      .strict(),
    output: publicSchema,
  },
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
    plugins: {
      type: "boolean",
      label: "Установка и включение плагинов",
      default: false,
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
  const login = new GitHubLogin(
    async (token) => {
      await settings.experimental_set({ token });
    },
    publish,
    lifecycle.signal,
  );
  async function accountClient() {
    const { token } = await settings.get();
    if (!token) throw new Error("Сначала подключи GitHub.");
    return new GitHubAccount(token, lifecycle.signal);
  }
  let edits: Promise<unknown> = Promise.resolve();
  function edit<T>(task: () => Promise<T>): Promise<T> {
    const result = edits.then(task);
    edits = result.catch(() => {});
    return result;
  }
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
        plugins: config.plugins,
      };
      if (!Object.values(scope).some(Boolean))
        throw new Error("Выберите хотя бы одну группу настроек.");
      // Keep the existing baseline identity when the new group is off.
      const { plugins, ...originalScope } = scope;
      const id = fingerprint({
        target,
        scope: plugins ? scope : originalScope,
      });
      const key = fingerprint({ id, token: config.token });
      if (runtime?.key === key && !runtime.controller.signal.aborted)
        return runtime;
      runtime?.controller.abort();
      await runtime?.engine.drain();
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, lifecycle.signal]);
      const pluginSync = scope.plugins
        ? new PluginSync(
            bb.sdk,
            {
              async load() {
                const row = database
                  .prepare("SELECT value FROM sync_state WHERE target = ?")
                  .get("plugin-inventory-v1") as { value: string } | undefined;
                return row
                  ? pluginMemorySchema.parse(JSON.parse(row.value))
                  : null;
              },
              async save(value) {
                signal.throwIfAborted();
                database
                  .prepare(
                    "INSERT INTO sync_state(target, value) VALUES (?, ?) ON CONFLICT(target) DO UPDATE SET value=excluded.value",
                  )
                  .run("plugin-inventory-v1", JSON.stringify(value));
              },
            },
            signal,
            (message) => engine.progress(message),
          )
        : undefined;
      const preferences = new BbPreferences(bb.sdk, scope, signal, pluginSync);
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
  let operation: Promise<PublicStatus> | null = null;
  let operationError: string | null = null;
  async function publicStatus(): Promise<PublicStatus> {
    const config = await settings.get();
    try {
      const r = await getRuntime();
      return {
        configured: true,
        enabled: config.enabled,
        repository: config.repository,
        configurationError: null,
        status: operationError
          ? { ...r.engine.getStatus(), phase: "error", message: operationError }
          : operation
            ? { ...r.engine.getStatus(), phase: "syncing" }
            : r.engine.getStatus(),
        hasBaseline: await r.engine.hasBaseline(),
        needsReview:
          (await bb.storage.kv.get<boolean>("review-required")) === true,
        options: {
          appearance: config.appearance,
          keyboard: config.keyboard,
          interface: config.interface,
          plugins: config.plugins,
          intervalSeconds: config.intervalSeconds,
        },
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
        hasBaseline: false,
        needsReview: false,
        options: {
          appearance: config.appearance,
          keyboard: config.keyboard,
          interface: config.interface,
          plugins: config.plugins,
          intervalSeconds: config.intervalSeconds,
        },
      };
    }
  }
  async function sync(
    resolution?: Parameters<Engine["sync"]>[0],
  ): Promise<PublicStatus> {
    operationError = null;
    const r = await getRuntime();
    await r.engine.sync(resolution);
    if (r.engine.getStatus().phase === "synced")
      await bb.storage.kv.set("review-required", false);
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
  async function launch(
    task: () => Promise<PublicStatus>,
  ): Promise<PublicStatus> {
    if (!operation) {
      operationError = null;
      operation = task();
      void operation
        .catch((error: unknown) => {
          operationError =
            error instanceof Error
              ? error.message
              : "Не удалось завершить перенос.";
          publish();
        })
        .finally(() => {
          operation = null;
          publish();
        });
    }
    // Keep RPCs short while BB's durable installation jobs continue server-side.
    await Promise.race([operation.catch(() => {}), sleep(150)]);
    if (operationError) throw new Error(operationError);
    return publicStatus();
  }
  bb.rpc.register(rpcContract, {
    status: publicStatus,
    sync: () => launch(() => sync()),
    resolve: (input) => launch(() => sync(input)),
    restore: () => launch(restore),
    preview: async () => {
      const r = await getRuntime();
      const preview = await r.engine.preview();
      return {
        ...preview,
        planId: fingerprint({ target: r.key, planId: preview.planId }),
      };
    },
    setup_load: async () => {
      const { token } = await settings.get();
      if (!token) return { account: null, auth: login.status(), error: null };
      try {
        return {
          account: await (await accountClient()).user(),
          auth: login.status(),
          error: null,
        };
      } catch {
        return {
          account: null,
          auth: login.status(),
          error: "Не удалось проверить аккаунт. Повтори подключение GitHub.",
        };
      }
    },
    auth_start: () => login.begin(),
    auth_restart: () => login.begin(true),
    auth_status: () => login.status(),
    auth_cancel: () => login.cancel(),
    repositories: async ({ page }) =>
      (await accountClient()).repositories(page),
    setup_prepare: (input) =>
      edit(async () => {
        if (runtime?.engine.getStatus().phase === "recovery")
          throw new Error(
            "Сначала заверши прерванное применение или восстанови снимок.",
          );
        const client = await accountClient();
        const repo = input.create
          ? await client.create(input.repository)
          : await client.repository(input.repository.trim());
        await client.initialize(repo);
        const previous = await settings.get();
        const sameRepo =
          previous.repository.toLowerCase() === repo.fullName.toLowerCase();
        await bb.storage.kv.set("review-required", true);
        await settings.experimental_set({
          repository: repo.fullName,
          branch: sameRepo ? previous.branch : repo.branch,
          path: sameRepo ? previous.path : "bb-sync.json",
          enabled: false,
          ...input.scope,
        });
        publish();
        return publicStatus();
      }),
    setup_finish: (input) =>
      launch(() =>
        edit(async () => {
          const r = await getRuntime();
          const preview = await r.engine.preview();
          if (
            input.planId !==
            fingerprint({ target: r.key, planId: preview.planId })
          )
            throw new Error(
              "Настройки или хранилище изменились. Обнови сравнение перед переносом.",
            );
          await r.engine.sync({
            planId: preview.planId,
            choices: input.choices,
          });
          if ((await getRuntime()).key !== r.key)
            throw new Error(
              "Подключение изменилось во время переноса. Проверь выбранное хранилище.",
            );
          if (r.engine.getStatus().phase === "synced") {
            await bb.storage.kv.set("review-required", false);
            await settings.experimental_set({ enabled: true });
          }
          publish();
          return publicStatus();
        }),
      ),
    options: (input) =>
      edit(async () => {
        const config = await settings.get();
        const scope = {
          appearance: input.appearance ?? config.appearance,
          keyboard: input.keyboard ?? config.keyboard,
          interface: input.interface ?? config.interface,
          plugins: input.plugins ?? config.plugins,
        };
        scopeInput.parse(scope);
        const scopeChanged = Object.entries(scope).some(
          ([k, value]) => config[k as keyof typeof scope] !== value,
        );
        if (scopeChanged && runtime?.engine.getStatus().phase === "recovery")
          throw new Error("Сначала заверши прерванное применение.");
        if (
          input.enabled &&
          !scopeChanged &&
          ((await bb.storage.kv.get<boolean>("review-required")) === true ||
            !(await (await getRuntime()).engine.hasBaseline()))
        )
          throw new Error("Сначала выполни первый перенос настроек.");
        await settings.experimental_set({
          ...input,
          ...(scopeChanged ? { enabled: false } : {}),
        });
        if (scopeChanged) await bb.storage.kv.set("review-required", true);
        publish();
        return publicStatus();
      }),
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
  settings.onChange((next, previous) => {
    const keys = [
      "repository",
      "branch",
      "path",
      "token",
      "appearance",
      "keyboard",
      "interface",
      "plugins",
    ] as const;
    if (keys.some((key) => next[key] !== previous[key]))
      runtime?.controller.abort();
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
          if (
            config.enabled &&
            !operation &&
            (!runtime ||
              runtime.controller.signal.aborted ||
              runtime.engine.getStatus().phase !== "syncing") &&
            !(await bb.storage.kv.get<boolean>("review-required"))
          ) {
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
            if ((due || changed) && !operation) {
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
    await login.dispose();
    await operation?.catch(() => {});
    await edits;
    runtime?.controller.abort();
    await runtime?.engine.drain();
  });
}
