import type { Inngest } from "inngest";
import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import { admitCodingTask } from "./admit-coding-task.js";
import { startCodingTask } from "./start-coding-task.js";
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
 * execute; plan and progress reach the user via the
 * `CodingStreamingRegistry` and Telegram delivery, not via the tool result
 * (`DELEGATE_CODING_GUIDANCE` in `tool.ts` tells the model so). Fast tool
 * return, out-of-band execution, results in later turns — the usual shape
 * for long-running agent tools.
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
        return rejected(
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
          return rejected(
            "Skills repo isn't configured yet. Run `cogmo migrate-skills-remote` " +
              "(or re-run `cogmo setup`) to attach a remote and register the row.",
          );
        }
        return rejected(
          `Repo not registered: ${input.repoName}. Use /repo list to see available repos.`,
        );
      }

      const admit = await deps.runInTx((tx) =>
        admitCodingTask(tx, deps.codingStore, {
          repo,
          conversationId,
          goal: input.goal,
          idempotencyKey: input.idempotencyKey,
        }),
      );
      if (admit.kind === "rejected") {
        return rejected(
          `Repo "${repo.name}" already has ${admit.active} active task(s) ` +
            `(limit ${repo.maxConcurrentTasks}). Wait for one to finish or cancel it.`,
        );
      }
      const { task } = admit;
      if (admit.kind === "recovered") {
        log.info(
          { taskId: task.id, priorStatus: task.status, idempotencyKey: input.idempotencyKey },
          "coding task submission recovered — prior attempt already inserted it",
        );
        // Still `queued`: the prior attempt died between the row committing
        // and its send, so nothing is driving this task — re-emit, absorbed
        // by `task-start-<taskId>` at the bus and the claim past it. Any
        // other status is claimed or terminal, and a re-emit could only race
        // a live run.
        if (task.status === "queued") await startCodingTask(deps, task.id);
        return { taskId: task.id, status: "recovered", priorStatus: task.status };
      }

      // Once this lands the service has no further role.
      await startCodingTask(deps, task.id);
      log.info(
        { taskId: task.id, repo: repo.name, conversationId, goal: input.goal },
        "coding task submitted",
      );
      return { taskId: task.id, status: "queued" };
    },
  };
}

function rejected(reason: string): DelegateResult {
  return { taskId: null, status: "rejected", reason };
}
