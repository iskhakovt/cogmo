import type { Transactor } from "../../db/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { DefaultCtxHandler, type DefaultCtxHandlerOptions } from "../ctx-handler.js";
import type { SkillRunAs } from "../run-as.js";
import type { SkillSourceCacheEntry } from "../source-cache.js";
import type { SkillRow, SkillStore } from "../store/index.js";
import { dispatchToRuntime, type RuntimeConfig, type SkillRuntime } from "./runtime.js";
import type { ExecutedOutcome } from "./start-run.js";

export interface ExecuteRunDeps {
  store: SkillStore;
  runInTx: Transactor;
  secretsStore: SecretsStore;
  /** IANA timezone: `ctx.user().timezone`. */
  userTimezone: string;
  runtime: RuntimeConfig;
  /** The network `ctx.http` reaches; unset for real DNS and the global `fetch`. */
  ctxHttp: Required<Pick<DefaultCtxHandlerOptions, "resolveHost" | "fetch">> | undefined;
}

/**
 * The `started → executed` transition: run the skill body on `runtime`, then
 * record what it produced and its resource usage on the run row. The body is
 * the non-idempotent, side-effecting part of a run, so nothing replays it.
 */
export async function executeRun(
  deps: ExecuteRunDeps,
  args: {
    run: { id: string; createdAt: Date };
    skill: SkillRow;
    cached: SkillSourceCacheEntry;
    inputs: unknown;
    runAs: SkillRunAs;
    runtime: SkillRuntime;
  },
): Promise<ExecutedOutcome> {
  const { run, skill, cached, runAs } = args;
  const ctxHandler = new DefaultCtxHandler({
    manifest: cached.manifest,
    runId: run.id,
    user: { id: runAs.userId, timezone: deps.userTimezone },
    secretsStore: deps.secretsStore,
    runInTx: deps.runInTx,
    service: runAs.service,
    recordContextCall: (call) => deps.runInTx((tx) => deps.store.recordContextCall(tx, call)),
    // Named fields, not a spread: a wider object is assignable to the
    // option's type, and anything else it carried would override the
    // handler's manifest or audit binding.
    ...(deps.ctxHttp && {
      resolveHost: deps.ctxHttp.resolveHost,
      fetch: deps.ctxHttp.fetch,
    }),
  });

  const result = await dispatchToRuntime(
    deps.runtime,
    args.runtime,
    skill,
    cached,
    args.inputs,
    ctxHandler,
    run.id,
  );
  const finishedAt = new Date();
  // `wallClockMs` is always derived from the host-side timestamps;
  // `peakMemoryBytes` rides whatever the runtime contributed via
  // `result.rusage` (tier-2 populates it from `getrusage`, tier-1 leaves it
  // unset and we store null).
  const resourceUsage = {
    wallClockMs: Math.max(0, finishedAt.getTime() - run.createdAt.getTime()),
    peakMemoryBytes: result.rusage?.peakMemoryBytes ?? null,
  };
  const executed: ExecutedOutcome = result.ok
    ? { kind: "output", output: result.output ?? null }
    : { kind: "error", error: result.error };
  await deps.runInTx((tx) =>
    deps.store.transitionToExecuted(tx, {
      id: run.id,
      output: executed.kind === "output" ? executed.output : null,
      error: executed.kind === "error" ? executed.error : null,
      resourceUsage,
      finishedAt,
    }),
  );
  return executed;
}
