import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { revParse } from "./git-ops.js";
import { manifestErrorIssues, parseManifest } from "./manifest.js";
import { readSkillFile, type SkillFile, type SkillsRepo } from "./skill-files.js";
import type { SkillManifest } from "./types.js";

export const SKILL_MANIFEST_FILE = "SKILL.md";
export const SKILL_BODY_FILE = "skill.py";
export const SKILL_TEST_FILE = "test_skill.py";

/** A skill's manifest and Python body, as committed at one sha. */
export interface SkillSource {
  manifest: SkillManifest;
  body: string;
}

export type SkillSourceError =
  | { kind: "commit_not_found" }
  | { kind: "missing_file"; file: typeof SKILL_MANIFEST_FILE | typeof SKILL_BODY_FILE }
  | { kind: "invalid_manifest"; issues: readonly string[] };

/**
 * Read and parse skill `name` as committed at `sha`: `SKILL.md`, then
 * `skill.py`, from `skills/<name>/` or, at a sha from before the layout
 * commit, the repo root. Errs when `sha` does not resolve, either file is
 * absent, or the manifest does not parse.
 */
export async function readSkillSource(
  repo: SkillsRepo,
  name: string,
  sha: string,
): Promise<Result<SkillSource, SkillSourceError>> {
  if ((await revParse(repo.path, `${sha}^{commit}`)).isErr()) {
    return err({ kind: "commit_not_found" });
  }
  const manifestSource = await readFileAtSha(repo, name, sha, SKILL_MANIFEST_FILE);
  if (manifestSource.isErr()) return err(manifestSource.error);
  const body = await readFileAtSha(repo, name, sha, SKILL_BODY_FILE);
  if (body.isErr()) return err(body.error);
  const parsed = parseManifest(manifestSource.value);
  if (parsed.isErr()) {
    return err({ kind: "invalid_manifest", issues: manifestErrorIssues(parsed.error) });
  }
  return ok({ manifest: parsed.value.manifest, body: body.value });
}

/** One of skill `name`'s files at `sha`, or null where it has none there; `sha` must resolve. */
export async function readOptionalSkillFile(
  repo: SkillsRepo,
  name: string,
  sha: string,
  file: SkillFile,
): Promise<string | null> {
  return (await readSkillFile(repo, name, sha, file)).match(
    (text) => text,
    (e) =>
      match(e)
        .with({ kind: "file_not_found" }, () => null)
        .with({ kind: "ref_not_found" }, () => {
          throw new Error(`${sha} does not resolve, though its skill was read there`);
        })
        .exhaustive(),
  );
}

async function readFileAtSha(
  repo: SkillsRepo,
  name: string,
  sha: string,
  file: typeof SKILL_MANIFEST_FILE | typeof SKILL_BODY_FILE,
): Promise<Result<string, SkillSourceError>> {
  return (await readSkillFile(repo, name, sha, file)).mapErr((e) =>
    e.kind === "ref_not_found" ? { kind: "commit_not_found" } : { kind: "missing_file", file },
  );
}
