import { setTimeout as sleep } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { equal, type Snapshot } from "./model";

type Sdk = BbPluginApi["sdk"];
type Installed = Awaited<ReturnType<Sdk["plugins"]["list"]>>["plugins"][number];
const idPattern = /^[a-z0-9][a-z0-9_-]{0,149}$/;
const directory = z
  .string()
  .max(500)
  .refine((s) =>
    s
      .split("/")
      .every(
        (part) =>
          /^[a-zA-Z0-9_.-]+$/.test(part) && part !== "." && part !== "..",
      ),
  );
function portableSource(source: string): boolean {
  if (/^builtin:[a-z0-9][a-z0-9_-]{0,149}$/.test(source)) return true;
  if (
    /^npm:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(
      source,
    )
  )
    return true;
  const match = /^git:(https:\/\/.+)@([a-f0-9]{40})$/.exec(source);
  if (!match) return false;
  try {
    const url = new URL(match[1]!);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
export const pluginSpecSchema = z
  .object({
    enabled: z.boolean(),
    source: z
      .string()
      .max(1000)
      .refine(portableSource, "Непереносимый источник плагина"),
    subdirectory: directory.optional(),
  })
  .strict()
  .refine((v) => !v.subdirectory || v.source.startsWith("git:"));
export type PluginSpec = z.infer<typeof pluginSpecSchema>;
export function pluginId(key: string): string | null {
  const id = key.startsWith("plugins/") ? key.slice(8) : "";
  return idPattern.test(id) && id !== "bb-sync" ? id : null;
}
export const pluginMemorySchema = z.object({
  known: z.record(z.string(), pluginSpecSchema),
  jobs: z.record(z.string(), z.string()),
});
export type PluginMemory = z.infer<typeof pluginMemorySchema>;
export interface PluginMemoryStore {
  load(): Promise<PluginMemory | null>;
  save(value: PluginMemory): Promise<void>;
}

// This inventory is device-local. Retaining a missing known entry prevents a
// local uninstall from becoming either a shared deletion or a reinstall loop.
export class PluginSync {
  private memory: Promise<PluginMemory> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private installed = new Map<string, Installed>();
  constructor(
    private sdk: Sdk,
    private store: PluginMemoryStore,
    private signal?: AbortSignal,
    private progress: (message: string) => void = () => {},
  ) {}
  private loadMemory(): Promise<PluginMemory> {
    this.memory ??= this.store
      .load()
      .then((value) =>
        pluginMemorySchema.parse(value ?? { known: {}, jobs: {} }),
      );
    return this.memory;
  }
  private async save(memory: PluginMemory) {
    const value = structuredClone(memory);
    this.writes = this.writes
      .catch(() => {})
      .then(() => this.store.save(value));
    await this.writes;
  }
  supports(key: string) {
    const id = pluginId(key);
    return (
      id !== null &&
      (!this.installed.get(id) || this.isPortable(this.installed.get(id)!))
    );
  }
  private isPortable(p: Installed) {
    return (
      p.provenance === "builtin" ||
      p.source.startsWith("git:https://") ||
      p.source.startsWith("npm:")
    );
  }
  private async spec(p: Installed): Promise<PluginSpec | null> {
    if (!this.isPortable(p)) return null;
    if (p.provenance === "builtin")
      return { enabled: p.enabled, source: `builtin:${p.id}` };
    const detail = await this.sdk.plugins.getSource({
      pluginId: p.id,
      signal: this.signal,
    });
    let source: string;
    if (p.source.startsWith("npm:")) {
      const name = /^(npm:(?:@[^/]+\/)?[^@]+)@/.exec(detail.requested)?.[1];
      if (!name) return null;
      source = `${name}@${p.version}`;
    } else {
      // Use the activated commit, never a moving branch or a credential-bearing URL.
      const commit = detail.history.reduce<
        (typeof detail.history)[number] | undefined
      >(
        (latest, entry) =>
          !latest || entry.activatedAt > latest.activatedAt ? entry : latest,
        undefined,
      )?.version;
      if (!commit) return null;
      // The requested semver form can contain '/' in its tag prefix.
      const repository = detail.requested
        .slice(4)
        .split("@semver:")[0]!
        .replace(/@[a-zA-Z0-9._/-]+$/, "");
      source = `git:${repository}@${commit}`;
    }
    const parsed = pluginSpecSchema.safeParse({
      enabled: p.enabled,
      source,
      ...(detail.subdirectory ? { subdirectory: detail.subdirectory } : {}),
    });
    return parsed.success ? parsed.data : null;
  }
  async capture(): Promise<Snapshot> {
    this.signal?.throwIfAborted();
    const { plugins } = await this.sdk.plugins.list({ signal: this.signal });
    this.installed = new Map(plugins.map((p) => [p.id, p]));
    const memory = await this.loadMemory();
    const previous = structuredClone(memory.known);
    const result: Snapshot = {};
    for (const p of plugins) {
      if (!pluginId(`plugins/${p.id}`) || !this.isPortable(p)) continue;
      const spec = memory.known[p.id]
        ? { ...memory.known[p.id]!, enabled: p.enabled }
        : await this.spec(p);
      if (spec) memory.known[p.id] = spec;
    }
    for (const [id, spec] of Object.entries(memory.known))
      if (this.supports(`plugins/${id}`)) result[`plugins/${id}`] = spec;
    if (!equal(previous, memory.known)) await this.save(memory);
    return result;
  }
  async prepare(target: Snapshot): Promise<boolean> {
    const memory = await this.loadMemory();
    let activation = false;
    for (const [key, value] of Object.entries(target)) {
      if (!this.supports(key)) continue;
      const id = pluginId(key)!;
      const spec = pluginSpecSchema.parse(value);
      if (spec.source.startsWith("builtin:") && spec.source !== `builtin:${id}`)
        throw new Error(`Источник не соответствует плагину ${id}.`);
      if (!this.installed.has(id) && !memory.known[id]) {
        if (spec.source.startsWith("builtin:"))
          throw new Error(
            `Обнови BB: встроенный плагин ${id} отсутствует на этом ноутбуке.`,
          );
        activation = true;
      }
      if (spec.enabled && this.installed.get(id)?.enabled === false)
        activation = true;
    }
    return activation;
  }
  private async install(id: string, spec: PluginSpec, memory: PluginMemory) {
    this.progress(`Установка плагина ${id}…`);
    let job = memory.jobs[id]
      ? await this.sdk.plugins.installJobs.get({ jobId: memory.jobs[id]! })
      : undefined;
    if (!job) {
      // Reconcile a lost startInstall response before creating another job.
      const jobs = await this.sdk.plugins.installJobs.list({
        signal: this.signal,
      });
      job = jobs.find((j) => {
        if (j.state !== "queued" && j.state !== "running") return false;
        const t = j.target;
        return (
          t.kind === "source" &&
          t.source === spec.source &&
          (spec.subdirectory
            ? t.selection.kind === "subdirectory" &&
              t.selection.path === spec.subdirectory
            : t.selection.kind === "root")
        );
      });
      job ??= await this.sdk.plugins.startInstall({
        source: spec.source,
        ...(spec.subdirectory ? { subdirectory: spec.subdirectory } : {}),
      });
      memory.jobs[id] = job.id;
      await this.save(memory);
    }
    while (job.state === "queued" || job.state === "running") {
      await sleep(750, undefined, { signal: this.signal });
      job = await this.sdk.plugins.installJobs.get({ jobId: job.id });
    }
    if (job.state !== "succeeded") {
      delete memory.jobs[id];
      await this.save(memory);
      throw new Error(
        `Не удалось установить ${id}. Проверь доступ к источнику и совместимость с BB, затем повтори синхронизацию.`,
      );
    }
    if (job.plugin.id !== id)
      throw new Error(
        `Источник ${id} установил другой плагин. Автоматическое применение остановлено.`,
      );
    this.installed.set(id, job.plugin);
    // Preserve the job until the inventory is durable so recovery never mistakes
    // our completed install for a deliberate local uninstall.
    memory.known[id] = spec;
    delete memory.jobs[id];
    await this.save(memory);
  }
  async apply(target: Snapshot, before: Snapshot) {
    await this.capture();
    await this.prepare(target);
    const memory = await this.loadMemory();
    for (const [key, value] of Object.entries(target)) {
      if (!this.supports(key)) continue;
      this.signal?.throwIfAborted();
      const id = pluginId(key)!;
      const spec = pluginSpecSchema.parse(value);
      if (equal(before[key], value) && equal(memory.known[id], spec)) continue;
      // Re-read immediately before changing state; never overwrite a third edit.
      const fresh = await this.sdk.plugins.list({ signal: this.signal });
      this.installed = new Map(fresh.plugins.map((p) => [p.id, p]));
      if (!this.supports(key)) continue;
      let current = this.installed.get(id);
      if (!current && !memory.known[id]) {
        await this.install(id, spec, memory);
        current = this.installed.get(id);
      }
      if (current && current.enabled !== spec.enabled) {
        const old =
          before[key] === undefined
            ? undefined
            : pluginSpecSchema.parse(before[key]).enabled;
        if (old !== undefined && current.enabled !== old)
          throw new Error(
            `Состояние ${id} изменилось во время переноса. Проверь его перед повтором.`,
          );
        this.progress(
          `${spec.enabled ? "Включение" : "Отключение"} плагина ${id}…`,
        );
        if (spec.enabled) await this.sdk.plugins.enable({ pluginId: id });
        else await this.sdk.plugins.disable({ pluginId: id });
      }
      if (!equal(memory.known[id], spec)) {
        memory.known[id] = spec;
        await this.save(memory);
      }
    }
  }
}
