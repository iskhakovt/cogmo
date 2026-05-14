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
import { mkdirSync, writeFileSync } from "node:fs";
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
import { bootstrapSkillsRepo, SKILLS_CODING_REPO_NAME } from "./repo.js";

const execFileP = promisify(execFile);

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

  // Probe and report current state — operators benefit from seeing what
  // they're about to change before they pick a mode.
  const currentOrigin = await readOriginUrl(deps.skillsRepoPath);
  const existingRow = await deps.runInTx((tx) =>
    deps.codingStore.getRepoByName(tx, SKILLS_CODING_REPO_NAME),
  );

  p.note(
    [
      `Bare repo:   ${deps.skillsRepoPath}`,
      `  origin:    ${currentOrigin ?? "(unset)"}`,
      `DB row:      ${existingRow ? `present (remote_url: ${existingRow.remoteUrl || "(empty)"})` : "(missing)"}`,
    ].join("\n"),
    "Current state",
  );

  // Backup before mutate. Only meaningful when a row exists — a missing
  // row is the "fresh install" case with nothing to restore.
  if (existingRow) {
    const backupPath = makeBackupPath();
    writeFileSync(backupPath, JSON.stringify(existingRow, null, 2));
    p.log.info(`Backed up current row to ${backupPath}`);
  }

  const mode = await collectMode(deps);
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

  p.outro(
    `Skills remote configured: ${result.value.remoteUrl}\n` +
      `  origin: ${result.value.originAction}; DB row: ${result.value.ensured.kind}`,
  );
  return 0;
}

/**
 * Prompt for own / auto-provision / skip. Returns `"cancelled"` when the
 * operator hits Ctrl-C / Esc — caller maps that to exit code 130.
 *
 * Inline duplicate of the wizard's `collectSkillsRemoteMode` rather than a
 * shared helper: only two callers, the @clack/prompts integration is the
 * bulk of the code, and the cancel-handling shape differs between wizard
 * (throws `WizardCancelled`) and CLI (returns sentinel). Extracting would
 * cost more in indirection than it saves.
 */
async function collectMode(
  deps: MigrateSkillsRemoteCliDeps,
): Promise<ConfigureSkillsRemoteMode | "cancelled"> {
  const identity = await deps.runInTx((tx) =>
    resolveGitHubIdentity(tx, deps.secretsStore, DEFAULT_GITHUB_IDENTITY_NAME),
  );
  const hasGitHubIdentity = identity.isOk();

  const options: { value: "own" | "auto-provision" | "skip"; label: string; hint?: string }[] = [
    { value: "own", label: "Use my own remote", hint: "paste a pre-created URL" },
  ];
  if (hasGitHubIdentity) {
    options.push({
      value: "auto-provision",
      label: "Auto-provision on GitHub",
      hint: "create private `cogmo-skills` repo using configured PAT",
    });
  }
  options.push({
    value: "skip",
    label: "Skip — keep current state",
  });

  const choice = await p.select({
    message: "How should the skills repo's remote be configured?",
    options,
  });
  if (p.isCancel(choice)) return "cancelled";

  if (choice === "skip") return { kind: "skip" };

  if (choice === "own") {
    const url = await p.text({
      message: "Paste the remote URL (https://… or git@host:…):",
      placeholder: "git@github.com:you/cogmo-skills.git",
      validate: (v) => {
        if (!v || v.trim().length === 0) return "URL is required";
        return undefined;
      },
    });
    if (p.isCancel(url)) return "cancelled";
    const ownMode: ConfigureSkillsRemoteMode = { kind: "own", remoteUrl: url.trim() };
    if (identity.isOk()) ownMode.identity = identity.value;
    return ownMode;
  }

  // auto-provision — gated above on hasGitHubIdentity so identity is ok here.
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
        `Remote has no \`refs/heads/main\` to fetch. Initialize the remote first ` +
          `(GitHub: \`gh repo create --add-readme\`; Gitea/Forgejo: tick "Initialize Repository") and retry.`,
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
          `Re-run and pick "Use my own remote" pointing at the existing repo.`,
      );
      break;
  }
}

/** Read `origin` URL from the bare repo — returns null if unset. */
async function readOriginUrl(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", repoPath, "remote", "get-url", "origin"]);
    return stdout.trim();
  } catch (e) {
    if ((e as { code?: number }).code === 2) return null;
    throw e;
  }
}

function makeBackupPath(): string {
  mkdirSync(BACKUP_DIR, { recursive: true });
  return join(BACKUP_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
}
