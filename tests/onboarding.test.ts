import { describe, expect, it, vi } from "vitest";
import {
  type GhCommands,
  GitHubAccount,
  GitHubAuthorizationError,
  GitHubLogin,
} from "../src/onboarding";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const repo = (extra: Record<string, unknown> = {}) => ({
  full_name: "owner/bb-sync-settings",
  default_branch: "main",
  private: true,
  permissions: { push: true },
  ...extra,
});
describe("GitHub setup", () => {
  it("lists writable private repositories and keeps pagination explicit", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response([
          repo(),
          repo({ full_name: "owner/public", private: false }),
          repo({ full_name: "owner/readonly", permissions: { push: false } }),
          repo({ full_name: "owner/archived", archived: true }),
        ]),
      );
    const client = new GitHubAccount(
      "secret",
      new AbortController().signal,
      request,
    );
    expect(await client.repositories(2)).toEqual({
      repositories: [
        { fullName: "owner/bb-sync-settings", branch: "main", empty: false },
      ],
      more: false,
    });
    expect(request.mock.calls[0]![0]).toContain("page=2");
  });
  it("creates an initialized private repository for the authenticated account", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ login: "owner", name: null }))
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response(repo(), 201));
    const client = new GitHubAccount(
      "secret",
      new AbortController().signal,
      request,
    );
    expect(await client.create("bb-sync-settings")).toEqual({
      fullName: "owner/bb-sync-settings",
      branch: "main",
      empty: false,
    });
    const create = request.mock.calls[2]!;
    expect(create[0]).toBe("https://api.github.com/user/repos");
    expect(JSON.parse(create[1]!.body as string)).toMatchObject({
      private: true,
      auto_init: true,
    });
  });
  it("reuses the recommended private repository without recreating it", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ login: "owner", name: "Owner" }))
      .mockResolvedValueOnce(response(repo()))
      .mockResolvedValueOnce(response(repo()))
      .mockResolvedValueOnce(response({ name: "main" }));
    const client = new GitHubAccount(
      "secret",
      new AbortController().signal,
      request,
    );
    expect((await client.create("bb-sync-settings")).empty).toBe(false);
    expect(request.mock.calls.every((call) => !call[1]?.method)).toBe(true);
  });
  it("refuses to adopt an existing public repository", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(repo({ private: false })));
    await expect(
      new GitHubAccount(
        "secret",
        new AbortController().signal,
        request,
      ).repository("owner/settings"),
    ).rejects.toThrow("приватный");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("initializes a verified empty repository without overwriting any branch", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({}, 201));
    await new GitHubAccount(
      "secret",
      new AbortController().signal,
      request,
    ).initialize({
      fullName: "owner/bb-sync-settings",
      branch: "main",
      empty: true,
    });
    expect(request.mock.calls[1]![1]?.method).toBe("PUT");
    const raced = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([{ name: "other" }]));
    await expect(
      new GitHubAccount(
        "secret",
        new AbortController().signal,
        raced,
      ).initialize({
        fullName: "owner/bb-sync-settings",
        branch: "main",
        empty: true,
      }),
    ).rejects.toThrow("уже есть ветки");
    expect(raced).toHaveBeenCalledTimes(1);
  });
  it("rejects hostile repository input before making a request", async () => {
    const request = vi.fn<typeof fetch>();
    const client = new GitHubAccount(
      "secret",
      new AbortController().signal,
      request,
    );
    await expect(client.create("../../other")).rejects.toThrow();
    await expect(
      client.repository("https://example.com/secret"),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("never includes a GitHub error response body in a credential failure", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ message: "secret credential" }, 401));
    await expect(
      new GitHubAccount("secret", new AbortController().signal, request).user(),
    ).rejects.toThrow("Вход в GitHub истёк");
  });
});

const commands = (): GhCommands => ({
  available: vi.fn(async () => true),
  token: vi.fn(async () => "private-token"),
  login: vi.fn(async () => {}),
});
describe("guided GitHub sign-in", () => {
  it("can explicitly request browser sign-in even when the CLI already has an account", async () => {
    const cli = commands();
    const login = new GitHubLogin(
      async () => {},
      () => {},
      new AbortController().signal,
      cli,
      async () => ({}),
    );
    await login.begin(true);
    await vi.waitFor(() => expect(login.status().phase).toBe("connected"));
    expect(cli.login).toHaveBeenCalledTimes(1);
    await login.dispose();
  });
  it("offers browser reauthentication when a stored CLI credential has expired", async () => {
    const cli = commands();
    cli.token = vi
      .fn()
      .mockResolvedValueOnce("expired")
      .mockResolvedValueOnce("new-private-token");
    const verify = vi
      .fn()
      .mockRejectedValueOnce(new GitHubAuthorizationError("expired"))
      .mockResolvedValueOnce({});
    const save = vi.fn(async (_token: string) => {});
    const login = new GitHubLogin(
      save,
      () => {},
      new AbortController().signal,
      cli,
      verify,
    );
    await login.begin();
    await vi.waitFor(() => expect(login.status().phase).toBe("connected"));
    expect(cli.login).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("new-private-token");
    await login.dispose();
  });
  it("reuses the existing account without exposing credentials to the frontend", async () => {
    const cli = commands(),
      save = vi.fn(async (_token: string) => {}),
      verify = vi.fn(async () => ({}));
    const login = new GitHubLogin(
      save,
      () => {},
      new AbortController().signal,
      cli,
      verify,
    );
    await login.begin();
    await vi.waitFor(() => expect(login.status().phase).toBe("connected"));
    expect(save).toHaveBeenCalledWith("private-token");
    expect(JSON.stringify(login.status())).not.toContain("private-token");
    expect(cli.login).not.toHaveBeenCalled();
    await login.dispose();
  });
  it.each([
    [
      "! First copy your one-",
      "time code: ABCD-1234\nprivate-token-not-for-ui",
    ],
    [
      "! One-time code (ABCD-",
      "1234) copied to clipboard\nprivate-token-not-for-ui",
    ],
  ])(
    "exposes the device code from gh output, then completes after confirmation",
    async (first, second) => {
      const cli = commands();
      cli.token = vi
        .fn()
        .mockRejectedValueOnce(new Error("not logged in"))
        .mockResolvedValueOnce("private-token");
      let finish: (() => void) | undefined;
      cli.login = vi.fn(async (_signal, output) => {
        output(first);
        output(second);
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
      const save = vi.fn(async (_token: string) => {});
      const login = new GitHubLogin(
        save,
        () => {},
        new AbortController().signal,
        cli,
        async () => ({}),
      );
      await login.begin();
      await vi.waitFor(() => expect(login.status().phase).toBe("waiting"));
      expect(login.status()).toMatchObject({
        code: "ABCD-1234",
        url: "https://github.com/login/device",
      });
      expect(JSON.stringify(login.status())).not.toContain("private-token");
      finish!();
      await vi.waitFor(() => expect(login.status().phase).toBe("connected"));
      expect(login.status().code).toBeNull();
      await login.dispose();
    },
  );
  it("cancels a pending device login without saving a credential", async () => {
    const cli = commands();
    cli.token = vi.fn(async () => {
      throw new Error("not logged in");
    });
    cli.login = vi.fn(async (signal, output) => {
      output("! First copy your one-time code: ABCD-1234");
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    const save = vi.fn(async (_token: string) => {});
    const login = new GitHubLogin(
      save,
      () => {},
      new AbortController().signal,
      cli,
      async () => ({}),
    );
    await login.begin();
    await vi.waitFor(() => expect(login.status().phase).toBe("waiting"));
    await login.cancel();
    expect(login.status()).toMatchObject({ phase: "idle", code: null });
    expect(save).not.toHaveBeenCalled();
  });
  it("starts only one authentication task when multiple windows click Connect", async () => {
    const cli = commands(),
      save = vi.fn(async (_token: string) => {});
    const login = new GitHubLogin(
      save,
      () => {},
      new AbortController().signal,
      cli,
      async () => ({}),
    );
    await Promise.all([login.begin(), login.begin(), login.begin()]);
    await vi.waitFor(() => expect(login.status().phase).toBe("connected"));
    expect(cli.token).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    await login.dispose();
  });
  it("provides an actionable missing-CLI state without attempting another login method", async () => {
    const cli = commands();
    cli.available = vi.fn(async () => false);
    const login = new GitHubLogin(
      async () => {},
      () => {},
      new AbortController().signal,
      cli,
    );
    await login.begin();
    await vi.waitFor(() => expect(login.status().phase).toBe("missing"));
    expect(cli.token).not.toHaveBeenCalled();
    expect(cli.login).not.toHaveBeenCalled();
    await login.dispose();
  });
});
