import { err, type Result } from "neverthrow";
import * as R from "remeda";
import { match } from "ts-pattern";
import { classifyWithAst } from "../ast-classifier.js";
import { normaliseDepName } from "../ast-rules.js";
import type { SkillsCapabilities } from "../capabilities.js";
import { manifestErrorIssues, parseManifest } from "../manifest.js";
import { skillDir } from "../skill-files.js";
import { formatSkillFinding, runSkillGates } from "../skill-gates.js";
import { SKILL_BODY_FILE, SKILL_MANIFEST_FILE, type SkillFileTexts } from "../skill-source.js";
import type { ClassifierLog, SkillManifest } from "../types.js";
import { checkRegisterBody } from "./check-register-body.js";

/** A skill whose files passed register's step 4. */
export interface CheckedSkillFiles {
  manifest: SkillManifest;
  body: string;
  classifierLog: ClassifierLog;
}

/** Why register's step 4 refuses a skill's files. */
export type SkillFilesRejection =
  /** Terminal for the tip: the strings `RegisterResult.errors` carries, in register's order. */
  | { kind: "refused"; errors: readonly string[] }
  /** A parse or a walk threw: pausing, since nothing is wrong with the tip. */
  | { kind: "registrar_unavailable"; cause: "parser"; detail: string };

/**
 * Register's step 4 after `locateSkill`, on skill `name`'s `SKILL.md` and
 * `skill.py`: each file present, the manifest's parse, the name check, then
 * the register-time gates and the classifier on the tree the gates parsed
 * (`checkRegisterBody`). Each stage refuses alone. Register calls it on the
 * tip's files and the gates CLI on the working tree's, so the two refuse
 * alike (design/skills.md → The gates in verify). Reads nothing but its
 * arguments and the build's rules.
 */
export async function checkSkillFiles(
  name: string,
  files: SkillFileTexts,
  capabilities: SkillsCapabilities,
): Promise<Result<CheckedSkillFiles, SkillFilesRejection>> {
  if (files.manifest === null) return refused([missingFile(name, SKILL_MANIFEST_FILE)]);
  if (files.body === null) return refused([missingFile(name, SKILL_BODY_FILE)]);
  const parsed = parseSkillManifest(files.manifest);
  if (parsed.isErr()) return refused(parsed.error);
  const manifest = parsed.value;
  if (manifest.name !== name) {
    return refused([
      `skill_name_mismatch: ${skillDir(name)}${SKILL_MANIFEST_FILE} names the skill '${manifest.name}'; its directory must be ${skillDir(manifest.name)}`,
    ]);
  }
  const body = files.body;
  const checked = await checkRegisterBody(
    { runGates: runSkillGates, classify: classifyWithAst },
    { name, manifest, body },
    capabilities,
  );
  return checked
    .map((classifierLog) => ({ manifest, body, classifierLog }))
    .mapErr((rejection) =>
      match(rejection)
        .returnType<SkillFilesRejection>()
        .with({ kind: "lint_failed" }, ({ findings }) => ({
          kind: "refused",
          errors: findings.map(formatSkillFinding),
        }))
        .with({ kind: "classifier_rejected" }, ({ validationErrors }) => ({
          kind: "refused",
          errors: [validationErrors.join("; ")],
        }))
        .with({ kind: "registrar_unavailable" }, (unavailable) => unavailable)
        .exhaustive(),
    );
}

/**
 * The dependency names skill `name`'s `SKILL.md` declares, PEP 503-normalized
 * and each once, from the manifest as register parses it. Errs with the
 * strings {@link checkSkillFiles} refuses with for a manifest that is absent
 * or does not parse.
 */
export function declaredDependencyNames(
  name: string,
  manifest: string | null,
): Result<readonly string[], readonly string[]> {
  if (manifest === null) return err([missingFile(name, SKILL_MANIFEST_FILE)]);
  return parseSkillManifest(manifest).map((parsed) =>
    R.unique(parsed.dependencies.map(normaliseDepName)),
  );
}

function parseSkillManifest(source: string): Result<SkillManifest, readonly string[]> {
  return parseManifest(source)
    .map((parsed) => parsed.manifest)
    .mapErr(manifestErrorIssues);
}

function refused(errors: readonly string[]): Result<never, SkillFilesRejection> {
  return err({ kind: "refused", errors });
}

function missingFile(
  name: string,
  file: typeof SKILL_MANIFEST_FILE | typeof SKILL_BODY_FILE,
): string {
  const id = match(file)
    .with(SKILL_MANIFEST_FILE, () => "missing_skill_md")
    .with(SKILL_BODY_FILE, () => "missing_skill_py")
    .exhaustive();
  return `${id}: ${skillDir(name)}${file} not found`;
}
