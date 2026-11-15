import { describe, expect, it } from "vitest";
import { Engine, emptyState, type State, type StateStore } from "../src/engine";
import { RemoteChanged } from "../src/github";
import type { Snapshot } from "../src/model";
import type { Preferences } from "../src/preferences";

class MemoryState implements StateStore {
  value: State | null = null;
  async load() {
    return structuredClone(this.value);
  }
  async save(state: State) {
    this.value = structuredClone(state);
  }
}
class Local implements Preferences {
  values: Snapshot;
  failApply = false;
  applications = 0;
  constructor(values: Snapshot) {
    this.values = structuredClone(values);
  }
  async capture() {
    return structuredClone(this.values);
  }
  supports(key: string) {
    return !key.startsWith("future/");
  }
  async prepare() {}
  async apply(target: Snapshot, before: Snapshot) {
    this.applications++;
    if (this.failApply) throw new Error("SDK unavailable");
    for (const key of new Set([
      ...Object.keys(before),
      ...Object.keys(target),
    ])) {
      if (!this.supports(key)) continue;
      const current = this.values[key];
      if (
        JSON.stringify(current) !== JSON.stringify(before[key]) &&
        JSON.stringify(current) !== JSON.stringify(target[key])
      )
        throw new Error("Concurrent local edit");
    }
    this.values = Object.fromEntries(
      Object.entries(target).filter(([key]) => this.supports(key)),
    );
  }
}
class Repository {
  values: Snapshot;
  revision = 1;
  exists = true;
  offline = false;
  race: (() => void) | null = null;
  writes = 0;
  constructor(values: Snapshot) {
    this.values = structuredClone(values);
  }
  async read() {
    if (this.offline) throw new Error("Offline");
    return {
      sha: this.exists ? String(this.revision) : null,
      settings: this.exists ? structuredClone(this.values) : {},
    };
  }
  async write(values: Snapshot, sha: string | null) {
    this.race?.();
    this.race = null;
    if (sha !== (this.exists ? String(this.revision) : null))
      throw new RemoteChanged();
    this.writes++;
    this.values = structuredClone(values);
    this.revision++;
    this.exists = true;
    return String(this.revision);
  }
}
async function established(
  values: Snapshot,
  repository = new Repository(values),
) {
  const local = new Local(values),
    state = new MemoryState();
  const engine = new Engine(local, repository, state);
  expect((await engine.sync()).phase).toBe("synced");
  return { local, state, engine, repository };
}

describe("two-way sync", () => {
  it("previews a first transfer without changing local or remote settings", async () => {
    const repo = new Repository({ theme: "dark" });
    const local = new Local({ theme: "light" }),
      state = new MemoryState();
    const engine = new Engine(local, repo, state);
    const preview = await engine.preview();
    expect(preview).toMatchObject({
      firstConnection: true,
      remoteExists: true,
      localCount: 1,
    });
    expect(preview.changes).toMatchObject([
      { key: "theme", local: "light", remote: "dark", conflicting: true },
    ]);
    expect(repo.writes).toBe(0);
    expect(local.applications).toBe(0);
    expect(state.value).toBeNull();
    expect(
      (
        await engine.sync({
          planId: preview.planId,
          choices: { theme: "remote" },
        })
      ).phase,
    ).toBe("synced");
    expect(local.values.theme).toBe("dark");
  });
  it("rejects a first-transfer preview when a local setting changes before confirmation", async () => {
    const repo = new Repository({ theme: "dark" }),
      local = new Local({ theme: "light" });
    const engine = new Engine(local, repo, new MemoryState());
    const preview = await engine.preview();
    local.values.theme = "blue";
    expect(
      (
        await engine.sync({
          planId: preview.planId,
          choices: { theme: "remote" },
        })
      ).phase,
    ).toBe("error");
    expect(local.values.theme).toBe("blue");
    expect(repo.writes).toBe(0);
  });
  it("publishes the first computer into a missing file without applying local changes", async () => {
    const local = new Local({ theme: "dark", hint: true });
    const repo = new Repository({});
    repo.exists = false;
    const state = new MemoryState();
    expect((await new Engine(local, repo, state).sync()).phase).toBe("synced");
    expect(repo.values).toEqual(local.values);
    expect(local.applications).toBe(0);
    expect(state.value?.base).toEqual(local.values);
  });
  it("does not overwrite a second computer before the first-connect choice", async () => {
    const repo = new Repository({ theme: "dark" });
    const local = new Local({ theme: "light" });
    const engine = new Engine(local, repo, new MemoryState());
    const status = await engine.sync();
    expect(status.phase).toBe("conflict");
    expect(local.values).toEqual({ theme: "light" });
    expect(repo.writes).toBe(0);
    expect(
      (
        await engine.sync({
          planId: status.planId!,
          choices: { theme: "remote" },
        })
      ).phase,
    ).toBe("synced");
    expect(local.values).toEqual({ theme: "dark" });
  });
  it("publishes newly selected required fields absent from an existing preset", async () => {
    const repo = new Repository({ theme: "dark" });
    const local = new Local({ theme: "dark", hints: true });
    const engine = new Engine(local, repo, new MemoryState());
    expect((await engine.sync()).phase).toBe("synced");
    expect(repo.values).toEqual({ theme: "dark", hints: true });
    expect(repo.writes).toBe(1);
  });
  it("merges independent offline edits from two laptops", async () => {
    const repo = new Repository({ theme: "light", hints: true });
    const a = await established(repo.values, repo),
      b = await established(repo.values, repo);
    a.local.values.theme = "dark";
    b.local.values.hints = false;
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    expect(a.local.values).toEqual({ theme: "dark", hints: false });
    expect(b.local.values).toEqual(a.local.values);
    expect(repo.values).toEqual(a.local.values);
    expect(repo.writes).toBe(2);
  });
  it("syncs shortcut reset as deletion, distinct from a disabled shortcut", async () => {
    const x = await established({
      "keyboard/one/all": null,
      "keyboard/two/mac": { key: "K" },
    });
    delete x.repository.values["keyboard/two/mac"];
    await x.engine.sync();
    expect(x.local.values).toEqual({ "keyboard/one/all": null });
  });
  it("does not choose a timestamp winner for a same-field conflict", async () => {
    const x = await established({ theme: "light" });
    x.local.values.theme = "dark";
    x.repository.values.theme = "blue";
    const result = await x.engine.sync();
    expect(result.conflicts[0]).toMatchObject({
      base: "light",
      local: "dark",
      remote: "blue",
    });
    expect(x.repository.writes).toBe(0);
    expect(x.local.values.theme).toBe("dark");
  });
  it("rejects a stale conflict choice after a third computer changes GitHub", async () => {
    const x = await established({ theme: "light" });
    x.local.values.theme = "dark";
    x.repository.values.theme = "blue";
    const plan = await x.engine.sync();
    x.repository.values.theme = "green";
    x.repository.revision++;
    expect(
      (
        await x.engine.sync({
          planId: plan.planId!,
          choices: { theme: "local" },
        })
      ).phase,
    ).toBe("error");
    expect(x.repository.values.theme).toBe("green");
    expect(x.repository.writes).toBe(0);
  });
  it("refetches and merges a concurrent GitHub write", async () => {
    const x = await established({ theme: "light", hints: true });
    x.local.values.theme = "dark";
    x.repository.race = () => {
      x.repository.values.hints = false;
      x.repository.revision++;
    };
    expect((await x.engine.sync()).phase).toBe("synced");
    expect(x.repository.values).toEqual({ theme: "dark", hints: false });
    expect(x.local.values).toEqual(x.repository.values);
  });
  it("preserves unknown fields from a newer plugin without applying them", async () => {
    const x = await established({ theme: "light" });
    x.repository.values["future/setting"] = { nested: [1, 2] };
    x.local.values.theme = "dark";
    const status = await x.engine.sync();
    expect(status.unsupported).toEqual(["future/setting"]);
    expect(x.repository.values["future/setting"]).toEqual({ nested: [1, 2] });
    expect(x.local.values).toEqual({ theme: "dark" });
  });
  it("keeps offline edits and the baseline until the network returns", async () => {
    const x = await established({ theme: "light" });
    x.local.values.theme = "dark";
    x.repository.offline = true;
    expect((await x.engine.sync()).phase).toBe("error");
    expect(x.local.values.theme).toBe("dark");
    expect(x.state.value?.base).toEqual({ theme: "light" });
    x.repository.offline = false;
    expect((await x.engine.sync()).phase).toBe("synced");
    expect(x.repository.values.theme).toBe("dark");
  });
  it("refuses an unexpected remote-file deletion", async () => {
    const x = await established({ theme: "light" });
    x.repository.exists = false;
    expect((await x.engine.sync()).phase).toBe("error");
    expect(x.local.values).toEqual({ theme: "light" });
    expect(x.repository.writes).toBe(0);
  });
  it("recovers a failed apply across restart without republishing stale local settings", async () => {
    const x = await established({ theme: "light" });
    x.repository.values.theme = "dark";
    x.local.failApply = true;
    expect((await x.engine.sync()).phase).toBe("recovery");
    expect(x.engine.getStatus().backupAt).not.toBeNull();
    expect(x.state.value?.journal?.before).toEqual({ theme: "light" });
    x.local.failApply = false;
    const restarted = new Engine(x.local, x.repository, x.state);
    await restarted.initialize();
    expect(restarted.getStatus().phase).toBe("recovery");
    expect((await restarted.sync()).phase).toBe("synced");
    expect(x.local.values.theme).toBe("dark");
    expect(x.repository.writes).toBe(0);
  });
  it("never clobbers a third local edit during interrupted-apply recovery", async () => {
    const x = await established({ theme: "light" });
    x.repository.values.theme = "dark";
    x.local.failApply = true;
    await x.engine.sync();
    x.local.failApply = false;
    x.local.values.theme = "green";
    expect((await x.engine.sync()).phase).toBe("recovery");
    expect(x.local.values.theme).toBe("green");
    expect(x.repository.values.theme).toBe("dark");
  });
  it("restores the last local snapshot without touching GitHub", async () => {
    const x = await established({ theme: "light" });
    x.repository.values.theme = "dark";
    await x.engine.sync();
    await x.engine.restore();
    expect(x.local.values.theme).toBe("light");
    expect(x.repository.values.theme).toBe("dark");
    expect(x.repository.writes).toBe(0);
  });
  it("serializes simultaneous sync requests", async () => {
    const x = await established({ theme: "light" });
    x.local.values.theme = "dark";
    const results = await Promise.all([
      x.engine.sync(),
      x.engine.sync(),
      x.engine.sync(),
    ]);
    expect(results.every((r) => r.phase === "synced")).toBe(true);
    expect(x.repository.writes).toBe(1);
  });
  it("continues an interrupted restore when Restore is requested again", async () => {
    const x = await established({ theme: "light" });
    x.repository.values.theme = "dark";
    await x.engine.sync();
    x.local.failApply = true;
    await expect(x.engine.restore()).rejects.toThrow("SDK unavailable");
    expect(x.state.value?.journal?.kind).toBe("restore");
    x.local.failApply = false;
    await x.engine.restore();
    expect(x.local.values.theme).toBe("light");
    expect(x.repository.values.theme).toBe("dark");
  });
  it("retains a durable recovery record if persisting the final baseline fails", async () => {
    const x = await established({ theme: "light" });
    x.repository.values.theme = "dark";
    const save = x.state.save.bind(x.state);
    x.state.save = async (state) => {
      if (state.journal === null) throw new Error("Disk full");
      await save(state);
    };
    expect((await x.engine.sync()).phase).toBe("recovery");
    expect(x.local.values.theme).toBe("dark");
    expect(x.state.value?.journal).not.toBeNull();
    x.state.save = save;
    expect((await x.engine.sync()).phase).toBe("synced");
  });
  it("recovers interrupted restore without redefining the common baseline", async () => {
    const x = await established({ theme: "light" });
    x.state.value = {
      ...emptyState(),
      base: { theme: "dark" },
      journal: {
        kind: "restore",
        before: { theme: "dark" },
        target: { theme: "light" },
        createdAt: new Date().toISOString(),
      },
    };
    x.local.values.theme = "dark";
    x.repository.values.theme = "dark";
    const restarted = new Engine(x.local, x.repository, x.state);
    const result = await restarted.sync();
    expect(result.phase).toBe("ready");
    expect(x.local.values.theme).toBe("light");
    expect(x.repository.values.theme).toBe("dark");
    expect(x.state.value?.base).toEqual({ theme: "dark" });
  });
});
