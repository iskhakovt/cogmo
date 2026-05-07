import { z } from "zod";
import type { Service } from "../agent/service.js";
import { logger } from "../logger.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { CtxError, type CtxHandler } from "./dispatcher.js";
import type { SkillManifest } from "./types.js";

const log = logger.child({ component: "skills.ctx" });

/**
 * Tier-1 `ctx.*` v1 surface. Six methods cover the slice's end-to-end test
 * matrix; `attachments`, `llm.complete`, `notify` deferred to P3.2 (each
 * crosses module boundaries the slice does not otherwise touch — see plan).
 */
export const CTX_METHODS = [
  "secrets.get",
  "memory.recall",
  "memory.remember",
  "files.read",
  "files.write",
  "files.list",
  "now",
  "user",
  "log.info",
] as const;
export type CtxMethod = (typeof CTX_METHODS)[number];

export interface CtxUser {
  id: string;
  timezone: string;
}

export interface DefaultCtxHandlerOptions {
  manifest: SkillManifest;
  /** `skill_runs.id` — every persisted ctx_call is scoped to this row. */
  runId: string;
  user: CtxUser;
  /** Memory bank id — typically the user's bank. */
  memoryBankId: string;
  secretsStore: SecretsStore;
  memory: MemoryProvider;
  /**
   * The agent's per-user file workspace. Same surface the in-process
   * `read_file` / `write_file` / `list_files` tools use — one workspace,
   * two callers. Skills only see paths their own host service exposes.
   */
  files: Service["files"];
  /**
   * Persists the call to `skill_context_calls` (target name only — never
   * value). Injected as a function so the handler doesn't require the full
   * `SkillStore`; the runner binds this to `SkillStore.recordContextCall`.
   */
  recordContextCall: (call: {
    runId: string;
    method: CtxMethod;
    target: string | null;
    ok: boolean;
    error: string | null;
  }) => Promise<void>;
  /** Pluggable clock for deterministic tests. Returns ISO-8601 UTC timestamp. */
  now?: () => string;
}

const SecretsGetArgsSchema = z.object({ name: z.string().min(1) });
const MemoryRecallArgsSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).optional(),
});
const MemoryRememberArgsSchema = z.object({
  content: z.string().min(1),
  tags: z.array(z.string().min(1)).optional(),
});
const FilesReadArgsSchema = z.object({ path: z.string().min(1) });
const FilesWriteArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});
const FilesListArgsSchema = z.object({
  prefix: z.string().optional(),
});
const LogInfoArgsSchema = z.object({
  message: z.string(),
  fields: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Resolves `ctx.*` RPCs from a Tier 1 worker against host services. Every
 * invocation: (1) validates the args against a per-method schema, (2)
 * enforces manifest-declared allowlists, (3) hits the host service, (4)
 * persists to `skill_context_calls` (target name only — never value), (5)
 * returns the value or throws a typed `CtxError` the dispatcher will surface
 * as a typed Python exception.
 */
export class DefaultCtxHandler implements CtxHandler {
  #manifest: SkillManifest;
  #runId: string;
  #user: CtxUser;
  #memoryBankId: string;
  #secretsStore: SecretsStore;
  #memory: MemoryProvider;
  #files: Service["files"];
  #recordContextCall: DefaultCtxHandlerOptions["recordContextCall"];
  #now: () => string;
  #declaredSecrets: ReadonlySet<string>;

  constructor(opts: DefaultCtxHandlerOptions) {
    this.#manifest = opts.manifest;
    this.#runId = opts.runId;
    this.#user = opts.user;
    this.#memoryBankId = opts.memoryBankId;
    this.#secretsStore = opts.secretsStore;
    this.#memory = opts.memory;
    this.#files = opts.files;
    this.#recordContextCall = opts.recordContextCall;
    this.#now = opts.now ?? (() => new Date().toISOString());
    this.#declaredSecrets = new Set(
      opts.manifest.secrets.map((s) => (typeof s === "string" ? s : s.name)),
    );
  }

  async handle(call: { method: string; args: unknown }): Promise<unknown> {
    const method = call.method;
    if (!isCtxMethod(method)) {
      await this.#audit(method, null, false, "unknown_method");
      throw new CtxError("unknown_method", `unknown ctx method: ${method}`);
    }
    const value = await this.#dispatch(method, call.args);
    return value;
  }

  async #dispatch(method: CtxMethod, args: unknown): Promise<unknown> {
    switch (method) {
      case "secrets.get":
        return this.#secretsGet(args);
      case "memory.recall":
        return this.#memoryRecall(args);
      case "memory.remember":
        return this.#memoryRemember(args);
      case "files.read":
        return this.#filesRead(args);
      case "files.write":
        return this.#filesWrite(args);
      case "files.list":
        return this.#filesList(args);
      case "now":
        return this.#nowMethod();
      case "user":
        return this.#userMethod();
      case "log.info":
        return this.#logInfo(args);
    }
  }

  async #secretsGet(args: unknown): Promise<string> {
    const parsed = SecretsGetArgsSchema.safeParse(args);
    if (!parsed.success) {
      await this.#audit("secrets.get", null, false, "invalid_args");
      throw new CtxError("invalid_args", "secrets.get expects { name: string }");
    }
    const name = parsed.data.name;
    if (!this.#declaredSecrets.has(name)) {
      await this.#audit("secrets.get", name, false, "not_in_allowlist");
      throw new CtxError(
        "not_in_allowlist",
        `secret '${name}' is not declared in SKILL.md frontmatter`,
      );
    }
    const value = await this.#secretsStore.getSecret(name);
    if (value === undefined) {
      await this.#audit("secrets.get", name, false, "secret_not_found");
      throw new CtxError("secret_not_found", `secret '${name}' is declared but not configured`);
    }
    await this.#audit("secrets.get", name, true, null);
    return value;
  }

  async #memoryRecall(args: unknown): Promise<{ memories: { content: string; type: string }[] }> {
    const parsed = MemoryRecallArgsSchema.safeParse(args);
    if (!parsed.success) {
      await this.#audit("memory.recall", null, false, "invalid_args");
      throw new CtxError("invalid_args", "memory.recall expects { query: string, limit?: number }");
    }
    if (!this.#manifest.effects.includes("reads_memory")) {
      await this.#audit("memory.recall", null, false, "missing_effect");
      throw new CtxError(
        "missing_effect",
        "memory.recall requires effects: [reads_memory] in SKILL.md",
      );
    }
    const result = await this.#memory.recall(this.#memoryBankId, parsed.data.query, {});
    // Hindsight's RecallOptions takes `maxTokens`, not a per-item count.
    // The Python-facing `limit` is "max number of memories" — apply it
    // client-side after the recall returns. This also caps payload size
    // when the backend returns more than the skill asked for.
    const limit = parsed.data.limit;
    const sliced = limit === undefined ? result.memories : result.memories.slice(0, limit);
    await this.#audit("memory.recall", null, true, null);
    return {
      memories: sliced.map((m) => ({ content: m.content, type: m.type })),
    };
  }

  async #memoryRemember(args: unknown): Promise<null> {
    const parsed = MemoryRememberArgsSchema.safeParse(args);
    if (!parsed.success) {
      await this.#audit("memory.remember", null, false, "invalid_args");
      throw new CtxError(
        "invalid_args",
        "memory.remember expects { content: string, tags?: string[] }",
      );
    }
    if (!this.#manifest.effects.includes("writes_memory")) {
      await this.#audit("memory.remember", null, false, "missing_effect");
      throw new CtxError(
        "missing_effect",
        "memory.remember requires effects: [writes_memory] in SKILL.md",
      );
    }
    await this.#memory.retain(this.#memoryBankId, parsed.data.content, {
      ...(parsed.data.tags && { tags: parsed.data.tags }),
    });
    await this.#audit("memory.remember", null, true, null);
    return null;
  }

  async #filesRead(args: unknown): Promise<string> {
    const parsed = FilesReadArgsSchema.safeParse(args);
    if (!parsed.success) {
      await this.#audit("files.read", null, false, "invalid_args");
      throw new CtxError("invalid_args", "files.read expects { path: string }");
    }
    if (!this.#manifest.effects.includes("reads_filesystem")) {
      await this.#audit("files.read", parsed.data.path, false, "missing_effect");
      throw new CtxError(
        "missing_effect",
        "files.read requires effects: [reads_filesystem] in SKILL.md",
      );
    }
    try {
      const content = await this.#files.read(parsed.data.path);
      await this.#audit("files.read", parsed.data.path, true, null);
      return content;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.#audit("files.read", parsed.data.path, false, "read_failed");
      throw new CtxError("read_failed", message);
    }
  }

  async #filesWrite(args: unknown): Promise<null> {
    const parsed = FilesWriteArgsSchema.safeParse(args);
    if (!parsed.success) {
      await this.#audit("files.write", null, false, "invalid_args");
      throw new CtxError("invalid_args", "files.write expects { path: string, content: string }");
    }
    if (!this.#manifest.effects.includes("writes_filesystem")) {
      await this.#audit("files.write", parsed.data.path, false, "missing_effect");
      throw new CtxError(
        "missing_effect",
        "files.write requires effects: [writes_filesystem] in SKILL.md",
      );
    }
    try {
      await this.#files.write(parsed.data.path, parsed.data.content);
      await this.#audit("files.write", parsed.data.path, true, null);
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.#audit("files.write", parsed.data.path, false, "write_failed");
      throw new CtxError("write_failed", message);
    }
  }

  async #filesList(args: unknown): Promise<{
    entries: { path: string; size: number; last_modified: string }[];
  }> {
    const parsed = FilesListArgsSchema.safeParse(args);
    if (!parsed.success) {
      await this.#audit("files.list", null, false, "invalid_args");
      throw new CtxError("invalid_args", "files.list expects { prefix?: string }");
    }
    if (!this.#manifest.effects.includes("reads_filesystem")) {
      await this.#audit("files.list", parsed.data.prefix ?? null, false, "missing_effect");
      throw new CtxError(
        "missing_effect",
        "files.list requires effects: [reads_filesystem] in SKILL.md",
      );
    }
    try {
      const entries = await this.#files.list(parsed.data.prefix);
      await this.#audit("files.list", parsed.data.prefix ?? null, true, null);
      return {
        entries: entries.map((e) => ({
          path: e.path,
          size: e.size,
          last_modified: e.lastModified.toISOString(),
        })),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.#audit("files.list", parsed.data.prefix ?? null, false, "list_failed");
      throw new CtxError("list_failed", message);
    }
  }

  async #nowMethod(): Promise<string> {
    const value = this.#now();
    await this.#audit("now", null, true, null);
    return value;
  }

  async #userMethod(): Promise<CtxUser> {
    await this.#audit("user", null, true, null);
    return this.#user;
  }

  async #logInfo(args: unknown): Promise<null> {
    const parsed = LogInfoArgsSchema.safeParse(args);
    if (!parsed.success) {
      await this.#audit("log.info", null, false, "invalid_args");
      throw new CtxError(
        "invalid_args",
        "log.info expects { message: string, fields?: Record<string, unknown> }",
      );
    }
    log.info(
      {
        // Skill-supplied fields go FIRST so the trusted host fields below
        // can't be spoofed (object-spread later wins). A skill calling
        // `ctx.log.info("hi", skillRunId="evil")` will have its `skillRunId`
        // overwritten by the real one.
        ...parsed.data.fields,
        skillRunId: this.#runId,
        skillName: this.#manifest.name,
      },
      parsed.data.message,
    );
    await this.#audit("log.info", null, true, null);
    return null;
  }

  /**
   * Audit failures are logged (warn) but do NOT propagate. Trade-off: a DB
   * hiccup shouldn't break skill execution mid-flight, but the consequence
   * is that a successful `secrets.get` can return the secret value to
   * Python without a corresponding audit row landing in `skill_context_calls`.
   *
   * TODO(P3.3): when the design's threat model gets a formal review,
   * decide whether audit-failure should be fail-closed (refuse to return
   * the value) for sensitive methods like `secrets.get` while staying
   * fail-open for low-risk methods like `now()`.
   */
  async #audit(
    method: CtxMethod | string,
    target: string | null,
    ok: boolean,
    errorKind: string | null,
  ): Promise<void> {
    try {
      await this.#recordContextCall({
        runId: this.#runId,
        method: method as CtxMethod,
        target,
        ok,
        error: errorKind,
      });
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), method },
        "failed to record ctx audit row",
      );
    }
  }
}

function isCtxMethod(method: string): method is CtxMethod {
  return (CTX_METHODS as readonly string[]).includes(method);
}
