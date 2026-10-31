/**
 * Commit-and-push runner — slice 4.0f.
 *
 * Runs entirely inside the task container via `container.exec`. The host
 * orchestrator never touches the worktree directly; that keeps the
 * filesystem boundary clean (sysbox / runc isolation) and lets the same
 * code work regardless of where the task is executing.
 *
 * Steps:
 *   1. `git status --porcelain` — if empty, skip the commit (idempotent
 *      retry path: a prior run already committed, we just need to push).
 *   2. `git -c gpg.format=ssh -c user.signingkey=<path> -c user.email=...
 *       -c user.name="..." commit -S -m <message>`. Per-invocation `-c`
 *      flags keep the config scoped — no global state in the container.
 *   3. `git push origin <branch>`. PAT auth comes via `GIT_ASKPASS`
 *      (slice 4.0d's per-task helper); `GIT_TERMINAL_PROMPT=0` ensures
 *      missing auth fails fast instead of hanging on a TTY prompt.
 *
 * Every invocation additionally carries
 * {@link NO_BACKGROUND_MAINTENANCE_FLAGS}: steps 2 and 3 are the two commands
 * that spawn a detached `git maintenance run --auto`, and on the bind-mount
 * backend `worktreeDir` is the host working tree that teardown deletes once
 * the task settles.
 *
 * Discriminates outcomes so the orchestrator can render the right
 * Telegram message and persist the right `failure_reason`. `branch_conflict`
 * is rare (UUIDv7-prefix collision on `cogmo/<idShort>`) but worth its own
 * code so the operator sees a clear message instead of generic git output.
 */

import { type SandboxSession, unwrapExit } from "../../sandbox/index.js";
import type { GitHubIdentity } from "../../secrets/github.js";
import { redactSecretsInText } from "../../util/redact-secrets.js";
import { NO_BACKGROUND_MAINTENANCE_FLAGS } from "./git-maintenance.js";

const REMOTE = "origin";

/**
 * Compose a `git commit` author from a `GitHubIdentity`. The email maps
 * to GitHub's noreply alias so commits authored under it reverse-resolve
 * to the bot account on github.com (avatar + "authored by" link), and
 * delivery to the address is blocked by GitHub. Author name is the
 * freeform display label, which we set to the login.
 */
export function commitAuthorFor(identity: GitHubIdentity): { name: string; email: string } {
  return {
    name: identity.login,
    email: `${identity.id}+${identity.login}@users.noreply.github.com`,
  };
}

export interface CommitAndPushParams {
  container: Pick<SandboxSession, "execStreaming">;
  /** Working directory inside the container — typically `/workspace`. */
  worktreeDir: string;
  /** Local branch the commit lands on, e.g. `cogmo/<idShort>`. */
  branch: string;
  /**
   * Remote ref to push to. Omit to push `<branch>` to the same name on
   * origin (the verify-side push: feature branch -> feature branch).
   * Set to a different value when the local branch and the remote ref
   * intentionally diverge — the execute-side push commits on the local
   * feature branch but writes to the run-branch on origin, because the
   * verify sandbox clones the run-branch into a fresh tree.
   */
  remoteBranch?: string;
  /** Commit message — typically `task.goal` truncated. */
  commitMessage: string;
  /** In-container path to the SSH signing key (slice 4.0d askpass output). */
  signingKeyPath: string;
  /** Env vars from `provisionAskpass(...)` (`GIT_ASKPASS`, `GIT_TERMINAL_PROMPT`). */
  askpassEnv: Readonly<Record<string, string>>;
  /** Author identity for the commit. */
  author: { name: string; email: string };
}

export type CommitAndPushResult =
  | { kind: "pushed"; commitSha: string; output: string }
  | { kind: "nothing_to_commit"; output: string }
  | { kind: "branch_conflict"; output: string }
  | { kind: "auth_failed"; output: string }
  | { kind: "failed"; output: string };

export async function runCommitAndPush(params: CommitAndPushParams): Promise<CommitAndPushResult> {
  const {
    container,
    worktreeDir,
    branch,
    remoteBranch,
    commitMessage,
    signingKeyPath,
    askpassEnv,
    author,
  } = params;
  // Push HEAD to <remoteBranch> when the caller asked for a different
  // remote ref; default sends the local <branch> under the same name
  // on origin.
  const pushRefspec = remoteBranch === undefined ? branch : `HEAD:refs/heads/${remoteBranch}`;
  // 1. Working-tree status. Empty stdout = clean tree.
  const status = await runGit(container, ["status", "--porcelain"], {
    workingDir: worktreeDir,
    env: askpassEnv,
    timeoutMs: GIT_LOCAL_TOTAL_MS,
    idleTimeoutMs: GIT_IDLE_MS,
  });
  if (status.exitCode !== 0) {
    return { kind: "failed", output: combine(status) };
  }

  let committed = false;
  if (status.stdout.trim() !== "") {
    // 2. Commit with SSH signing. Stage everything that's tracked or in
    // the worktree — Cogmo doesn't (yet) gate which files Claude
    // modifies, and the verify step that just passed implicitly approved
    // the full diff.
    const addResult = await runGit(container, ["add", "-A"], {
      workingDir: worktreeDir,
      env: askpassEnv,
      timeoutMs: GIT_LOCAL_TOTAL_MS,
      idleTimeoutMs: GIT_IDLE_MS,
    });
    if (addResult.exitCode !== 0) {
      return { kind: "failed", output: combine(addResult) };
    }

    const commitResult = await runGit(
      container,
      [
        "-c",
        `user.email=${author.email}`,
        "-c",
        `user.name=${author.name}`,
        "-c",
        "gpg.format=ssh",
        "-c",
        `user.signingkey=${signingKeyPath}`,
        "commit",
        "-S",
        "-m",
        commitMessage,
      ],
      {
        workingDir: worktreeDir,
        env: askpassEnv,
        timeoutMs: GIT_LOCAL_TOTAL_MS,
        idleTimeoutMs: GIT_IDLE_MS,
      },
    );
    if (commitResult.exitCode !== 0) {
      // `git commit` exits 1 when there's nothing to commit — but we
      // already filtered that case via `status --porcelain`. A non-zero
      // here is something else (sign failure, signing-key permission,
      // pre-commit hook from inside the repo).
      return { kind: "failed", output: combine(commitResult) };
    }
    committed = true;
  }

  // 3. Push. Even when nothing was committed locally, push is still safe
  // (a prior run might have committed but failed to push; idempotent
  // retry should converge).
  const pushResult = await runGit(container, ["push", REMOTE, pushRefspec], {
    workingDir: worktreeDir,
    env: askpassEnv,
    timeoutMs: GIT_PUSH_TOTAL_MS,
    idleTimeoutMs: GIT_IDLE_MS,
  });
  const pushOutput = combine(pushResult);
  if (pushResult.exitCode !== 0) {
    if (looksLikeAuthFailure(pushOutput)) {
      return { kind: "auth_failed", output: pushOutput };
    }
    if (looksLikeBranchConflict(pushOutput)) {
      return { kind: "branch_conflict", output: pushOutput };
    }
    return { kind: "failed", output: pushOutput };
  }

  if (!committed) {
    return { kind: "nothing_to_commit", output: pushOutput };
  }

  // Capture the pushed SHA so the orchestrator (4.0g) can record it on
  // the PR row. `rev-parse HEAD` is cheap; failing here doesn't unwind
  // the push but does mean we record the kind=pushed without a SHA.
  const sha = await runGit(container, ["rev-parse", "HEAD"], {
    workingDir: worktreeDir,
    env: askpassEnv,
    timeoutMs: GIT_LOCAL_TOTAL_MS,
    idleTimeoutMs: GIT_IDLE_MS,
  });
  const commitSha = sha.exitCode === 0 ? sha.stdout.trim() : "";
  return { kind: "pushed", commitSha, output: pushOutput };
}

/**
 * Config every salvage exec carries, ahead of whatever the tree's own
 * `.git/config` says: no hooks, no fsmonitor, no credential helper. Command
 * line `-c` outranks repo config; an empty `credential.helper` resets the
 * helper list. Filters named in `.gitattributes`, and transport settings
 * such as `url.*.insteadOf`, still apply in the tree — which is why the
 * commit stage runs with no credential mounted, and the push stage pushes
 * from a scratch repo whose config the tree does not write.
 */
const SALVAGE_CONFIG_FLAGS: ReadonlyArray<string> = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "credential.helper=",
];

/**
 * The upload-pack the scratch fetch runs against the tree. The tree's
 * config governs it, so a tree that declares itself a partial clone, with
 * HEAD on a commit whose objects are missing, can make it lazy-fetch through
 * a transport that runs a command (`core.sshCommand`, `ext::`) while the PAT
 * is readable. Git 2.45.1 and later honour `GIT_NO_LAZY_FETCH`; the
 * protocol denies, which command-line `-c` makes outrank the tree's config,
 * close the command-running transports on a git too old to know it.
 */
const SALVAGE_UPLOAD_PACK = [
  "env GIT_NO_LAZY_FETCH=1 git",
  "-c protocol.ext.allow=never",
  "-c protocol.ssh.allow=never",
  "-c protocol.file.allow=never",
  "upload-pack",
].join(" ");

/** The salvage command that exited non-zero, or the fetched HEAD that moved. */
type WipSalvageStage =
  | "status"
  | "add"
  | "commit"
  | "rev-parse"
  | "rev-list"
  | "init"
  | "fetch"
  | "push";

export interface WipCommitParams {
  container: Pick<SandboxSession, "execStreaming">;
  /** Working directory inside the container — typically `/workspace`. */
  worktreeDir: string;
  /** Names the WIP commit. */
  taskId: string;
}

export type WipCommitResult =
  /** No edits, and every commit on HEAD is on some remote-tracking ref. */
  | { kind: "clean" }
  /** HEAD — the WIP commit, or unpushed commits — has to reach the remote. */
  | { kind: "needs_push"; sha: string }
  | { kind: "failed"; stage: WipSalvageStage; output: string };

/**
 * The salvage's first stage, run with no credential in the container: commit
 * whatever the tree holds as `wip: <taskId>` and report whether HEAD still
 * has to reach the remote. Unsigned under a fixed author, since the user
 * never approved this state, and `--no-verify` so a hook cannot block it.
 * A re-run after a lost result finds the tree clean and unpushed, and
 * reports the same HEAD.
 *
 * Throws when an exec does (the container is gone); the caller owns the
 * container and reads that as the salvage being unavailable.
 */
export async function runWipCommit(params: WipCommitParams): Promise<WipCommitResult> {
  const { container, worktreeDir, taskId } = params;
  const local = (args: ReadonlyArray<string>) =>
    runGit(container, [...SALVAGE_CONFIG_FLAGS, ...args], {
      workingDir: worktreeDir,
      env: {},
      timeoutMs: GIT_LOCAL_TOTAL_MS,
      idleTimeoutMs: GIT_IDLE_MS,
    });

  const status = await local(["status", "--porcelain"]);
  if (status.exitCode !== 0) return { kind: "failed", stage: "status", output: combine(status) };
  if (status.stdout.trim() !== "") {
    const add = await local(["add", "-A"]);
    if (add.exitCode !== 0) return { kind: "failed", stage: "add", output: combine(add) };
    const commit = await local([
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.email=cogmo-bot@noreply.local",
      "-c",
      "user.name=Cogmo (WIP)",
      "commit",
      "--no-verify",
      "--allow-empty",
      "-m",
      `wip: ${taskId}`,
    ]);
    if (commit.exitCode !== 0) return { kind: "failed", stage: "commit", output: combine(commit) };
  }

  const head = await local(["rev-parse", "HEAD"]);
  if (head.exitCode !== 0) return { kind: "failed", stage: "rev-parse", output: combine(head) };
  const sha = head.stdout.trim();
  // Commits on HEAD that no remote-tracking ref holds. Zero for a plan that
  // left the tree where the clone put it, so most plan failures and cancels
  // never need the credential container.
  const unpushed = await local(["rev-list", "--count", "HEAD", "--not", "--remotes"]);
  const count = unpushed.stdout.trim();
  if (unpushed.exitCode !== 0 || !/^\d+$/.test(count)) {
    return { kind: "failed", stage: "rev-list", output: combine(unpushed) };
  }
  return count === "0" ? { kind: "clean" } : { kind: "needs_push", sha };
}

export interface WipPushParams {
  container: Pick<SandboxSession, "execStreaming">;
  /** The task tree inside the container — typically `/workspace`. */
  worktreeDir: string;
  /** A path in the container, outside the tree, for the scratch bare repo. */
  scratchGitDir: string;
  /** `coding_repos.remote_url`, pushed to by URL rather than by the tree's `origin`. */
  remoteUrl: string;
  taskId: string;
  /** What {@link runWipCommit} reported; a tree whose HEAD moved since is refused. */
  sha: string;
  /** Env from `provisionAskpass`, given to the push alone. */
  askpassEnv: Readonly<Record<string, string>>;
}

export type WipPushResult =
  | { kind: "pushed"; wipRef: string; sha: string }
  | { kind: "failed"; stage: WipSalvageStage; output: string };

/**
 * The salvage's second stage, the only one with the credential mounted:
 * fetch the tree's HEAD into a fresh bare repo and force-push it from there
 * to `refs/cogmo-wip/<taskId>` on `remoteUrl`. The push reads the scratch
 * repo's config, which the tree does not write, so the tree's remotes,
 * `insteadOf` rewrites, protocol and proxy settings never reach it. The
 * fetch is a local one: the tree's side is `git-upload-pack`, which runs no
 * hooks or filters, with lazy fetch off ({@link SALVAGE_UPLOAD_PACK}) and no
 * submodule recursion. A per-task ref makes `--force` safe and the push
 * idempotent.
 *
 * Throws when an exec does (the container is gone), as {@link runWipCommit}.
 */
export async function runWipPush(params: WipPushParams): Promise<WipPushResult> {
  const { container, worktreeDir, scratchGitDir, remoteUrl, taskId, sha, askpassEnv } = params;
  const wipRef = `refs/cogmo-wip/${taskId}`;
  const scratch = (
    args: ReadonlyArray<string>,
    env: Readonly<Record<string, string>>,
    timeoutMs: number,
  ) =>
    runGit(container, [...SALVAGE_CONFIG_FLAGS, `--git-dir=${scratchGitDir}`, ...args], {
      workingDir: "/",
      env,
      timeoutMs,
      idleTimeoutMs: GIT_IDLE_MS,
    });

  const init = await scratch(["init", "--bare", "--quiet"], {}, GIT_LOCAL_TOTAL_MS);
  if (init.exitCode !== 0) return { kind: "failed", stage: "init", output: combine(init) };
  const fetch = await scratch(
    [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      `--upload-pack=${SALVAGE_UPLOAD_PACK}`,
      worktreeDir,
      `+HEAD:${wipRef}`,
    ],
    { GIT_NO_LAZY_FETCH: "1" },
    GIT_PUSH_TOTAL_MS,
  );
  if (fetch.exitCode !== 0) return { kind: "failed", stage: "fetch", output: combine(fetch) };
  const fetched = await scratch(["rev-parse", "--verify", wipRef], {}, GIT_LOCAL_TOTAL_MS);
  if (fetched.exitCode !== 0) {
    return { kind: "failed", stage: "rev-parse", output: combine(fetched) };
  }
  if (fetched.stdout.trim() !== sha) {
    return {
      kind: "failed",
      stage: "fetch",
      output: `HEAD moved after the WIP commit: expected ${sha}, fetched ${fetched.stdout.trim()}`,
    };
  }
  const push = await scratch(
    ["push", "--force", "--no-verify", remoteUrl, `${wipRef}:${wipRef}`],
    askpassEnv,
    GIT_PUSH_TOTAL_MS,
  );
  if (push.exitCode !== 0) return { kind: "failed", stage: "push", output: combine(push) };
  return { kind: "pushed", wipRef, sha };
}

interface ExecCapture {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Per-call exec timeouts for `git` invocations in commit-and-push. See
// design/coding-delegation.md → Per-callsite exec timeouts. Local-mutating
// git ops are fast; `git push` carries a generous total cap because a
// large delta legitimately takes longer. Idle cap protects against a
// hung TLS connection mid-upload.
const GIT_LOCAL_TOTAL_MS = 60_000;
const GIT_PUSH_TOTAL_MS = 5 * 60 * 1000;
const GIT_IDLE_MS = 30_000;

async function runGit(
  container: Pick<SandboxSession, "execStreaming">,
  args: ReadonlyArray<string>,
  opts: {
    workingDir: string;
    env: Readonly<Record<string, string>>;
    timeoutMs: number;
    idleTimeoutMs: number;
  },
): Promise<ExecCapture> {
  // Suppression rides on the argv rather than the env: the container's
  // ambient `GIT_CONFIG_*` pairs aren't visible from here, and numbering
  // blind would shadow index 0 of whatever it already declares.
  const handle = await container.execStreaming(
    ["git", ...NO_BACKGROUND_MAINTENANCE_FLAGS, ...args],
    {
      workingDir: opts.workingDir,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      idleTimeoutMs: opts.idleTimeoutMs,
    },
  );
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  // Settled from the start: a stream fails along with its exec, which
  // `exited` reports, and must not surface as an unhandled rejection.
  const drained = Promise.allSettled([
    (async () => {
      for await (const c of handle.stdout) {
        stdoutChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
      }
    })(),
    (async () => {
      for await (const c of handle.stderr) {
        stderrChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
      }
    })(),
  ]);

  const exited = await handle.exited;
  await drained;
  const wait = unwrapExit(exited);

  return {
    exitCode: wait.exitCode,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

// `output` is a step result and ends up in `failure_detail`, the Inngest
// event payload and the chat's failure message — cap from the tail so the
// actionable stderr survives.
const MAX_OUTPUT_BYTES = 8 * 1024;
const OUTPUT_TRUNCATED_PREFIX = "[cogmo: output truncated to last 8 KiB]\n";

function combine(c: ExecCapture): string {
  // Masked ahead of the cap, which could cut a credential past recognition.
  const raw = redactSecretsInText(
    c.stdout && c.stderr ? `${c.stdout.trimEnd()}\n${c.stderr.trimEnd()}` : c.stdout || c.stderr,
  );
  if (raw.length <= MAX_OUTPUT_BYTES) return raw;
  return `${OUTPUT_TRUNCATED_PREFIX}${raw.slice(-MAX_OUTPUT_BYTES)}`;
}

function looksLikeAuthFailure(output: string): boolean {
  return (
    /authentication failed/i.test(output) ||
    /could not read username/i.test(output) ||
    // Anchored on word boundaries so a SHA, line number, or branch name
    // containing the digits 403 (e.g. `cogmo/403-fix-bug`) doesn't get
    // misclassified as an auth failure.
    /\b403\b/.test(output) ||
    /permission denied \(publickey/i.test(output)
  );
}

function looksLikeBranchConflict(output: string): boolean {
  return (
    /\[rejected\]/i.test(output) ||
    /non-fast-forward/i.test(output) ||
    /failed to push some refs/i.test(output) ||
    /already exists/i.test(output)
  );
}
