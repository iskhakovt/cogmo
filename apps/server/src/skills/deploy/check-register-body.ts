import { err, ok, type Result, ResultAsync } from "neverthrow";
import { logger } from "../../logger.js";
import { describeError } from "../../util/describe-error.js";
import type { SkillsCapabilities } from "../capabilities.js";
import type { SkillFinding } from "../skill-gates.js";
import type { ClassifierLog, SkillManifest } from "../types.js";

const log = logger.child({ component: "skills.register" });

/** The skill register's body checks read: its name, parsed frontmatter and `skill.py`. */
interface CheckedSkill {
  name: string;
  manifest: SkillManifest;
  body: string;
}

/** The checks, each throwing when its parse or a walk throws. */
interface RegisterBodyChecks {
  /** The register-time gates' three stages (`runSkillGates`). */
  runGates(skill: CheckedSkill): Promise<readonly SkillFinding[]>;
  /** The AST classifier as register runs it (`classifyWithAst`). */
  classify(
    manifest: SkillManifest,
    body: string,
    capabilities: SkillsCapabilities,
  ): Promise<ClassifierLog>;
}

/** Why register's body checks refuse a tip (design/skills.md → Register-time gates → Outcomes). */
export type RegisterBodyRejection =
  /** The gates' and `wasm-lint`'s findings, terminal for the tip. */
  | { kind: "lint_failed"; findings: readonly SkillFinding[] }
  /** Undeclared effects the classifier detected, terminal for the tip. */
  | { kind: "classifier_rejected"; validationErrors: readonly string[] }
  /** A parse or a walk threw: pausing, since nothing is wrong with the tip. */
  | { kind: "registrar_unavailable"; cause: "parser"; detail: string };

/**
 * Register's step-4 checks of `skill.py`, before its transaction and its
 * sandbox sessions: the register-time gates' three stages, then the AST
 * classifier, each rejecting with one kind. A throw from either is the
 * pausing `registrar_unavailable` (`parser`), logged at error.
 */
export async function checkRegisterBody(
  checks: RegisterBodyChecks,
  skill: CheckedSkill,
  capabilities: SkillsCapabilities,
): Promise<Result<ClassifierLog, RegisterBodyRejection>> {
  const judged = await ResultAsync.fromPromise(judge(checks, skill, capabilities), describeError);
  return judged.match(
    (verdict) => verdict,
    (detail) => {
      log.error(
        { skillName: skill.name, detail },
        "the register-time gates could not run; the register pauses",
      );
      return err({ kind: "registrar_unavailable", cause: "parser", detail });
    },
  );
}

/** The gates, then the classifier; throws when a parse or a walk throws. */
async function judge(
  checks: RegisterBodyChecks,
  skill: CheckedSkill,
  capabilities: SkillsCapabilities,
): Promise<Result<ClassifierLog, RegisterBodyRejection>> {
  const findings = await checks.runGates(skill);
  if (findings.length > 0) return err({ kind: "lint_failed", findings });
  const classifierLog = await checks.classify(skill.manifest, skill.body, capabilities);
  return classifierLog.validation_errors.length > 0
    ? err({ kind: "classifier_rejected", validationErrors: classifierLog.validation_errors })
    : ok(classifierLog);
}
