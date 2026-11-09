import type { Result } from "neverthrow";
import { type GitShowError, gitShow, isAncestor, revParse, runGitIn } from "./git-ops.js";

/**
 * The files a skill owns, the only ones register lets a branch change, in
 * `skills/<name>/` (design/skills.md → Per-skill structure).
 */
export const SKILL_FILES = ["SKILL.md", "skill.py", "requirements.lock", "test_skill.py"] as const;
export type SkillFile = (typeof SKILL_FILES)[number];

/** The bare skills repo and the commit that moved skills to `skills/<name>/`. */
export interface SkillsRepo {
  readonly path: string;
  /** The recorded layout commit; throws when boot has not recorded one. */
  layoutCommitSha(): Promise<string>;
}

/**
 * The skills repo at `path`, its layout commit read through `read` on each
 * use: boot records it before anything reads a skill, and an adopt that
 * replaces the bare layout commit records another (configure-remote.ts).
 */
export function recordedSkillsRepo(path: string, read: () => Promise<string | null>): SkillsRepo {
  return {
    path,
    async layoutCommitSha() {
      const sha = await read();
      if (sha === null) {
        throw new Error(
          "the skills repo's layout commit is not recorded; boot records it (migrateSkillsLayout) before skills are read",
        );
      }
      return sha;
    },
  };
}

/** The directory of the skills that live in `skills/<name>/`. */
export const SKILLS_DIR = "skills";

export function skillDir(name: string): string {
  return `${SKILLS_DIR}/${name}/`;
}

/**
 * Where `name`'s files sit at `sha`: `skills/<name>/` when the layout commit
 * is `sha` or an ancestor of it, the repo root otherwise. `sha` must resolve.
 */
export async function skillPrefixAt(repo: SkillsRepo, name: string, sha: string): Promise<string> {
  return (await isAncestor(repo.path, await repo.layoutCommitSha(), sha)) ? skillDir(name) : "";
}

/** One of a skill's files at `sha`, read from where it sits there. */
export async function readSkillFile(
  repo: SkillsRepo,
  name: string,
  sha: string,
  file: SkillFile,
): Promise<Result<string, GitShowError>> {
  return gitShow(repo.path, sha, `${await skillPrefixAt(repo, name, sha)}${file}`);
}

/** A blob in a tree: its mode and object id. */
export interface TreeBlob {
  mode: string;
  sha: string;
}

/**
 * The skill files present under `prefix` in `sha`'s tree, by file name.
 * `prefix` is `""` for the repo root or `skills/<name>/`.
 */
export async function skillBlobsUnder(
  repoPath: string,
  sha: string,
  prefix: string,
): Promise<ReadonlyMap<SkillFile, TreeBlob>> {
  const stdout = await runGitIn(repoPath, [
    "ls-tree",
    "-z",
    sha,
    "--",
    ...SKILL_FILES.map((f) => `${prefix}${f}`),
  ]);
  return new Map(
    stdout.split("\0").flatMap((record): [SkillFile, TreeBlob][] => {
      const tab = record.indexOf("\t");
      if (tab < 0) return [];
      const [mode, type, objectSha] = record.slice(0, tab).split(" ");
      const file = SKILL_FILES.find((f) => `${prefix}${f}` === record.slice(tab + 1));
      return type === "blob" && mode !== undefined && objectSha !== undefined && file !== undefined
        ? [[file, { mode, sha: objectSha }]]
        : [];
    }),
  );
}

/** `name`'s files at `sha`, read from where they sit there. */
export async function skillBlobsAt(
  repo: SkillsRepo,
  name: string,
  sha: string,
): Promise<ReadonlyMap<SkillFile, TreeBlob>> {
  return skillBlobsUnder(repo.path, sha, await skillPrefixAt(repo, name, sha));
}

/**
 * Whether `name`'s files at `sha` are `blobs`. A `sha` the repo lacks holds
 * other files, as a live sha does once the repo is restored from a remote
 * that lagged its deploy.
 */
export async function skillBlobsMatchAt(
  repo: SkillsRepo,
  name: string,
  sha: string,
  blobs: ReadonlyMap<SkillFile, TreeBlob>,
): Promise<boolean> {
  return (
    (await revParse(repo.path, `${sha}^{commit}`)).isOk() &&
    sameSkillBlobs(blobs, await skillBlobsAt(repo, name, sha))
  );
}

/** Whether two sets of skill files hold the same files with the same contents and modes. */
export function sameSkillBlobs(
  a: ReadonlyMap<SkillFile, TreeBlob>,
  b: ReadonlyMap<SkillFile, TreeBlob>,
): boolean {
  return (
    a.size === b.size &&
    [...a].every(([file, blob]) => {
      const other = b.get(file);
      return other !== undefined && other.mode === blob.mode && other.sha === blob.sha;
    })
  );
}
