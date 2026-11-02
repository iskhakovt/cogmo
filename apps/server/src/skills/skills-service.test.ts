import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { EventPublisher } from "../inngest/durable.js";
import { liveRegisterResult, pendingRegisterResult } from "../test/skills-fixtures.js";
import type { RegisterResult, SkillRunner } from "./runner.js";
import { createSkillsService } from "./skills-service.js";

const CONV_ID = "019d0000-0000-7000-8000-000000000777";
/** The turn's user and profile. */
const ORIGIN = {
  userId: "019d0000-0000-7000-8000-0000000000a7",
  profileId: "019d0000-0000-7000-8000-0000000000b7",
};

function serviceFor(result: RegisterResult) {
  const runner = mock<SkillRunner>();
  runner.register.mockResolvedValue(result);
  const inngest = mock<EventPublisher>();
  const service = createSkillsService({
    runner,
    inngest,
    conversationId: CONV_ID,
    origin: ORIGIN,
  });
  return { service, runner, send: inngest.send };
}

describe("createSkillsService.register", () => {
  it("announces a live deploy as skills/deploy/outcome in the turn's conversation", async () => {
    const runnerResult = liveRegisterResult();
    const { service, send } = serviceFor(runnerResult);

    const result = await service.register({ branch: "skill/echo" });

    expect(result).toEqual(runnerResult);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      name: "skills/deploy/outcome",
      data: expect.objectContaining({
        outcome: "live",
        conversationId: CONV_ID,
        deployId: runnerResult.deployId,
        skillName: "echo",
      }),
    });
  });

  it("announces a pending deploy", async () => {
    const { service, send } = serviceFor(pendingRegisterResult());

    await service.register({ branch: "skill/notifier" });

    expect(send).toHaveBeenCalledWith({
      name: "skills/deploy/outcome",
      data: expect.objectContaining({ outcome: "pending_approval", conversationId: CONV_ID }),
    });
  });

  it("keeps a rejection silent: the model relays it to the user", async () => {
    const { service, send } = serviceFor({
      name: "",
      riskTier: "notify",
      status: "rejected",
      gitSha: "",
      errors: ["branch_not_found"],
    });

    await service.register({ branch: "skill/missing" });

    expect(send).not.toHaveBeenCalled();
  });

  it("returns the runner result when the emit fails", async () => {
    const runnerResult = pendingRegisterResult();
    const { service, send } = serviceFor(runnerResult);
    send.mockRejectedValue(new Error("inngest unreachable"));

    const result = await service.register({ branch: "skill/notifier" });

    // The deploy is committed whether or not the message went out.
    expect(result).toEqual(runnerResult);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("createSkillsService origin", () => {
  it("registers with the turn's conversation as the origin", async () => {
    const { service, runner } = serviceFor(liveRegisterResult());

    await service.register({ branch: "skill/echo" });

    expect(runner.register).toHaveBeenCalledWith({
      branch: "skill/echo",
      origin: { kind: "conversation", ...ORIGIN },
    });
  });
});
