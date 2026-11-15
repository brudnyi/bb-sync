import { z } from "zod";
import {
  decodeDocument,
  encodeDocument,
  MAX_BYTES,
  type Snapshot,
} from "./model";

export const targetSchema = z.object({
  repository: z
    .string()
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/,
      "Use owner/repository",
    ),
  branch: z
    .string()
    .min(1)
    .max(200)
    .refine(
      (s) =>
        !/[\s~^:?*[\\]/.test(s) &&
        !s.includes("..") &&
        !s.startsWith("-") &&
        !s.endsWith("."),
      "Invalid branch",
    ),
  path: z
    .string()
    .min(1)
    .max(240)
    .refine(
      (s) =>
        s.endsWith(".json") &&
        s.split("/").every((p) => p !== "" && p !== "." && p !== "..") &&
        !s.includes("\\"),
      "Use a relative .json path",
    ),
});
export type Target = z.infer<typeof targetSchema>;
export type Remote = { sha: string | null; settings: Snapshot };
export class RemoteChanged extends Error {
  constructor() {
    super("GitHub changed during sync. Retry to merge the latest version.");
  }
}
export class GitHub {
  private readonly root: string;
  constructor(
    private target: Target,
    private token: string,
    private signal: AbortSignal,
    private request: typeof fetch = fetch,
  ) {
    targetSchema.parse(target);
    if (!token.trim())
      throw new Error("Set the GitHub token in bb-sync settings.");
    this.root = `https://api.github.com/repos/${target.repository}`;
  }
  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.request(this.root + path, {
      ...init,
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(20_000)]),
    });
    if (response.status === 401)
      throw new Error("GitHub token is invalid or expired.");
    if (response.status === 403 || response.status === 429) {
      const reset = response.headers.get("x-ratelimit-reset");
      throw new Error(
        `GitHub denied access or rate-limited requests.${reset ? ` Rate limit resets at ${new Date(Number(reset) * 1000).toISOString()}.` : " Check repository Contents permissions."}`,
      );
    }
    return response;
  }
  private filePath(): string {
    return `/contents/${this.target.path.split("/").map(encodeURIComponent).join("/")}`;
  }
  async read(): Promise<Remote> {
    // A missing/inaccessible repository must never be mistaken for a new settings file.
    const repo = await this.call("");
    if (!repo.ok)
      throw new Error(
        `Cannot access GitHub repository (${repo.status}). Check repository and token access.`,
      );
    const info = z.object({ private: z.boolean() }).parse(await repo.json());
    if (!info.private)
      throw new Error("Use a private repository for personal settings.");
    const branch = await this.call(
      `/branches/${encodeURIComponent(this.target.branch)}`,
    );
    if (!branch.ok)
      throw new Error(
        `Branch is unavailable (${branch.status}). Initialize the private repository with a README first.`,
      );
    const response = await this.call(
      `${this.filePath()}?ref=${encodeURIComponent(this.target.branch)}`,
    );
    if (response.status === 404) return { sha: null, settings: {} };
    if (!response.ok)
      throw new Error(`Cannot read GitHub settings (${response.status}).`);
    const body = z
      .object({
        type: z.literal("file"),
        encoding: z.literal("base64"),
        sha: z.string().regex(/^[a-f0-9]{40,64}$/),
        size: z.number().int().min(0).max(MAX_BYTES),
        content: z.string().max(MAX_BYTES * 2),
      })
      .parse(await response.json());
    return {
      sha: body.sha,
      settings: decodeDocument(
        Buffer.from(body.content, "base64").toString("utf8"),
      ).settings,
    };
  }
  async write(settings: Snapshot, sha: string | null): Promise<string> {
    const response = await this.call(this.filePath(), {
      method: "PUT",
      body: JSON.stringify({
        message: "bb-sync: update preferences",
        branch: this.target.branch,
        content: Buffer.from(encodeDocument(settings)).toString("base64"),
        ...(sha === null ? {} : { sha }),
      }),
    });
    if (response.status === 409 || response.status === 422)
      throw new RemoteChanged();
    if (!response.ok)
      throw new Error(
        `Cannot update GitHub settings (${response.status}). Check Contents read/write permission.`,
      );
    return z
      .object({ content: z.object({ sha: z.string() }) })
      .parse(await response.json()).content.sha;
  }
}
