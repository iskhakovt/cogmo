import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { CodingStore } from "../../agent/coding/store/index.js";
import type { Transactor } from "../../db/index.js";
import { runGit, withGitAskpass } from "../../secrets/git-askpass.js";
import {
  DEFAULT_GITHUB_IDENTITY_NAME,
  describeResolveIdentityError,
  resolveGitHubIdentity,
} from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { TransportError } from "../transport-error.js";

/** Summary fields exposed to channel adapters for `/repo list`. */
export interface RepoSummary {
  id: string;
  name: string;
  localPath: string;
  defaultBranch: string;
  remoteUrl: string;
  verifyCommand: string;
}

/**
 * Input for `repos.add` — register a pre-existing local clone. Used by the
 * positional `/repo add <name> <path> <url>` scripting form.
 */
export interface RepoInput {
  name: string;
  localPath: string;
  remoteUrl: string;
  /** Optional override; defaults to "main" when omitted. */
  defaultBranch?: string;
  /**
   * Optional override; defaults to `"true"` (no-op) so slice-1 plan-only
   * tasks have something to record. Slice 4's verify+push step needs a real
   * value and the user can update via `/repo edit` (later) or SQL meanwhile.
   */
  verifyCommand?: string;
  /** Optional override; defaults to `'default'` (the wizard-provisioned bot). */
  identityName?: string;
}

/**
 * Input for `repos.cloneAndAdd` — clone the remote, then register. Used by
 * the slice 4.0c FSM dialog. `localPath` is derived from `${reposDir}/${name}`
 * inside the implementation; the caller doesn't choose it.
 */
export interface RepoCloneAndAddInput {
  name: string;
  remoteUrl: string;
  /** Optional override; defaults to "main" when omitted. */
  defaultBranch?: string;
  /** Optional override; defaults to `"true"` until `/repo edit` ships. */
  verifyCommand?: string;
  /** Optional override; defaults to `'default'` (the wizard-provisioned bot). */
  identityName?: string;
}

/**
 * Coding-repo registry. Returns `sandbox_disabled` when the sandbox module
 * isn't initialized (no `SANDBOX_RUNTIME` env).
 */
export interface ReposNamespace {
  list(): Promise<Result<ReadonlyArray<RepoSummary>, TransportError>>;
  /** Register an already-cloned repo by absolute path (positional / scripting form). */
  add(input: RepoInput): Promise<Result<RepoSummary, TransportError>>;
  /**
   * Clone the remote into `${reposDir}/${name}` using the default GitHub
   * identity's PAT, then register it. Used by the slice 4.0c FSM dialog
   * (name → remoteUrl → confirm) so the operator never has to think about
   * paths or pre-clone manually. Returns `github_identity_unavailable`
   * when no identity is provisioned, `repo_local_path_exists` when the
   * target directory is already populated, and `repo_clone_failed` for
   * git-side failures (auth, network, bad URL).
   */
  cloneAndAdd(input: RepoCloneAndAddInput): Promise<Result<RepoSummary, TransportError>>;
  remove(name: string): Promise<Result<void, TransportError>>;
}

export function createRepos(deps: {
  runInTx: Transactor;
  codingStore: CodingStore | undefined;
  secretsStore: SecretsStore | undefined;
  reposDir: string | undefined;
}): ReposNamespace {
  const { runInTx, codingStore, secretsStore, reposDir } = deps;
  return {
    async list() {
      if (!codingStore) return err({ code: "sandbox_disabled" as const });
      const rows = await runInTx((tx) => codingStore.listRepos(tx));
      return ok(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          localPath: r.localPath,
          defaultBranch: r.defaultBranch,
          remoteUrl: r.remoteUrl,
          verifyCommand: r.verifyCommand,
        })),
      );
    },
    async add(input) {
      if (!codingStore) return err({ code: "sandbox_disabled" as const });
      // Input validation — `name` becomes a path segment under
      // worktreesDir, so it must be a safe identifier. `localPath` must
      // be absolute (relative would resolve against Cogmo's CWD, which
      // changes between dev and prod). `remoteUrl` is opaque to slice 1
      // (we only `git -C localPath` operations), but slice 4 will pass
      // it to `git push` — empty-string check is enough for now.
      const validation = validateRepoInput(input);
      if (validation) return err(validation);
      const inserted = await runInTx((tx) =>
        codingStore.insertRepo(tx, {
          name: input.name,
          localPath: input.localPath,
          defaultBranch: input.defaultBranch ?? "main",
          remoteUrl: input.remoteUrl,
          devcontainer: null,
          allowedBackends: ["claude"],
          // Slice-1 default: a no-op so plan-only tasks have something to
          // record. Slice 4's verify+push step needs a real value before
          // it can use the repo. /repo edit (later) or SQL update for now.
          verifyCommand: input.verifyCommand ?? "true",
          taskTokenBudget: 200_000,
          taskWallTimeSeconds: 1800,
          maxConcurrentTasks: 1,
          ...(input.identityName !== undefined && { identityName: input.identityName }),
        }),
      );
      return inserted
        .map((row) => ({
          id: row.id,
          name: row.name,
          localPath: row.localPath,
          defaultBranch: row.defaultBranch,
          remoteUrl: row.remoteUrl,
          verifyCommand: row.verifyCommand,
        }))
        .mapErr((e) => ({ code: "repo_name_taken" as const, name: e.name }));
    },
    async cloneAndAdd(input) {
      if (!codingStore) return err({ code: "sandbox_disabled" as const });
      if (!secretsStore || !reposDir) {
        return err({
          code: "github_identity_unavailable" as const,
          reason:
            "Encrypted secrets or repos directory not configured; run setup before /repo add.",
        });
      }
      const identityName = input.identityName ?? DEFAULT_GITHUB_IDENTITY_NAME;
      const secretsStoreLocal = secretsStore;
      const identity = await runInTx((tx) =>
        resolveGitHubIdentity(tx, secretsStoreLocal, identityName),
      );
      if (identity.isErr()) {
        return err({
          code: "github_identity_unavailable" as const,
          reason: describeResolveIdentityError(identity.error),
        });
      }

      const localPath = join(reposDir, input.name);
      const validation = validateRepoInput({
        name: input.name,
        localPath,
        remoteUrl: input.remoteUrl,
      });
      if (validation) return err(validation);

      // Pre-check the registry by name — otherwise we'd clone (slow, network
      // egress, Gitea/GitHub side effects) and only fail on the DB insert,
      // leaving an orphaned working tree on disk that the operator has to
      // clean up by hand. Tiny TOCTOU window between this check and
      // `insertRepo` below; UNIQUE(name) still catches the race so the
      // worst case is the rare orphan rather than the common one.
      const existing = await runInTx((tx) => codingStore.getRepoByName(tx, input.name));
      if (existing) {
        return err({ code: "repo_name_taken" as const, name: input.name });
      }

      if (existsSync(localPath)) {
        return err({ code: "repo_local_path_exists" as const, path: localPath });
      }

      if (!existsSync(reposDir)) {
        mkdirSync(reposDir, { recursive: true, mode: 0o700 });
      }

      try {
        await withGitAskpass(identity.value.pat, async (env) => {
          await runGit(["clone", "--quiet", input.remoteUrl, localPath], env);
        });
      } catch (e) {
        return err({
          code: "repo_clone_failed" as const,
          reason: (e as Error).message,
        });
      }

      const inserted = await runInTx((tx) =>
        codingStore.insertRepo(tx, {
          name: input.name,
          localPath,
          defaultBranch: input.defaultBranch ?? "main",
          remoteUrl: input.remoteUrl,
          devcontainer: null,
          allowedBackends: ["claude"],
          verifyCommand: input.verifyCommand ?? "true",
          taskTokenBudget: 200_000,
          taskWallTimeSeconds: 1800,
          maxConcurrentTasks: 1,
          ...(input.identityName !== undefined && { identityName: input.identityName }),
        }),
      );
      return inserted
        .map((row) => ({
          id: row.id,
          name: row.name,
          localPath: row.localPath,
          defaultBranch: row.defaultBranch,
          remoteUrl: row.remoteUrl,
          verifyCommand: row.verifyCommand,
        }))
        .mapErr((e) => ({ code: "repo_name_taken" as const, name: e.name }));
    },
    async remove(name) {
      if (!codingStore) return err({ code: "sandbox_disabled" as const });
      // Resolve name → id outside the atomic check (the name lookup itself
      // doesn't race meaningfully — names are unique). The active-task
      // count + delete run inside one transaction in `removeRepoIfIdle`,
      // so a concurrent `insertTask` can't slip past the count.
      const repo = await runInTx((tx) => codingStore.getRepoByName(tx, name));
      if (!repo) return err({ code: "repo_not_found" as const, name });
      const result = await runInTx((tx) => codingStore.removeRepoIfIdle(tx, repo.id));
      return (
        match(result)
          .returnType<Result<void, TransportError>>()
          .with({ kind: "deleted" }, () => ok(undefined))
          .with({ kind: "in_use" }, ({ activeTasks }) =>
            err({ code: "repo_in_use", name, activeTasks }),
          )
          // Race window: repo existed at getRepoByName but was deleted
          // between the lookup and the atomic check. Surface as
          // not_found rather than synthesizing a stale success.
          .with({ kind: "not_found" }, () => err({ code: "repo_not_found", name }))
          .exhaustive()
      );
    },
  };
}

/**
 * Validate `RepoInput` for shape constraints that the schema can't enforce
 * (the DB is text, but we have semantic constraints for filesystem safety).
 * Returns a `TransportError` to surface, or `null` if input is valid.
 */
const REPO_NAME_RE = /^[a-zA-Z0-9._-]+$/;

function validateRepoInput(input: {
  name: string;
  localPath: string;
  remoteUrl: string;
}): { code: "repo_invalid_input"; field: string; reason: string } | null {
  if (!REPO_NAME_RE.test(input.name)) {
    return {
      code: "repo_invalid_input",
      field: "name",
      reason: "must match [a-zA-Z0-9._-]+ (no path separators, spaces, or shell metacharacters)",
    };
  }
  // Reject `.` / `..` even though they pass the alphabet — `path.join(reposDir,
  // "..")` escapes the intended subtree, and `repo add . /...` would treat the
  // whole reposDir as a single repo. Empty-after-strip is impossible here
  // (regex requires at least one char) but guard anyway.
  if (input.name === "." || input.name === "..") {
    return {
      code: "repo_invalid_input",
      field: "name",
      reason: "must not be '.' or '..'",
    };
  }
  if (!isAbsolute(input.localPath)) {
    return {
      code: "repo_invalid_input",
      field: "localPath",
      reason: "must be an absolute path (resolved against Cogmo's CWD otherwise)",
    };
  }
  if (input.remoteUrl.trim() === "") {
    return {
      code: "repo_invalid_input",
      field: "remoteUrl",
      reason: "must not be empty",
    };
  }
  return null;
}
