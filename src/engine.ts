import { z } from "zod";
import { type Remote, RemoteChanged } from "./github";
import {
  type Choices,
  conflictSchema,
  equal,
  fingerprint,
  merge,
  type Snapshot,
  snapshotSchema,
} from "./model";
import type { Preferences } from "./preferences";

const journalSchema = z.object({
  kind: z.enum(["sync", "restore"]),
  before: snapshotSchema,
  target: snapshotSchema,
  createdAt: z.string(),
});
export const stateSchema = z.object({
  base: snapshotSchema.nullable(),
  journal: journalSchema.nullable(),
  backup: journalSchema.nullable(),
  lastSync: z.string().nullable(),
});
export type State = z.infer<typeof stateSchema>;
export const statusSchema = z.object({
  phase: z.enum([
    "ready",
    "syncing",
    "synced",
    "conflict",
    "error",
    "recovery",
  ]),
  message: z.string(),
  lastSync: z.string().nullable(),
  backupAt: z.string().nullable(),
  planId: z.string().nullable(),
  conflicts: z.array(conflictSchema),
  unsupported: z.array(z.string()),
});
export type SyncStatus = z.infer<typeof statusSchema>;
export const previewSchema = z.object({
  planId: z.string(),
  firstConnection: z.boolean(),
  remoteExists: z.boolean(),
  localCount: z.number(),
  changes: z.array(conflictSchema.extend({ conflicting: z.boolean() })),
  unsupported: z.array(z.string()),
});
export type Preview = z.infer<typeof previewSchema>;
export type RemoteStore = {
  read(): Promise<Remote>;
  write(settings: Snapshot, sha: string | null): Promise<string>;
};
export interface StateStore {
  load(): Promise<State | null>;
  save(state: State): Promise<void>;
}
export const emptyState = (): State => ({
  base: null,
  journal: null,
  backup: null,
  lastSync: null,
});

export class Engine {
  private queue: Promise<unknown> = Promise.resolve();
  private status: SyncStatus = {
    phase: "ready",
    message: "Готово к синхронизации",
    lastSync: null,
    backupAt: null,
    planId: null,
    conflicts: [],
    unsupported: [],
  };
  constructor(
    private preferences: Preferences,
    private remote: RemoteStore,
    private store: StateStore,
    private changed: () => void = () => {},
  ) {}
  async initialize(): Promise<void> {
    const state = await this.store.load();
    if (state)
      this.setStatus({
        lastSync: state.lastSync,
        backupAt: state.backup?.createdAt ?? null,
        ...(state.journal
          ? {
              phase: "recovery",
              message:
                "Применение было прервано. Повторите синхронизацию или восстановите снимок.",
            }
          : {}),
      });
  }
  progress(message: string): void {
    this.setStatus({ message });
  }
  getStatus(): SyncStatus {
    return structuredClone(this.status);
  }
  configure(task: () => Promise<void>): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.store.load();
      if (state?.journal)
        throw new Error("Сначала заверши прерванное применение.");
      await task();
    });
  }
  async drain(): Promise<void> {
    await this.queue;
  }
  private setStatus(update: Partial<SyncStatus>) {
    this.status = { ...this.status, ...update };
    this.changed();
  }
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
  private async readPlan(
    state: State,
    resolution?: { planId: string; choices: Choices },
  ) {
    const remote = await this.remote.read();
    const originalRemoteSettings = structuredClone(remote.settings);
    if (state.base !== null && remote.sha === null)
      throw new Error(
        "Файл настроек удалён из GitHub. Восстановите его из истории репозитория.",
      );
    const local = await this.preferences.capture();
    const base = state.base;
    // Preserve settings owned by a newer plugin or disabled scope verbatim.
    const projectedLocal: Snapshot = { ...local };
    const unsupported = Object.keys(remote.settings).filter(
      (k) => !this.preferences.supports(k),
    );
    for (const key of new Set([...Object.keys(base ?? {}), ...unsupported])) {
      if (!this.preferences.supports(key)) {
        if (Object.hasOwn(remote.settings, key))
          projectedLocal[key] = remote.settings[key]!;
        else delete projectedLocal[key];
      }
    }
    // A newly enabled scope has no remote values yet. Keep required local
    // preferences; absent keyboard entries still mean reset and need a choice.
    if (base === null)
      for (const [key, value] of Object.entries(projectedLocal)) {
        if (
          this.preferences.supports(key) &&
          !key.startsWith("keyboard/") &&
          !key.startsWith("plugins/") &&
          !Object.hasOwn(remote.settings, key)
        )
          remote.settings[key] = value;
      }
    const planId = fingerprint({ base, local: projectedLocal, remote });
    if (resolution && resolution.planId !== planId)
      throw new Error(
        "Настройки изменились после показа конфликта. Обновите сравнение и выберите значения заново.",
      );
    const initial = remote.sha === null && base === null;
    const plan = initial
      ? { settings: projectedLocal, conflicts: [] }
      : merge(base, projectedLocal, remote.settings, resolution?.choices);
    return {
      remote,
      originalRemoteSettings,
      local,
      base,
      unsupported,
      planId,
      plan,
    };
  }
  async hasBaseline(): Promise<boolean> {
    const state = await this.store.load();
    return state !== null && state.base !== null;
  }
  preview(): Promise<Preview> {
    return this.exclusive(async () => {
      const state = (await this.store.load()) ?? emptyState();
      if (state.journal)
        throw new Error(
          "Сначала заверши прерванное применение или восстанови снимок.",
        );
      const {
        remote,
        originalRemoteSettings,
        local,
        base,
        unsupported,
        planId,
        plan,
      } = await this.readPlan(state);
      const conflictKeys = new Set(plan.conflicts.map((c) => c.key));
      const changes = [
        ...new Set([
          ...Object.keys(local),
          ...Object.keys(originalRemoteSettings),
        ]),
      ]
        .sort()
        .filter(
          (key) =>
            this.preferences.supports(key) &&
            !equal(local[key], originalRemoteSettings[key]),
        )
        .map((key) => ({
          key,
          base: base?.[key] ?? null,
          local: local[key] ?? null,
          remote: originalRemoteSettings[key] ?? null,
          basePresent: base?.[key] !== undefined,
          localPresent: Object.hasOwn(local, key),
          remotePresent: Object.hasOwn(originalRemoteSettings, key),
          conflicting: conflictKeys.has(key),
        }));
      return {
        planId,
        firstConnection: base === null,
        remoteExists: remote.sha !== null,
        localCount: Object.keys(local).length,
        changes,
        unsupported: unsupported.slice(0, 100),
      };
    });
  }
  sync(resolution?: { planId: string; choices: Choices }): Promise<SyncStatus> {
    return this.exclusive(async () => {
      this.setStatus({ phase: "syncing", message: "Синхронизация…" });
      let state = (await this.store.load()) ?? emptyState();
      try {
        // A durable journal prevents a partial apply from being pushed back as a new edit.
        if (state.journal) {
          const restoring = state.journal.kind === "restore";
          await this.preferences.capture();
          await this.preferences.apply(
            state.journal.target,
            state.journal.before,
          );
          state = {
            ...state,
            base:
              state.journal.kind === "sync" ? state.journal.target : state.base,
            journal: null,
            lastSync: new Date().toISOString(),
          };
          await this.store.save(state);
          if (restoring) {
            this.setStatus({
              phase: "ready",
              message: "Снимок восстановлен. Автосинхронизация приостановлена.",
              planId: null,
              conflicts: [],
            });
            return this.getStatus();
          }
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          const {
            remote,
            originalRemoteSettings,
            local,
            base,
            unsupported,
            planId,
            plan,
          } = await this.readPlan(state, resolution);
          if (plan.conflicts.length) {
            this.setStatus({
              phase: "conflict",
              message:
                base === null
                  ? "Первое подключение: выберите различающиеся настройки."
                  : "Выберите значения конфликтующих настроек.",
              planId,
              conflicts: plan.conflicts,
              unsupported: unsupported.slice(0, 100),
            });
            return this.getStatus();
          }
          await this.preferences.prepare(plan.settings);
          if (
            !equal(originalRemoteSettings, plan.settings) ||
            remote.sha === null
          ) {
            try {
              await this.remote.write(plan.settings, remote.sha);
            } catch (error) {
              if (error instanceof RemoteChanged && !resolution && attempt < 2)
                continue;
              throw error;
            }
          }
          // Save before the first local mutation. A lost GitHub response is harmless:
          // the old baseline will merge the same remote commit on the next attempt.
          const targetChanged = !equal(
            local,
            Object.fromEntries(
              Object.entries(plan.settings).filter(([k]) =>
                this.preferences.supports(k),
              ),
            ),
          );
          if (targetChanged) {
            const journal = {
              kind: "sync" as const,
              before: local,
              target: plan.settings,
              createdAt: new Date().toISOString(),
            };
            state = { ...state, journal, backup: journal };
            await this.store.save(state);
            this.setStatus({ backupAt: journal.createdAt });
            await this.preferences.apply(plan.settings, local);
          }
          state = {
            ...state,
            base: plan.settings,
            journal: null,
            lastSync: new Date().toISOString(),
          };
          await this.store.save(state);
          this.setStatus({
            phase: "synced",
            message: "Все настройки синхронизированы",
            lastSync: state.lastSync,
            backupAt: state.backup?.createdAt ?? null,
            planId: null,
            conflicts: [],
            unsupported: unsupported
              .filter((key) => !this.preferences.supports(key))
              .slice(0, 100),
          });
          return this.getStatus();
        }
        throw new Error("GitHub keeps changing. Try again shortly.");
      } catch (error) {
        const persisted = await this.store.load();
        this.setStatus({
          phase: persisted?.journal ? "recovery" : "error",
          message:
            error instanceof Error ? error.message : "Синхронизация не удалась",
          planId: null,
          conflicts: [],
        });
        return this.getStatus();
      }
    });
  }
  restore(): Promise<SyncStatus> {
    return this.exclusive(async () => {
      const state = (await this.store.load()) ?? emptyState();
      const backup = state.journal ?? state.backup;
      if (!backup) throw new Error("Нет сохранённого снимка.");
      const restoreTarget =
        state.journal?.kind === "restore"
          ? state.journal.target
          : backup.before;
      const current = await this.preferences.capture();
      await this.preferences.prepare(restoreTarget);
      // Restore is explicit and local. Caller pauses automatic sync first.
      const journal = {
        kind: "restore" as const,
        before: current,
        target: restoreTarget,
        createdAt: new Date().toISOString(),
      };
      await this.store.save({ ...state, journal });
      await this.preferences.apply(restoreTarget, current);
      await this.store.save({ ...state, journal: null });
      this.setStatus({
        phase: "ready",
        message: "Снимок восстановлен. Автосинхронизация приостановлена.",
        planId: null,
        conflicts: [],
      });
      return this.getStatus();
    });
  }
}
