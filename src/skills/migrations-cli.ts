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

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import type { CodingStore } from "../agent/coding/store/index.js";
import type { Transactor } from "../db/index.js";
import { DEFAULT_GITHUB_IDENTITY_NAME, resolveGitHubIdentity } from "../secrets/github.js";
import type { SecretsStore } from "../secrets/store/index.js";
import {
  type ConfigureSkillsRemoteError,
  type ConfigureSkillsRemoteMode,
  configureSkillsRemote,
} from "./configure-remote.js";
import { bootstrapSkillsRepo, readOriginUrl, SKILLS_CODING_REPO_NAME } from "./repo.js";

const BACKUP_DIR = ".dev/skills-backups";

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

  // Backup before mutate. Only meaningful when a row exists — a missing
  // row is the "fresh install" case with nothing to restore.
  if (existingRow) {
    const backupPath = await makeBackupPath();
    await writeFile(backupPath, JSON.stringify(existingRow, null, 2));
    p.log.info(`Backed up current row to ${backupPath}`);
  }

  const mode = await collectMode(deps, localMainSha);
  if (mode === "cancelled") {
    p.outro("Cancelled.");
    return 130;
  }

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

  const directionVerb = result.value.direction === "publish" ? "published to" : "adopted from";
  p.outro(
    `Skills remote ${directionVerb}: ${result.value.remoteUrl}\n` +
      `  origin: ${result.value.originAction}; DB row: ${result.value.ensured.kind}`,
  );
  return 0;
}

/**
 * Prompt for own / auto-provision / skip. Returns `"cancelled"` when the
 * operator hits Ctrl-C / Esc — caller maps that to exit code 130.
 *
 * Prompt text and `own`'s `direction` follow local state (the
 * `localMainSha` argument). Inline duplicate of the wizard's
 * `collectSkillsRemoteMode` rather than a shared helper: only two
 * callers, the @clack/prompts integration is the bulk of the code, and
 * the cancel-handling shape differs (wizard throws `WizardCancelled`;
 * CLI returns sentinel).
 */
async function collectMode(
  deps: MigrateSkillsRemoteCliDeps,
  localMainSha: string | null,
): Promise<ConfigureSkillsRemoteMode | "cancelled"> {
  const identity = await deps.runInTx((tx) =>
    resolveGitHubIdentity(tx, deps.secretsStore, DEFAULT_GITHUB_IDENTITY_NAME),
  );
  const hasGitHubIdentity = identity.isOk();
  const direction: "adopt" | "publish" = localMainSha === null ? "adopt" : "publish";

  const promptMessage =
    direction === "adopt"
      ? "Skills bare repo is empty. How should it be configured?"
      : "Skills bare repo has commits already. How should the remote be configured?";

  const ownLabel = direction === "adopt" ? "Adopt an existing remote" : "Publish to a fresh remote";
  const ownHint =
    direction === "adopt"
      ? "paste URL of a pre-populated repo; Cogmo fetches main"
      : "paste URL of an empty repo; Cogmo pushes main";
  const autoHint =
    direction === "adopt"
      ? "Cogmo creates a private `cogmo-skills` repo with a README seed"
      : "Cogmo creates an empty private `cogmo-skills` repo and pushes your skills";

  const options: { value: "own" | "auto-provision" | "skip"; label: string; hint?: string }[] = [
    { value: "own", label: ownLabel, hint: ownHint },
  ];
  if (hasGitHubIdentity) {
    options.push({ value: "auto-provision", label: "Auto-provision on GitHub", hint: autoHint });
  }
  options.push({ value: "skip", label: "Skip — keep current state" });

  const choice = await p.select({ message: promptMessage, options });
  if (p.isCancel(choice)) return "cancelled";

  if (choice === "skip") return { kind: "skip" };

  if (choice === "own") {
    const url = await p.text({
      message:
        direction === "adopt"
          ? "Paste the URL of the remote to adopt (https://… or git@host:…):"
          : "Paste the URL of an empty remote to publish to (https://… or git@host:…):",
      placeholder: "git@github.com:you/cogmo-skills.git",
      validate: (v) => {
        if (!v || v.trim().length === 0) return "URL is required";
        return undefined;
      },
    });
    if (p.isCancel(url)) return "cancelled";
    const ownMode: ConfigureSkillsRemoteMode = {
      kind: "own",
      direction,
      remoteUrl: url.trim(),
    };
    if (identity.isOk()) ownMode.identity = identity.value;
    return ownMode;
  }

  // auto-provision — gated above on hasGitHubIdentity so identity.isOk() here.
  if (!identity.isOk()) return "cancelled";
  return { kind: "auto-provision", identity: identity.value };
}

/** Format a `configureSkillsRemote` error as operator-readable CLI output.
 * Mirrors the wizard's renderer one-for-one — kept inline for the same
 * reason as `collectMode`. */
function renderConfigureError(error: ConfigureSkillsRemoteError): void {
  switch (error.kind) {
    case "url_invalid":
      p.log.error(`Invalid URL: ${error.reason}`);
      break;
    case "remote_unreachable":
      p.log.error(`Remote unreachable: ${error.reason}`);
      p.log.info(
        "Check the URL, credentials, and network. For HTTPS URLs, the GitHub identity's PAT must have access.",
      );
      break;
    case "remote_empty":
      p.log.error(
        `Remote has no \`refs/heads/main\` to adopt. Pick "Publish to a fresh remote" instead, ` +
          `or initialize the remote first (GitHub: \`gh repo create --add-readme\`).`,
      );
      break;
    case "local_empty":
      p.log.error(
        'Local skills bare repo has no commits to publish. Pick "Adopt an existing remote" instead.',
      );
      break;
    case "remote_diverged":
      p.log.error(
        `Adopt would orphan local commits. Local main is ${error.localSha.slice(0, 7)}; ` +
          `remote main is ${error.remoteSha.slice(0, 7)} and isn't a descendant. ` +
          `Resolve outside the helper: push local first (\`git push origin main\` from $COGMO_SKILLS_PATH) ` +
          `or delete local main intentionally (\`git update-ref -d refs/heads/main\`) and re-run.`,
      );
      break;
    case "local_diverged":
      p.log.error(
        `Publish would orphan remote commits. Local main is ${error.localSha.slice(0, 7)}; ` +
          `remote main is ${error.remoteSha.slice(0, 7)} and isn't an ancestor. ` +
          `Resolve outside the helper: fetch remote first (\`git fetch origin main\` from $COGMO_SKILLS_PATH), ` +
          `merge or rebase, then re-run.`,
      );
      break;
    case "auto_provision_failed":
      p.log.error(
        `Auto-provision failed${error.status ? ` (HTTP ${error.status})` : ""}: ${error.reason}`,
      );
      break;
    case "auto_provision_repo_exists":
      p.log.error(
        `\`${error.repoName}\` already exists on the configured GitHub account. ` +
          `Re-run and pick "Adopt an existing remote" pointing at the existing repo.`,
      );
      break;
  }
}

async function makeBackupPath(): Promise<string> {
  await mkdir(BACKUP_DIR, { recursive: true });
  return join(BACKUP_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
}

const execFileP = promisify(execFile);

/** Read local `refs/heads/main` sha — returns null when main is unborn.
 * Used to pick adopt-vs-publish direction in `collectMode`. */
async function readLocalMainSha(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", [
      "-C",
      repoPath,
      "rev-parse",
      "--verify",
      "refs/heads/main",
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}
