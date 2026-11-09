import type { Transaction, Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import {
  commitAsCogmo,
  LAYOUT_TRAILER,
  LAYOUT_TRAILER_VALUE,
  logCommits,
  madeByCogmo,
  pathsUnder,
  type TreeEdit,
  writeEditedTree,
} from "./cogmo-commits.js";
import { ZERO_SHA } from "./deploy/deploy-deps.js";
import { getMainSha, isAncestor, RefMovedError, revParse, runGitIn, updateRef } from "./git-ops.js";
import { SKILL_FILES, SKILLS_DIR, skillBlobsUnder, skillDir } from "./skill-files.js";
import type { SkillRow, SkillStore } from "./store/index.js";

const log = logger.child({ component: "skills.layout" });

/** Attempts before a `main` that keeps moving under the move fails the boot. */
const MAX_ATTEMPTS = 5;

export interface MigrateSkillsLayoutDeps {
  runInTx: Transactor;
  store: SkillStore;
}

/**
 * Move every skill to `skills/<name>/` in one layout commit on `main`, and
 * record it, once (design/skills.md → Per-skill structure). Runs at boot
 * under the bootstrap lock, and after an adopt replaces the bare layout
 * commit. Each attempt starts with the recovery check: a recorded commit is
 * returned as is unless it is stale (`isStaleLayout`), and a layout commit
 * already on `main` with no row is recorded instead of making a second.
 * Otherwise it copies the files of every `skills` row whose sha is on
 * `main`, read at that sha from the repo root, and advances `main` with
 * compare-and-swap inside the transaction that records it. A lost swap rolls
 * back and the move is rebuilt from fresh reads; a concurrent move's insert
 * raises `40001`, which the transactor retries. Returns the layout commit.
 */
export async function migrateSkillsLayout(
  deps: MigrateSkillsLayoutDeps,
  repoPath: string,
): Promise<string> {
  // The attempt holds no row (none read, or a stale one dropped), so the row
  // it writes is its own.
  const record = async (tx: Transaction, sha: string) => {
    const stored = await deps.store.recordLayoutCommit(tx, sha);
    if (stored !== sha) {
      throw new Error(`migrateSkillsLayout: recorded ${sha}, but the row holds ${stored}`);
    }
  };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await deps.runInTx(async (tx) => {
        const recorded = await deps.store.getLayoutCommitSha(tx);
        if (recorded !== null) {
          if (!(await isStaleLayout(repoPath, recorded))) return recorded;
          log.warn(
            { layoutCommit: recorded },
            "recorded skills layout commit is stale; moving again",
          );
          await deps.store.forgetLayoutCommit(tx);
        }

        const rows = await deps.store.listAllSkills(tx);
        const mainSha = await getMainSha(repoPath);
        const found = mainSha === null ? null : await findLayoutCommit(repoPath, mainSha, rows);
        if (found !== null) {
          await record(tx, found);
          // The crash that left the commit unrecorded may have left the
          // mirror state behind main too.
          if (mainSha !== null) await deps.store.markMainAdvanced(tx, mainSha);
          log.info({ layoutCommit: found }, "recorded the skills layout commit found on main");
          return found;
        }

        const commit = await makeLayoutCommit(repoPath, mainSha, rows);
        await record(tx, commit);
        await deps.store.markMainAdvanced(tx, commit);
        await updateRef(repoPath, "refs/heads/main", commit, mainSha ?? ZERO_SHA);
        log.info({ layoutCommit: commit, skills: rows.length }, "moved skills to skills/<name>/");
        return commit;
      });
    } catch (e) {
      if (!(e instanceof RefMovedError)) throw e;
      log.info({ attempt }, "main moved during the skills layout move; retrying");
    }
  }
  throw new Error(
    `migrateSkillsLayout: main moved under each of ${MAX_ATTEMPTS} attempts to move skills to skills/<name>/`,
  );
}

/**
 * The layout commit in `mainSha`'s history, every parent followed, since a
 * deploy merging `main` into a draft cut before the move makes it a second
 * parent: the oldest commit carrying the layout trailer under Cogmo's
 * identity whose tree keeps no skill file at the root and a `skills/<name>/`
 * for each row at it or an ancestor.
 */
async function findLayoutCommit(
  repoPath: string,
  mainSha: string,
  rows: readonly SkillRow[],
): Promise<string | null> {
  const candidates = await logCommits(repoPath, [
    "--reverse",
    "--fixed-strings",
    `--grep=${LAYOUT_TRAILER}: ${LAYOUT_TRAILER_VALUE}`,
    mainSha,
  ]);
  for (const commit of candidates) {
    if (commit.trailers.get(LAYOUT_TRAILER) !== LAYOUT_TRAILER_VALUE || !madeByCogmo(commit)) {
      continue;
    }
    if (await hasLayoutTree(repoPath, commit.sha, rows)) return commit.sha;
  }
  return null;
}

async function hasLayoutTree(
  repoPath: string,
  sha: string,
  rows: readonly SkillRow[],
): Promise<boolean> {
  if ((await skillBlobsUnder(repoPath, sha, "")).size > 0) return false;
  for (const row of rows) {
    if (!(await onHistoryOf(repoPath, row.gitSha, sha))) continue;
    if ((await skillBlobsUnder(repoPath, sha, skillDir(row.name))).size === 0) return false;
  }
  return true;
}

/**
 * The layout commit for `mainSha` (none when `main` is unborn): its tree
 * without the root skill files or anything under `skills/`, which no reader
 * read before the move, and with each row's files on `main` copied from that
 * row's sha to `skills/<name>/`.
 */
async function makeLayoutCommit(
  repoPath: string,
  mainSha: string | null,
  rows: readonly SkillRow[],
): Promise<string> {
  const edits: TreeEdit[] =
    mainSha === null
      ? []
      : [
          ...[...SKILL_FILES, ...(await pathsUnder(repoPath, mainSha, `${SKILLS_DIR}/`))].map(
            (path): TreeEdit => ({ kind: "remove", path }),
          ),
          ...(await copiesOnMain(repoPath, mainSha, rows)),
        ];
  const tree = await writeEditedTree(repoPath, mainSha, edits);
  return commitAsCogmo(repoPath, {
    tree,
    parent: mainSha,
    subject: "chore(skills): move each skill to skills/<name>/",
    trailers: { [LAYOUT_TRAILER]: LAYOUT_TRAILER_VALUE },
  });
}

/** The edits that copy each row on `main` from its sha's root to `skills/<name>/`. */
async function copiesOnMain(
  repoPath: string,
  mainSha: string,
  rows: readonly SkillRow[],
): Promise<TreeEdit[]> {
  const edits: TreeEdit[] = [];
  for (const row of rows) {
    if (!(await onHistoryOf(repoPath, row.gitSha, mainSha))) continue;
    const blobs = await skillBlobsUnder(repoPath, row.gitSha, "");
    if (blobs.size === 0) {
      throw new Error(
        `migrateSkillsLayout: skill '${row.name}' at ${row.gitSha} has no skill files at the repo root`,
      );
    }
    const dir = skillDir(row.name);
    edits.push(
      ...[...blobs].map(([file, blob]): TreeEdit => ({ kind: "put", path: `${dir}${file}`, blob })),
    );
  }
  return edits;
}

/** Whether `sha` resolves and is `head` or an ancestor of it. */
async function onHistoryOf(repoPath: string, sha: string, head: string): Promise<boolean> {
  return (
    (await revParse(repoPath, `${sha}^{commit}`)).isOk() && (await isAncestor(repoPath, sha, head))
  );
}

/**
 * Whether a recorded layout commit no longer describes the repo: the repo
 * was recreated without it, or it is a bare layout commit `main` no longer
 * descends from, as after an adopt replaced it. A bare one holds no skill, so
 * moving again reads every row as before.
 */
async function isStaleLayout(repoPath: string, recorded: string): Promise<boolean> {
  if ((await revParse(repoPath, `${recorded}^{commit}`)).isErr()) return true;
  const mainSha = await getMainSha(repoPath);
  return (
    mainSha !== null &&
    !(await isAncestor(repoPath, recorded, mainSha)) &&
    (await isBareLayoutCommit(repoPath, recorded))
  );
}

/** Git's empty tree. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The skills repo's `main` as configuring a remote sees it: null when it is
 * unborn or holds only the bare layout commit the boot makes on an unborn
 * `main` (no parent, the empty tree), which carries no skill to keep.
 */
export async function configurableMainSha(repoPath: string): Promise<string | null> {
  const mainSha = await getMainSha(repoPath);
  return mainSha === null || (await isBareLayoutCommit(repoPath, mainSha)) ? null : mainSha;
}

/** Whether `sha` is the bare layout commit: Cogmo's, with no parent and the empty tree. */
export async function isBareLayoutCommit(repoPath: string, sha: string): Promise<boolean> {
  const [commit] = await logCommits(repoPath, ["-1", sha]);
  if (
    commit === undefined ||
    !madeByCogmo(commit) ||
    commit.trailers.get(LAYOUT_TRAILER) !== LAYOUT_TRAILER_VALUE
  ) {
    return false;
  }
  const [parents = "", tree = ""] = (
    await runGitIn(repoPath, ["log", "-1", "--format=%P%n%T", sha])
  )
    .split("\n")
    .map((line) => line.trim());
  return parents === "" && tree === EMPTY_TREE;
}
