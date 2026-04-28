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
    invoke: vi.fn(),
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
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
