import { err, ok } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { logger } from "../../logger.js";
import type { SkillTests } from "../skill-tests.js";
import type { SkillManifest, SkillTestsNotRun } from "../types.js";
import { checkRegisterTests } from "./check-register-tests.js";

const MANIFEST: SkillManifest = {
  name: "echo",
  description: "check-register-tests fixture skill",
  tier: "container",
  triggers: ["manual"],
  inputs: { type: "object", properties: {} },
  effects: [],
  secrets: [],
  dependencies: [],
  cost_per_call_usd: 0,
};
const FILES = {
  "SKILL.md": "---\nname: echo\n---\n",
  "skill.py": "async def run(inputs, ctx):\n    return {}\n",
  "test_skill.py": "def test_a():\n    pass\n",
};
const LOCKFILE = { hash: "c".repeat(64), contents: "idna==3.10 --hash=sha256:00\n" };
const WASM: SkillManifest = { ...MANIFEST, tier: "wasm" };
/** A container-tier skill with a test file, off `main`, which a capable deployment tests. */
const SKILL = { name: "echo", manifest: MANIFEST, lockfile: null, files: FILES, atMain: false };
const OPTS = { testRunner: true, signal: undefined };

/** A deployment's tests: offline and sharing a venv volume unless told otherwise. */
function testsAnswering(
  answer: Awaited<ReturnType<SkillTests["run"]>>,
  capabilities: Partial<Pick<SkillTests, "offline" | "sharedVenv">> = {},
): SkillTests {
  const tests = mock<SkillTests>({ offline: true, sharedVenv: true, ...capabilities });
  tests.run.mockResolvedValue(answer);
  return tests;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkRegisterTests", () => {
  it("records the count that passed, handing the suite the files, the lockfile, the skill's limits and the signal", async () => {
    const tests = testsAnswering(ok(3));
    const signal = new AbortController().signal;
    const manifest = { ...MANIFEST, resources: { memory_mb: 256, cpu_shares: 2 } };

    const checked = await checkRegisterTests(
      tests,
      { ...SKILL, manifest, lockfile: LOCKFILE },
      { ...OPTS, signal },
    );

    expect(checked._unsafeUnwrap()).toEqual({ kind: "passed", count: 3 });
    expect(tests.run).toHaveBeenCalledWith({
      files: FILES,
      lockfile: LOCKFILE,
      resourceLimits: { memory_bytes: 256 * 1024 * 1024, cpus: 2 },
      signal,
    });
  });

  // Each row of design/skills.md → Which registers run the suite, with every
  // row below it applying too, so the first that applies decides.
  it.each([
    {
      reason: "no_sandbox",
      tests: undefined,
      skill: { files: null, atMain: true, manifest: WASM, lockfile: LOCKFILE },
      testRunner: false,
    },
    {
      reason: "no_test_file",
      tests: { offline: false, sharedVenv: false },
      skill: { files: null, atMain: true, manifest: WASM, lockfile: LOCKFILE },
      testRunner: false,
    },
    {
      reason: "tip_is_main",
      tests: { offline: false, sharedVenv: false },
      skill: { atMain: true, manifest: WASM, lockfile: LOCKFILE },
      testRunner: false,
    },
    {
      reason: "wasm_tier_held",
      tests: { offline: false, sharedVenv: false },
      skill: { manifest: WASM, lockfile: LOCKFILE },
      testRunner: false,
    },
    {
      reason: "no_offline_session",
      tests: { offline: false, sharedVenv: false },
      skill: { lockfile: LOCKFILE },
      testRunner: false,
    },
    {
      reason: "no_shared_venv",
      tests: { sharedVenv: false },
      skill: { lockfile: LOCKFILE },
      testRunner: false,
    },
    { reason: "image_lacks_runner", tests: {}, skill: {}, testRunner: false },
  ] satisfies {
    reason: SkillTestsNotRun;
    tests: Partial<Pick<SkillTests, "offline" | "sharedVenv">> | undefined;
    skill: Partial<Parameters<typeof checkRegisterTests>[1]>;
    testRunner: boolean;
  }[])(
    "records not_run: $reason, starting no session",
    async ({ reason, tests, skill, testRunner }) => {
      const deployment = tests === undefined ? undefined : testsAnswering(ok(1), tests);

      const checked = await checkRegisterTests(
        deployment,
        { ...SKILL, ...skill },
        { ...OPTS, testRunner },
      );

      expect(checked._unsafeUnwrap()).toEqual({ kind: "not_run", reason });
      if (deployment !== undefined) expect(deployment.run).not.toHaveBeenCalled();
    },
  );

  it("runs a dependency-free skill's suite without the shared venv volume", async () => {
    const tests = testsAnswering(ok(1), { sharedVenv: false });

    const checked = await checkRegisterTests(tests, SKILL, OPTS);

    expect(checked._unsafeUnwrap()).toEqual({ kind: "passed", count: 1 });
  });

  it("refuses the suite's findings, each at test_skill.py", async () => {
    const tests = testsAnswering(
      err({
        kind: "failed",
        findings: [
          { line: 4, message: "test_a: AssertionError: assert 1 == 2" },
          { line: null, message: "the suite reached its 60 s cap" },
        ],
      }),
    );

    const checked = await checkRegisterTests(tests, SKILL, OPTS);

    expect(checked._unsafeUnwrapErr()).toEqual({
      kind: "tests_failed",
      findings: [
        {
          id: "tests",
          path: "skills/echo/test_skill.py",
          line: 4,
          column: null,
          message: "test_a: AssertionError: assert 1 == 2",
        },
        {
          id: "tests",
          path: "skills/echo/test_skill.py",
          line: null,
          column: null,
          message: "the suite reached its 60 s cap",
        },
      ],
    });
  });

  it("pauses on a suite that could not run, logged at error", async () => {
    const error = vi.spyOn(logger, "error");
    const detail = "the suite could not run: pytest refused its command line";
    const tests = testsAnswering(err({ kind: "unavailable", detail }));

    const checked = await checkRegisterTests(tests, SKILL, OPTS);

    expect(checked._unsafeUnwrapErr()).toEqual({
      kind: "registrar_unavailable",
      cause: "sandbox",
      detail,
    });
    expect(error).toHaveBeenCalledWith(
      { skillName: "echo", detail },
      "the skill's tests could not run; the register pauses",
    );
  });
});
