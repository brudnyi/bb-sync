import { describe, expect, it, vi } from "vitest";
import { GitHub, RemoteChanged, targetSchema } from "../src/github";
import { decodeDocument, encodeDocument } from "../src/model";

const target = {
  repository: "owner/preferences",
  branch: "main",
  path: "bb-sync.json",
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const file = (settings: Record<string, string>) => ({
  type: "file",
  sha: "a".repeat(40),
  encoding: "base64",
  size: 100,
  content: Buffer.from(encodeDocument(settings)).toString("base64"),
});
describe("GitHub transport", () => {
  it("reads only a private repository and a verified branch", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ private: true }))
      .mockResolvedValueOnce(response({ name: "main" }))
      .mockResolvedValueOnce(response(file({ theme: "dark" })));
    const github = new GitHub(
      target,
      "secret",
      new AbortController().signal,
      request,
    );
    expect(await github.read()).toEqual({
      sha: "a".repeat(40),
      settings: { theme: "dark" },
    });
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: "Bearer secret" },
    });
  });
  it("refuses public repositories before reading any settings", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ private: false }));
    await expect(
      new GitHub(
        target,
        "secret",
        new AbortController().signal,
        request,
      ).read(),
    ).rejects.toThrow("private");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not treat a repository/branch 404 as a missing settings file", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({}, 404));
    await expect(
      new GitHub(
        target,
        "secret",
        new AbortController().signal,
        request,
      ).read(),
    ).rejects.toThrow("Cannot access");
    request
      .mockReset()
      .mockResolvedValueOnce(response({ private: true }))
      .mockResolvedValueOnce(response({}, 404));
    await expect(
      new GitHub(
        target,
        "secret",
        new AbortController().signal,
        request,
      ).read(),
    ).rejects.toThrow("Branch");
  });
  it("initializes only when the contents endpoint returns 404", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ private: true }))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({}, 404));
    expect(
      await new GitHub(
        target,
        "secret",
        new AbortController().signal,
        request,
      ).read(),
    ).toEqual({ sha: null, settings: {} });
  });
  it("writes with the exact previously read SHA and handles a write race", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({}, 409));
    await expect(
      new GitHub(target, "secret", new AbortController().signal, request).write(
        { theme: "dark" },
        "old-sha",
      ),
    ).rejects.toBeInstanceOf(RemoteChanged);
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toMatchObject(
      { sha: "old-sha", branch: "main" },
    );
  });
  it("keeps authentication response bodies out of error messages", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ message: "secret" }, 401));
    await expect(
      new GitHub(
        target,
        "secret",
        new AbortController().signal,
        request,
      ).read(),
    ).rejects.toThrow("invalid or expired");
  });
  it("honors lifecycle cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const request: typeof fetch = async (_url, init) => {
      init?.signal?.throwIfAborted();
      throw new Error("should not run");
    };
    await expect(
      new GitHub(target, "secret", controller.signal, request).read(),
    ).rejects.toThrow();
  });
});
describe("file boundary", () => {
  it("preserves unknown settings without validating all of BB's evolving config", () => {
    const values = { "future/field": { a: [true, "x", null] } };
    expect(decodeDocument(encodeDocument(values)).settings).toEqual(values);
  });
  it("rejects unsupported formats, invalid JSON, and oversized files", () => {
    expect(() =>
      decodeDocument('{"format":"bb-sync","version":2,"settings":{}}'),
    ).toThrow();
    expect(() => decodeDocument("{")).toThrow();
    expect(() => encodeDocument({ huge: "x".repeat(100_000) })).toThrow(
      "96 KiB",
    );
  });
  it("rejects traversal and invalid repository names", () => {
    expect(
      targetSchema.safeParse({ ...target, path: "../settings.json" }).success,
    ).toBe(false);
    expect(
      targetSchema.safeParse({
        ...target,
        repository: "https://github.com/a/b",
      }).success,
    ).toBe(false);
  });
});
