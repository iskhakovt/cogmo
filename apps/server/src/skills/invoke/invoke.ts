import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import type { SandboxClient } from "../../sandbox/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { DefaultCtxHandlerOptions } from "../ctx-handler.js";
import type { SkillInvokeRejection } from "../invoke-rejection.js";
import type { SkillRunAs } from "../run-as.js";
import type { SkillSourceCache } from "../source-cache.js";
import type { SkillRunTrigger, SkillStore } from "../store/index.js";
import { executeRun } from "./execute-run.js";
import { finishRun } from "./finish-run.js";
import type { SkillRunResult } from "./run-result.js";
import { planRuntime, type RuntimeConfig, type SkillRuntime } from "./runtime.js";
import { startRun } from "./start-run.js";
import type { LazyWarmPool } from "./warm-pool.js";

const log = logger.child({ component: "skills.runner" });

/** What an invocation reaches: the run rows, the source cache, the runtimes. */
export interface InvokeDeps {
  store: SkillStore;
  runInTx: Transactor;
  secretsStore: SecretsStore;
  /** IANA timezone: `ctx.user().timezone`. */
  userTimezone: string;
  sourceCache: SkillSourceCache;
  /** Tier-2 sandbox; unset leaves container skills unavailable. */
  sandbox: SandboxClient | undefined;
  warmPool: LazyWarmPool;
  runtime: RuntimeConfig;
  /** The network `ctx.http` reaches; unset for real DNS and the global `fetch`. */
  ctxHttp: Required<Pick<DefaultCtxHandlerOptions, "resolveHost" | "fetch">> | undefined;
}

export interface InvokeArgs {
  name: string;
  inputs: unknown;
  trigger?: SkillRunTrigger;
  idempotencyKey?: string;
  runAs: SkillRunAs;
}

/**
 * Run a skill once. Pre-flight reads reject before any DB write; then the run
 * row's recovery point decides what is left to do (`startRun`): execute and
 * finish, finish only, replay a settled result, or refuse an attempt in flight.
 */
export async function invokeSkill(
  deps: InvokeDeps,
  opts: InvokeArgs,
): Promise<Result<SkillRunResult, SkillInvokeRejection>> {
  // Empty-string idempotency keys would all collide on the UNIQUE
  // constraint as if they were the same key. Keys are built by code,
  // never taken from input, so an empty one is a caller bug.
  if (opts.idempotencyKey === "") {
    throw new Error(
      `invoke: idempotencyKey must be non-empty when provided (skill '${opts.name}')`,
    );
  }

  // --- Pre-flight (cheap, idempotent reads; re-runs freely on retry) ---
  // A rejection here precedes any DB write.
  const name = opts.name;
  const skill = await deps.runInTx((tx) => deps.store.getSkillByName(tx, name));
  if (!skill) return err({ kind: "not_found", name });
  if (skill.disabled) return err({ kind: "disabled", name });

  const cached = await deps.sourceCache.load(skill);

  if (!cached.inputsValidator(opts.inputs)) {
    const issues = (cached.inputsValidator.errors ?? []).map(
      (e) => `${e.instancePath || "<root>"} ${e.message ?? "invalid"}`,
    );
    return err({ kind: "invalid_inputs", name, issues });
  }

  const plan = planRuntime(skill.tier, cached.manifest, deps.sandbox);
  if (plan === null) return err({ kind: "sandbox_unavailable", name });

  const trigger: SkillRunTrigger = opts.trigger ?? "manual";
  const { idempotencyKey } = opts;

  // The warm pool starts before the run row is written, so a pool that
  // can't start throws with no row behind and a keyed retry runs the skill
  // rather than refusing a `started` row as in flight. A key that already
  // has a row is a replay, which recovery settles without the pool.
  const pool =
    plan.kind === "pool" && !(await hasKeyedRun(deps, idempotencyKey))
      ? await deps.warmPool.ensure(plan.sandbox)
      : undefined;

  const start = await startRun(deps, {
    skillId: skill.id,
    trigger,
    inputs: opts.inputs,
    ...(idempotencyKey !== undefined && { idempotencyKey }),
  });
  const logFields = {
    skillName: name,
    tier: skill.tier,
    trigger,
    ...(idempotencyKey !== undefined && { idempotencyKey }),
  };

  return match(start)
    .returnType<Promise<Result<SkillRunResult, SkillInvokeRejection>>>()
    .with({ kind: "replay" }, async ({ result }) => {
      log.info(
        { runId: result.runId, ...logFields },
        "replaying cached terminal skill run (recovery_point=finished)",
      );
      return ok(result);
    })
    .with({ kind: "inflight" }, async ({ runId }) => err({ kind: "inflight", name, runId }))
    .with({ kind: "finish" }, async ({ runId, executed }) => {
      log.info(
        { runId, ...logFields, resumingFrom: "executed" },
        "resuming skill from executed phase",
      );
      return ok(await finishRun(deps, { runId, skillName: name, cached, executed }));
    })
    .with({ kind: "execute" }, async ({ runId, createdAt }) => {
      log.info({ runId, ...logFields }, "invoking skill");
      // `pool` is unset here only when the keyed row seen above was gone by
      // the time this attempt inserted its own.
      const runtime: SkillRuntime =
        plan.kind === "pool"
          ? { kind: "pool", pool: pool ?? (await deps.warmPool.ensure(plan.sandbox)) }
          : plan;
      const executed = await executeRun(deps, {
        run: { id: runId, createdAt },
        skill,
        cached,
        inputs: opts.inputs,
        runAs: opts.runAs,
        runtime,
      });
      return ok(await finishRun(deps, { runId, skillName: name, cached, executed }));
    })
    .exhaustive();
}

/** Whether a run row already holds this idempotency key. */
async function hasKeyedRun(
  deps: Pick<InvokeDeps, "store" | "runInTx">,
  idempotencyKey: string | undefined,
): Promise<boolean> {
  if (idempotencyKey === undefined) return false;
  const row = await deps.runInTx((tx) => deps.store.getRunByIdempotencyKey(tx, idempotencyKey));
  return row !== undefined;
}
