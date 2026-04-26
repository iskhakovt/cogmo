import type { Inngest } from "inngest";
import { codingTaskStart } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type { CodingStore } from "./store/index.js";

const log = logger.child({ component: "coding.service" });

export interface CodingServiceDeps {
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

      const repo = await deps.codingStore.getRepoByName(input.repoName);
      if (!repo) {
        throw new Error(
          `Repo not registered: ${input.repoName}. Use /repo list to see available repos.`,
        );
      }

      // Admission check: cap concurrent tasks per repo. Slice 1 skipped
      // this because the inline orchestrator ran synchronously inside the
      // turn, so the LLM couldn't fan out parallel calls within one turn.
      // Slice 2's async submit + durable orchestrator means multiple
      // conversations (or repeated taps from the same one) could each
      // trigger a task concurrently — guard before INSERT to avoid
      // contended worktrees on the same repo.
      const active = await deps.codingStore.countActiveTasksForRepo(repo.id);
      if (active >= repo.maxConcurrentTasks) {
        return {
          taskId: null,
          status: "rejected",
          reason:
            `Repo "${repo.name}" already has ${active} active task(s) ` +
            `(limit ${repo.maxConcurrentTasks}). Wait for one to finish or cancel it.`,
        };
      }

      // Insert in `queued` status. Worktree assignment, container id,
      // session id, etc. all stay null — the orchestrator's steps fill
      // them in.
      const task = await deps.codingStore.insertTask({
        repoId: repo.id,
        conversationId,
        goal: input.goal,
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });

      // Hand off to the durable orchestrator. Once this event lands the
      // service has no further role — plan rendering, approval, execute,
      // and progress all happen out-of-band.
      await deps.inngest.send({
        name: codingTaskStart.name,
        data: { taskId: task.id },
      });

      log.info(
        { taskId: task.id, repo: repo.name, conversationId, goal: input.goal },
        "coding task submitted",
      );

      return { taskId: task.id, status: "queued" };
    },
  };
}
