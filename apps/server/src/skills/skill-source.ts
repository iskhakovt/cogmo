import { err, ok, type Result } from "neverthrow";
import { gitShow } from "./git-ops.js";
import { manifestErrorIssues, parseManifest } from "./manifest.js";
import type { SkillManifest } from "./types.js";

export const SKILL_MANIFEST_FILE = "SKILL.md";
export const SKILL_BODY_FILE = "skill.py";

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
 * Read and parse the skill committed at `sha`: `SKILL.md`, then `skill.py`.
 * Errs when `sha` does not resolve, either file is absent, or the manifest
 * does not parse.
 */
export async function readSkillSource(
  repoPath: string,
  sha: string,
): Promise<Result<SkillSource, SkillSourceError>> {
  const manifestSource = await readFileAtSha(repoPath, sha, SKILL_MANIFEST_FILE);
  if (manifestSource.isErr()) return err(manifestSource.error);
  const body = await readFileAtSha(repoPath, sha, SKILL_BODY_FILE);
  if (body.isErr()) return err(body.error);
  const parsed = parseManifest(manifestSource.value);
  if (parsed.isErr()) {
    return err({ kind: "invalid_manifest", issues: manifestErrorIssues(parsed.error) });
  }
  return ok({ manifest: parsed.value.manifest, body: body.value });
}

async function readFileAtSha(
  repoPath: string,
  sha: string,
  file: typeof SKILL_MANIFEST_FILE | typeof SKILL_BODY_FILE,
): Promise<Result<string, SkillSourceError>> {
  return (await gitShow(repoPath, sha, file)).mapErr((e) =>
    e.kind === "ref_not_found" ? { kind: "commit_not_found" } : { kind: "missing_file", file },
  );
}
