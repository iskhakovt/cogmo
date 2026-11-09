import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { match } from "ts-pattern";
import { runGitIn } from "./git-ops.js";
import type { TreeBlob } from "./skill-files.js";

/**
 * The identity every commit Cogmo makes on the skills repo carries, as author
 * and committer: the layout commit and the restoring commits. Register
 * refuses it on an author's commits (`layout_violation`), so a commit on
 * `main` carrying it is Cogmo's.
 */
export const COGMO_COMMIT_NAME = "Cogmo";
export const COGMO_COMMIT_EMAIL = "skills@cogmo.invalid";

/** The trailer the layout commit carries. */
export const LAYOUT_TRAILER = "Cogmo-Layout";
export const LAYOUT_TRAILER_VALUE = "v1";
/** The trailer a restoring commit carries, naming the commit whose skill files it restored. */
export const RESTORES_TRAILER = "Cogmo-Restores";

/** One change to a tree: drop `path`, or put a blob there. */
export type TreeEdit =
  | { kind: "remove"; path: string }
  | { kind: "put"; path: string; blob: TreeBlob };

/**
 * Write the tree `base`'s tree becomes after `edits`, through a private
 * index file, since the bare repo has no working tree. `base` null starts
 * from the empty tree. Returns the new tree's id.
 */
export async function writeEditedTree(
  repoPath: string,
  base: string | null,
  edits: readonly TreeEdit[],
): Promise<string> {
  const indexFile = join(tmpdir(), `cogmo-skills-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    await runGitIn(repoPath, base === null ? ["read-tree", "--empty"] : ["read-tree", base], {
      env,
    });
    const lines = edits.map((edit) =>
      match(edit)
        .with({ kind: "remove" }, ({ path }) => `0 ${"0".repeat(40)}\t${path}`)
        .with({ kind: "put" }, ({ path, blob }) => `${blob.mode} ${blob.sha}\t${path}`)
        .exhaustive(),
    );
    if (lines.length > 0) {
      await runGitIn(repoPath, ["update-index", "--index-info"], {
        env,
        input: `${lines.join("\n")}\n`,
      });
    }
    return (await runGitIn(repoPath, ["write-tree"], { env })).trim();
  } finally {
    await rm(indexFile, { force: true });
  }
}

/**
 * Commit `tree` under Cogmo's identity with `parent` as its only parent (none
 * when null), the subject and the trailers given. Returns the commit's id;
 * no ref moves.
 */
export async function commitAsCogmo(
  repoPath: string,
  args: {
    tree: string;
    parent: string | null;
    subject: string;
    trailers: Readonly<Record<string, string>>;
  },
): Promise<string> {
  const trailerBlock = Object.entries(args.trailers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: COGMO_COMMIT_NAME,
    GIT_AUTHOR_EMAIL: COGMO_COMMIT_EMAIL,
    GIT_COMMITTER_NAME: COGMO_COMMIT_NAME,
    GIT_COMMITTER_EMAIL: COGMO_COMMIT_EMAIL,
  };
  const parentArgs = args.parent === null ? [] : ["-p", args.parent];
  const commit = await runGitIn(
    repoPath,
    ["commit-tree", args.tree, ...parentArgs, "-m", args.subject, "-m", trailerBlock],
    { env },
  );
  return commit.trim();
}

/** A commit as the recovery checks and register's identity check read it. */
export interface CommitIdentity {
  sha: string;
  authorEmail: string;
  committerEmail: string;
  /** Every trailer the commit carries, by key; a repeated key keeps its last value. */
  trailers: ReadonlyMap<string, string>;
}

/** Whether `commit` was made by Cogmo: its identity as author and committer. */
export function madeByCogmo(commit: CommitIdentity): boolean {
  return commit.authorEmail === COGMO_COMMIT_EMAIL && commit.committerEmail === COGMO_COMMIT_EMAIL;
}

/** The prefix of every trailer only Cogmo's commits may carry. */
export const COGMO_TRAILER_PREFIX = "Cogmo-";

const FIELD = "\x1f";
const RECORD = "\x1e";
const TRAILER = "\x1d";

/**
 * The commits `git log <args>` lists, newest first unless `args` reverses
 * them, with their identities and trailers.
 */
export async function logCommits(
  repoPath: string,
  args: readonly string[],
): Promise<readonly CommitIdentity[]> {
  const format = `%H%x1f%ae%x1f%ce%x1f%(trailers:only,unfold,separator=%x1d)%x1e`;
  const stdout = await runGitIn(repoPath, ["log", `--format=${format}`, ...args]);
  return stdout
    .split(RECORD)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = "", authorEmail = "", committerEmail = "", trailerBlock = ""] =
        record.split(FIELD);
      const trailers = new Map(
        trailerBlock.split(TRAILER).flatMap((line) => {
          const colon = line.indexOf(":");
          return colon > 0
            ? [[line.slice(0, colon).trim(), line.slice(colon + 1).trim()] as const]
            : [];
        }),
      );
      return { sha, authorEmail, committerEmail, trailers };
    });
}

/** Every path under `dir` (a `skills/<name>/` prefix) in `sha`'s tree. */
export async function pathsUnder(repoPath: string, sha: string, dir: string): Promise<string[]> {
  const stdout = await runGitIn(repoPath, ["ls-tree", "-r", "-z", "--name-only", sha, "--", dir]);
  return stdout.split("\0").filter((path) => path.length > 0);
}
