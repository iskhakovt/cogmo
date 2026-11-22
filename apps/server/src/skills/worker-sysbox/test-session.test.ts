import { describe, expect, it, vi } from "vitest";
import type { SandboxCapabilities } from "../../sandbox/index.js";
import { expectDefined } from "../../test/assertions.js";
import {
  type ExecScript,
  type SessionHarness,
  sessionHarness,
} from "../../test/session-harness.js";
import { DEFAULT_DEPENDENCY_SESSION_LIMITS, RUNTIME_PYTHON } from "../deps.js";
import { makeSandboxSkillTests } from "./test-session.js";

const VOLUME = "cogmo-skills-venvs";
const LOCKFILE = { hash: "c".repeat(64), contents: "idna==3.10 --hash=sha256:00\n" };
const FILES = {
  "SKILL.md": "---\nname: echo\n---\n",
  "skill.py": "async def run(inputs, ctx):\n    return {}\n",
  "test_skill.py": "def test_a():\n    pass\n",
};
/** The runtime interpreter, which `deps.test.ts` pins against the skills image. */
const TEST_RUNNER = [RUNTIME_PYTHON, "-I", "-m", "cogmo_skills_runtime.skill_tests"];
const MIB = 1024 * 1024;

function reply(value: object): ExecScript {
  return { stdout: `${JSON.stringify(value)}\n`, exitCode: 0 };
}

const PASSED = reply({ type: "test_findings", findings: [], count: 2 });

function tests(h: SessionHarness, depsCacheVolumeName: string | undefined) {
  return makeSandboxSkillTests({
    sandbox: h.sandbox,
    image: "cogmo-skills:test",
    depsCacheVolumeName,
  });
}

function run(
  h: SessionHarness,
  overrides: Partial<Parameters<ReturnType<typeof makeSandboxSkillTests>["run"]>[0]> = {},
) {
  return tests(h, VOLUME).run({
    files: FILES,
    lockfile: null,
    resourceLimits: {},
    signal: undefined,
    ...overrides,
  });
}

describe("makeSandboxSkillTests", () => {
  it("runs the suite in one session with no network, under the defaults, and counts what passed", async () => {
    const h = sessionHarness({}, PASSED);
    const before = Date.now();

    const ran = await run(h);

    expect(ran._unsafeUnwrap()).toBe(2);
    const [spec] = h.specs;
    expect(spec).toMatchObject({
      network: "none",
      image: "cogmo-skills:test",
      resourceLimits: DEFAULT_DEPENDENCY_SESSION_LIMITS,
    });
    expect(spec).not.toHaveProperty("depsCacheVolume");
    // The suite's 60 s and the runner's 30 s, then the 60 s margin before the reaper may take it.
    const expiry = expectDefined(spec, "spec").expiresAt.getTime() - before;
    expect(expiry).toBeGreaterThanOrEqual(150_000);
    expect(expiry).toBeLessThan(151_000);
    expect(h.execs).toEqual([
      { cmd: TEST_RUNNER, stdin: JSON.stringify({ files: FILES, lockfileHash: null }) },
    ]);
    expect(h.deleted).toBe(1);
  });

  it.each([
    {
      name: "more memory and CPU than the defaults",
      skill: { memory_bytes: 1024 * MIB, cpus: 2 },
      limits: { ...DEFAULT_DEPENDENCY_SESSION_LIMITS, memory_bytes: 1024 * MIB, cpus: 2 },
    },
    {
      name: "less than the defaults",
      skill: { memory_bytes: 128 * MIB, cpus: 0.5 },
      limits: DEFAULT_DEPENDENCY_SESSION_LIMITS,
    },
    {
      name: "more memory alone",
      skill: { memory_bytes: 768 * MIB },
      limits: { ...DEFAULT_DEPENDENCY_SESSION_LIMITS, memory_bytes: 768 * MIB },
    },
  ])("takes the larger of the defaults and a skill asking $name", async ({ skill, limits }) => {
    const h = sessionHarness({}, PASSED);

    await run(h, { resourceLimits: skill });

    expect(h.specs.map((s) => s.resourceLimits)).toEqual([limits]);
  });

  it("mounts the shared venv volume for a skill with dependencies, naming the lockfile's hash", async () => {
    const h = sessionHarness({}, PASSED);
    const files = { ...FILES, "requirements.lock": LOCKFILE.contents };

    const ran = await run(h, { files, lockfile: LOCKFILE });

    expect(ran.isOk()).toBe(true);
    expect(h.specs.map((s) => [s.network, s.depsCacheVolume])).toEqual([
      ["none", { volumeName: VOLUME }],
    ]);
    expect(h.execs.map((e) => JSON.parse(e.stdin))).toEqual([
      { files, lockfileHash: LOCKFILE.hash },
    ]);
  });

  it("refuses with the suite's findings", async () => {
    const findings = [
      { line: 4, message: "test_a: AssertionError: assert 1 == 2" },
      { line: null, message: "and 3 more tests findings" },
    ];
    const h = sessionHarness({}, reply({ type: "test_findings", findings, count: 104 }));

    expect((await run(h))._unsafeUnwrapErr()).toEqual({ kind: "failed", findings });
  });

  it("refuses a pass that counts no test, which only code under test writes", async () => {
    const h = sessionHarness({}, reply({ type: "test_findings", findings: [], count: 0 }));

    expect((await run(h))._unsafeUnwrapErr()).toEqual({
      kind: "failed",
      findings: [{ line: null, message: "a pass with no test" }],
    });
  });

  it("refuses a reply past the host's read, which only code under test writes", async () => {
    const h = sessionHarness({}, { stdout: "x".repeat(MIB + 1), exitCode: 0 });

    expect((await run(h))._unsafeUnwrapErr()).toEqual({
      kind: "failed",
      findings: [
        { line: null, message: "the test runner wrote more than 1048576 bytes to stdout" },
      ],
    });
    expect(h.deleted).toBe(1);
  });

  it.each([
    {
      name: "fatal",
      script: reply({
        type: "fatal",
        error: "the skill venv has no site-packages at /skill-venvs/x",
      }),
      detail: "the suite could not run: the skill venv has no site-packages at /skill-venvs/x",
    },
    {
      name: "no reply",
      script: { stderr: "Killed\n", exitCode: 137 },
      detail: "the test runner exited 137 with no reply: Killed",
    },
    {
      name: "an exec that times out",
      script: { failure: { kind: "timed_out", deadline: "total", timeoutMs: 90_000 } },
      detail: "the test runner timed out after 90000ms",
    },
  ] satisfies { name: string; script: ExecScript; detail: string }[])(
    "reads $name as a suite that could not run",
    async ({ script, detail }) => {
      const h = sessionHarness({}, script);

      expect((await run(h))._unsafeUnwrapErr()).toEqual({ kind: "unavailable", detail });
      expect(h.deleted).toBe(1);
    },
  );

  it("masks a secret the fatal reply quotes from pytest's output", async () => {
    const h = sessionHarness(
      {},
      reply({
        type: "fatal",
        error: "pytest refused its command line: fetching https://owner:hunter2@example.com/plugin",
      }),
    );

    expect((await run(h))._unsafeUnwrapErr()).toEqual({
      kind: "unavailable",
      detail:
        "the suite could not run: pytest refused its command line: fetching https://REDACTED@example.com/plugin",
    });
  });

  it("reads a session that does not start as a suite that could not run", async () => {
    const h = sessionHarness({});
    vi.mocked(h.sandbox.create).mockRejectedValueOnce(new Error("daemon unreachable"));

    expect((await run(h))._unsafeUnwrapErr()).toEqual({
      kind: "unavailable",
      detail: "test session did not start: daemon unreachable",
    });
  });

  it("stops the suite the register's signal aborts, and deletes the session", async () => {
    const h = sessionHarness({}, { hang: true });
    const controller = new AbortController();

    const pending = run(h, { signal: controller.signal });
    await vi.waitFor(() => expect(h.execs).toHaveLength(1));
    controller.abort(new Error("register deadline"));

    expect((await pending)._unsafeUnwrapErr()).toEqual({
      kind: "unavailable",
      detail: "the test runner was stopped",
    });
    expect(h.deleted).toBe(1);
  });

  it("tells register whether its backend creates sessions with no network and shares a venv volume", () => {
    const daytona: Partial<SandboxCapabilities> = { noNetworkSessions: false };

    expect(tests(sessionHarness({}), VOLUME)).toMatchObject({ offline: true, sharedVenv: true });
    expect(tests(sessionHarness(daytona), undefined)).toMatchObject({
      offline: false,
      sharedVenv: false,
    });
  });

  it("throws on a run its backend or volume cannot hold, a caller bug", async () => {
    await expect(
      tests(sessionHarness({ noNetworkSessions: false }), VOLUME).run({
        files: FILES,
        lockfile: null,
        resourceLimits: {},
        signal: undefined,
      }),
    ).rejects.toThrow("the backend creates no session with no network");
    await expect(
      tests(sessionHarness({}), undefined).run({
        files: FILES,
        lockfile: LOCKFILE,
        resourceLimits: {},
        signal: undefined,
      }),
    ).rejects.toThrow("a lockfile needs the shared venv volume");
  });
});
