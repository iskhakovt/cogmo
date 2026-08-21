import type { Inngest } from "inngest";
import type { Transactor } from "../../db/index.js";
import { codingTaskStart } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type { CodingStore, CodingTaskStatus } from "./store/index.js";

const log = logger.child({ component: "coding.service" });

export interface CodingServiceDeps {
  runInTx: Transactor;
  codingStore: CodingStore;
  /**
   * Inngest client used to emit `coding/task/start`. The orchestrator
   * function ({@link createCodingOrchestrator}) consumes the event and
   * runs the durable plan flow.
   */
  inngest: Inngest;
  /**
   * Whether the sandbox module is initialized. The service itself doesn't
   * touch the sandbox — the orchestrator (running inside Inngest) does.
   * The flag exists so we can fail fast at delegate time on a dev machine
   * without `SANDBOX_RUNTIME` set, instead of inserting a task that the
   * orchestrator immediately marks as failed.
   */
  sandboxAvailable: boolean;
}

export interface DelegateInput {
  goal: string;
  repoName: string;
  /**
   * Deterministic-per-submission token from the tool call's
   * `ToolCallContext`. Makes the insert + emit pair recoverable: the tool
   * runs inside a durable `step.run`, so a crash between this row
   * committing and Inngest recording the step result re-runs the body, and
   * without a key that mints a second task and a second sandbox. Omitted by
   * callers with no retry semantics (CLI, tests).
   */
  idempotencyKey?: string;
}

export type DelegateResult =
  | { taskId: string; status: "queued" }
  /**
   * A prior attempt at this exact submission already inserted the task —
   * same idempotency key. `priorStatus` is where that task has got to, which
   * the caller needs: a `queued` row has just been re-driven, a started one
   * is already running, and a terminal one will never run again. Reporting
   * all three as `queued` would tell the model a failed task is under way.
   */
  | { taskId: string; status: "recovered"; priorStatus: CodingTaskStatus }
  | { taskId: null; status: "rejected"; reason: string };

/**
 * Coding namespace on the per-turn `Service`. `delegate` is a **submit**
 * call: it inserts a `coding_tasks` row in `queued` status, emits
 * `coding/task/start`, and returns immediately. The durable orchestrator
 * picks up the event and drives the task through plan → approval →
 * execute. Plan and progress messages reach the user via the
 * `CodingStreamingRegistry` + Telegram delivery (slice 2.0e+g), not via
 * the tool result.
 *
 * This is a real LLM-facing API change vs slice 1: the tool result no
 * longer carries the plan text. `DELEGATE_CODING_GUIDANCE` (in
 * `tool.ts`) tells the model to acknowledge briefly and not speculate
 * about plan content. Matches the industry pattern for long-running
 * agent tools (Devin / Cursor background agents / LangGraph
 * `interrupt`): fast tool return, out-of-band execution, results
 * surface in subsequent LLM turns via new conversation messages.
 */
export interface CodingService {
  delegate(input: DelegateInput): Promise<DelegateResult>;
}

export function createCodingService(
  deps: CodingServiceDeps,
  conversationId: string,
): CodingService {
  return {
    async delegate(input: DelegateInput): Promise<DelegateResult> {
      if (!deps.sandboxAvailable) {
        throw new Error(
          "Coding delegation is unavailable — the sandbox module is not initialized. " +
            "Set SANDBOX_RUNTIME (sysbox in prod, runc for dev/CI) and restart Cogmo.",
        );
      }

      const repo = await deps.runInTx((tx) => deps.codingStore.getRepoByName(tx, input.repoName));
      if (!repo) {
        // The `skills` row is auto-managed (inserted by `ensureSkillsCodingRepo`
        // on boot once the bare repo has an `origin` configured). Operators
        // hitting "skills not registered" are usually one wizard step away,
        // not in a "no /repo add yet" state — point them at the dedicated
        // CLI rather than the generic registry surface.
        if (input.repoName === "skills") {
          throw new Error(
            "Skills repo isn't configured yet. Run `cogmo migrate-skills-remote` " +
              "(or re-run `cogmo setup`) to attach a remote and register the row.",
          );
        }
        throw new Error(
          `Repo not registered: ${input.repoName}. Use /repo list to see available repos.`,
        );
      }

      // Recognise a retry before spending an admission check on it: the row
      // a retry is recovering counts against the repo's own limit, so with
      // the default `maxConcurrentTasks` of 1 it would reject itself.
      //
      // Admission check + insert share one tx. The async submit +
      // durable orchestrator means multiple conversations (or repeated
      // taps from the same one) could each trigger a task concurrently;
      // splitting count and insert across two transactions opened a
      // window where each saw `active < limit` and both inserted,
      // exceeding `maxConcurrentTasks`. REPEATABLE READ (the project
      // default) doesn't catch this predicate race either — snapshot
      // isolation doesn't predicate-lock — but at single-user scale
      // the residual race is acceptable. If multi-tenant lands, prefer
      // `SELECT ... FOR UPDATE` on the `coding_repos` row inside the
      // count over SERIALIZABLE — row-locking prevents the race
      // outright instead of detecting and retrying it.
      const admit = await deps.runInTx(async (tx) => {
        if (input.idempotencyKey !== undefined) {
          const prior = await deps.codingStore.getTaskByIdempotencyKey(tx, input.idempotencyKey);
          if (prior) return { kind: "recovered" as const, task: prior };
        }
        const active = await deps.codingStore.countActiveTasksForRepo(tx, repo.id);
        if (active >= repo.maxConcurrentTasks) {
          return { kind: "rejected" as const, active };
        }
        const values = {
          repoId: repo.id,
          conversationId,
          goal: input.goal,
          triggerSource: "user" as const,
          backend: "claude" as const,
          allowPrivilegedRunc: false,
        };
        if (input.idempotencyKey === undefined) {
          return { kind: "admitted" as const, task: await deps.codingStore.insertTask(tx, values) };
        }
        // `insertOrRecoverTask`'s ON CONFLICT DO NOTHING closes the window
        // the pre-check above leaves open — two concurrent retries can both
        // read no row under snapshot isolation, and the loser recovers the
        // winner's row instead of raising a unique violation.
        const insert = await deps.codingStore.insertOrRecoverTask(tx, {
          ...values,
          idempotencyKey: input.idempotencyKey,
        });
        return insert.kind === "new"
          ? { kind: "admitted" as const, task: insert.row }
          : { kind: "recovered" as const, task: insert.row };
      });
      if (admit.kind === "recovered") {
        const prior = admit.task;
        log.info(
          { taskId: prior.id, priorStatus: prior.status, idempotencyKey: input.idempotencyKey },
          "coding task submission recovered — prior attempt already inserted it",
        );
        if (prior.status !== "queued") {
          // The orchestrator already claimed this task (or it is terminal).
          // Re-emitting could only race a live run, and the `queued ->
          // planning` transition would skip it anyway. Report the real
          // status so a task that will never run isn't announced as pending.
          return { taskId: prior.id, status: "recovered", priorStatus: prior.status };
        }
        // Still `queued`: the prior attempt died between the row committing
        // and its `inngest.send`, so nothing is driving this task. Re-emit —
        // skipping would trade a duplicate for a permanent stall — and let a
        // send failure propagate without marking the row failed, so the next
        // attempt can still recover it. The re-send is absorbed twice over:
        // `task-start-<taskId>` at the bus, and the `queued -> planning`
        // transition past that window.
        await deps.inngest.send({
          name: codingTaskStart.name,
          data: { taskId: prior.id },
          id: `task-start-${prior.id}`,
        });
        return { taskId: prior.id, status: "recovered", priorStatus: prior.status };
      }
      if (admit.kind === "rejected") {
        return {
          taskId: null,
          status: "rejected",
          reason:
            `Repo "${repo.name}" already has ${admit.active} active task(s) ` +
            `(limit ${repo.maxConcurrentTasks}). Wait for one to finish or cancel it.`,
        };
      }
      const { task } = admit;

      // Hand off to the durable orchestrator. Once this event lands the
      // service has no further role — plan rendering, approval, execute,
      // and progress all happen out-of-band.
      //
      // If `inngest.send` fails after the row is in `queued`, the task
      // would be orphaned: it permanently counts against
      // `maxConcurrentTasks` (admission slot leak) and never progresses.
      // Mark it failed before propagating so the row is in a terminal
      // state and the slot frees up. The original send error is
      // re-thrown so the caller knows the submission didn't take.
      //
      // Freshly admitted tasks only. The recovery branch returns before here
      // precisely so this can stay unconditional: `updateTaskStatus` is an
      // unguarded `UPDATE ... WHERE id`, and a recovered row may be mid-flight
      // or already `pr_open`.
      try {
        await deps.inngest.send({
          name: codingTaskStart.name,
          data: { taskId: task.id },
          // Bus-level dedup, same `<verb>-<taskId>` shape as the
          // orchestrators' `task-failed-` / `plan-approved-` emits. Minted
          // per submission, so it can only collapse a re-send of this exact
          // one. Pairs with the `queued -> planning` transition, which holds
          // outside the bus's 24h dedup window.
          id: `task-start-${task.id}`,
        });
      } catch (sendErr) {
        await deps
          .runInTx(async (tx) => {
            await deps.codingStore.updateTaskStatus(tx, {
              id: task.id,
              status: "failed",
              failureReason: `inngest.send failed: ${(sendErr as Error).message}`,
            });
            // Release the key along with the row. It identifies a submission
            // that is about to be retried, and a retry that recovered this
            // terminal row would report a dead task back to the model rather
            // than re-submitting — trading the duplicate this key exists to
            // prevent for a silent no-op. The row stays terminal so the
            // admission slot is freed either way.
            if (input.idempotencyKey !== undefined) {
              await deps.codingStore.clearTaskIdempotencyKey(tx, task.id);
            }
          })
          .catch((cleanupErr) => {
            log.error(
              { err: cleanupErr, taskId: task.id, sendErr },
              "failed to mark task failed after inngest.send error — task is now orphaned",
            );
          });
        throw sendErr;
      }

      log.info(
        { taskId: task.id, repo: repo.name, conversationId, goal: input.goal },
        "coding task submitted",
      );

      return { taskId: task.id, status: "queued" };
    },
  };
}
