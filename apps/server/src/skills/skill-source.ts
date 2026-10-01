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
  | { kind: "missing_file"; file: typeof SKILL_MANIFEST_FILE | typeof SKILL_BODY_FILE }
  | { kind: "invalid_manifest"; issues: readonly string[] };

/**
 * Read and parse the skill committed at `sha`: `SKILL.md`, then `skill.py`.
 * Errs when either file is absent or the manifest does not parse. Throws
 * when `sha` itself does not resolve: every caller has resolved it first,
 * so a missing commit is a repo fault, not an authoring mistake.
 */
export async function readSkillSource(
  repoPath: string,
  sha: string,
): Promise<Result<SkillSource, SkillSourceError>> {
  const manifestSource = await readFileAtSha(repoPath, sha, SKILL_MANIFEST_FILE);
  if (manifestSource === null) return err({ kind: "missing_file", file: SKILL_MANIFEST_FILE });
  const body = await readFileAtSha(repoPath, sha, SKILL_BODY_FILE);
  if (body === null) return err({ kind: "missing_file", file: SKILL_BODY_FILE });
  const parsed = parseManifest(manifestSource);
  if (parsed.isErr()) {
    return err({ kind: "invalid_manifest", issues: manifestErrorIssues(parsed.error) });
  }
  return ok({ manifest: parsed.value.manifest, body });
}

/** The file's contents at `sha`, or null when the commit has no such path. */
async function readFileAtSha(repoPath: string, sha: string, file: string): Promise<string | null> {
  const shown = await gitShow(repoPath, sha, file);
  if (shown.isOk()) return shown.value;
  if (shown.error.kind === "ref_not_found") {
    throw new Error(`readSkillSource: commit ${sha} not found in ${repoPath}`);
  }
  return null;
}
