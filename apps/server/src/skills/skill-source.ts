import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { revParse } from "./git-ops.js";
import { manifestErrorIssues, parseManifest } from "./manifest.js";
import { readSkillFile, type SkillsRepo } from "./skill-files.js";
import type { SkillManifest } from "./types.js";

export const SKILL_MANIFEST_FILE = "SKILL.md";
export const SKILL_BODY_FILE = "skill.py";

/** A skill's manifest and Python body, as committed at one sha. */
export interface SkillSource {
  manifest: SkillManifest;
  body: string;
}

/** A skill's `SKILL.md` and `skill.py` as text, each null where it is absent. */
export interface SkillFileTexts {
  manifest: string | null;
  body: string | null;
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
  const texts = await readSkillTexts(repo, name, sha);
  if (texts.isErr()) return err(texts.error);
  const { manifest: manifestSource, body } = texts.value;
  if (manifestSource === null) return err({ kind: "missing_file", file: SKILL_MANIFEST_FILE });
  if (body === null) return err({ kind: "missing_file", file: SKILL_BODY_FILE });
  const parsed = parseManifest(manifestSource);
  if (parsed.isErr()) {
    return err({ kind: "invalid_manifest", issues: manifestErrorIssues(parsed.error) });
  }
  return ok({ manifest: parsed.value.manifest, body });
}

/**
 * Skill `name`'s `SKILL.md` and `skill.py` as committed at `sha`, unparsed,
 * from where they sit there (`readSkillSource`). Errs when `sha` does not
 * resolve.
 */
export async function readSkillTexts(
  repo: SkillsRepo,
  name: string,
  sha: string,
): Promise<Result<SkillFileTexts, { kind: "commit_not_found" }>> {
  if ((await revParse(repo.path, `${sha}^{commit}`)).isErr()) {
    return err({ kind: "commit_not_found" });
  }
  const manifest = await readFileAtSha(repo, name, sha, SKILL_MANIFEST_FILE);
  if (manifest.isErr()) return err(manifest.error);
  const body = await readFileAtSha(repo, name, sha, SKILL_BODY_FILE);
  if (body.isErr()) return err(body.error);
  return ok({ manifest: manifest.value, body: body.value });
}

/** One of the skill's files at `sha`, or null where it is absent. */
async function readFileAtSha(
  repo: SkillsRepo,
  name: string,
  sha: string,
  file: typeof SKILL_MANIFEST_FILE | typeof SKILL_BODY_FILE,
): Promise<Result<string | null, { kind: "commit_not_found" }>> {
  return (await readSkillFile(repo, name, sha, file)).orElse((e) =>
    match(e)
      .returnType<Result<string | null, { kind: "commit_not_found" }>>()
      .with({ kind: "ref_not_found" }, () => err({ kind: "commit_not_found" }))
      .with({ kind: "file_not_found" }, () => ok(null))
      .exhaustive(),
  );
}
