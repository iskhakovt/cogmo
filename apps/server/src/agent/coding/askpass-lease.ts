/**
 * The run-scoped lifetime of a task's host-side askpass directory, which
 * holds the PAT in plaintext and the SSH signing key.
 */

import { type AskpassMaterials, cleanupAskpass, provisionAskpass } from "../../sandbox/askpass.js";
import type { GitHubIdentity } from "../../secrets/github.js";
import type { CodingRun } from "./coding-run.js";

/**
 * Askpass material this run may have written to the host. An orchestrator
 * releases it in its `finally`: every exit, early returns included. Safe
 * there because a step boundary abandons the function rather than unwinding
 * it (see .claude/rules/inngest.md), so the release runs once, at the end of
 * the run. `sandbox.deleteByTaskId` does not cover it: Local-Docker's
 * supervisor wipes the bind-mount source as a side effect, but a managed
 * backend clears only its own sandbox-side copy.
 */
export class AskpassLease {
  readonly #baseDir: string;
  readonly #taskId: string;
  #provisioned = false;

  constructor(baseDir: string, taskId: string) {
    this.#baseDir = baseDir;
    this.#taskId = taskId;
  }

  /**
   * The `provision-askpass` step. Marks the lease before the body runs, so
   * a partial provision (the mkdir landed, a write threw) is still released.
   */
  async provision(run: CodingRun, identity: GitHubIdentity): Promise<AskpassMaterials> {
    this.#provisioned = true;
    return run.stepRun("provision-askpass", async () =>
      provisionAskpass({ baseDir: this.#baseDir, rootTaskId: this.#taskId, identity }),
    );
  }

  /** Idempotent and tolerant of a missing or partial dir. */
  release(): void {
    if (this.#provisioned) {
      cleanupAskpass({ baseDir: this.#baseDir, rootTaskId: this.#taskId });
    }
  }
}
