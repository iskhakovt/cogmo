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
    };
    const result = (
      await registerSkillTool.handler({ branch: "skill/echo" }, makeService(skills))
    )._unsafeUnwrap();
    expect(register).toHaveBeenCalledWith({ branch: "skill/echo" });
    const parsed = RegisterAckSchema.parse(JSON.parse(result));
    expect(parsed.status).toBe("live");
    expect(parsed.name).toBe("echo");
    expect(parsed.gitSha).toBe("abcdef0");
    expect(parsed.nextStep).toMatch(/appears as its own tool starting next turn/);
  });

  it("rejects with the error list verbatim on rejected", async () => {
    const skills: SkillsService = {
      register: vi.fn().mockResolvedValue({
        name: "",
        riskTier: "notify",
        status: "rejected",
        gitSha: "",
        errors: ["non_fast_forward: rebase branch onto main and retry"],
      }),
    };
    const rejection = (
      await registerSkillTool.handler({ branch: "x" }, makeService(skills))
    )._unsafeUnwrapErr();
    expect(rejection.message).toBe(
      "Register rejected: non_fast_forward: rebase branch onto main and retry. " +
        "Surface the errors verbatim and ask the user for guidance.",
    );
  });

  it("joins multiple errors and names a missing reason on rejected", async () => {
    const register = vi
      .fn()
      .mockResolvedValueOnce({
        name: "",
        riskTier: "notify",
        status: "rejected",
        gitSha: "",
        errors: ["a", "b"],
      })
      .mockResolvedValueOnce({ name: "", riskTier: "notify", status: "rejected", gitSha: "" });
    const service = makeService({ register });
    const joined = (await registerSkillTool.handler({ branch: "x" }, service))._unsafeUnwrapErr();
    expect(joined.message).toMatch(/^Register rejected: a; b\. /);
    const bare = (await registerSkillTool.handler({ branch: "x" }, service))._unsafeUnwrapErr();
    expect(bare.message).toMatch(/^Register rejected: no reason given\. /);
  });

  it("rejects with a clear message when service.skills is missing", async () => {
    const rejection = (
      await registerSkillTool.handler({ branch: "x" }, makeService(undefined))
    )._unsafeUnwrapErr();
    expect(rejection.message).toMatch(/Skills runtime is unavailable/);
  });
});
