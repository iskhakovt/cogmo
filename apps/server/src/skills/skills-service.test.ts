import type { Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import type { RegisterResult, SkillRunner } from "./runner.js";
import { createSkillsService } from "./skills-service.js";

function makeRunner(overrides: Partial<SkillRunner> = {}): SkillRunner {
  return {
    register: vi.fn(),
    approveDeploy: vi.fn(),
    denyDeploy: vi.fn(),
    rollback: vi.fn(),
    deregister: vi.fn(),
    enable: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    listAll: vi.fn().mockResolvedValue([]),
    listToolDefs: vi.fn().mockResolvedValue([]),
    invoke: vi.fn(),
    ...overrides,
  };
}

function makeInngest(): { inngest: Inngest; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn().mockResolvedValue(undefined);
  return { inngest: { send } as unknown as Inngest, send };
}

const PENDING_ID = "019d0000-0000-7000-8000-000000000001";
const CONV_ID = "019d0000-0000-7000-8000-000000000777";

describe("createSkillsService.register", () => {
  it("emits skills/deploy/approval-requested when the runner returns pending_approval", async () => {
    const runnerResult: RegisterResult = {
      name: "notifier",
      riskTier: "approve",
      status: "pending_approval",
      gitSha: "abcdef0123456789",
      pendingId: PENDING_ID,
    };
    const runner = makeRunner({ register: vi.fn().mockResolvedValue(runnerResult) });
    const { inngest, send } = makeInngest();

    const service = createSkillsService({ runner, inngest, conversationId: CONV_ID });
    const result = await service.register({ branch: "skill/notifier" });

    expect(result).toEqual(runnerResult);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      name: "skills/deploy/approval-requested",
      data: {
        pendingId: PENDING_ID,
        skillName: "notifier",
        gitSha: "abcdef0123456789",
        conversationId: CONV_ID,
      },
    });
  });

  it("does NOT emit on a live result (notify-tier auto-merge)", async () => {
    const runnerResult: RegisterResult = {
      name: "echo",
      riskTier: "notify",
      status: "live",
      gitSha: "abcdef0",
    };
    const runner = makeRunner({ register: vi.fn().mockResolvedValue(runnerResult) });
    const { inngest, send } = makeInngest();

    const service = createSkillsService({ runner, inngest, conversationId: CONV_ID });
    await service.register({ branch: "skill/echo" });

    expect(send).not.toHaveBeenCalled();
  });

  it("does NOT emit on a rejected result", async () => {
    const runnerResult: RegisterResult = {
      name: "",
      riskTier: "notify",
      status: "rejected",
      gitSha: "",
      errors: ["branch_not_found"],
    };
    const runner = makeRunner({ register: vi.fn().mockResolvedValue(runnerResult) });
    const { inngest, send } = makeInngest();

    const service = createSkillsService({ runner, inngest, conversationId: CONV_ID });
    await service.register({ branch: "skill/missing" });

    expect(send).not.toHaveBeenCalled();
  });

  it("returns the runner result even if event emit fails (fire-and-forget)", async () => {
    const runnerResult: RegisterResult = {
      name: "notifier",
      riskTier: "approve",
      status: "pending_approval",
      gitSha: "abc",
      pendingId: PENDING_ID,
    };
    const runner = makeRunner({ register: vi.fn().mockResolvedValue(runnerResult) });
    const send = vi.fn().mockRejectedValue(new Error("inngest unreachable"));
    const inngest = { send } as unknown as Inngest;

    const service = createSkillsService({ runner, inngest, conversationId: CONV_ID });
    const result = await service.register({ branch: "skill/notifier" });

    // Register itself succeeds — the deploy is pending in the DB regardless
    // of whether the keyboard was posted. Operator can approve via CLI.
    expect(result).toEqual(runnerResult);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
