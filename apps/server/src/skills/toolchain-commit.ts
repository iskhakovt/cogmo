import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import {
  commitAsCogmo,
  pathsUnder,
  TOOLCHAIN_TRAILER,
  type TreeEdit,
  writeEditedTree,
} from "./cogmo-commits.js";
import { getMainSha, RefMovedError, runGitIn, updateRef } from "./git-ops.js";
import type { SkillStore } from "./store/index.js";
import {
  type RefusedToolchainEntry,
  type ReleaseToolchain,
  type ToolchainEntry,
  toolchainPathsAt,
} from "./toolchain.js";

const log = logger.child({ component: "skills.toolchain" });

/** Attempts before a `main` that keeps moving under the commit fails the boot. */
const MAX_ATTEMPTS = 5;

export interface CommitToolchainDeps {
  runInTx: Transactor;
  store: Pick<SkillStore, "markMainAdvanced">;
}

/** What the toolchain commit did to `main`. */
export type ToolchainCommitOutcome =
  /** Every entry on `main` already matched the release's: nothing written. */
  { kind: "unchanged" } | { kind: "committed"; sha: string };

/** A root entry of a tree: its mode and object id. */
interface RootEntry {
  mode: string;
  id: string;
}

/**
 * Set the skills repo's toolchain entries on `main` to `release`'s
 * (design/skills.md → Verify stage → The skills repo toolchain). Each entry
 * on `main` is compared with the release's by mode and object id, `.cogmo/`
 * as one tree; when any differs, Cogmo commits on top of `main` a tree with
 * each entry set to the release's and each entry `main`'s `.cogmo/paths`
 * lists but the release's does not removed. The comparison is the recovery
 * check, so the commit needs no row. It marks the mirror state and advances
 * `main` by compare-and-swap in one transaction; a lost swap retries from a
 * fresh `main`, five attempts in all. Runs after the layout move, which
 * leaves `main` born; the caller holds the bootstrap lock. Errs, writing
 * nothing, when `main`'s list names an entry the toolchain may not own,
 * which only the operator can repair.
 */
export async function commitToolchain(
  deps: CommitToolchainDeps,
  repoPath: string,
  release: ReleaseToolchain,
): Promise<Result<ToolchainCommitOutcome, RefusedToolchainEntry>> {
  const puts = await writeBlobs(repoPath, release.entries, "");
  const names = release.entries.map((entry) => entry.name);
  const wanted = await rootEntries(repoPath, await writeEditedTree(repoPath, null, puts), names);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await deps.runInTx(
        async (tx): Promise<Result<ToolchainCommitOutcome, RefusedToolchainEntry>> => {
          const mainSha = await getMainSha(repoPath);
          if (mainSha === null) {
            throw new Error(
              "commitToolchain: the skills repo's main is unborn; the layout move runs first",
            );
          }
          const onMain = await rootEntries(repoPath, mainSha, names);
          if (names.every((name) => sameEntry(onMain.get(name), wanted.get(name)))) {
            return ok({ kind: "unchanged" });
          }
          const listed = await toolchainPathsAt(repoPath, mainSha);
          if (listed.isErr()) return err(listed.error);
          const dropped = listed.value.filter((name) => !names.includes(name));
          const removals: TreeEdit[] = [];
          for (const name of [...names, ...dropped]) {
            for (const path of await pathsUnder(repoPath, mainSha, name)) {
              removals.push({ kind: "remove", path });
            }
          }
          const tree = await writeEditedTree(repoPath, mainSha, [...removals, ...puts]);
          const sha = await commitAsCogmo(repoPath, {
            tree,
            parent: mainSha,
            subject: `chore(skills): set Cogmo's toolchain to ${release.version}`,
            trailers: { [TOOLCHAIN_TRAILER]: release.version },
          });
          await deps.store.markMainAdvanced(tx, sha);
          await updateRef(repoPath, "refs/heads/main", sha, mainSha);
          log.info(
            { toolchainCommit: sha, version: release.version, removed: dropped },
            "committed the release's toolchain to the skills repo",
          );
          return ok({ kind: "committed", sha });
        },
      );
    } catch (e) {
      if (!(e instanceof RefMovedError)) throw e;
      log.info({ attempt }, "main moved during the toolchain commit; retrying");
    }
  }
  throw new Error(
    `commitToolchain: main moved under each of ${MAX_ATTEMPTS} attempts to commit the toolchain`,
  );
}

/** Write each file under `entries` as a blob, returning the edits that put them at their paths. */
async function writeBlobs(
  repoPath: string,
  entries: readonly ToolchainEntry[],
  prefix: string,
): Promise<TreeEdit[]> {
  const edits: TreeEdit[] = [];
  for (const entry of entries) {
    const path = `${prefix}${entry.name}`;
    edits.push(
      ...(await match(entry)
        .returnType<Promise<TreeEdit[]>>()
        .with({ kind: "tree" }, (tree) => writeBlobs(repoPath, tree.entries, `${path}/`))
        .with({ kind: "file" }, async (file) => {
          const sha = (
            await runGitIn(repoPath, ["hash-object", "-w", "--stdin"], { input: file.content })
          ).trim();
          return [{ kind: "put", path, blob: { mode: file.mode, sha } }];
        })
        .exhaustive()),
    );
  }
  return edits;
}

/** The root entries `names` of `treeish`'s tree, by name; an absent one is missing. */
async function rootEntries(
  repoPath: string,
  treeish: string,
  names: readonly string[],
): Promise<ReadonlyMap<string, RootEntry>> {
  const stdout = await runGitIn(repoPath, [
    "--literal-pathspecs",
    "ls-tree",
    "-z",
    treeish,
    "--",
    ...names,
  ]);
  return new Map(
    stdout.split("\0").flatMap((record): [string, RootEntry][] => {
      const tab = record.indexOf("\t");
      if (tab < 0) return [];
      const [mode, , id] = record.slice(0, tab).split(" ");
      return mode !== undefined && id !== undefined ? [[record.slice(tab + 1), { mode, id }]] : [];
    }),
  );
}

function sameEntry(a: RootEntry | undefined, b: RootEntry | undefined): boolean {
  return a !== undefined && b !== undefined && a.mode === b.mode && a.id === b.id;
}
