import { match, P } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { truncate } from "../../util/string.js";
import { DefaultCtxHandler, type DefaultCtxHandlerOptions } from "../ctx-handler.js";
import type { DispatchDecision, DispatchGate, TaskErrorKind, TaskOutcome } from "../protocol.js";
import type { SkillRunAs } from "../run-as.js";
import type { SkillSourceCacheEntry } from "../source-cache.js";
import type {
  ExecutedOutcome,
  ExecuteRunTransition,
  SkillRow,
  SkillRunError,
  SkillRunRow,
  SkillStore,
} from "../store/index.js";
import type { SkillRunResourceUsage } from "../types.js";
import { wallClockSOf } from "../wall-clock.js";
import { dispatchDeadline, dispatchRun } from "./dispatch-run.js";
import { failBeforeDispatch } from "./fail-before-dispatch.js";
import { dispatchToRuntime, type RuntimeConfig, type SkillRuntime } from "./runtime.js";

const log = logger.child({ component: "skills.runner" });

/** How much of an outcome the sweeper beat is logged. */
const DISCARDED_LOG_CHARS = 2000;

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

/** Where a run's dispatch gate stands: not asked, or what it answered. */
type GateState = { kind: "not_asked" } | DispatchDecision;

/** What executing a run left: the outcome it recorded, or the sweeper's finish it lost to. */
export type ExecuteRunResult =
  | { kind: "executed"; outcome: ExecutedOutcome }
  | { kind: "swept"; row: SkillRunRow };

/**
 * Run the skill body on `runtime` and record what it produced. The runtime
 * moves the row `started → dispatched` through the gate immediately before
 * it sends the task; a task it sent is recorded `dispatched → executed`, and
 * one it never sent goes through `failBeforeDispatch`. The body is the
 * non-idempotent, side-effecting part of a run, so nothing replays it.
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
): Promise<ExecuteRunResult> {
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

  // What the runtime's gate answered, which decides the transition that
  // records the outcome. A holder, not a `let`: the gate sets it from a
  // callback, which narrowing does not see.
  const gate: { state: GateState } = { state: { kind: "not_asked" } };
  // One wall clock for the runtime to enforce and the deadline to count from.
  const wallClockS = wallClockSOf(skill.tier, cached.manifest.resources);
  const dispatch: DispatchGate = async () => {
    const decision = await dispatchRun(deps, {
      runId: run.id,
      deadlineAt: dispatchDeadline(new Date(), wallClockS),
    });
    gate.state = decision;
    return decision;
  };

  const result = await dispatchToRuntime(deps.runtime, args.runtime, {
    skill,
    cached,
    inputs: args.inputs,
    ctxHandler,
    taskId: run.id,
    dispatch,
    wallClockS,
  });
  const finishedAt = new Date();
  // `wallClockMs` is always derived from the host-side timestamps;
  // `peakMemoryBytes` rides whatever the runtime contributed via
  // `result.rusage` (container populates it from `getrusage`, wasm leaves it
  // unset and we store null).
  const resourceUsage = {
    wallClockMs: Math.max(0, finishedAt.getTime() - run.createdAt.getTime()),
    peakMemoryBytes: result.rusage?.peakMemoryBytes ?? null,
  };
  const write = { id: run.id, resourceUsage, finishedAt };
  const { outcome, transition } = await match(gate.state)
    .returnType<Promise<{ outcome: ExecutedOutcome; transition: ExecuteRunTransition }>>()
    .with({ kind: "send" }, () =>
      recordExecuted(deps, { ...write, outcome: executedOutcomeOfTask(result) }),
    )
    .with({ kind: P.union("not_asked", "withhold") }, () =>
      failBeforeDispatch(deps, { ...write, result }),
    )
    .exhaustive();
  return match(transition)
    .returnType<ExecuteRunResult>()
    .with({ kind: "transitioned" }, () => ({ kind: "executed", outcome }))
    .with({ kind: "swept" }, ({ row }) => {
      log.warn(
        {
          runId: run.id,
          skillName: skill.name,
          errorKind: row.errorKind,
          discarded: truncate(JSON.stringify(outcome), DISCARDED_LOG_CHARS),
        },
        "skill run was swept before its outcome was recorded; discarding the outcome",
      );
      return { kind: "swept", row };
    })
    .exhaustive();
}

/** Record a dispatched task's outcome: `dispatched → executed`. */
async function recordExecuted(
  deps: Pick<ExecuteRunDeps, "store" | "runInTx">,
  args: {
    id: string;
    outcome: ExecutedOutcome;
    resourceUsage: SkillRunResourceUsage;
    finishedAt: Date;
  },
): Promise<{ outcome: ExecutedOutcome; transition: ExecuteRunTransition }> {
  const transition = await deps.runInTx((tx) => deps.store.transitionToExecuted(tx, args));
  return { outcome: args.outcome, transition };
}

/** A task's outcome as the `executed` row records it. */
function executedOutcomeOfTask(result: TaskOutcome): ExecutedOutcome {
  return match(result)
    .returnType<ExecutedOutcome>()
    .with({ ok: true }, ({ output }) => ({ kind: "output", output: output ?? null }))
    .with({ ok: false }, ({ errorKind, error }) => ({
      kind: "error",
      error: taskError(errorKind, error),
    }))
    .exhaustive();
}

/** A runtime's error as a run error; a worker's `output_invalid` had no JSON to keep. */
function taskError(kind: TaskErrorKind, message: string): SkillRunError {
  return match(kind)
    .returnType<SkillRunError>()
    .with("output_invalid", (k) => ({ kind: k, message, output: null }))
    .with(P.not("output_invalid"), (k) => ({ kind: k, message }))
    .exhaustive();
}
