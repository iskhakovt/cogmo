import { describe, expect, it, vi } from "vitest";
import type { SandboxCapabilities } from "../../sandbox/index.js";
import { expectDefined } from "../../test/assertions.js";
import {
  type ExecScript,
  type SessionHarness,
  sessionHarness,
} from "../../test/session-harness.js";
import { isUuid } from "../../util/uuid.js";
import { DEFAULT_DEPENDENCY_SESSION_LIMITS } from "../deps.js";
import { makeSandboxCpythonChecks } from "./check-session.js";

const VOLUME = "cogmo-skills-venvs";
const LOCKFILE = { hash: "c".repeat(64), contents: "idna==3.10 --hash=sha256:00\n" };
const BODY = "import idna\n\n\nasync def run(inputs, ctx):\n    return idna.__name__\n";
const FINDING = { id: "ruff", line: 1, column: 8, message: "F401 `os` imported but unused" };
const FINDINGS_REPLY = `${JSON.stringify({
  type: "check_findings",
  findings: [FINDING],
  toolchainVersion: "2.17.0",
})}\n`;
const CHECK_RUNNER = ["python3", "-I", "-m", "cogmo_skills_runtime.check"];
/** The populate script's command: `sh -c <script> populate <hash> <worker id>`. */
const POPULATE = ["sh", "-c"];
const DAYTONA: Partial<SandboxCapabilities> = {
  noNetworkSessions: false,
  depsCacheSharing: "per-sandbox",
};

function checks(h: SessionHarness, depsCacheVolumeName: string | undefined) {
  return makeSandboxCpythonChecks({
    sandbox: h.sandbox,
    image: "cogmo-skills:test",
    depsCacheVolumeName,
  });
}

/** How long past its creation each recorded session expires. */
function expiries(h: SessionHarness, createdBy: number): number[] {
  return h.specs.map((spec) => spec.expiresAt.getTime() - createdBy);
}

describe("makeSandboxCpythonChecks", () => {
  it("checks a skill with no dependencies in one session with no network, under Cogmo's limits", async () => {
    const h = sessionHarness({}, { stdout: FINDINGS_REPLY, exitCode: 0 });
    const before = Date.now();

    const checked = await checks(h, VOLUME).check({
      body: BODY,
      dependencies: [],
      lockfile: null,
      signal: undefined,
    });

    expect(checked._unsafeUnwrap()).toEqual({ findings: [FINDING], toolchainVersion: "2.17.0" });
    expect(h.specs).toHaveLength(1);
    const [spec] = h.specs;
    expect(spec).toMatchObject({
      network: "none",
      image: "cogmo-skills:test",
      resourceLimits: DEFAULT_DEPENDENCY_SESSION_LIMITS,
    });
    expect(spec).not.toHaveProperty("depsCacheVolume");
    expect(isUuid(expectDefined(spec, "spec").taskId)).toBe(true);
    // The tools' 120 s, and the 60 s margin before the reaper may take it.
    const [expiry] = expiries(h, before);
    expect(expiry).toBeGreaterThanOrEqual(180_000);
    expect(expiry).toBeLessThan(181_000);
    expect(h.execs).toEqual([
      {
        cmd: CHECK_RUNNER,
        stdin: JSON.stringify({ body: BODY, dependencies: [], lockfileHash: null }),
      },
    ]);
    expect(h.deleted).toBe(1);
  });

  it("checks with the backend's network where it creates no session without one", async () => {
    const h = sessionHarness(DAYTONA, { stdout: FINDINGS_REPLY, exitCode: 0 });

    const checked = await checks(h, undefined).check({
      body: BODY,
      dependencies: [],
      lockfile: null,
      signal: undefined,
    });

    expect(checked.isOk()).toBe(true);
    expect(h.specs.map((s) => s.network)).toEqual(["bridge"]);
  });

  it("installs the dependencies on the shared volume with network, then checks with that volume and none", async () => {
    const h = sessionHarness({}, { exitCode: 0 }, { stdout: FINDINGS_REPLY, exitCode: 0 });
    const before = Date.now();

    const checked = await checks(h, VOLUME).check({
      body: BODY,
      dependencies: ["idna==3.10"],
      lockfile: LOCKFILE,
      signal: undefined,
    });

    expect(checked.isOk()).toBe(true);
    const volume = { volumeName: VOLUME };
    expect(h.specs.map((s) => [s.network, s.depsCacheVolume, s.resourceLimits])).toEqual([
      ["bridge", volume, DEFAULT_DEPENDENCY_SESSION_LIMITS],
      ["none", volume, DEFAULT_DEPENDENCY_SESSION_LIMITS],
    ]);
    // The install's 180 s, then the tools' 120 s, each with the margin.
    const [install, check] = expiries(h, before);
    expect(install).toBeGreaterThanOrEqual(240_000);
    expect(check).toBeGreaterThanOrEqual(180_000);
    expect(check).toBeLessThan(181_000);
    expect(h.execs.map((e) => e.cmd.slice(0, 2))).toEqual([POPULATE, CHECK_RUNNER.slice(0, 2)]);
    expect(h.execs[0]?.stdin).toBe(LOCKFILE.contents);
    expect(h.execs[1]?.stdin).toBe(
      JSON.stringify({ body: BODY, dependencies: ["idna==3.10"], lockfileHash: LOCKFILE.hash }),
    );
    expect(h.deleted).toBe(2);
  });

  it("populates the venv in the check session itself, with network, where no volume is shared", async () => {
    const h = sessionHarness(DAYTONA, { exitCode: 0 }, { stdout: FINDINGS_REPLY, exitCode: 0 });
    const before = Date.now();

    const checked = await checks(h, undefined).check({
      body: BODY,
      dependencies: ["idna==3.10"],
      lockfile: LOCKFILE,
      signal: undefined,
    });

    expect(checked.isOk()).toBe(true);
    expect(h.specs).toHaveLength(1);
    expect(h.specs[0]).toMatchObject({ network: "bridge" });
    expect(h.specs[0]).not.toHaveProperty("depsCacheVolume");
    // The tools' 120 s plus the install's 180 s, and the margin.
    const [expiry] = expiries(h, before);
    expect(expiry).toBeGreaterThanOrEqual(360_000);
    expect(expiry).toBeLessThan(361_000);
    expect(h.execs.map((e) => e.cmd.slice(0, 2))).toEqual([POPULATE, CHECK_RUNNER.slice(0, 2)]);
    expect(h.deleted).toBe(1);
  });

  it.each([
    {
      name: "no wheel under --only-binary",
      stderr:
        "error: No solution found when resolving dependencies\n  cause: Because sdistonly==1.0 has no usable wheels and you require sdistonly==1.0, we can conclude that your requirements are unsatisfiable.",
    },
    {
      name: "no wheel for the interpreter",
      stderr:
        "error: No solution found when resolving dependencies\n  cause: Because cponly==1.0 has no wheels with a matching Python ABI tag (e.g., `cp314`) and you require cponly==1.0, we can conclude that your requirements are unsatisfiable.",
    },
    {
      name: "a hash mismatch",
      stderr: "error: Failed to download `okpkg==1.0`\n  cause: Hash mismatch for `okpkg==1.0`",
    },
  ])("reads an install uv refuses for $name as a verdict on the lockfile", async ({ stderr }) => {
    const h = sessionHarness({}, { stderr, exitCode: 1 });

    const checked = await checks(h, VOLUME).check({
      body: BODY,
      dependencies: ["idna==3.10"],
      lockfile: LOCKFILE,
      signal: undefined,
    });

    expect(checked._unsafeUnwrapErr()).toEqual({ kind: "lockfile_invalid", detail: stderr });
    // No check session runs on a lockfile that does not install.
    expect(h.specs).toHaveLength(1);
    expect(h.deleted).toBe(1);
  });

  it("reads any other install failure as a check that could not run", async () => {
    const stderr =
      "error: Failed to fetch: https://pypi.org/simple/idna/\n  cause: error sending request for url";
    const h = sessionHarness({}, { stderr, exitCode: 2 });

    const checked = await checks(h, VOLUME).check({
      body: BODY,
      dependencies: ["idna==3.10"],
      lockfile: LOCKFILE,
      signal: undefined,
    });

    expect(checked._unsafeUnwrapErr()).toEqual({
      kind: "unavailable",
      detail: `the skill's dependencies did not install: ${stderr}`,
    });
    expect(h.specs).toHaveLength(1);
  });

  it("splits a check session's own populate the same way, running no tool after it", async () => {
    const stderr =
      "error: Failed to download `idna==3.10`\n  cause: Hash mismatch for `idna==3.10`";
    const h = sessionHarness(DAYTONA, { stderr, exitCode: 1 });

    const checked = await checks(h, undefined).check({
      body: BODY,
      dependencies: ["idna==3.10"],
      lockfile: LOCKFILE,
      signal: undefined,
    });

    expect(checked._unsafeUnwrapErr()).toEqual({ kind: "lockfile_invalid", detail: stderr });
    expect(h.execs).toHaveLength(1);
    expect(h.deleted).toBe(1);
  });

  it("reads an install whose exec fails in transport as a check that could not run", async () => {
    const h = sessionHarness(
      {},
      { failure: { kind: "transport_failed", error: new Error("socket closed") } },
    );

    const checked = await checks(h, VOLUME).check({
      body: BODY,
      dependencies: ["idna==3.10"],
      lockfile: LOCKFILE,
      signal: undefined,
    });

    expect(checked._unsafeUnwrapErr()).toEqual({
      kind: "unavailable",
      detail: expect.stringMatching(/^the install did not finish: /),
    });
  });

  it.each([
    {
      name: "a fatal reply",
      script: {
        stdout: `${JSON.stringify({ type: "fatal", error: "ruff exited 2: config unreadable" })}\n`,
        exitCode: 0,
      },
      detail: "the checks could not run: ruff exited 2: config unreadable",
    },
    {
      name: "an exit with no reply",
      script: { stderr: "Killed\n", exitCode: 137 },
      detail: "the check runner exited 137 with no reply: Killed",
    },
    {
      name: "a reply past its cap",
      script: { stdout: "x".repeat(1024 * 1024 + 1), exitCode: 0 },
      detail: "the check runner wrote more than 1048576 bytes to stdout",
    },
  ] satisfies { name: string; script: ExecScript; detail: string }[])(
    "reads $name as a check that could not run",
    async ({ script, detail }) => {
      const h = sessionHarness({}, script);

      const checked = await checks(h, VOLUME).check({
        body: BODY,
        dependencies: [],
        lockfile: null,
        signal: undefined,
      });

      expect(checked._unsafeUnwrapErr()).toEqual({ kind: "unavailable", detail });
      expect(h.deleted).toBe(1);
    },
  );

  it("reads a session that does not start as a check that could not run", async () => {
    const h = sessionHarness({});
    vi.mocked(h.sandbox.create).mockRejectedValueOnce(new Error("daemon unreachable"));

    const checked = await checks(h, VOLUME).check({
      body: BODY,
      dependencies: [],
      lockfile: null,
      signal: undefined,
    });

    expect(checked._unsafeUnwrapErr()).toEqual({
      kind: "unavailable",
      detail: "check session did not start: daemon unreachable",
    });
    expect(h.deleted).toBe(0);
  });

  it("stops the checks the register's signal aborts, and deletes the session", async () => {
    const h = sessionHarness({}, { hang: true });
    const controller = new AbortController();

    const pending = checks(h, VOLUME).check({
      body: BODY,
      dependencies: [],
      lockfile: null,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(h.execs).toHaveLength(1));
    controller.abort(new Error("register deadline"));
    const checked = await pending;

    expect(checked._unsafeUnwrapErr()).toEqual({
      kind: "unavailable",
      detail: "the check runner was stopped",
    });
    expect(h.deleted).toBe(1);
  });

  it("starts no session once the register's signal has aborted", async () => {
    const h = sessionHarness({});

    const checked = await checks(h, VOLUME).check({
      body: BODY,
      dependencies: ["idna==3.10"],
      lockfile: LOCKFILE,
      signal: AbortSignal.abort(new Error("register deadline")),
    });

    expect(checked._unsafeUnwrapErr()).toEqual({
      kind: "unavailable",
      detail: "install session did not start: register deadline",
    });
    expect(h.specs).toEqual([]);
  });
});
