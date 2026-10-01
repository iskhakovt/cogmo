import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { SkillRunAs, SkillRunServices } from "../skills/run-as.js";
import type { SkillRunner } from "../skills/runner.js";
import { captureIo, mockFilesService } from "../test/factories.js";
import { type CliIo, runCli } from "./run.js";
import { type SkillsCliDeps, skillsCli } from "./skills.js";

function makeRunner(overrides: Partial<SkillRunner> = {}): SkillRunner {
  return mock<SkillRunner>({ list: vi.fn().mockResolvedValue([]), ...overrides });
}

/** The install owner with the default profile, as `main.ts` resolves them. */
const OWNER_RUN_AS: SkillRunAs = {
  userId: "019d0000-0000-7000-8000-0000000000a1",
  service: { memory: mock<SkillRunServices["memory"]>(), files: mockFilesService() },
};

function depsFor(runner: SkillRunner) {
  return { runner, ownerRunAs: vi.fn().mockResolvedValue(OWNER_RUN_AS) };
}

function run(argv: readonly string[], deps: SkillsCliDeps, io: CliIo): Promise<number> {
  return runCli(
    skillsCli(io, async () => deps),
    argv,
    io,
  );
}

describe("skillsCli", () => {
  it("prints help when no command given", async () => {
    const { io, out } = captureIo();
    const code = await run([], depsFor(makeRunner()), io);
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/skills <subcommand>/);
  });

  it.each([["--help"], ["-h"], ["run", "--help"]])(
    "answers %j with help on stdout, exit 0, and no dependencies loaded",
    async (...argv) => {
      const { io, out, err } = captureIo();
      const loadDeps = vi.fn(async () => depsFor(makeRunner()));
      const code = await runCli(skillsCli(io, loadDeps), argv, io);
      expect(code).toBe(0);
      expect(out.join("\n")).toMatch(/skills/);
      expect(err).toEqual([]);
      expect(loadDeps).not.toHaveBeenCalled();
    },
  );

  it("prints (no enabled skills) when list is empty", async () => {
    const { io, out } = captureIo();
    const code = await run(["list"], depsFor(makeRunner()), io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("(no enabled skills)");
  });

  it("prints a tab-separated row per skill", async () => {
    const { io, out } = captureIo();
    const runner = makeRunner({
      list: vi.fn().mockResolvedValue([
        {
          name: "echo",
          tier: "wasm",
          riskTier: "auto",
          disabled: false,
          gitSha: "abc12345",
        },
      ]),
    });
    const code = await run(["list"], depsFor(runner), io);
    expect(code).toBe(0);
    const printed = out.join("\n");
    expect(printed).toContain("name\ttier\trisk\tdisabled\tgit_sha");
    expect(printed).toContain("echo\twasm\tauto\tno\tabc12345");
  });

  it("rejects `run` without a name", async () => {
    const { io, err } = captureIo();
    const code = await run(["run"], depsFor(makeRunner()), io);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/No value provided for name/);
  });

  it("rejects `run` with a name but no inputs", async () => {
    const { io, err } = captureIo();
    const code = await run(["run", "echo"], depsFor(makeRunner()), io);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/No value provided for jsonInputs/);
  });

  it("rejects `run` with non-JSON inputs before loading dependencies", async () => {
    const { io, err } = captureIo();
    const loadDeps = vi.fn(async () => depsFor(makeRunner()));
    const code = await runCli(skillsCli(io, loadDeps), ["run", "echo", "{not json"], io);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/invalid JSON inputs/);
    expect(loadDeps).not.toHaveBeenCalled();
  });

  it("invokes the runner and prints success result with exit 0", async () => {
    const { io, out } = captureIo();
    const runner = makeRunner({
      invoke: vi.fn().mockResolvedValue(
        ok({
          runId: "run-1",
          status: "success",
          output: { echo: 2 },
        }),
      ),
    });
    const code = await run(["run", "echo", `{"x":1}`], depsFor(runner), io);
    expect(code).toBe(0);
    expect(runner.invoke).toHaveBeenCalledWith({
      name: "echo",
      inputs: { x: 1 },
      trigger: "manual",
      runAs: OWNER_RUN_AS,
    });
    const printed = out.join("\n");
    expect(printed).toContain('"status": "success"');
    expect(printed).toContain('"echo": 2');
  });

  it("resolves the owner's identity only for `run`", async () => {
    const deps = depsFor(makeRunner());
    await run(["list"], deps, captureIo().io);
    expect(deps.ownerRunAs).not.toHaveBeenCalled();
  });

  it("returns exit 1 when the run errors", async () => {
    const { io } = captureIo();
    const runner = makeRunner({
      invoke: vi.fn().mockResolvedValue(
        ok({
          runId: "run-2",
          status: "error",
          error: "boom",
        }),
      ),
    });
    const code = await run(["run", "echo", "{}"], depsFor(runner), io);
    expect(code).toBe(1);
  });

  it("returns exit 2 on unknown command", async () => {
    const { io, err } = captureIo();
    const code = await run(["nonsense"], depsFor(makeRunner()), io);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/Not a valid subcommand name/);
  });

  it("returns exit 2 on an unknown flag", async () => {
    const { io, err } = captureIo();
    const code = await run(["list", "--verbose"], depsFor(makeRunner()), io);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/--verbose\n\s+\^ Unknown arguments/);
  });

  it("accepts a JSON array as inputs (validation deferred to runner)", async () => {
    const { io } = captureIo();
    const runner = makeRunner({
      invoke: vi.fn().mockResolvedValue(ok({ runId: "r", status: "success", output: null })),
    });
    const code = await run(["run", "echo", "[1,2,3]"], depsFor(runner), io);
    expect(code).toBe(0);
    expect(runner.invoke).toHaveBeenCalledWith({
      name: "echo",
      inputs: [1, 2, 3],
      trigger: "manual",
      runAs: OWNER_RUN_AS,
    });
  });

  it("exits 1 naming a rejection on stderr", async () => {
    const { io, err: stderr } = captureIo();
    const runner = makeRunner({
      invoke: vi.fn().mockResolvedValue(err({ kind: "not_found", name: "echo" })),
    });
    const code = await run(["run", "echo", "{}"], depsFor(runner), io);
    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/invoke failed: skill not found: echo/);
  });

  it("catches a runner.invoke exception and exits 1 with stderr", async () => {
    const { io, err } = captureIo();
    const runner = makeRunner({
      invoke: vi.fn().mockRejectedValue(new Error("not found")),
    });
    const code = await run(["run", "echo", "{}"], depsFor(runner), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/invoke failed: not found/);
  });

  describe("register / approve / deny / rollback / deregister subcommands", () => {
    it("`register <branch>` calls runner.register and exits 0 on live", async () => {
      const { io, out } = captureIo();
      const register = vi.fn().mockResolvedValue({
        name: "echo",
        riskTier: "notify",
        status: "live",
        gitSha: "abc",
      });
      const code = await run(["register", "skill/echo"], depsFor(makeRunner({ register })), io);
      expect(register).toHaveBeenCalledWith({ branch: "skill/echo", origin: { kind: "owner" } });
      expect(code).toBe(0);
      expect(out.join("\n")).toContain('"status": "live"');
    });

    it("`register` exits 1 on rejected", async () => {
      const { io } = captureIo();
      const register = vi.fn().mockResolvedValue({
        name: "",
        riskTier: "notify",
        status: "rejected",
        gitSha: "",
        errors: ["non_fast_forward"],
      });
      const code = await run(["register", "x"], depsFor(makeRunner({ register })), io);
      expect(code).toBe(1);
    });

    it("`register` without branch exits 2", async () => {
      const { io, err } = captureIo();
      const code = await run(["register"], depsFor(makeRunner()), io);
      expect(code).toBe(2);
      expect(err.join("\n")).toMatch(/No value provided for branch/);
    });

    it("`approve <pendingId>` calls runner.approveDeploy and exits 0 on live", async () => {
      const { io } = captureIo();
      const approveDeploy = vi.fn().mockResolvedValue({
        name: "echo",
        riskTier: "approve",
        status: "live",
        gitSha: "abc",
      });
      const code = await run(["approve", "deploy-1"], depsFor(makeRunner({ approveDeploy })), io);
      expect(approveDeploy).toHaveBeenCalledWith({
        pendingId: "deploy-1",
        origin: { kind: "owner" },
      });
      expect(code).toBe(0);
    });

    it("`deny <pendingId> reason words` joins reason and exits 0", async () => {
      const { io, out } = captureIo();
      const denyDeploy = vi.fn().mockResolvedValue(undefined);
      const code = await run(
        ["deny", "deploy-1", "looks", "sketchy"],
        depsFor(makeRunner({ denyDeploy })),
        io,
      );
      expect(denyDeploy).toHaveBeenCalledWith({
        pendingId: "deploy-1",
        reason: "looks sketchy",
      });
      expect(code).toBe(0);
      expect(out.join("\n")).toContain('"reason": "looks sketchy"');
    });

    it("`rollback <name> <sha>` calls runner.rollback", async () => {
      const { io } = captureIo();
      const rollback = vi.fn().mockResolvedValue({
        name: "echo",
        riskTier: "notify",
        status: "live",
        gitSha: "older",
      });
      const code = await run(["rollback", "echo", "older"], depsFor(makeRunner({ rollback })), io);
      expect(rollback).toHaveBeenCalledWith({
        name: "echo",
        toGitSha: "older",
        origin: { kind: "owner" },
      });
      expect(code).toBe(0);
    });

    it("`deregister <name>` calls runner.deregister and surfaces the disabled status", async () => {
      const { io, out } = captureIo();
      const deregister = vi.fn().mockResolvedValue({ kind: "deregistered", name: "echo" });
      const code = await run(["deregister", "echo"], depsFor(makeRunner({ deregister })), io);
      expect(deregister).toHaveBeenCalledWith({ name: "echo" });
      expect(code).toBe(0);
      expect(out.join("\n")).toContain('"status": "disabled"');
    });

    it("`deregister <name>` exits 1 on rejected:not_found", async () => {
      const { io, err } = captureIo();
      const deregister = vi
        .fn()
        .mockResolvedValue({ kind: "rejected", name: "ghost", reason: "not_found" });
      const code = await run(["deregister", "ghost"], depsFor(makeRunner({ deregister })), io);
      expect(code).toBe(1);
      expect(err.join("\n")).toContain("skill not found: ghost");
    });
  });

  it("printed JSON output is valid (round-trips through JSON.parse)", async () => {
    const { io, out } = captureIo();
    const runner = makeRunner({
      invoke: vi.fn().mockResolvedValue(
        ok({
          runId: "r",
          status: "success",
          output: { nested: { deep: [1, 2, 3] } },
        }),
      ),
    });
    await run(["run", "echo", "{}"], depsFor(runner), io);
    const last = out.join("\n");
    // The pretty-printed JSON spans multiple lines; reparse.
    expect(() => JSON.parse(last)).not.toThrow();
  });

  it("`approve` without pendingId exits 2 naming the missing argument", async () => {
    const { io, err } = captureIo();
    const code = await run(["approve"], depsFor(makeRunner()), io);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/No value provided for pendingId/);
  });

  it("`approve` refuses a flag in place of the pendingId", async () => {
    const { io, err } = captureIo();
    const approveDeploy = vi.fn();
    const code = await run(["approve", "--", "--all"], depsFor(makeRunner({ approveDeploy })), io);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/expected a value, got the flag "--all"/);
    expect(approveDeploy).not.toHaveBeenCalled();
  });

  it("`approve` exits 1 when runner.approveDeploy returns rejected", async () => {
    const { io } = captureIo();
    const approveDeploy = vi
      .fn()
      .mockResolvedValue({ status: "rejected", reason: "schema_mismatch" });
    const code = await run(["approve", "p-1"], depsFor(makeRunner({ approveDeploy })), io);
    expect(code).toBe(1);
  });

  it("`deny` without pendingId exits 2 naming the missing argument", async () => {
    const { io, err } = captureIo();
    const code = await run(["deny"], depsFor(makeRunner()), io);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/No value provided for pendingId/);
  });

  it("`deny` without reason words emits reason=null in the JSON", async () => {
    const { io, out } = captureIo();
    const denyDeploy = vi.fn().mockResolvedValue(undefined);
    const code = await run(["deny", "p-1"], depsFor(makeRunner({ denyDeploy })), io);
    expect(code).toBe(0);
    expect(denyDeploy).toHaveBeenCalledWith({ pendingId: "p-1" });
    expect(out.join("\n")).toContain('"reason": null');
  });

  it("`rollback` without args exits 2 naming the missing argument", async () => {
    const { io, err } = captureIo();
    const code = await run(["rollback"], depsFor(makeRunner()), io);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/No value provided for name/);
  });

  it("`rollback` with only one arg exits 2", async () => {
    const { io, err } = captureIo();
    const code = await run(["rollback", "echo"], depsFor(makeRunner()), io);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/No value provided for toGitSha/);
  });

  it("`rollback` exits 1 when runner.rollback returns rejected", async () => {
    const { io } = captureIo();
    const rollback = vi.fn().mockResolvedValue({ status: "rejected", reason: "git_sha_not_known" });
    const code = await run(["rollback", "echo", "sha"], depsFor(makeRunner({ rollback })), io);
    expect(code).toBe(1);
  });

  it("`deregister` without name exits 2 naming the missing argument", async () => {
    const { io, err } = captureIo();
    const code = await run(["deregister"], depsFor(makeRunner()), io);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/No value provided for name/);
  });
});
