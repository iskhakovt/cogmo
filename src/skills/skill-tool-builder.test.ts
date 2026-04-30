import { describe, expect, it, vi } from "vitest";
import type { Service } from "../agent/service.js";
import type { SkillRunner, SkillToolDef } from "./runner.js";
import { buildSkillToolSpec, buildSkillTools } from "./skill-tool-builder.js";

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
  };
}

const STUB_SERVICE = {} as Service;

const ECHO_DEF: SkillToolDef = {
  name: "echo",
  description: "Echo a number, plus one.",
  inputs: { type: "object", properties: { x: { type: "integer" } }, required: ["x"] },
  tier: "wasm",
  riskTier: "notify",
  gitSha: "abcdef0",
};

describe("buildSkillToolSpec", () => {
  it("translates a SkillToolDef into a ToolSpec with the manifest's name + schema", () => {
    const runner = makeRunner();
    const spec = buildSkillToolSpec(ECHO_DEF, runner);
    expect(spec.name).toBe("echo");
    expect(spec.description).toBe("Echo a number, plus one.");
    expect(spec.inputSchema).toEqual(ECHO_DEF.inputs);
  });

  it("handler invokes the runner and returns success JSON", async () => {
    const invoke = vi.fn().mockResolvedValue({
      runId: "run-1",
      status: "success",
      output: { echo: 8 },
    });
    const runner = makeRunner({ invoke });
    const spec = buildSkillToolSpec(ECHO_DEF, runner);

    const result = await spec.handler({ x: 7 }, STUB_SERVICE);
    expect(invoke).toHaveBeenCalledWith({
      name: "echo",
      inputs: { x: 7 },
      trigger: "manual",
    });
    expect(JSON.parse(result)).toEqual({
      ok: true,
      runId: "run-1",
      output: { echo: 8 },
    });
  });

  it("handler returns ok:false on runner error result (not a throw)", async () => {
    const invoke = vi.fn().mockResolvedValue({
      runId: "run-2",
      status: "error",
      error: "kaboom",
    });
    const runner = makeRunner({ invoke });
    const spec = buildSkillToolSpec(ECHO_DEF, runner);

    const result = await spec.handler({ x: 1 }, STUB_SERVICE);
    expect(JSON.parse(result)).toEqual({
      ok: false,
      error: "kaboom",
      runId: "run-2",
    });
  });

  it("handler propagates a thrown runner error (e.g. invalid inputs)", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("inputs failed schema"));
    const runner = makeRunner({ invoke });
    const spec = buildSkillToolSpec(ECHO_DEF, runner);

    await expect(spec.handler({}, STUB_SERVICE)).rejects.toThrow(/inputs failed schema/);
  });
});

describe("buildSkillTools", () => {
  it("returns one tool per registered skill", async () => {
    const runner = makeRunner({
      listToolDefs: vi
        .fn()
        .mockResolvedValue([
          ECHO_DEF,
          { ...ECHO_DEF, name: "double", description: "doubles x", gitSha: "1234567" },
        ]),
    });
    const tools = await buildSkillTools(runner);
    expect(tools.map((t) => t.name)).toEqual(["echo", "double"]);
  });

  it("returns empty array when listToolDefs throws (fault-tolerant)", async () => {
    const runner = makeRunner({
      listToolDefs: vi.fn().mockRejectedValue(new Error("git unreachable")),
    });
    const tools = await buildSkillTools(runner);
    expect(tools).toEqual([]);
  });
});
