import { z } from "zod";
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
    if (value === null) {
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
    await this.#audit("memory.recall", null, true, null);
    return {
      memories: result.memories.map((m) => ({ content: m.content, type: m.type })),
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
        skillRunId: this.#runId,
        skillName: this.#manifest.name,
        ...parsed.data.fields,
      },
      parsed.data.message,
    );
    await this.#audit("log.info", null, true, null);
    return null;
  }

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
