import { err, ok, type Result, ResultAsync } from "neverthrow";
import { describeError } from "../../util/describe-error.js";
import type { SkillsCapabilities } from "../capabilities.js";
import type { SkillTree } from "../python-ast.js";
import type { SkillFinding } from "../skill-gates.js";
import type { ClassifierLog, SkillManifest } from "../types.js";

/** The skill register's body checks read: its name, parsed frontmatter and `skill.py`. */
interface CheckedSkill {
  name: string;
  manifest: SkillManifest;
  body: string;
}

/** The checks, each throwing when its parse or a walk throws. */
interface RegisterBodyChecks {
  /**
   * The register-time gates' three stages, which hand the tree they parsed to
   * `read` once they pass (`runSkillGates`).
   */
  runGates(
    skill: CheckedSkill,
    read: (tree: SkillTree) => ClassifierLog,
  ): Promise<Result<ClassifierLog, readonly SkillFinding[]>>;
  /** The AST classifier as register runs it, on the gates' tree (`classifyWithAst`). */
  classify(
    tree: SkillTree,
    manifest: SkillManifest,
    capabilities: SkillsCapabilities,
  ): ClassifierLog;
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
 * classifier on the tree the gates parsed, each rejecting with one kind. A
 * throw from either is the pausing `registrar_unavailable` (`parser`), which
 * the caller logs: this runs in the gates bundle too, which carries no logger.
 */
export async function checkRegisterBody(
  checks: RegisterBodyChecks,
  skill: CheckedSkill,
  capabilities: SkillsCapabilities,
): Promise<Result<ClassifierLog, RegisterBodyRejection>> {
  const judged = await ResultAsync.fromPromise(judge(checks, skill, capabilities), describeError);
  return judged.match(
    (verdict) => verdict,
    (detail) => err({ kind: "registrar_unavailable", cause: "parser", detail }),
  );
}

/** The gates, then the classifier; throws when a parse or a walk throws. */
async function judge(
  checks: RegisterBodyChecks,
  skill: CheckedSkill,
  capabilities: SkillsCapabilities,
): Promise<Result<ClassifierLog, RegisterBodyRejection>> {
  const gated = await checks.runGates(skill, (tree) =>
    checks.classify(tree, skill.manifest, capabilities),
  );
  if (gated.isErr()) return err({ kind: "lint_failed", findings: gated.error });
  const classifierLog = gated.value;
  return classifierLog.validation_errors.length > 0
    ? err({ kind: "classifier_rejected", validationErrors: classifierLog.validation_errors })
    : ok(classifierLog);
}
