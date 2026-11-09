import { err, ok, type Result } from "neverthrow";
import * as R from "remeda";
import { match } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import { COGMO_COMMIT_EMAIL, COGMO_TRAILER_PREFIX, logCommits } from "../cogmo-commits.js";
import { runGitIn } from "../git-ops.js";
import {
  SKILL_FILES,
  SKILLS_DIR,
  type SkillsRepo,
  sameSkillBlobs,
  skillBlobsAt,
  skillBlobsUnder,
  skillDir,
} from "../skill-files.js";
import type { SkillStore } from "../store/index.js";

/** A changed path inside a skill's directory: `skills/<name>/<file>`. */
const SKILL_PATH = new RegExp(`^${SKILLS_DIR}/([^/]+)/([^/]+)$`);

/** Why a branch names no one skill to deploy (design/skills.md → Per-skill structure). */
export type LocateSkillRejection =
  /** Skill files at the repo root. */
  | { kind: "root_files"; paths: readonly string[] }
  /** Commits carrying Cogmo's identity or a `Cogmo-` trailer. */
  | { kind: "cogmo_commits"; shas: readonly string[] }
  /** Paths outside one skill's own files. */
  | { kind: "outside_paths"; paths: readonly string[] }
  /** The branch changes, or the tip holds changes to, more than one skill. */
  | { kind: "several_skills"; names: readonly string[]; atTip: boolean }
  | { kind: "nothing_to_register" };

/**
 * The skill a branch tip deploys (design/skills.md → Per-skill structure).
 * The tip descends from `main`, so `main..tip` is the branch's own change: it
 * must touch only one skill's own files in `skills/<name>/`, and that skill is
 * the one. A tip that changes nothing is `main` itself, as after a register
 * whose commit failed once `update-ref` landed: its skill is the one whose
 * files differ from its live version, or, when none does, the one live at the
 * tip. Its commits must not carry Cogmo's identity or trailers.
 */
export async function locateSkill(
  deps: { runInTx: Transactor; store: SkillStore },
  repo: SkillsRepo,
  mainSha: string,
  tipSha: string,
): Promise<Result<string, LocateSkillRejection>> {
  const cogmoMade = (await logCommits(repo.path, [`${mainSha}..${tipSha}`])).filter(
    (c) =>
      c.authorEmail === COGMO_COMMIT_EMAIL ||
      c.committerEmail === COGMO_COMMIT_EMAIL ||
      [...c.trailers.keys()].some((key) => key.startsWith(COGMO_TRAILER_PREFIX)),
  );
  if (cogmoMade.length > 0) {
    return err({ kind: "cogmo_commits", shas: cogmoMade.map((c) => c.sha) });
  }

  const changed = await changedPaths(repo.path, mainSha, tipSha);
  const atRoot = changed.filter((path) => SKILL_FILES.some((f) => f === path));
  if (atRoot.length > 0) return err({ kind: "root_files", paths: atRoot });
  const owned = changed.map((path) => ({ path, match: SKILL_PATH.exec(path) }));
  const outside = owned
    .filter(({ match }) => match === null || !SKILL_FILES.some((f) => f === match[2]))
    .map(({ path }) => path);
  if (outside.length > 0) return err({ kind: "outside_paths", paths: outside });
  const names = R.unique(owned.flatMap(({ match }) => (match?.[1] ? [match[1]] : [])));
  if (names.length > 1) return err({ kind: "several_skills", names, atTip: false });
  const [name] = names;
  if (name !== undefined) return ok(name);
  return skillAtUnchangedTip(deps, repo, tipSha);
}

/** A rejection as the register error it surfaces as. */
export function describeLocateSkillRejection(rejection: LocateSkillRejection): string {
  return match(rejection)
    .with(
      { kind: "cogmo_commits" },
      ({ shas }) =>
        `layout_violation: ${shas.map((sha) => sha.slice(0, 7)).join(", ")} carry Cogmo's commit identity or a ${COGMO_TRAILER_PREFIX} trailer, which only Cogmo's own commits may`,
    )
    .with(
      { kind: "root_files" },
      ({ paths }) =>
        `layout_violation: ${paths.join(", ")} at the repo root; a skill's files live in skills/<name>/`,
    )
    .with(
      { kind: "outside_paths" },
      ({ paths }) =>
        `owned_paths: ${paths.join(", ")} outside a skill's own files (skills/<name>/ with ${SKILL_FILES.join(", ")})`,
    )
    .with(
      { kind: "several_skills", atTip: false },
      ({ names }) => `owned_paths: the branch changes more than one skill: ${names.join(", ")}`,
    )
    .with(
      { kind: "several_skills", atTip: true },
      ({ names }) =>
        `owned_paths: more than one skill differs from its live version at the tip: ${names.join(", ")}`,
    )
    .with({ kind: "nothing_to_register" }, () => "nothing_to_register: the branch changes no skill")
    .exhaustive();
}

async function skillAtUnchangedTip(
  deps: { runInTx: Transactor; store: SkillStore },
  repo: SkillsRepo,
  tipSha: string,
): Promise<Result<string, LocateSkillRejection>> {
  const rows = await deps.runInTx((tx) => deps.store.listAllSkills(tx));
  const live = new Map(rows.map((row) => [row.name, row]));
  const differing: string[] = [];
  for (const name of await skillNamesAt(repo.path, tipSha)) {
    const row = live.get(name);
    const atTip = await skillBlobsUnder(repo.path, tipSha, skillDir(name));
    if (row === undefined || !sameSkillBlobs(atTip, await skillBlobsAt(repo, name, row.gitSha))) {
      differing.push(name);
    }
  }
  if (differing.length > 1) return err({ kind: "several_skills", names: differing, atTip: true });
  const name = differing[0] ?? rows.find((row) => row.gitSha === tipSha)?.name;
  return name === undefined ? err({ kind: "nothing_to_register" }) : ok(name);
}

async function changedPaths(repoPath: string, from: string, to: string): Promise<string[]> {
  return (await runGitIn(repoPath, ["diff", "--name-only", "--no-renames", "-z", from, to, "--"]))
    .split("\0")
    .filter((path) => path.length > 0);
}

/** The skill directories under `skills/` at `sha`. */
async function skillNamesAt(repoPath: string, sha: string): Promise<string[]> {
  return (
    await runGitIn(repoPath, ["ls-tree", "-d", "-z", "--name-only", sha, "--", `${SKILLS_DIR}/`])
  )
    .split("\0")
    .filter((path) => path.length > 0)
    .map((path) => path.slice(SKILLS_DIR.length + 1));
}
