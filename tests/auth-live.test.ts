import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ghCommands } from "../src/onboarding";

it.skipIf(process.env.BB_SYNC_LIVE_GH !== "1")(
  "obtains a real GitHub device code and cancels without signing in",
  async () => {
    const config = await mkdtemp(join(tmpdir(), "bb-sync-login-check-"));
    const names = [
      "GH_CONFIG_DIR",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ];
    const previous = new Map(names.map((key) => [key, process.env[key]]));
    for (const key of names) delete process.env[key];
    process.env.GH_CONFIG_DIR = config;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let tail = "",
      received = false;
    try {
      await ghCommands
        .login(controller.signal, (text) => {
          tail = (tail + text).slice(-8192);
          if (/one-time code:\s*[A-Z0-9]{4}-[A-Z0-9]{4}/i.test(tail)) {
            received = true;
            controller.abort();
          }
        })
        .catch(() => {});
      expect(received).toBe(true);
    } finally {
      clearTimeout(timer);
      controller.abort();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(config, { recursive: true, force: true });
    }
  },
  25000,
);
