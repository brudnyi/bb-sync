import { createHash } from "node:crypto";
import { z } from "zod";

export const MAX_BYTES = 96 * 1024;
export const valueSchema = z.json();
export type Value = z.infer<typeof valueSchema>;
export type Snapshot = Record<string, Value>;
const dangerous = new Set(["__proto__", "constructor", "prototype"]);
export const snapshotSchema = z
  .record(z.string().min(1).max(512), valueSchema)
  .refine(
    (v) =>
      Object.keys(v).length <= 1500 &&
      Object.keys(v).every((k) => !dangerous.has(k)),
    "Invalid settings keys",
  );
export const documentSchema = z
  .object({
    format: z.literal("bb-sync"),
    version: z.literal(1),
    settings: snapshotSchema,
  })
  .strict();
export type SyncDocument = z.infer<typeof documentSchema>;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
export const equal = (a: unknown, b: unknown): boolean =>
  canonical(a) === canonical(b);
export const fingerprint = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function encodeDocument(settings: Snapshot): string {
  const doc = documentSchema.parse({ format: "bb-sync", version: 1, settings });
  const text = `${JSON.stringify(JSON.parse(canonical(doc)), null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_BYTES)
    throw new Error("Settings file exceeds 96 KiB.");
  return text;
}
export function decodeDocument(text: string): SyncDocument {
  if (Buffer.byteLength(text) > MAX_BYTES)
    throw new Error("Settings file exceeds 96 KiB.");
  return documentSchema.parse(JSON.parse(text));
}
export const conflictSchema = z.object({
  key: z.string(),
  base: valueSchema.nullable(),
  local: valueSchema.nullable(),
  remote: valueSchema.nullable(),
  basePresent: z.boolean(),
  localPresent: z.boolean(),
  remotePresent: z.boolean(),
});
export type Conflict = z.infer<typeof conflictSchema>;
export type Choices = Record<string, "local" | "remote">;
export function merge(
  base: Snapshot | null,
  local: Snapshot,
  remote: Snapshot,
  choices: Choices = {},
) {
  const result: Snapshot = Object.create(null);
  const conflicts: Conflict[] = [];
  const keys = [
    ...new Set([
      ...Object.keys(base ?? {}),
      ...Object.keys(local),
      ...Object.keys(remote),
    ]),
  ].sort();
  for (const key of keys) {
    const b = base?.[key],
      l = local[key],
      r = remote[key];
    let value: Value | undefined;
    if (equal(l, r)) value = l;
    else if (base !== null && equal(l, b)) value = r;
    else if (base !== null && equal(r, b)) value = l;
    else if (choices[key]) value = choices[key] === "local" ? l : r;
    else {
      conflicts.push({
        key,
        base: b ?? null,
        local: l ?? null,
        remote: r ?? null,
        basePresent: b !== undefined,
        localPresent: l !== undefined,
        remotePresent: r !== undefined,
      });
      continue;
    }
    if (value !== undefined) result[key] = value;
  }
  return { settings: result, conflicts };
}
