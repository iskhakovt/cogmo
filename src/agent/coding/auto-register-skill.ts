/**
 * Closes the chat -> delegate -> register -> invoke loop on the cogmo-skills
 * bare repo. Subscribes to `coding/task/pr-opened`; for tasks whose target
 * is the well-known skills repo, fetches the PR's head branch from origin
 * into the local bare repo and calls `runner.register({ branch })`.
 *
 * Fetch target is the PR head branch (`cogmo/<idShort>`), not the
 * `cogmo/run/<task-id>` run-branch — the run-branch is cleaned up on the
 * same event by `createRunBranchCleanupSubscriber` and the race almost
 * always goes to cleanup (one HTTP delete vs a git fetch).
 *
 * For human-mediated repos this is a no-op — they get the standard
 * "review + merge on GitHub" gate, no auto-register. The user's chat
 * request IS the gate for the skills-authoring flow; the PR exists as
 * provenance, not as an approval step.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Inngest } from "inngest";
import type { Transactor } from "../../db/index.js";
import { codingTaskPrOpened } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import { withGitAskpass } from "../../secrets/git-askpass.js";
import { describeResolveIdentityError, resolveGitHubIdentity } from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { SKILLS_CODING_REPO_NAME } from "../../skills/repo.js";
import type { RegisterResult, SkillRunner } from "../../skills/runner.js";
import type { CodingStore } from "./store/index.js";

const execFileP = promisify(execFile);
const log = logger.child({ component: "coding.auto-register-skill" });

export interface AutoRegisterSkillDeps {
  runInTx: Transactor;
  store: CodingStore;
  secretsStore: SecretsStore;
  skillRunner: SkillRunner;
  /**
   * Bare repo path for the skills library. Production passes
   * `env.COGMO_SKILLS_PATH`; tests inject a tmpdir.
   */
  skillsRepoPath: string;
}

export type AutoRegisterResult =
  | { kind: "skipped"; reason: string }
  | { kind: "registered"; branch: string; result: RegisterResult };

export async function autoRegisterSkill(
  deps: AutoRegisterSkillDeps,
  args: { taskId: string },
): Promise<AutoRegisterResult> {
  // One tx for (task, repo, identity) — atomic snapshot, one round-trip.
  const snapshot = await deps.runInTx(async (tx) => {
    const task = await deps.store.getTask(tx, args.taskId);
    if (!task) return { kind: "skipped" as const, reason: "task row not found" };
    const repo = await deps.store.getRepoById(tx, task.repoId);
    if (!repo) return { kind: "skipped" as const, reason: "repo row not found" };
    if (repo.name !== SKILLS_CODING_REPO_NAME) {
      return { kind: "skipped" as const, reason: `not the skills repo (name=${repo.name})` };
    }
    if (!task.worktreeAssignment) {
      return {
        kind: "skipped" as const,
        reason: "worktree_assignment is null (task never started)",
      };
    }
    const identityResult = await resolveGitHubIdentity(tx, deps.secretsStore, repo.identityName);
    if (identityResult.isErr()) {
      return {
        kind: "skipped" as const,
        reason: describeResolveIdentityError(identityResult.error),
      };
    }
    return {
      kind: "ok" as const,
      repo,
      identity: identityResult.value,
      branch: task.worktreeAssignment.branch,
    };
  });
  if (snapshot.kind === "skipped") return snapshot;
  const { repo, identity, branch } = snapshot;
  // Refuse anything outside the orchestrator's per-task namespace —
  // `git fetch +<branch>:<branch>` against `main` would clobber the bare repo's main.
  if (!branch.startsWith("cogmo/") || branch === "cogmo/" || branch.includes("..")) {
    return { kind: "skipped", reason: `unsafe branch name: ${branch}` };
  }
  // Address remote by URL, not name — see pushTaskBranchToRemote.
  await withGitAskpass(identity.pat, async (env) => {
    await execFileP(
      "git",
      ["-C", deps.skillsRepoPath, "fetch", repo.remoteUrl, `+${branch}:${branch}`],
      { env: { ...process.env, ...env } },
    );
  });

  // KNOWN LEAK: register() has no AbortSignal — underlying call keeps running past this cap. See AbortSignal-threading p3 in todo.md.
  // Budget covers the compile sandbox's `DEFAULT_COMPILE_TIMEOUT_MS` (240s) plus boot + classifier overhead.
  const REGISTER_TIMEOUT_MS = 300_000;
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      deps.skillRunner.register({ branch }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`register exceeded ${REGISTER_TIMEOUT_MS}ms wall-clock cap`)),
          REGISTER_TIMEOUT_MS,
        );
      }),
    ]);
    const hasErrors = result.errors && result.errors.length > 0;
    const logLevel = result.status === "live" && !hasErrors ? "info" : "warn";
    log[logLevel](
      {
        taskId: args.taskId,
        branch,
        status: result.status,
        name: result.name,
        ...(hasErrors && { errors: result.errors }),
      },
      "auto-register fired",
    );
    return { kind: "registered", branch, result };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export function createAutoRegisterSkillSubscriber(deps: AutoRegisterSkillDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "coding-auto-register-skill",
      idempotency: "event.data.taskId",
      // register isn't idempotent under retry — re-author via chat instead.
      retries: 0,
      triggers: [codingTaskPrOpened],
    },
    async ({ event, step }) => {
      const taskId = event.data.taskId;
      return await step.run("auto-register-skill", () => autoRegisterSkill(deps, { taskId }));
    },
  );
}
