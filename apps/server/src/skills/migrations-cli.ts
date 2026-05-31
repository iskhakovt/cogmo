/**
 * Standalone CLI handler for `cogmo migrate-skills-remote` — interactive
 * one-shot configuration of the skills bare repo's `origin` and the
 * corresponding `coding_repos.skills.remote_url`.
 *
 * Same three-way UX (own / auto-provision / skip) the wizard exposes at
 * setup time, reachable without running through every wizard step. Used in
 * two scenarios:
 *
 *   1. **Migration** — existing deployments with `remote_url=''` from a
 *      pre-fix boot. Backs up the current row, prompts the operator, and
 *      records the chosen URL.
 *   2. **Reconfiguration** — operator wants to swap the skills remote
 *      post-setup (e.g. GitHub → self-hosted Gitea). Same code path.
 *
 * Backup before mutate: dumps the current row to
 * `.dev/skills-backups/<timestamp>.json` (matches the convention in
 * `src/agent/evolution/migrations-cli.ts`).
 *
 * Interactive-only in v1. Future scripted use (CI provisioning) would add
 * `--mode=own --url=...` flags; the underlying `configureSkillsRemote`
 * helper already supports both modes programmatically.
 */

import * as p from "@clack/prompts";
import type { CodingStore } from "../agent/coding/store/index.js";
import type { Transactor } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { configureSkillsRemote } from "./configure-remote.js";
import {
  collectSkillsRemoteMode,
  readLocalMainSha,
  renderConfigureError,
} from "./configure-remote-prompts.js";
import { bootstrapSkillsRepo, readOriginUrl, SKILLS_CODING_REPO_NAME } from "./repo.js";

export interface MigrateSkillsRemoteCliDeps {
  runInTx: Transactor;
  codingStore: CodingStore;
  secretsStore: SecretsStore;
  /** Bare-repo path — usually `env.COGMO_SKILLS_PATH`. */
  skillsRepoPath: string;
}

/**
 * `cogmo migrate-skills-remote` entry point. Returns a process exit code:
 *
 *   - `0` — configured successfully OR operator explicitly skipped
 *   - `1` — error (URL invalid, remote unreachable, auto-provision failed)
 *   - `130` — operator cancelled (Ctrl-C / Esc on a prompt; standard SIGINT exit code)
 */
export async function runMigrateSkillsRemoteCli(
  args: ReadonlyArray<string>,
  deps: MigrateSkillsRemoteCliDeps,
): Promise<number> {
  if (args.length > 0) {
    console.error("Usage: cogmo migrate-skills-remote (interactive)");
    return 1;
  }

  p.intro("Cogmo: configure skills repo remote");

  // Bootstrap the bare repo so the helper has somewhere to attach origin.
  // Idempotent — no-op when the repo already exists.
  await bootstrapSkillsRepo({ path: deps.skillsRepoPath });

  // Probe and report current state. `localMainSha` drives the
  // adopt-vs-publish direction in `collectMode` — operators see prompts
  // tailored to whether their bare repo is empty or has commits.
  const currentOrigin = await readOriginUrl(deps.skillsRepoPath);
  const localMainSha = await readLocalMainSha(deps.skillsRepoPath);
  const existingRow = await deps.runInTx((tx) =>
    deps.codingStore.getRepoByName(tx, SKILLS_CODING_REPO_NAME),
  );

  p.note(
    [
      `Bare repo:   ${deps.skillsRepoPath}`,
      `  origin:    ${currentOrigin ?? "(unset)"}`,
      `  main:      ${localMainSha ? `${localMainSha.slice(0, 7)} (populated)` : "(unborn)"}`,
      `DB row:      ${existingRow ? `present (remote_url: ${existingRow.remoteUrl || "(empty)"})` : "(missing)"}`,
    ].join("\n"),
    "Current state",
  );

  // CLI cancel = sentinel return → exit code 130 (SIGINT convention).
  // T = "cancelled", so the union narrows on the check below.
  const mode = await collectSkillsRemoteMode(deps, localMainSha, () => "cancelled" as const);
  if (mode === "cancelled") {
    p.outro("Cancelled.");
    return 130;
  }

  // `configureSkillsRemote` writes the backup itself (and returns the
  // path on success) so wizard and CLI share one backup-before-mutate
  // path. The CLI surfaces the path here for the operator's audit trail.
  const result = await configureSkillsRemote(deps, mode);

  if (result.isErr()) {
    renderConfigureError(result.error);
    p.outro("Migration aborted — re-run when ready.");
    return 1;
  }

  if (result.value.kind === "skipped") {
    p.outro("Skipped — re-run `cogmo migrate-skills-remote` when ready.");
    return 0;
  }

  if (result.value.backupPath) {
    p.log.info(`Backed up previous \`coding_repos.skills\` row to ${result.value.backupPath}`);
  }
  const directionVerb = result.value.direction === "publish" ? "published to" : "adopted from";
  p.outro(
    `Skills remote ${directionVerb}: ${result.value.remoteUrl}\n` +
      `  origin: ${result.value.originAction}; DB row: ${result.value.ensured.kind}`,
  );
  return 0;
}
