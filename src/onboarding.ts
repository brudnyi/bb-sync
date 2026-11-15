import { type ChildProcess, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { targetSchema } from "./github";

const execute = promisify(execFile);
export class GitHubAuthorizationError extends Error {}
function ghEnvironment() {
  const env = { ...process.env };
  // Guided login uses the CLI's account store, not automation-only env tokens.
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
  ])
    delete env[key];
  return env;
}
export const accountSchema = z.object({
  login: z.string(),
  name: z.string().nullable(),
});
export const repositorySchema = z.object({
  fullName: z.string(),
  branch: z.string(),
  empty: z.boolean(),
});
export type Repository = z.infer<typeof repositorySchema>;
const apiRepoSchema = z.object({
  full_name: z.string(),
  default_branch: z.string(),
  private: z.boolean(),
  archived: z.boolean().optional(),
  permissions: z.object({ push: z.boolean() }).optional(),
});
export const authSchema = z.object({
  phase: z.enum([
    "idle",
    "starting",
    "waiting",
    "connected",
    "missing",
    "error",
  ]),
  code: z.string().nullable(),
  url: z.string().nullable(),
  message: z.string().nullable(),
});
export type AuthState = z.infer<typeof authSchema>;
export class GitHubAccount {
  constructor(
    private token: string,
    private signal: AbortSignal,
    private request: typeof fetch = fetch,
  ) {}
  private async call(path: string, init: RequestInit = {}) {
    const response = await this.request(`https://api.github.com${path}`, {
      ...init,
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(15000)]),
    });
    if (response.status === 401)
      throw new GitHubAuthorizationError(
        "Вход в GitHub истёк. Подключи аккаунт заново.",
      );
    if (response.status === 403 || response.status === 429)
      throw new Error(
        "GitHub ограничил запрос или доступ. Проверь права аккаунта и попробуй позже.",
      );
    return response;
  }
  async user() {
    const response = await this.call("/user");
    if (!response.ok)
      throw new Error(
        `Не удалось получить аккаунт GitHub (${response.status}).`,
      );
    return accountSchema.parse(await response.json());
  }
  async repositories(page: number) {
    const response = await this.call(
      `/user/repos?visibility=private&affiliation=owner,collaborator,organization_member&sort=pushed&per_page=50&page=${page}`,
    );
    if (!response.ok)
      throw new Error(`Не удалось загрузить хранилища (${response.status}).`);
    const rows = z
      .array(apiRepoSchema)
      .max(50)
      .parse(await response.json());
    return {
      repositories: rows
        .filter(
          (r) => r.private && !r.archived && r.permissions?.push !== false,
        )
        .map((r) => ({
          fullName: r.full_name,
          branch: r.default_branch,
          empty: false,
        })),
      more: rows.length === 50,
    };
  }
  async repository(fullName: string): Promise<Repository> {
    targetSchema.pick({ repository: true }).parse({ repository: fullName });
    const response = await this.call(`/repos/${fullName}`);
    if (!response.ok)
      throw new Error(
        `Хранилище недоступно (${response.status}). Проверь название и доступ аккаунта.`,
      );
    const repo = apiRepoSchema.parse(await response.json());
    if (!repo.private)
      throw new Error("Для личных настроек выбери приватный репозиторий.");
    if (repo.archived || repo.permissions?.push === false)
      throw new Error("В это хранилище нельзя записывать настройки.");
    const branch = await this.call(
      `/repos/${repo.full_name}/branches/${encodeURIComponent(repo.default_branch)}`,
    );
    if (branch.status === 404)
      return {
        fullName: repo.full_name,
        branch: repo.default_branch,
        empty: true,
      };
    if (!branch.ok)
      throw new Error(`Не удалось проверить ветку (${branch.status}).`);
    return {
      fullName: repo.full_name,
      branch: repo.default_branch,
      empty: false,
    };
  }
  async create(name: string): Promise<Repository> {
    z.string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/)
      .parse(name);
    const user = await this.user();
    const existing = await this.call(`/repos/${user.login}/${name}`);
    if (existing.ok) return this.repository(`${user.login}/${name}`);
    if (existing.status !== 404)
      throw new Error(
        `Не удалось проверить название хранилища (${existing.status}).`,
      );
    const response = await this.call("/user/repos", {
      method: "POST",
      body: JSON.stringify({
        name,
        private: true,
        auto_init: true,
        description: "Private BB preferences synchronized by bb-sync",
      }),
    });
    // A double click or another laptop can create the same repository first.
    if (response.status === 422)
      return this.repository(`${user.login}/${name}`);
    if (!response.ok)
      throw new Error(
        `Не удалось создать хранилище (${response.status}). Аккаунту нужно право создавать приватные репозитории.`,
      );
    const repo = apiRepoSchema.parse(await response.json());
    if (!repo.private)
      throw new Error(
        "GitHub не создал приватное хранилище. Подключение остановлено.",
      );
    return {
      fullName: repo.full_name,
      branch: repo.default_branch,
      empty: false,
    };
  }
  async initialize(repo: Repository): Promise<void> {
    if (!repo.empty) return;
    const refs = await this.call(`/repos/${repo.fullName}/branches?per_page=1`);
    if (
      !refs.ok ||
      z.array(z.unknown()).parse(await refs.json()).length !== 0
    ) {
      throw new Error(
        "В репозитории уже есть ветки. Выбери его повторно, чтобы проверить текущую ветку.",
      );
    }
    const response = await this.call(
      `/repos/${repo.fullName}/contents/README.md`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: "bb-sync: initialize private preferences",
          content: Buffer.from(
            "# BB preferences\n\nPrivate preferences managed by bb-sync.\n",
          ).toString("base64"),
          branch: repo.branch,
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        `Не удалось подготовить пустое хранилище (${response.status}). Попробуй подключить его повторно.`,
      );
  }
}

export interface GhCommands {
  token(signal: AbortSignal): Promise<string>;
  available(signal: AbortSignal): Promise<boolean>;
  login(signal: AbortSignal, output: (text: string) => void): Promise<void>;
}
export const ghCommands: GhCommands = {
  async available(signal) {
    try {
      await execute("gh", ["--version"], {
        signal,
        timeout: 10000,
        maxBuffer: 16384,
        windowsHide: true,
        env: ghEnvironment(),
      });
      return true;
    } catch {
      signal.throwIfAborted();
      return false;
    }
  },
  async token(signal) {
    try {
      const result = await execute(
        "gh",
        ["auth", "token", "--hostname", "github.com"],
        {
          signal,
          timeout: 10000,
          maxBuffer: 16384,
          windowsHide: true,
          env: ghEnvironment(),
        },
      );
      const token = result.stdout.trim();
      if (!token) throw new Error("Missing credential");
      return token;
    } catch {
      signal.throwIfAborted();
      throw new Error("Войди в GitHub, чтобы продолжить.");
    }
  },
  login(signal, output) {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(
          "gh",
          [
            "auth",
            "login",
            "--hostname",
            "github.com",
            "--git-protocol",
            "https",
            "--web",
          ],
          {
            signal,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
              ...ghEnvironment(),
              GH_PROMPT_DISABLED: "1",
              NO_COLOR: "1",
              CLICOLOR: "0",
            },
          },
        );
      } catch {
        reject(new Error("Не удалось начать вход в GitHub."));
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Время входа истекло. Запроси новый код."));
      }, 10 * 60_000);
      timer.unref();
      child.stdout?.on("data", (data: Buffer) => output(data.toString("utf8")));
      child.stderr?.on("data", (data: Buffer) => output(data.toString("utf8")));
      child.stdin?.on("error", () => {});
      child.stdin?.end("\n");
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Не удалось запустить вход через GitHub CLI."));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error("Вход не завершён. Попробуй ещё раз."));
      });
    });
  },
};

export class GitHubLogin {
  private state: AuthState = {
    phase: "idle",
    code: null,
    url: null,
    message: null,
  };
  private controller: AbortController | null = null;
  private task: Promise<void> | null = null;
  constructor(
    private save: (token: string) => Promise<void>,
    private changed: () => void,
    private lifecycle: AbortSignal,
    private commands: GhCommands = ghCommands,
    private verify: (token: string, signal: AbortSignal) => Promise<unknown> = (
      t,
      s,
    ) => new GitHubAccount(t, s).user(),
  ) {}
  status(): AuthState {
    return { ...this.state };
  }
  private update(state: Partial<AuthState>) {
    this.state = { ...this.state, ...state };
    this.changed();
  }
  async begin(reauthenticate = false): Promise<AuthState> {
    if (this.task) return this.status();
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.lifecycle, this.controller.signal]);
    this.update({ phase: "starting", code: null, url: null, message: null });
    this.task = (async () => {
      try {
        if (!(await this.commands.available(signal))) {
          this.update({
            phase: "missing",
            message:
              "Установи GitHub CLI на компьютере, где работает сервер bb, и нажми «Повторить».",
          });
          return;
        }
        await this.authenticate(signal, reauthenticate);
      } catch {
        if (!signal.aborted)
          this.update({
            phase: "error",
            message: "Не удалось начать вход в GitHub.",
          });
      }
    })().finally(() => {
      this.task = null;
    });
    return this.status();
  }
  private async authenticate(signal: AbortSignal, reauthenticate: boolean) {
    try {
      let token: string | null = null;
      if (!reauthenticate) {
        try {
          token = await this.commands.token(signal);
        } catch {
          signal.throwIfAborted();
        }
      }
      if (token) {
        try {
          await this.verify(token, signal);
        } catch (error) {
          if (error instanceof GitHubAuthorizationError) token = null;
          else throw error;
        }
      }
      if (!token) {
        let tail = "";
        await this.commands.login(signal, (text) => {
          if (signal.aborted) return;
          // CLI output never leaves this process. Only a one-time device code is exposed.
          tail = (tail + text).slice(-8192);
          const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(
            tail,
          )?.[1];
          if (code)
            this.update({
              phase: "waiting",
              code,
              url: "https://github.com/login/device",
              message: null,
            });
        });
        token = await this.commands.token(signal);
        await this.verify(token, signal);
      }
      signal.throwIfAborted();
      await this.save(token);
      this.update({ phase: "connected", code: null, url: null, message: null });
    } catch {
      if (!signal.aborted)
        this.update({
          phase: "error",
          code: null,
          url: null,
          message:
            "Не удалось подключить GitHub. Проверь интернет и повтори вход.",
        });
    }
  }
  async cancel() {
    this.controller?.abort();
    await this.task;
    this.update({ phase: "idle", code: null, url: null, message: null });
    return this.status();
  }
  async dispose() {
    this.controller?.abort();
    await this.task;
  }
}
