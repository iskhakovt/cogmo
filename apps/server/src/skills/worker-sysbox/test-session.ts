import { err, ok, type Result } from "neverthrow";
import { match, P } from "ts-pattern";
import type { ResourceLimits } from "../../sandbox/index.js";
import { DEFAULT_DEPENDENCY_SESSION_LIMITS, RUNTIME_PYTHON } from "../deps.js";
import { SkillTestsReplySchema, type SkillTestsRequest } from "../protocol.js";
import type { SkillTests, SkillTestsError } from "../skill-tests.js";
import { execForReply, type SkillsSessionHost, withOneShotSession } from "./one-shot-session.js";

/** The suite's 60 s cap, which the runner enforces, and 30 s for the runner around it. */
const TEST_TIMEOUT_MS = 90_000;

export interface SandboxSkillTestsOptions extends SkillsSessionHost {
  /**
   * The shared venv volume, which carries register's install session's venv
   * to the test session; a lockfile without it is a caller bug.
   */
  depsCacheVolumeName: string | undefined;
}

/**
 * The test session's limits: memory and CPU each the larger of the
 * dependency sessions' defaults and the skill's own, pids and disk the
 * defaults', so the suite never gets less than the defaults.
 */
function testSessionLimits(skill: Partial<ResourceLimits>): ResourceLimits {
  return {
    ...DEFAULT_DEPENDENCY_SESSION_LIMITS,
    memory_bytes: Math.max(DEFAULT_DEPENDENCY_SESSION_LIMITS.memory_bytes, skill.memory_bytes ?? 0),
    cpus: Math.max(DEFAULT_DEPENDENCY_SESSION_LIMITS.cpus, skill.cpus ?? 0),
  };
}

/**
 * The {@link SkillTests} over a session of the skills image created with no
 * network, deleted whatever the outcome (design/skills.md → Register-time
 * tests → The session).
 */
export function makeSandboxSkillTests(opts: SandboxSkillTestsOptions): SkillTests {
  const offline = opts.sandbox.capabilities.noNetworkSessions;
  const volumeName = opts.depsCacheVolumeName;
  return {
    offline,
    sharedVenv: volumeName !== undefined,
    async run({ files, lockfile, resourceLimits, signal }) {
      if (!offline) throw new Error("skill tests: the backend creates no session with no network");
      if (lockfile !== null && volumeName === undefined) {
        throw new Error("skill tests: a lockfile needs the shared venv volume");
      }
      const unavailable = (detail: string): SkillTestsError => ({ kind: "unavailable", detail });
      const request: SkillTestsRequest = { files, lockfileHash: lockfile?.hash ?? null };
      const replied = await withOneShotSession(
        opts,
        {
          name: "test",
          network: "none",
          depsCacheVolume:
            lockfile === null || volumeName === undefined ? undefined : { volumeName },
          resourceLimits: testSessionLimits(resourceLimits),
          budgetMs: TEST_TIMEOUT_MS,
        },
        signal,
        unavailable,
        async (session) => {
          const reply = await execForReply(session, {
            argv: [RUNTIME_PYTHON, "-I", "-m", "cogmo_skills_runtime.skill_tests"],
            stdin: JSON.stringify(request),
            schema: SkillTestsReplySchema,
            timeoutMs: TEST_TIMEOUT_MS,
            signal,
            label: "the test runner",
          });
          // A reply past its cap is the tip's: only code under test writes there.
          return reply.mapErr((e) =>
            match(e)
              .returnType<SkillTestsError>()
              .with({ kind: "overflow" }, ({ message }) => ({
                kind: "failed",
                findings: [{ line: null, message }],
              }))
              .with({ kind: "failed" }, ({ message }) => unavailable(message))
              .exhaustive(),
          );
        },
      );
      if (replied.isErr()) return err(replied.error);
      return match(replied.value)
        .returnType<Result<number, SkillTestsError>>()
        .with({ type: "test_findings", findings: [], count: P.number.positive() }, ({ count }) =>
          ok(count),
        )
        .with({ type: "test_findings" }, ({ findings }) =>
          err({
            kind: "failed",
            // A pass that counts no test is a reply code under test wrote.
            findings:
              findings.length > 0 ? findings : [{ line: null, message: "a pass with no test" }],
          }),
        )
        .with({ type: "fatal" }, ({ error }) =>
          err(unavailable(`the suite could not run: ${error}`)),
        )
        .exhaustive();
    },
  };
}
