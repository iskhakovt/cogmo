import { ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import type { LockfileSnapshot } from "../deps.js";
import { mapManifestResourceLimits } from "../invoke/runtime.js";
import type { SkillTestsRequest } from "../protocol.js";
import { skillDir } from "../skill-files.js";
import type { SkillFinding } from "../skill-gates.js";
import { SKILL_TEST_FILE } from "../skill-source.js";
import type { SkillTests } from "../skill-tests.js";
import type { SkillManifest, SkillTestsNotRun, SkillTestsRecord } from "../types.js";

const log = logger.child({ component: "skills.register" });

/** The skill register's tests read. */
interface TestedSkill {
  name: string;
  manifest: SkillManifest;
  lockfile: LockfileSnapshot | null;
  /** The skill's files at the tip; null without a `test_skill.py`. */
  files: SkillTestsRequest["files"] | null;
  /** Whether the tip is `main`, which carries no change register has not judged. */
  atMain: boolean;
}

/** Why register's tests refuse a tip (design/skills.md → Register-time tests → Outcomes). */
export type RegisterTestsRejection =
  /** The suite's findings, terminal for the tip. */
  | { kind: "tests_failed"; findings: readonly SkillFinding[] }
  /** The suite could not run: pausing, since nothing is wrong with the tip. */
  | { kind: "registrar_unavailable"; cause: "sandbox"; detail: string };

/** Whether register runs the suite, and why not when it does not. */
type TestsPlan =
  | { kind: "not_run"; reason: SkillTestsNotRun }
  | { kind: "run"; tests: SkillTests; files: SkillTestsRequest["files"] };

/**
 * The first row of design/skills.md → Register-time tests → Which registers
 * run the suite that applies. `testRunner` is the check reply's.
 */
function planTests(
  tests: SkillTests | undefined,
  skill: TestedSkill,
  testRunner: boolean,
): TestsPlan {
  const notRun = (reason: SkillTestsNotRun): TestsPlan => ({ kind: "not_run", reason });
  if (tests === undefined) return notRun("no_sandbox");
  if (skill.files === null) return notRun("no_test_file");
  if (skill.atMain) return notRun("tip_is_main");
  if (skill.manifest.tier === "wasm") return notRun("wasm_tier_held");
  if (!tests.offline) return notRun("no_offline_session");
  if (skill.lockfile !== null && !tests.sharedVenv) return notRun("no_shared_venv");
  if (!testRunner) return notRun("image_lacks_runner");
  return { kind: "run", tests, files: skill.files };
}

/**
 * Register's run of a container-tier skill's tests, after its schemas and
 * last in step 5. Resolves to what the deploy's classifier log records: the
 * count that passed, or why the suite did not run. A suite that cannot run is
 * logged at error.
 */
export async function checkRegisterTests(
  tests: SkillTests | undefined,
  skill: TestedSkill,
  opts: { testRunner: boolean; signal: AbortSignal | undefined },
): Promise<Result<SkillTestsRecord, RegisterTestsRejection>> {
  return match(planTests(tests, skill, opts.testRunner))
    .returnType<Promise<Result<SkillTestsRecord, RegisterTestsRejection>>>()
    .with({ kind: "not_run" }, async ({ reason }) => ok({ kind: "not_run", reason }))
    .with({ kind: "run" }, async (plan) => {
      const ran = await plan.tests.run({
        files: plan.files,
        lockfile: skill.lockfile,
        resourceLimits: mapManifestResourceLimits(skill.manifest.resources),
        signal: opts.signal,
      });
      const path = `${skillDir(skill.name)}${SKILL_TEST_FILE}`;
      return ran
        .map((count): SkillTestsRecord => ({ kind: "passed", count }))
        .mapErr((e) =>
          match(e)
            .returnType<RegisterTestsRejection>()
            .with({ kind: "failed" }, ({ findings }) => ({
              kind: "tests_failed",
              findings: findings.map((f) => ({ id: "tests", path, column: null, ...f })),
            }))
            .with({ kind: "unavailable" }, ({ detail }) => {
              log.error(
                { skillName: skill.name, detail },
                "the skill's tests could not run; the register pauses",
              );
              return { kind: "registrar_unavailable", cause: "sandbox", detail };
            })
            .exhaustive(),
        );
    })
    .exhaustive();
}
