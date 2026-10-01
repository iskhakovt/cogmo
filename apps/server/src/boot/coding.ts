/**
 * Coding delegation: the progress streams, the per-conversation coding
 * service, and the orchestrator functions registered when a coding-capable
 * sandbox is configured.
 */

import { createAutoRegisterSkillSubscriber } from "../agent/coding/auto-register-skill.js";
import { ClaudeCodeBackend } from "../agent/coding/claude.js";
import { createOrphanRunBranchSweepFunctions } from "../agent/coding/cleanup-orphan-run-branches.js";
import { createRunBranchCleanupSubscriber } from "../agent/coding/cleanup-run-branch.js";
import { findEndedCodingTasks } from "../agent/coding/find-ended-coding-tasks.js";
import {
  createCodingExecuteOrchestrator,
  createCodingOrchestrator,
} from "../agent/coding/orchestrator.js";
import { createCodingTaskReconcile } from "../agent/coding/reconcile-on-failure.js";
import { createCodingService } from "../agent/coding/service.js";
import { CodingStreamingRegistry } from "../agent/coding/streaming-registry.js";
import { createCodingVerifyOrchestrator } from "../agent/coding/verify-orchestrator.js";
import { env } from "../env.js";
import { inngest } from "../inngest/index.js";
import { createSandboxReaper } from "../sandbox/reaper.js";
import type { SkillRunnerImpl } from "../skills/runner.js";
import type { BootstrapOptions, CoreDeps, SandboxDeps } from "./stages.js";

/**
 * Coding-delegation sandboxes (devbase image). 2 cpu / 2 GiB fits
 * `claude` CLI + a TS compile + pnpm install. `disk_bytes` omitted —
 * Daytona's 3 GiB default has headroom over the ~1.5 GiB devbase image.
 */
export const DEFAULT_CODING_RESOURCE_LIMITS = {
  cpus: 2,
  memory_bytes: 2 * 1024 * 1024 * 1024,
  pids: 256,
} as const;

export function createCodingRuntime(
  core: CoreDeps,
  sandbox: SandboxDeps,
  skillRunner: SkillRunnerImpl,
  opts: BootstrapOptions,
) {
  const codingBackend = new ClaudeCodeBackend();
  const codingStreamingRegistry = CodingStreamingRegistry.create({
    endedTasks: (taskIds) =>
      findEndedCodingTasks({ runInTx: core.runInTx, store: core.codingStore }, taskIds),
    sweepIntervalMs: 10 * 60 * 1000,
  });
  const codingServiceFactory = (conversationId: string) =>
    createCodingService(
      {
        runInTx: core.runInTx,
        codingStore: core.codingStore,
        inngest,
        sandboxAvailable: sandbox.codingSandbox !== null,
      },
      conversationId,
    );

  // Register the durable orchestrators only when a coding-capable sandbox
  // is configured. Both sandbox backends qualify — local-docker via
  // host-bind-mount worktrees, Daytona via git-as-transport — and the
  // orchestrators branch on `capabilities.workingTreeTransport`, never on
  // which sandbox provider is behind it.
  // biome-ignore lint/suspicious/noExplicitAny: Inngest function types vary by trigger
  const codingFunctions: any[] = [];
  if (sandbox.codingSandbox) {
    // Every coding function reads tasks and repos, and authenticates to
    // GitHub through the stored identity.
    const repoDeps = {
      runInTx: core.runInTx,
      store: core.codingStore,
      secretsStore: core.secretsStore,
    };
    const octokit = opts.octokitFactory && { octokitFactory: opts.octokitFactory };
    // What every orchestrator that runs a task in a sandbox shares.
    const sandboxTaskDeps = {
      ...repoDeps,
      sandbox: sandbox.codingSandbox,
      devbaseImage: env.COGMO_DEVBASE_IMAGE,
      defaultResourceLimits: DEFAULT_CODING_RESOURCE_LIMITS,
      taskTtlMs: env.CODING_TASK_IDLE_TTL_MINUTES * 60 * 1000,
      askpassBaseDir: env.SANDBOX_ASKPASS_DIR,
      ...(opts.codingAuthOverride && { loadCodingSandboxEnv: opts.codingAuthOverride }),
    };
    // The plan/execute orchestrators use the secrets store's identity to push
    // dirty/unpushed worktrees to `refs/cogmo-wip/<taskId>` on failure
    // (`safeTeardownWorktree`); verify uses it to sign and push.
    const orchestratorDeps = {
      ...sandboxTaskDeps,
      backend: codingBackend,
      worktreesDir: env.COGMO_WORKTREES_DIR,
      openPlanStream: async (taskId: string) => codingStreamingRegistry.planStream(taskId),
      openExecuteStream: async (taskId: string) => codingStreamingRegistry.executeStream(taskId),
    };
    codingFunctions.push(createCodingOrchestrator(orchestratorDeps, inngest));
    codingFunctions.push(createCodingExecuteOrchestrator(orchestratorDeps, inngest));
    codingFunctions.push(
      createCodingVerifyOrchestrator({ ...sandboxTaskDeps, ...octokit }, inngest),
    );

    // Event-driven cleanup of `cogmo/run/*` branches once a task reaches
    // a terminal state (`pr_open` or `failed`). Best-effort — the weekly
    // cron in `cleanup-orphan-run-branches.ts` is the safety net for
    // events that never fired.
    codingFunctions.push(createRunBranchCleanupSubscriber({ ...repoDeps, ...octokit }, inngest));

    // Closes the chat -> register -> invoke loop for skills the agent
    // authors via the coding pipeline. No-op for human-mediated repos.
    codingFunctions.push(
      createAutoRegisterSkillSubscriber(
        {
          ...repoDeps,
          agentStore: core.agentStore,
          skillRunner,
          skillsRepoPath: env.COGMO_SKILLS_PATH,
        },
        inngest,
      ),
    );

    // Weekly orphan-run-branch sweep — safety net for refs the
    // event-driven cleanup missed (host crash before emit, drift,
    // foreign refs). Cron emits one event per repo; the per-repo
    // handler queries origin + DB and force-deletes stale refs.
    codingFunctions.push(...createOrphanRunBranchSweepFunctions(repoDeps, inngest));

    // Subscribes to `inngest/function.failed` and flips any non-terminal
    // `coding_tasks` row whose function id matches a coding orchestrator
    // to `failed`. Covers the worker-disconnect class that the in-worker
    // `try/catch` and per-function `onFailure` both miss — see
    // design/coding-delegation.md → Worker-death reconciliation.
    codingFunctions.push(
      createCodingTaskReconcile({ runInTx: core.runInTx, store: core.codingStore }, inngest),
    );

    // Sandbox reaper — runs every minute, kills TTL-expired containers,
    // discovers orphans tagged with dead instance ids, marks stale DB
    // rows exited. See `src/sandbox/reaper.ts`.
    if (sandbox.sandboxDocker && sandbox.sandboxInstanceId) {
      codingFunctions.push(
        createSandboxReaper(
          {
            docker: sandbox.sandboxDocker,
            store: core.sandboxStore,
            runInTx: core.runInTx,
            instanceId: sandbox.sandboxInstanceId,
          },
          inngest,
        ),
      );
    }
  }

  return { codingStreamingRegistry, codingServiceFactory, codingFunctions };
}
