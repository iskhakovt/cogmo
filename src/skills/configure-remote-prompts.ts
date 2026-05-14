/**
 * @clack/prompts UX shared between `src/setup/wizard.ts:stepConfigureSkillsRemote`
 * and `src/skills/migrations-cli.ts:runMigrateSkillsRemoteCli`. Splits the
 * prompt construction + error rendering out of both callers so a new
 * `ConfigureSkillsRemoteError` variant or a re-worded prompt updates
 * exactly one place.
 *
 * Cancel handling is parameterised, not coupled to either caller. The
 * wizard wants `p.isCancel(value)` to throw a `WizardCancelled` so its
 * top-level catch can exit cleanly; the CLI wants a sentinel return so
 * its handler can `return 130` for the SIGINT exit code. `collectMode`'s
 * `onCancel` callback handles both — wizard passes `() => { throw new
 * WizardCancelled() }` (TS infers `T = never`); CLI passes `() =>
 * "cancelled" as const`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import type { Transactor } from "../db/index.js";
import {
  DEFAULT_GITHUB_IDENTITY_NAME,
  type GitHubIdentitySecretsLookup,
  resolveGitHubIdentity,
} from "../secrets/github.js";
import type { ConfigureSkillsRemoteError, ConfigureSkillsRemoteMode } from "./configure-remote.js";

const execFileP = promisify(execFile);

/** Subset of wizard/CLI deps that `collectSkillsRemoteMode` actually needs.
 * Both `WizardDeps` and `MigrateSkillsRemoteCliDeps` satisfy this via
 * structural typing — no shared interface declaration required. */
export interface CollectSkillsRemoteModeDeps {
  runInTx: Transactor;
  secretsStore: GitHubIdentitySecretsLookup;
}

/**
 * Prompt for own / auto-provision / skip. Prompt text and `own`'s
 * `direction` follow `localMainSha`: null → adopt-flavored (fetch from
 * a populated remote), non-null → publish-flavored (push to a fresh
 * remote). On `p.isCancel`, returns whatever `onCancel()` returns —
 * letting wizard throw vs. CLI sentinel-return without entangling them.
 */
export async function collectSkillsRemoteMode<T>(
  deps: CollectSkillsRemoteModeDeps,
  localMainSha: string | null,
  onCancel: () => T,
): Promise<ConfigureSkillsRemoteMode | T> {
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
  options.push({
    value: "skip",
    label: "Skip — configure later via `cogmo migrate-skills-remote`",
  });

  const choice = await p.select({ message: promptMessage, options });
  if (p.isCancel(choice)) return onCancel();

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
    if (p.isCancel(url)) return onCancel();
    const ownMode: ConfigureSkillsRemoteMode = {
      kind: "own",
      direction,
      remoteUrl: url.trim(),
    };
    if (identity.isOk()) ownMode.identity = identity.value;
    return ownMode;
  }

  // auto-provision — gated above on hasGitHubIdentity so identity.isOk() here.
  // Defensive: if for some reason identity resolution fell through, treat as
  // cancel rather than constructing an invalid mode.
  if (!identity.isOk()) return onCancel();
  return { kind: "auto-provision", identity: identity.value };
}

/** Format a `ConfigureSkillsRemoteError` as operator-readable @clack/prompts
 * output. Exhaustive over the error variants so a new variant added to
 * `configure-remote.ts` won't silently render as nothing — TypeScript flags
 * the missing case via the `never` assignment in `default`. */
export function renderConfigureError(error: ConfigureSkillsRemoteError): void {
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
    case "origin_attach_failed":
      p.log.error(
        `Transfer succeeded but \`git remote add\` failed: ${error.reason}. ` +
          `The bare repo at $COGMO_SKILLS_PATH may be missing the \`origin\` config; ` +
          `re-run \`cogmo migrate-skills-remote\` to retry.`,
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
    default: {
      // Exhaustiveness: TS errors here if a new variant lands without a case.
      const _exhaustive: never = error;
      throw new Error(
        `unhandled ConfigureSkillsRemoteError variant: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
  p.log.warn("Re-run `cogmo setup` or `cogmo migrate-skills-remote` to retry.");
}

/** Read local `refs/heads/main` sha — returns null when main is unborn
 * (fresh `git init --bare` state). Used by `stepConfigureSkillsRemote`
 * and `runMigrateSkillsRemoteCli` to pick the adopt-vs-publish direction
 * without inferring inside `configureSkillsRemote`. */
export async function readLocalMainSha(repoPath: string): Promise<string | null> {
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
