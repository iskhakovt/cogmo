import { describe, expect, it, vi } from "vitest";
import { type CliIo, runSkillsCli } from "./cli.js";
import type { SkillRunner } from "./runner.js";

function makeIo(): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    out: (l) => stdout.push(l),
    err: (l) => stderr.push(l),
    stdout,
    stderr,
  };
}

function makeRunner(overrides: Partial<SkillRunner> = {}): SkillRunner {
  return {
    register: vi.fn(),
    approveDeploy: vi.fn(),
    denyDeploy: vi.fn(),
    rollback: vi.fn(),
    deregister: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    listToolDefs: vi.fn().mockResolvedValue([]),
    invoke: vi.fn(),
    ...overrides,
  } as any;
}

describe("runSkillsCli", () => {
  it("prints usage when no command given", async () => {
    const io = makeIo();
    const code = await runSkillsCli([], makeRunner(), io);
    expect(code).toBe(0);
    expect(io.stdout.join("\n")).toContain("Usage: cogmo skills");
  });

  it("prints (no enabled skills) when list is empty", async () => {
    const io = makeIo();
    const code = await runSkillsCli(["list"], makeRunner(), io);
    expect(code).toBe(0);
    expect(io.stdout.join("\n")).toContain("(no enabled skills)");
  });

  it("prints a tab-separated row per skill", async () => {
    const io = makeIo();
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
    const code = await runSkillsCli(["list"], runner, io);
    expect(code).toBe(0);
    const out = io.stdout.join("\n");
    expect(out).toContain("name\ttier\trisk\tdisabled\tgit_sha");
    expect(out).toContain("echo\twasm\tauto\tno\tabc12345");
  });

  it("rejects `run` without inputs", async () => {
    const io = makeIo();
    const code = await runSkillsCli(["run"], makeRunner(), io);
    expect(code).toBe(2);
    expect(io.stderr.join("\n")).toMatch(/Usage:/);
  });

  it("rejects `run` with non-JSON inputs", async () => {
    const io = makeIo();
    const code = await runSkillsCli(["run", "echo", "{not json"], makeRunner(), io);
    expect(code).toBe(2);
    expect(io.stderr.join("\n")).toMatch(/invalid JSON/);
  });

  it("invokes the runner and prints success result with exit 0", async () => {
    const io = makeIo();
    const runner = makeRunner({
      invoke: vi.fn().mockResolvedValue({
        runId: "run-1",
        status: "success",
        output: { echo: 2 },
      }),
    });
    const code = await runSkillsCli(["run", "echo", `{"x":1}`], runner, io);
    expect(code).toBe(0);
    expect(runner.invoke).toHaveBeenCalledWith({
      name: "echo",
      inputs: { x: 1 },
      trigger: "manual",
    });
    const out = io.stdout.join("\n");
    expect(out).toContain('"status": "success"');
    expect(out).toContain('"echo": 2');
  });

  it("returns exit 1 when the run errors", async () => {
    const io = makeIo();
    const runner = makeRunner({
      invoke: vi.fn().mockResolvedValue({
        runId: "run-2",
        status: "error",
        error: "boom",
      }),
    });
    const code = await runSkillsCli(["run", "echo", "{}"], runner, io);
    expect(code).toBe(1);
  });

  it("returns exit 1 on unknown command", async () => {
    const io = makeIo();
    const code = await runSkillsCli(["nonsense"], makeRunner(), io);
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toMatch(/Unknown skills command/);
  });

  it.each(["help", "--help", "-h"])("prints usage on '%s'", async (alias) => {
    const io = makeIo();
    const code = await runSkillsCli([alias], makeRunner(), io);
    expect(code).toBe(0);
    expect(io.stdout.join("\n")).toContain("Usage: cogmo skills");
  });

  it("`run` without name and without inputs returns exit 2", async () => {
    const io = makeIo();
    const code = await runSkillsCli(["run"], makeRunner(), io);
    expect(code).toBe(2);
  });

  it("`run` with name but no inputs returns exit 2", async () => {
    const io = makeIo();
    const code = await runSkillsCli(["run", "echo"], makeRunner(), io);
    expect(code).toBe(2);
    expect(io.stderr.join("\n")).toMatch(/Usage:/);
  });

  it("accepts a JSON array as inputs (validation deferred to runner)", async () => {
    const io = makeIo();
    const runner = makeRunner({
      invoke: vi.fn().mockResolvedValue({ runId: "r", status: "success", output: null }),
    });
    const code = await runSkillsCli(["run", "echo", "[1,2,3]"], runner, io);
    expect(code).toBe(0);
    expect(runner.invoke).toHaveBeenCalledWith({
      name: "echo",
      inputs: [1, 2, 3],
      trigger: "manual",
    });
  });

  it("catches a runner.invoke exception and exits 1 with stderr", async () => {
    const io = makeIo();
    const runner = makeRunner({
      invoke: vi.fn().mockRejectedValue(new Error("not found")),
    });
    const code = await runSkillsCli(["run", "echo", "{}"], runner, io);
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toMatch(/invoke failed: not found/);
  });

  describe("register / approve / deny / rollback / deregister subcommands", () => {
    it("`register <branch>` calls runner.register and exits 0 on live", async () => {
      const io = makeIo();
      const register = vi.fn().mockResolvedValue({
        name: "echo",
        riskTier: "notify",
        status: "live",
        gitSha: "abc",
      });
      const code = await runSkillsCli(["register", "skill/echo"], makeRunner({ register }), io);
      expect(register).toHaveBeenCalledWith({ branch: "skill/echo" });
      expect(code).toBe(0);
      expect(io.stdout.join("\n")).toContain('"status": "live"');
    });

    it("`register` exits 1 on rejected", async () => {
      const io = makeIo();
      const register = vi.fn().mockResolvedValue({
        name: "",
        riskTier: "notify",
        status: "rejected",
        gitSha: "",
        errors: ["non_fast_forward"],
      });
      const code = await runSkillsCli(["register", "x"], makeRunner({ register }), io);
      expect(code).toBe(1);
    });

    it("`register` without branch exits 2", async () => {
      const io = makeIo();
      const code = await runSkillsCli(["register"], makeRunner(), io);
      expect(code).toBe(2);
    });

    it("`approve <pendingId>` calls runner.approveDeploy and exits 0 on live", async () => {
      const io = makeIo();
      const approveDeploy = vi.fn().mockResolvedValue({
        name: "echo",
        riskTier: "approve",
        status: "live",
        gitSha: "abc",
      });
      const code = await runSkillsCli(["approve", "deploy-1"], makeRunner({ approveDeploy }), io);
      expect(approveDeploy).toHaveBeenCalledWith({ pendingId: "deploy-1" });
      expect(code).toBe(0);
    });

    it("`deny <pendingId> reason words` joins reason and exits 0", async () => {
      const io = makeIo();
      const denyDeploy = vi.fn().mockResolvedValue(undefined);
      const code = await runSkillsCli(
        ["deny", "deploy-1", "looks", "sketchy"],
        makeRunner({ denyDeploy }),
        io,
      );
      expect(denyDeploy).toHaveBeenCalledWith({
        pendingId: "deploy-1",
        reason: "looks sketchy",
      });
      expect(code).toBe(0);
    });

    it("`rollback <name> <sha>` calls runner.rollback", async () => {
      const io = makeIo();
      const rollback = vi.fn().mockResolvedValue({
        name: "echo",
        riskTier: "notify",
        status: "live",
        gitSha: "older",
      });
      const code = await runSkillsCli(["rollback", "echo", "older"], makeRunner({ rollback }), io);
      expect(rollback).toHaveBeenCalledWith({ name: "echo", toGitSha: "older" });
      expect(code).toBe(0);
    });

    it("`deregister <name>` calls runner.deregister", async () => {
      const io = makeIo();
      const deregister = vi.fn().mockResolvedValue(undefined);
      const code = await runSkillsCli(["deregister", "echo"], makeRunner({ deregister }), io);
      expect(deregister).toHaveBeenCalledWith({ name: "echo" });
      expect(code).toBe(0);
      expect(io.stdout.join("\n")).toContain('"status": "disabled"');
    });
  });

  it("printed JSON output is valid (round-trips through JSON.parse)", async () => {
    const io = makeIo();
    const runner = makeRunner({
      invoke: vi.fn().mockResolvedValue({
        runId: "r",
        status: "success",
        output: { nested: { deep: [1, 2, 3] } },
      }),
    });
    await runSkillsCli(["run", "echo", "{}"], runner, io);
    const last = io.stdout.join("\n");
    // The pretty-printed JSON spans multiple lines; reparse.
    expect(() => JSON.parse(last)).not.toThrow();
  });
});
