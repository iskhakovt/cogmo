import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import type { CpythonChecks } from "../cpython-checks.js";
import type { LockfileSnapshot } from "../deps.js";
import { skillDir } from "../skill-files.js";
import type { SkillFinding } from "../skill-gates.js";
import { SKILL_BODY_FILE } from "../skill-source.js";
import type { SkillManifest } from "../types.js";

const log = logger.child({ component: "skills.register" });

/** The skill register's CPython checks read. */
interface CheckedSkill {
  name: string;
  manifest: SkillManifest;
  body: string;
  lockfile: LockfileSnapshot | null;
}

/** Why register's CPython checks refuse a tip (design/skills.md → Register-time CPython checks → Outcomes). */
export type RegisterCpythonRejection =
  /** The checks' findings, terminal for the tip. */
  | { kind: "lint_failed"; findings: readonly SkillFinding[] }
  /** uv refused the lockfile's content, terminal for the tip. */
  | { kind: "lockfile_invalid"; detail: string }
  /** A check could not run: pausing, since nothing is wrong with the tip. */
  | { kind: "registrar_unavailable"; cause: "sandbox"; detail: string };

/**
 * Register's CPython checks, after its lockfile compile and before its schema
 * import. Resolves to the release version of the toolchain that ran them, or
 * null where none ran: with no sandbox backend configured, register skips
 * them, logged at warn. A version other than the server's `releaseVersion`
 * is logged at warn; a check that cannot run at error.
 */
export async function checkRegisterCpython(
  checks: CpythonChecks | undefined,
  skill: CheckedSkill,
  opts: { releaseVersion: string; signal: AbortSignal | undefined },
): Promise<Result<string | null, RegisterCpythonRejection>> {
  if (checks === undefined) {
    log.warn(
      { skillName: skill.name },
      "no sandbox backend is configured: register skips the lockfile compile and the CPython checks",
    );
    return ok(null);
  }
  const checked = await checks.check({
    body: skill.body,
    dependencies: skill.manifest.dependencies,
    lockfile: skill.lockfile,
    signal: opts.signal,
  });
  if (checked.isErr()) {
    return err(
      match(checked.error)
        .returnType<RegisterCpythonRejection>()
        .with({ kind: "lockfile_invalid" }, ({ detail }) => ({ kind: "lockfile_invalid", detail }))
        .with({ kind: "unavailable" }, ({ detail }) => {
          log.error(
            { skillName: skill.name, detail },
            "the CPython checks could not run; the register pauses",
          );
          return { kind: "registrar_unavailable", cause: "sandbox", detail };
        })
        .exhaustive(),
    );
  }
  const { findings, toolchainVersion } = checked.value;
  if (toolchainVersion !== opts.releaseVersion) {
    log.warn(
      { skillName: skill.name, toolchainVersion, releaseVersion: opts.releaseVersion },
      "the skills image's toolchain belongs to another release than the server's",
    );
  }
  if (findings.length > 0) {
    const path = `${skillDir(skill.name)}${SKILL_BODY_FILE}`;
    return err({ kind: "lint_failed", findings: findings.map((f) => ({ ...f, path })) });
  }
  return ok(toolchainVersion);
}
