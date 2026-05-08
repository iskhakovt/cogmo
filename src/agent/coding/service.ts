import type { Inngest } from "inngest";
import type { Transactor } from "../../db/index.js";
import { codingTaskStart } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type { CodingStore } from "./store/index.js";

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
}

export type DelegateResult =
  | { taskId: string; status: "queued" }
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
        throw new Error(
          `Repo not registered: ${input.repoName}. Use /repo list to see available repos.`,
        );
      }

      // Admission check + insert share one tx. The async submit +
      // durable orchestrator means multiple conversations (or repeated
      // taps from the same one) could each trigger a task concurrently;
      // splitting count and insert across two transactions opened a
      // window where each saw `active < limit` and both inserted,
      // exceeding `maxConcurrentTasks`. Single tx narrows that window
      // sharply (concurrent admissions still serialise on the
      // underlying lock acquisition pattern under READ COMMITTED — at
      // single-user scale the residual race is acceptable). If multi-
      // tenant ever lands, lift to `SELECT ... FOR UPDATE` on the
      // `coding_repos` row inside the count.
      const admit = await deps.runInTx(async (tx) => {
        const active = await deps.codingStore.countActiveTasksForRepo(tx, repo.id);
        if (active >= repo.maxConcurrentTasks) {
          return { kind: "rejected" as const, active };
        }
        const task = await deps.codingStore.insertTask(tx, {
          repoId: repo.id,
          conversationId,
          goal: input.goal,
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        });
        return { kind: "admitted" as const, task };
      });
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
      try {
        await deps.inngest.send({
          name: codingTaskStart.name,
          data: { taskId: task.id },
        });
      } catch (sendErr) {
        await deps
          .runInTx((tx) =>
            deps.codingStore.updateTaskStatus(tx, {
              id: task.id,
              status: "failed",
              failureReason: `inngest.send failed: ${(sendErr as Error).message}`,
            }),
          )
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
