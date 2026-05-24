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
  const task = await deps.runInTx((tx) => deps.store.getTask(tx, args.taskId));
  if (!task) return { kind: "skipped", reason: "task row not found" };

  const repo = await deps.runInTx((tx) => deps.store.getRepoById(tx, task.repoId));
  if (!repo) return { kind: "skipped", reason: "repo row not found" };

  if (repo.name !== SKILLS_CODING_REPO_NAME) {
    return { kind: "skipped", reason: `not the skills repo (name=${repo.name})` };
  }

  const identityResult = await deps.runInTx((tx) =>
    resolveGitHubIdentity(tx, deps.secretsStore, repo.identityName),
  );
  if (identityResult.isErr()) {
    return { kind: "skipped", reason: describeResolveIdentityError(identityResult.error) };
  }
  const identity = identityResult.value;

  if (!task.worktreeAssignment) {
    return { kind: "skipped", reason: "worktree_assignment is null (task never started)" };
  }
  const branch = task.worktreeAssignment.branch;
  // Address the remote by URL not by name — symmetric with
  // `pushTaskBranchToRemote` in git-as-transport.ts, and decoupled from
  // whatever local remote name the bare repo happens to use.
  await withGitAskpass(identity.pat, async (env) => {
    await execFileP(
      "git",
      ["-C", deps.skillsRepoPath, "fetch", repo.remoteUrl, `+${branch}:${branch}`],
      { env: { ...process.env, ...env } },
    );
  });

  // Wall-clock cap on the register call. The lockfile-compile sandbox
  // has its own 60s + 30s expiresAt cap inside `makeSandboxLockfileCompiler`,
  // but the PTY-based wait() doesn't always detect sandbox death
  // cleanly — without this wrapper, a hung compile leaves the Inngest
  // function in-flight indefinitely and blocks graceful shutdown.
  const REGISTER_TIMEOUT_MS = 180_000;
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
    log.warn(
      {
        taskId: args.taskId,
        branch,
        status: result.status,
        name: result.name,
        ...(result.errors && result.errors.length > 0 && { errors: result.errors }),
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
      // Same retries:0 reasoning as the orchestrators: register's lockfile-
      // compile sandbox isn't idempotent under retry, and a transient
      // failure should surface as a failed registration the operator sees,
      // not a multi-minute retry storm. Re-author via chat to retry.
      retries: 0,
      triggers: [codingTaskPrOpened],
    },
    async ({ event, step }) => {
      const taskId = event.data.taskId;
      return await step.run("auto-register-skill", () => autoRegisterSkill(deps, { taskId }));
    },
  );
}
