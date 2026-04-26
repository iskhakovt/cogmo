import { logger } from "../../logger.js";
import type { Sandbox } from "../../sandbox/index.js";
import type { ResourceLimits } from "../../sandbox/types.js";
import type { CodingBackend } from "./backend.js";
import { runCodingTask, type StepRun } from "./orchestrator.js";
import type { CodingStore } from "./store/index.js";

const log = logger.child({ component: "coding.service" });

export interface CodingServiceDeps {
  codingStore: CodingStore;
  /** Slice 1: nullable — when SANDBOX_RUNTIME is unset the sandbox module isn't initialized. */
  sandbox: Sandbox | null;
  backend: CodingBackend;
  devbaseImage: string;
  defaultResourceLimits: ResourceLimits;
  taskTtlMs: number;
  worktreesDir: string;
}

export interface DelegateInput {
  goal: string;
  repoName: string;
}

export interface DelegateResult {
  taskId: string;
  status: "awaiting_approval" | "executing" | "failed";
  plan?: string;
  failureReason?: string;
}

/**
 * Coding namespace on the per-turn `Service`. Slice 1 ships only `delegate`
 * — runs the full plan-only flow inline (no Inngest function) and returns
 * the result to the caller. The agent tool surfaces this to the LLM.
 *
 * Slice 2+ wires the same logic into a durable Inngest function so plan
 * approval can park the task across sessions; the inline path may stay as
 * a fallback or shrink to a thin "submit" call.
 */
export interface CodingService {
  delegate(input: DelegateInput): Promise<DelegateResult>;
}

/**
 * Build a `CodingService` scoped to a conversation. The orchestrator's
 * `stepRun` dependency is satisfied with an inline shim (slice 1 runs
 * synchronously inside the agent tool's invocation; durable steps land in
 * slice 2).
 */
export function createCodingService(
  deps: CodingServiceDeps,
  conversationId: string,
): CodingService {
  return {
    async delegate(input: DelegateInput): Promise<DelegateResult> {
      if (!deps.sandbox) {
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

      // Insert a fresh task in `queued` status. Branch + worktree path
      // (jointly: `worktreeAssignment`) are null on insert — derived and
      // persisted by the orchestrator's `allocate-worktree` step. Keeps the
      // codebase's "DB always generates ids" invariant intact.
      const task = await deps.codingStore.insertTask({
        repoId: repo.id,
        conversationId,
        goal: input.goal,
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });

      // Slice 1: run the orchestrator inline. `stepRun` becomes a pass-through
      // that just invokes the body. Slice 2 swaps this for the durable
      // Inngest function so plan approval can park across sessions.
      const inlineStepRun: StepRun = ((_id: string, fn: () => Promise<unknown>) =>
        fn()) as unknown as StepRun;

      log.info({ taskId: task.id, repo: repo.name, goal: input.goal }, "coding task delegated");

      const result = await runCodingTask({
        taskId: task.id,
        deps: {
          store: deps.codingStore,
          sandbox: deps.sandbox,
          backend: deps.backend,
          devbaseImage: deps.devbaseImage,
          defaultResourceLimits: deps.defaultResourceLimits,
          taskTtlMs: deps.taskTtlMs,
          worktreesDir: deps.worktreesDir,
        },
        stepRun: inlineStepRun,
      });

      const out: DelegateResult = { taskId: task.id, status: result.status };
      if (result.plan !== undefined) out.plan = result.plan;
      if (result.failureReason !== undefined) out.failureReason = result.failureReason;
      return out;
    },
  };
}
