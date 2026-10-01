/**
 * Wizard step: the skills bare repo's `origin` — published to or adopted
 * from a GitHub remote, or kept as it is.
 */

import * as p from "@clack/prompts";
import { DrizzleCodingStore } from "../../agent/coding/store/index.js";
import { env } from "../../env.js";
import { configureSkillsRemote } from "../../skills/configure-remote.js";
import {
  collectSkillsRemoteMode,
  readLocalMainSha,
  renderConfigureError,
} from "../../skills/configure-remote-prompts.js";
import { bootstrapSkillsRepo, ensureSkillsCodingRepo, readOriginUrl } from "../../skills/repo.js";
import { cancelGuard, WizardCancelled, type WizardDeps } from "./step.js";

export async function stepConfigureSkillsRemote(deps: WizardDeps): Promise<void> {
  const skillsRepoPath = env.COGMO_SKILLS_PATH;

  // Bootstrap the bare repo so we have something to attach `origin` to.
  // Idempotent — no-op when the repo already exists. Under the bootstrap lock,
  // like `cogmo serve`'s: two first-time inits on one path can fail on git's
  // config lock.
  const skillsRepo = await deps.bootstrapLock(() => bootstrapSkillsRepo({ path: skillsRepoPath }));
  if (skillsRepo.initialized) {
    p.log.info(`Initialized bare skills repo at ${skillsRepoPath}`);
  }

  const codingStore = new DrizzleCodingStore();

  // Read local state once. Direction (publish vs. adopt) is determined by
  // this; prompts use it for human-readable text. Industry pattern is
  // one-directional with explicit mode — auto-detect bidirectional transfer
  // surprised operators in the original Option-A design and was rejected
  // in code review.
  const localMainSha = await readLocalMainSha(skillsRepoPath);

  // If origin is already attached, offer keep / replace. Keep just syncs
  // the DB row (no git transfer) so a re-run wizard doesn't accidentally
  // fetch/push and clobber state the operator is happy with.
  const currentOrigin = await readOriginUrl(skillsRepoPath);
  if (currentOrigin) {
    const action = await p.select({
      message: `Skills bare repo's origin is already attached:\n  ${currentOrigin}\nWhat would you like to do?`,
      options: [
        { value: "keep", label: "Keep current origin", hint: "syncs DB row, no git transfer" },
        { value: "replace", label: "Replace with a different URL" },
      ],
    });
    cancelGuard(action);
    if (action === "keep") {
      const ensured = await ensureSkillsCodingRepo(
        { runInTx: deps.runInTx, codingStore },
        { skillsRepoPath },
      );
      p.log.success(`Skills row in sync (${ensured.kind}).`);
      return;
    }
  }

  // Wizard cancel = throw WizardCancelled (caught by runSetup's top-level
  // try/catch for clean exit). T = never, so the return type narrows.
  const mode = await collectSkillsRemoteMode(deps, localMainSha, () => {
    throw new WizardCancelled();
  });
  const result = await configureSkillsRemote(
    { runInTx: deps.runInTx, codingStore, skillsRepoPath },
    mode,
  );
  if (result.isErr()) {
    renderConfigureError(result.error);
    return;
  }
  if (result.value.kind === "skipped") {
    p.log.warn("Skills remote not configured — re-run `cogmo migrate-skills-remote` when ready.");
    return;
  }
  if (result.value.backupPath) {
    p.log.info(`Backed up previous \`coding_repos.skills\` row to ${result.value.backupPath}`);
  }
  const directionVerb = result.value.direction === "publish" ? "published to" : "adopted from";
  p.log.success(`Skills remote ${directionVerb}: ${result.value.remoteUrl}`);
}
