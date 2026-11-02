import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import type { SandboxClient } from "../../sandbox/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { DefaultCtxHandlerOptions } from "../ctx-handler.js";
import type { SkillInvokeRejection } from "../invoke-rejection.js";
import type { SkillRunAs } from "../run-as.js";
import {
  type SkillSourceCache,
  type SkillSourceCacheEntry,
  schemaIssues,
} from "../source-cache.js";
import type { SkillRunTrigger, SkillStore } from "../store/index.js";
import { executeRun } from "./execute-run.js";
import { finishRun } from "./finish-run.js";
import type { SkillRunResult } from "./run-result.js";
import { planRuntime, type RuntimeConfig, type RuntimePlan, type SkillRuntime } from "./runtime.js";
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
    return err({ kind: "invalid_inputs", name, issues: schemaIssues(cached.inputsValidator) });
  }

  const plan = planRuntime(skill.tier, cached.manifest, deps.sandbox);
  if (plan === null) return err({ kind: "sandbox_unavailable", name });

  const trigger: SkillRunTrigger = opts.trigger ?? "manual";
  const { idempotencyKey } = opts;

  // The runtime is prepared before the run row is written: tier-1 packages
  // the host cannot provide, or a warm pool that can't start, leave no row
  // behind, so a keyed retry runs the skill rather than replaying a failure
  // no skill code produced or refusing a `started` row as in flight. A key
  // that already has a row is a replay, which recovery settles without a
  // runtime.
  const prepared = (await hasKeyedRun(deps, idempotencyKey))
    ? undefined
    : await prepareRuntime(deps, { name, plan, cached });
  if (prepared?.isErr()) return err(prepared.error);

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
      // `prepared` is unset here only when the keyed row seen above was gone
      // by the time this attempt inserted its own. A runtime that fails then
      // leaves that row `started`, which a keyed retry refuses as in flight.
      const runtime = prepared ?? (await prepareRuntime(deps, { name, plan, cached }));
      if (runtime.isErr()) return err(runtime.error);
      const executed = await executeRun(deps, {
        run: { id: runId, createdAt },
        skill,
        cached,
        inputs: opts.inputs,
        runAs: opts.runAs,
        runtime: runtime.value,
      });
      return ok(await finishRun(deps, { runId, skillName: name, cached, executed }));
    })
    .exhaustive();
}

/**
 * The runtime a run executes on: the tier-1 packages the lockfile needs,
 * resolved by the host, or the started warm pool. A lockfile whose packages
 * are unavailable rejects the invocation; a pool that can't start throws.
 */
async function prepareRuntime(
  deps: Pick<InvokeDeps, "runtime" | "warmPool">,
  args: { name: string; plan: RuntimePlan; cached: SkillSourceCacheEntry },
): Promise<Result<SkillRuntime, SkillInvokeRejection>> {
  const { name, plan, cached } = args;
  return match(plan)
    .returnType<Promise<Result<SkillRuntime, SkillInvokeRejection>>>()
    .with({ kind: "wasm" }, async () =>
      (await deps.runtime.resolveTier1Packages(cached.lockfile))
        .map((packages): SkillRuntime => ({ kind: "wasm", packages }))
        .mapErr(
          (error): SkillInvokeRejection => ({
            kind: "tier1_packages_unavailable",
            name,
            error,
          }),
        ),
    )
    .with({ kind: "pool" }, async ({ sandbox }) =>
      ok({ kind: "pool", pool: await deps.warmPool.ensure(sandbox) }),
    )
    .with({ kind: "one_shot" }, async (oneShot) => ok(oneShot))
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
