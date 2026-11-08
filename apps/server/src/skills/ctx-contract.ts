import * as R from "remeda";
import { z } from "zod";

/**
 * The `ctx` surface's contract: each method's arguments and result, and the
 * kinds a refusal carries (design/skills.md → Contracts). The handler
 * validates arguments and types its results against it, and
 * `ctx-contract-codegen.ts` generates `cogmo_ctx`'s Python types and the
 * worker protocol's JSON Schemas from it. Arguments are strict objects: a
 * key the method does not name is refused, as the generated schema says.
 */

/** Longest `http.request` timeout a skill may ask for; its own wall clock bounds it further. */
const MAX_HTTP_TIMEOUT_MS = 120_000;

/** The `kind` a refused ctx call raises in the skill as `CtxError.kind`. */
export const CtxErrorKindSchema = z
  .enum([
    "unknown_method",
    "invalid_args",
    "not_in_allowlist",
    "secret_not_found",
    "missing_effect",
    "read_failed",
    "write_failed",
    "list_failed",
    "blocked_destination",
    "timeout",
    "network_error",
    "response_too_large",
    // The dispatcher's answer when the handler throws.
    "internal",
  ])
  .meta({ title: "CtxErrorKind" });
export type CtxErrorKind = z.infer<typeof CtxErrorKindSchema>;

const NoArgsSchema = z.strictObject({});

const MemorySchema = z.object({ content: z.string(), type: z.string() }).meta({ title: "Memory" });

const FileEntrySchema = z
  .object({ path: z.string(), size: z.number().int().nonnegative(), last_modified: z.string() })
  .meta({ title: "FileEntry" });

const CtxUserSchema = z.object({ id: z.string(), timezone: z.string() }).meta({ title: "User" });
export type CtxUser = z.infer<typeof CtxUserSchema>;

export const CTX_CONTRACT = {
  "secrets.get": {
    args: z.strictObject({ name: z.string().min(1) }),
    result: z.string(),
  },
  "memory.recall": {
    args: z.strictObject({
      query: z.string().min(1),
      limit: z.number().int().positive().max(50).optional(),
    }),
    result: z.object({ memories: z.array(MemorySchema) }).meta({ title: "MemoryRecall" }),
  },
  "memory.remember": {
    args: z.strictObject({
      content: z.string().min(1),
      tags: z.array(z.string().min(1)).optional(),
    }),
    result: z.null(),
  },
  "files.read": {
    args: z.strictObject({ path: z.string().min(1) }),
    result: z.string(),
  },
  "files.write": {
    args: z.strictObject({ path: z.string().min(1), content: z.string() }),
    result: z.null(),
  },
  "files.list": {
    args: z.strictObject({ prefix: z.string().optional() }),
    result: z.object({ entries: z.array(FileEntrySchema) }).meta({ title: "FileList" }),
  },
  now: { args: NoArgsSchema, result: z.string() },
  user: { args: NoArgsSchema, result: CtxUserSchema },
  "log.info": {
    args: z.strictObject({
      message: z.string(),
      fields: z.record(z.string(), z.unknown()).optional(),
    }),
    result: z.null(),
  },
  "http.request": {
    args: z.strictObject({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
      timeoutMs: z.number().int().positive().max(MAX_HTTP_TIMEOUT_MS).optional(),
    }),
    result: z
      .object({
        status: z.number().int().nonnegative(),
        headers: z.record(z.string(), z.string()),
        body: z.string(),
      })
      .meta({ title: "HttpResponse" }),
  },
} as const satisfies Record<string, { args: z.ZodObject; result: z.ZodType }>;

export type CtxMethod = keyof typeof CTX_CONTRACT;

/** What `method` answers a skill with. */
export type CtxResultOf<M extends CtxMethod> = z.infer<(typeof CTX_CONTRACT)[M]["result"]>;

/** Whether a worker named a method of the contract. */
export function isCtxMethod(method: string): method is CtxMethod {
  return R.keys(CTX_CONTRACT).some((known) => known === method);
}
