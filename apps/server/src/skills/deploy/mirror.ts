import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { match, P } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import { type GitEnv, runGit, withGitAskpass } from "../../secrets/git-askpass.js";
import { DEFAULT_GITHUB_IDENTITY_NAME, resolveGitHubIdentity } from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { describeError } from "../../util/describe-error.js";
import { getMainSha, isAncestor, revParse } from "../git-ops.js";
import { readOriginUrl } from "../repo.js";
import type { SkillStore, SkillsMirrorFailure } from "../store/index.js";

const execFileP = promisify(execFile);
const log = logger.child({ component: "skills.mirror" });

/**
 * Cap on a push or a remote probe: one ref takes seconds, and a minute rides
 * out a slow link while still freeing the caller from a stalled connection.
 */
const MIRROR_TIMEOUT_MS = 60_000;

/** What pushing `main` to the skills remote, and reading the remote, need. */
export interface MirrorDeps {
  runInTx: Transactor;
  /** Resolves the GitHub identity an HTTPS remote authenticates with. */
  secretsStore: SecretsStore;
  store: Pick<SkillStore, "recordMirrorLanded" | "recordMirrorFailed" | "recordMirrorDiverged">;
}

/** The remote could not be read: unreachable, or its credentials refused. */
export interface RemoteUnreadable {
  kind: "unreadable";
  detail: string;
}

/** How one push of `main` to the skills remote went. */
export type MirrorPushOutcome =
  | { kind: "no_origin" }
  | { kind: "landed"; sha: string }
  | { kind: "failed"; failure: SkillsMirrorFailure; detail: string };

/**
 * Push `sha` to the skills remote's `main` and record the result in the
 * mirror state (design/skills.md → Repo location → Mirror state): a landed
 * push of `local_sha` is `synced`; a failed one keeps `behind` with its
 * cause; a rejection by a remote `main` that local `main` does not descend
 * from is `diverged`, while one by an older remote `main` lost to a newer
 * push and records nothing. Best-effort, after a deploy commits as from the
 * reconcile: local `main` and the database stay authoritative, so a failure
 * is recorded and logged, never thrown.
 *
 * The push, and the read of the remote after a rejection, each give up
 * after `MIRROR_TIMEOUT_MS`, or once `signal` aborts.
 */
export async function mirrorMain(
  deps: MirrorDeps,
  repoPath: string,
  sha: string,
  options?: { signal?: AbortSignal },
): Promise<MirrorPushOutcome> {
  const outcome = await pushMain(deps, repoPath, sha, options).catch(
    (e: unknown): MirrorPushOutcome => ({
      kind: "failed",
      failure: "unreachable",
      detail: describeError(e),
    }),
  );
  try {
    await recordPush(deps, repoPath, outcome, options);
  } catch (e) {
    log.warn({ sha, error: describeError(e) }, "skills mirror push not recorded");
  }
  return outcome;
}

/**
 * The remote's `main`, or null when it has none or there is no `origin`.
 * Gives up after `MIRROR_TIMEOUT_MS`, or once `signal` aborts.
 */
export async function readRemoteMain(
  deps: Pick<MirrorDeps, "runInTx" | "secretsStore">,
  repoPath: string,
  options?: { signal?: AbortSignal },
): Promise<Result<string | null, RemoteUnreadable>> {
  const remoteUrl = await readOriginUrl(repoPath);
  if (!remoteUrl) return ok(null);
  return ResultAsync.fromPromise(
    runRemoteGit(
      deps,
      repoPath,
      remoteUrl,
      ["ls-remote", remoteUrl, "refs/heads/main"],
      remoteCallSignal(options),
    ),
    (e): RemoteUnreadable => ({ kind: "unreadable", detail: describeError(e) }),
  ).map(({ stdout }) => stdout.split("\t")[0]?.trim() || null);
}

async function pushMain(
  deps: Pick<MirrorDeps, "runInTx" | "secretsStore">,
  repoPath: string,
  sha: string,
  options: { signal?: AbortSignal } | undefined,
): Promise<MirrorPushOutcome> {
  const remoteUrl = await readOriginUrl(repoPath);
  if (!remoteUrl) return { kind: "no_origin" };
  const signal = remoteCallSignal(options);
  try {
    await runRemoteGit(
      deps,
      repoPath,
      remoteUrl,
      ["push", remoteUrl, `${sha}:refs/heads/main`],
      signal,
    );
    return { kind: "landed", sha };
  } catch (e) {
    return { kind: "failed", failure: classifyPushFailure(e, signal), detail: describeError(e) };
  }
}

/** Why a push failed, from git's account of it. */
function classifyPushFailure(e: unknown, signal: AbortSignal): SkillsMirrorFailure {
  if (signal.aborted) return "timeout";
  const text = describeError(e);
  // The remote refused to update `main` because another push moved it
  // first, in git's words before 2.50 and after: a rejection, whose winner
  // `lostToNewerPush` reads. A ref the remote cannot lock for another reason
  // (permissions, I/O) prints neither, and is a failure to record.
  if (/incorrect old value provided|is at [0-9a-f]+ but expected [0-9a-f]+/i.test(text)) {
    return "rejected";
  }
  if (
    /\[remote rejected\]|protected branch|Authentication failed|Permission denied|denied to|marked as read only|could not read Username|\b40[13]\b/i.test(
      text,
    )
  ) {
    return "auth";
  }
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(text)) return "rejected";
  return "unreachable";
}

async function recordPush(
  deps: MirrorDeps,
  repoPath: string,
  outcome: MirrorPushOutcome,
  options: { signal?: AbortSignal } | undefined,
): Promise<void> {
  await match(outcome)
    .with({ kind: "no_origin" }, async () => {
      log.warn(
        { repoPath },
        "skills bare repo has no `origin`; nothing to mirror (configure via `cogmo migrate-skills-remote`)",
      );
    })
    .with({ kind: "landed" }, async ({ sha }) => {
      const synced = await deps.runInTx((tx) => deps.store.recordMirrorLanded(tx, sha));
      // Not synced: a newer `main`, whose own push follows, is still to land.
      log.info({ sha, synced }, "mirrored skills main to remote");
    })
    .with({ kind: "failed", failure: "rejected" }, async ({ detail }) => {
      const lost = await lostToNewerPush(deps, repoPath, options);
      if (lost.isErr()) {
        log.warn(
          { detail, error: lost.error.detail },
          "skills remote rejected the push and could not be read; the reconcile retries",
        );
        return;
      }
      if (lost.value) return;
      const entered = await deps.runInTx((tx) => deps.store.recordMirrorDiverged(tx));
      log.warn(
        { detail, entered },
        // A plain push is a non-fast-forward; the bare repo keeps no
        // remote-tracking ref, so the lease names the sha.
        "skills remote main diverged from local main; check what its main holds (`git -C $COGMO_SKILLS_PATH ls-remote origin main`), then push local main over it, as an identity allowed to force-push it: `git -C $COGMO_SKILLS_PATH push --force-with-lease=main:<that sha> origin main`",
      );
    })
    .with(
      { kind: "failed", failure: P.union("unreachable", "auth", "timeout") },
      async ({ failure, detail }) => {
        await deps.runInTx((tx) => deps.store.recordMirrorFailed(tx, failure));
        log.warn(
          { failure, detail },
          "skills remote mirror failed; the reconcile retries — or `git -C $COGMO_SKILLS_PATH push origin main`",
        );
      },
    )
    .exhaustive();
}

/** Whether the remote's `main` is an ancestor of local `main`: a newer push won. */
async function lostToNewerPush(
  deps: Pick<MirrorDeps, "runInTx" | "secretsStore">,
  repoPath: string,
  options: { signal?: AbortSignal } | undefined,
): Promise<Result<boolean, RemoteUnreadable>> {
  const remote = await readRemoteMain(deps, repoPath, options);
  if (remote.isErr()) return err(remote.error);
  const remoteMain = remote.value;
  const localMain = await getMainSha(repoPath);
  if (remoteMain === null || localMain === null) return ok(false);
  return ok(await remoteMainIsAncestor(repoPath, remoteMain, localMain));
}

/** Whether `remoteMain`, a sha read from the remote, is a commit here that `sha` descends from. */
export async function remoteMainIsAncestor(
  repoPath: string,
  remoteMain: string,
  sha: string,
): Promise<boolean> {
  return (
    (await revParse(repoPath, `${remoteMain}^{commit}`)).isOk() &&
    (await isAncestor(repoPath, remoteMain, sha))
  );
}

/** A remote call's signal: aborts after `MIRROR_TIMEOUT_MS`, or with the caller's. */
function remoteCallSignal(options: { signal?: AbortSignal } | undefined): AbortSignal {
  return AbortSignal.any([
    AbortSignal.timeout(MIRROR_TIMEOUT_MS),
    ...(options?.signal ? [options.signal] : []),
  ]);
}

/**
 * Run `git -C repoPath <args>` against `remoteUrl`, without prompting, and
 * with the GitHub identity's token for an HTTPS remote.
 */
async function runRemoteGit(
  deps: Pick<MirrorDeps, "runInTx" | "secretsStore">,
  repoPath: string,
  remoteUrl: string,
  args: ReadonlyArray<string>,
  signal: AbortSignal,
): Promise<{ stdout: string }> {
  const opts = { signal, env: await nonInteractiveEnv(repoPath) };
  const run = (askpass?: GitEnv) => runGit(["-C", repoPath, ...args], askpass, opts);
  // SSH remotes use ssh-agent or deploy keys; only HTTPS reads the identity.
  if (!remoteUrl.startsWith("https://")) return run();
  const identity = await deps.runInTx((tx) =>
    resolveGitHubIdentity(tx, deps.secretsStore, DEFAULT_GITHUB_IDENTITY_NAME),
  );
  return identity.isOk() ? withGitAskpass(identity.value.pat, run) : run();
}

/**
 * The env that makes a remote call fail instead of waiting on a prompt, which
 * would hold `cogmo serve`'s boot for the call's cap: no terminal prompt for
 * credentials, and ssh in batch mode, with no passphrase or host-key prompt.
 * `BatchMode` goes into the ssh command git would run, from `GIT_SSH_COMMAND`
 * or `core.sshCommand`, so a key or wrapper configured there still applies. A
 * `GIT_SSH` program, whose options git adapts to its variant, is left as it is.
 */
async function nonInteractiveEnv(repoPath: string): Promise<NodeJS.ProcessEnv> {
  const configured = process.env.GIT_SSH_COMMAND || (await readSshCommand(repoPath));
  const ssh = configured ?? (process.env.GIT_SSH ? null : "ssh");
  return {
    GIT_TERMINAL_PROMPT: "0",
    ...(ssh !== null && { GIT_SSH_COMMAND: withBatchMode(ssh) }),
  };
}

const NAME = /[A-Za-z_][A-Za-z0-9_]*/.source;
/**
 * A plain parameter such as `$HOME`; no other `$` form is read. It takes the
 * whole name, so a word splits only one way and the read stays linear.
 */
const PARAMETER = `\\$${NAME}(?![A-Za-z0-9_])`;
const ESCAPE = /\\[\s\S]/.source;
/** A double-quoted span holding no substitution. */
const DOUBLE_QUOTED = `"(?:[^"\\\\$\`]|${ESCAPE}|${PARAMETER})*"`;
/**
 * One part of a shell word. A substitution (`$(…)`, `${…}`, a backtick), an
 * operator (`;`, `&`, `|`, `<`, `>`, `(`, `{`, a newline) and an unbalanced
 * quote are none.
 */
const WORD_PART = `[^\\s'"\\\\$\`;&|<>(){}]|${ESCAPE}|'[^']*'|${DOUBLE_QUOTED}|${PARAMETER}`;
/**
 * A command read up to its executable, the first word past any variable
 * assignments, with the executable as group 1. A part the reader can't
 * follow, before the executable or right after it, leaves no match.
 */
const UP_TO_EXECUTABLE = new RegExp(
  `^[ \\t]*(?:${NAME}=(?:${WORD_PART})*[ \\t]+)*(?!${NAME}=)((?:${WORD_PART})+)(?=[ \\t]|$)`,
);

/**
 * `command` with `-o BatchMode=yes` right after its executable, so it precedes
 * the command's own options: ssh keeps the first value it reads for an option.
 * Only a command read up to an executable named `ssh` takes it there; anything
 * else (a wrapper, a list, a substitution, a part the reader can't follow)
 * gets it appended, as git appends its own arguments.
 */
function withBatchMode(command: string): string {
  const read = UP_TO_EXECUTABLE.exec(command);
  if (read === null || !namesSsh(read[1] ?? "")) return `${command} -o BatchMode=yes`;
  const end = read[0].length;
  return `${command.slice(0, end)} -o BatchMode=yes${command.slice(end)}`;
}

/** Whether a shell word's last path segment, its quotes dropped, is `ssh`. */
function namesSsh(word: string): boolean {
  return (
    word
      .replace(/['"\\]/g, "")
      .split("/")
      .at(-1) === "ssh"
  );
}

/** `core.sshCommand` as git reads it for the repo, or null when it is unset. */
async function readSshCommand(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", [
      "-C",
      repoPath,
      "config",
      "--get",
      "core.sshCommand",
    ]);
    return stdout.trim() || null;
  } catch (e) {
    // Exit 1 is git's "the key is not set".
    if (typeof e === "object" && e !== null && "code" in e && e.code === 1) return null;
    throw e;
  }
}
