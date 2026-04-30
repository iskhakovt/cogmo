import { describe, expect, it, vi } from "vitest";
import type { Service } from "../agent/service.js";
import type { SkillsService } from "./skills-service.js";
import { registerSkillTool } from "./skills-tool.js";

function makeService(skills: SkillsService | undefined): Service {
  // Cast — only the `skills` field is read by the tool handler in these tests.
  return { skills } as unknown as Service;
}

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
    const parsed = JSON.parse(result);
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
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("rejected");
    expect(parsed.errors).toEqual(["non_fast_forward: rebase branch onto main and retry"]);
  });

  it("throws a clear error when service.skills is missing", async () => {
    await expect(
      registerSkillTool.handler({ branch: "x" }, makeService(undefined)),
    ).rejects.toThrow(/Skills runtime is unavailable/);
  });
});
