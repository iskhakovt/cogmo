import { err, ok } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { logger } from "../../logger.js";
import type { CpythonChecks } from "../cpython-checks.js";
import type { SkillManifest } from "../types.js";
import { checkRegisterCpython } from "./check-register-cpython.js";

const MANIFEST: SkillManifest = {
  name: "echo",
  description: "check-register-cpython fixture skill",
  tier: "container",
  triggers: ["manual"],
  inputs: { type: "object", properties: {} },
  effects: [],
  secrets: [],
  dependencies: ["idna==3.10"],
  cost_per_call_usd: 0,
};

const LOCKFILE = { hash: "c".repeat(64), contents: "idna==3.10 --hash=sha256:00\n" };
const SKILL = { name: "echo", manifest: MANIFEST, body: "import idna\n", lockfile: LOCKFILE };
const OPTS = { releaseVersion: "2.17.0", signal: undefined };

function checksAnswering(answer: Awaited<ReturnType<CpythonChecks["check"]>>) {
  const checks = mock<CpythonChecks>();
  checks.check.mockResolvedValue(answer);
  return checks;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkRegisterCpython", () => {
  it("resolves to the toolchain version of checks that pass, handing them the skill and the signal", async () => {
    const checks = checksAnswering(ok({ findings: [], toolchainVersion: "2.17.0" }));
    const signal = new AbortController().signal;

    const checked = await checkRegisterCpython(checks, SKILL, { ...OPTS, signal });

    expect(checked._unsafeUnwrap()).toBe("2.17.0");
    expect(checks.check).toHaveBeenCalledWith({
      body: "import idna\n",
      dependencies: ["idna==3.10"],
      lockfile: LOCKFILE,
      signal,
    });
  });

  it("skips the checks, warning, when no sandbox backend is configured", async () => {
    const warn = vi.spyOn(logger, "warn");

    const checked = await checkRegisterCpython(undefined, SKILL, OPTS);

    expect(checked._unsafeUnwrap()).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      { skillName: "echo" },
      "no sandbox backend is configured: register skips the lockfile compile and the CPython checks",
    );
  });

  it("refuses the checks' findings, each at skill.py", async () => {
    const checks = checksAnswering(
      ok({
        findings: [
          { id: "imports", line: 1, column: 1, message: "'requests' is not allowed" },
          { id: "syntax", line: null, column: null, message: "null bytes" },
        ],
        toolchainVersion: "2.17.0",
      }),
    );

    const checked = await checkRegisterCpython(checks, SKILL, OPTS);

    expect(checked._unsafeUnwrapErr()).toEqual({
      kind: "lint_failed",
      findings: [
        {
          id: "imports",
          path: "skills/echo/skill.py",
          line: 1,
          column: 1,
          message: "'requests' is not allowed",
        },
        {
          id: "syntax",
          path: "skills/echo/skill.py",
          line: null,
          column: null,
          message: "null bytes",
        },
      ],
    });
  });

  it("refuses a lockfile uv will not install", async () => {
    const checks = checksAnswering(
      err({ kind: "lockfile_invalid", detail: "Hash mismatch for `idna==3.10`" }),
    );

    const checked = await checkRegisterCpython(checks, SKILL, OPTS);

    expect(checked._unsafeUnwrapErr()).toEqual({
      kind: "lockfile_invalid",
      detail: "Hash mismatch for `idna==3.10`",
    });
  });

  it("pauses on a check that could not run, logged at error", async () => {
    const error = vi.spyOn(logger, "error");
    const checks = checksAnswering(
      err({ kind: "unavailable", detail: "the check runner timed out after 120000ms" }),
    );

    const checked = await checkRegisterCpython(checks, SKILL, OPTS);

    expect(checked._unsafeUnwrapErr()).toEqual({
      kind: "registrar_unavailable",
      cause: "sandbox",
      detail: "the check runner timed out after 120000ms",
    });
    expect(error).toHaveBeenCalledWith(
      { skillName: "echo", detail: "the check runner timed out after 120000ms" },
      "the CPython checks could not run; the register pauses",
    );
  });

  it.each([
    { toolchainVersion: "2.16.0", warns: true },
    { toolchainVersion: "2.17.0", warns: false },
  ])(
    "warns on the image's toolchain version $toolchainVersion: $warns",
    async ({ toolchainVersion, warns }) => {
      const warn = vi.spyOn(logger, "warn");
      const checks = checksAnswering(ok({ findings: [], toolchainVersion }));

      const checked = await checkRegisterCpython(checks, SKILL, OPTS);

      expect(checked._unsafeUnwrap()).toBe(toolchainVersion);
      expect(warn).toHaveBeenCalledTimes(warns ? 1 : 0);
      if (warns) {
        expect(warn).toHaveBeenCalledWith(
          { skillName: "echo", toolchainVersion, releaseVersion: "2.17.0" },
          "the skills image's toolchain belongs to another release than the server's",
        );
      }
    },
  );
});
