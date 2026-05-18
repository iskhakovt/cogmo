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
 * Discriminates outcomes so the orchestrator can render the right
 * Telegram message and persist the right `failure_reason`. `branch_conflict`
 * is rare (UUIDv7-prefix collision on `cogmo/<idShort>`) but worth its own
 * code so the operator sees a clear message instead of generic git output.
 */

import type { SandboxSession } from "../../sandbox/index.js";

const REMOTE = "origin";

export interface CommitAndPushParams {
  container: Pick<SandboxSession, "execStreaming">;
  /** Working directory inside the container — typically `/workspace`. */
  worktreeDir: string;
  /** Branch to push, e.g. `cogmo/<idShort>`. */
  branch: string;
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
  const { container, worktreeDir, branch, commitMessage, signingKeyPath, askpassEnv, author } =
    params;

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
  const pushResult = await runGit(container, ["push", REMOTE, branch], {
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
  const handle = await container.execStreaming(["git", ...args], {
    workingDir: opts.workingDir,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    idleTimeoutMs: opts.idleTimeoutMs,
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const stdoutDone = (async () => {
    for await (const c of handle.stdout) {
      stdoutChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
    }
  })();
  const stderrDone = (async () => {
    for await (const c of handle.stderr) {
      stderrChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
    }
  })();

  const wait = await handle.wait();
  await Promise.all([stdoutDone, stderrDone]);

  return {
    exitCode: wait.exitCode,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

function combine(c: ExecCapture): string {
  if (c.stdout && c.stderr) return `${c.stdout.trimEnd()}\n${c.stderr.trimEnd()}`;
  return c.stdout || c.stderr;
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
