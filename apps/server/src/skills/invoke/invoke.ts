import { err, ok, type Result } from "neverthrow";
import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import type { SandboxClient } from "../../sandbox/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { DefaultCtxHandler, type DefaultCtxHandlerOptions } from "../ctx-handler.js";
import type { SkillInvokeRejection } from "../invoke-rejection.js";
import type { SkillRunAs } from "../run-as.js";
import type { SkillSourceCache, SkillSourceCacheEntry } from "../source-cache.js";
import type {
  SkillRunRecoveryPoint,
  SkillRunStatus,
  SkillRunTrigger,
  SkillStore,
} from "../store/index.js";
import { reconstructFinishedResult, type SkillRunResult } from "./run-result.js";
import {
  dispatchToRuntime,
  planRuntime,
  type RuntimeConfig,
  type SkillRuntime,
} from "./runtime.js";
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

/** Run a skill once, honouring the idempotency key's recovery point. */
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
  // Hoisted so the narrowed `string` survives into the `runInTx` closures.
  const idempotencyKey = opts.idempotencyKey;

  // The warm pool starts before the run row is written, so a pool that
  // can't start throws with no row behind and a keyed retry runs the skill
  // rather than refusing a `started` row as in flight. A key that already
  // has a row is a replay, which recovery settles without the pool.
  const pool =
    plan.kind === "pool" && !(await hasKeyedRun(deps, idempotencyKey))
      ? await deps.warmPool.ensure(plan.sandbox)
      : undefined;

  // --- Start or recover the run row ---
  //
  // Keyed path: `startOrRecoverRun` inserts a fresh row with
  // `recovery_point='started'` and returns `kind: 'new'`. If a row with
  // the same key already exists (prior crashed attempt, or a successful
  // run being replayed), it returns `kind: 'recovered'` with the stored
  // row; an in-flight (`started`) row is refused below.
  //
  // Non-keyed path: plain `insertRun` → fresh row every call. No
  // exactly-once semantic.
  let runId: string;
  let runCreatedAt: Date;
  let recoveryPoint: SkillRunRecoveryPoint;
  let savedOutput: unknown | null = null;
  let savedError: string | null = null;

  if (idempotencyKey !== undefined) {
    const { kind, row } = await deps.runInTx((tx) =>
      deps.store.startOrRecoverRun(tx, {
        skillId: skill.id,
        trigger,
        inputs: opts.inputs,
        idempotencyKey,
      }),
    );
    runId = row.id;
    runCreatedAt = row.createdAt;
    recoveryPoint = row.recoveryPoint;
    savedOutput = row.output;
    savedError = row.error;

    if (kind === "recovered" && recoveryPoint === "finished") {
      // Terminal cached result. Reconstruct SkillRunResult shape and
      // return without touching the runtime or the row.
      log.info(
        { runId, skillName: opts.name, idempotencyKey },
        "replaying cached terminal skill run (recovery_point=finished)",
      );
      return ok(reconstructFinishedResult(runId, row.status, savedOutput, savedError));
    }
    if (kind === "recovered" && recoveryPoint === "started") {
      return err({ kind: "inflight", name, runId });
    }
    // kind === 'new' (fresh start) OR kind === 'recovered' &&
    // recovery_point === 'executed' (execute succeeded last time, just
    // finalize). Both fall through.
  } else {
    const run = await deps.runInTx((tx) =>
      deps.store.insertRun(tx, { skillId: skill.id, trigger, inputs: opts.inputs }),
    );
    runId = run.id;
    runCreatedAt = run.createdAt;
    recoveryPoint = "started";
  }

  log.info(
    {
      runId,
      skillName: opts.name,
      tier: skill.tier,
      trigger,
      ...(idempotencyKey !== undefined && { idempotencyKey }),
      ...(recoveryPoint !== "started" && { resumingFrom: recoveryPoint }),
    },
    recoveryPoint === "started" ? "invoking skill" : "resuming skill from executed phase",
  );

  // --- Execute phase (skipped on `recovery_point='executed'` replay) ---
  if (recoveryPoint === "started") {
    const ctxHandler = new DefaultCtxHandler({
      manifest: cached.manifest,
      runId,
      user: { id: opts.runAs.userId, timezone: deps.userTimezone },
      secretsStore: deps.secretsStore,
      runInTx: deps.runInTx,
      service: opts.runAs.service,
      recordContextCall: (call) => deps.runInTx((tx) => deps.store.recordContextCall(tx, call)),
      // Named fields, not a spread: a wider object is assignable to the
      // option's type, and anything else it carried would override the
      // handler's manifest or audit binding.
      ...(deps.ctxHttp && {
        resolveHost: deps.ctxHttp.resolveHost,
        fetch: deps.ctxHttp.fetch,
      }),
    });

    // `pool` is unset here only when the keyed row seen above was gone by
    // the time this attempt inserted its own.
    const runtime: SkillRuntime =
      plan.kind === "pool"
        ? { kind: "pool", pool: pool ?? (await deps.warmPool.ensure(plan.sandbox)) }
        : plan;
    const result = await dispatchToRuntime(
      deps.runtime,
      runtime,
      skill,
      cached,
      opts.inputs,
      ctxHandler,
      runId,
    );
    const finishedAt = new Date();
    // Build the resource_usage blob once — `wallClockMs` is always derived
    // from the host-side timestamps; `peakMemoryBytes` rides whatever the
    // runtime contributed via `result.rusage` (tier-2 populates it from
    // `getrusage`, tier-1 leaves it unset and we store null).
    const resourceUsage = {
      wallClockMs: Math.max(0, finishedAt.getTime() - runCreatedAt.getTime()),
      peakMemoryBytes: result.rusage?.peakMemoryBytes ?? null,
    };
    savedOutput = result.ok ? (result.output ?? null) : null;
    savedError = result.ok ? null : (result.error ?? "unknown_error");
    await deps.runInTx((tx) =>
      deps.store.transitionToExecuted(tx, {
        id: runId,
        output: savedOutput,
        error: savedError,
        resourceUsage,
        finishedAt,
      }),
    );
  }

  // --- Validate + finalize phase (runs for new + recovered-executed
  // alike). Output validation is pure, so replaying it on a recovered
  // row produces the same verdict as the original attempt — safe.
  let finalStatus: SkillRunStatus;
  let finalOutput: unknown | null = savedOutput;
  let finalError: string | null = savedError;
  if (savedError !== null) {
    finalStatus = "error";
  } else {
    const valid = validateOutput(cached, savedOutput, opts.name);
    if (valid.isErr()) {
      finalStatus = "error";
      finalOutput = null;
      finalError = valid.error;
    } else {
      finalStatus = "success";
    }
  }

  await deps.runInTx((tx) =>
    deps.store.transitionToFinished(tx, {
      id: runId,
      status: finalStatus,
      output: finalOutput,
      error: finalError,
    }),
  );

  return ok(reconstructFinishedResult(runId, finalStatus, finalOutput, finalError));
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

/** Err with why `output` fails the manifest's `outputs` schema; ok when it declares none. */
function validateOutput(
  cached: SkillSourceCacheEntry,
  output: unknown,
  skillName: string,
): Result<void, string> {
  const validator = cached.outputsValidator;
  if (validator === undefined || validator(output)) return ok(undefined);
  const issues = (validator.errors ?? []).map(
    (e) => `${e.instancePath || "<root>"} ${e.message ?? "invalid"}`,
  );
  return err(`output failed schema validation for skill '${skillName}': ${issues.join("; ")}`);
}
