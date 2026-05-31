import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import type { Service } from "../agent/service.js";
import type { SkillsService } from "./skills-service.js";
import { registerSkillTool } from "./skills-tool.js";

function makeService(skills: SkillsService | undefined): Service {
  // mock<Service>() returns a Proxy that auto-mocks every property including
  // the optional `skills` namespace. The "missing runtime" path needs
  // `skills` to genuinely be absent, so construct a plain object with only
  // the surfaces the tool reads, adding `skills` when supplied.
  return {
    memory: mock<Service["memory"]>(),
    files: mock<Service["files"]>(),
    coreMemory: mock<Service["coreMemory"]>(),
    ...(skills !== undefined && { skills }),
  };
}

const RegisterAckSchema = z
  .object({
    name: z.string().optional(),
    status: z.string(),
    gitSha: z.string().optional(),
    nextStep: z.string().optional(),
    errors: z.array(z.string()).optional(),
  })
  .passthrough();

describe("registerSkillTool", () => {
  it("calls service.skills.register and reports a live deploy", async () => {
    const register = vi.fn().mockResolvedValue({
      name: "echo",
      riskTier: "notify",
      status: "live",
      gitSha: "abcdef0",
    });
    const skills: SkillsService = {
      register,
      approveDeploy: vi.fn(),
      denyDeploy: vi.fn(),
      rollback: vi.fn(),
    };
    const result = await registerSkillTool.handler({ branch: "skill/echo" }, makeService(skills));
    expect(register).toHaveBeenCalledWith({ branch: "skill/echo" });
    const parsed = RegisterAckSchema.parse(JSON.parse(result));
    expect(parsed.status).toBe("live");
    expect(parsed.name).toBe("echo");
    expect(parsed.gitSha).toBe("abcdef0");
    expect(parsed.nextStep).toMatch(/appears as its own tool starting next turn/);
  });

  it("forwards error list verbatim on rejected", async () => {
    const skills: SkillsService = {
      register: vi.fn().mockResolvedValue({
        name: "",
        riskTier: "notify",
        status: "rejected",
        gitSha: "",
        errors: ["non_fast_forward: rebase branch onto main and retry"],
      }),
      approveDeploy: vi.fn(),
      denyDeploy: vi.fn(),
      rollback: vi.fn(),
    };
    const result = await registerSkillTool.handler({ branch: "x" }, makeService(skills));
    const parsed = RegisterAckSchema.parse(JSON.parse(result));
    expect(parsed.status).toBe("rejected");
    expect(parsed.errors).toEqual(["non_fast_forward: rebase branch onto main and retry"]);
  });

  it("throws a clear error when service.skills is missing", async () => {
    await expect(
      registerSkillTool.handler({ branch: "x" }, makeService(undefined)),
    ).rejects.toThrow(/Skills runtime is unavailable/);
  });
});
