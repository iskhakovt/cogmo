import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { EventPublisher } from "../../inngest/durable.js";
import { skillsDeployOutcome } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import { expectDefined } from "../../test/assertions.js";
import {
  deployFactsFixture,
  FIXTURE_DEPLOY_ID,
  FIXTURE_SKILL_ID,
  liveRegisterResult,
  pendingRegisterResult,
} from "../../test/skills-fixtures.js";
import { announceDeployOutcome } from "./announce-outcome.js";
import { rejectedResult } from "./register-result.js";

const CONV_ID = "019d0000-0000-7000-8000-000000000777";

const FACTS = deployFactsFixture({
  description: "Posts the morning briefing.",
  effects: { declared: ["sends_message"], detected: ["reads_memory"] },
  hosts: ["api.example.com"],
  secrets: [
    { name: "api_key", bound: true },
    { name: "legacy_token", bound: false },
  ],
  dependencies: ["httpx==0.27.0"],
  schedule: "0 9 * * *",
  reasons: ["acting_effect", "secrets_with_network"],
  priorGitSha: "1111111",
});

/** The one event `result` announces, parsed through the event's own schema. */
async function announced(result: Parameters<typeof announceDeployOutcome>[1]["result"]) {
  const publisher = mock<EventPublisher>();
  await announceDeployOutcome({ publisher }, { result, conversationId: CONV_ID });
  expect(publisher.send).toHaveBeenCalledTimes(1);
  const [event] = expectDefined(publisher.send.mock.calls[0], "send call");
  if (Array.isArray(event)) throw new Error("expected a single event");
  expect(event.name).toBe(skillsDeployOutcome.name);
  return skillsDeployOutcome.schema.parse(event.data);
}

describe("announceDeployOutcome", () => {
  it("announces a live deploy with its facts", async () => {
    const data = await announced(liveRegisterResult({ facts: FACTS }));

    expect(data).toEqual({
      outcome: "live",
      conversationId: CONV_ID,
      skillId: FIXTURE_SKILL_ID,
      deployId: FIXTURE_DEPLOY_ID,
      skillName: "echo",
      riskTier: "notify",
      reasons: ["acting_effect", "secrets_with_network"],
      gitSha: "abc1234",
      priorGitSha: "1111111",
      description: "Posts the morning briefing.",
      effects: { declared: ["sends_message"], detected: ["reads_memory"] },
      hosts: ["api.example.com"],
      secrets: [
        { name: "api_key", bound: true },
        { name: "legacy_token", bound: false },
      ],
      dependencies: ["httpx==0.27.0"],
      schedule: "0 9 * * *",
    });
  });

  it("announces a pending deploy with the id approve and deny name", async () => {
    const data = await announced(pendingRegisterResult({ facts: FACTS }));

    expect(data).toMatchObject({
      outcome: "pending_approval",
      deployId: FIXTURE_DEPLOY_ID,
      skillName: "notifier",
      riskTier: "approve",
      gitSha: "abcdef0123456789",
      schedule: "0 9 * * *",
    });
  });

  it("announces a rejection with its errors", async () => {
    const data = await announced(rejectedResult("abc1234", "missing_skill_md", "bad_schema"));

    expect(data).toEqual({
      outcome: "rejected",
      conversationId: CONV_ID,
      skillName: "",
      gitSha: "abc1234",
      errors: ["missing_skill_md", "bad_schema"],
    });
  });

  it("announces nothing for a no-op", async () => {
    const publisher = mock<EventPublisher>();

    await announceDeployOutcome(
      { publisher },
      {
        result: { name: "echo", riskTier: "notify", status: "no_op", gitSha: "abc1234" },
        conversationId: CONV_ID,
      },
    );

    expect(publisher.send).not.toHaveBeenCalled();
  });

  it("logs a failed emit at error level and resolves", async () => {
    const publisher = mock<EventPublisher>();
    publisher.send.mockRejectedValue(new Error("inngest unreachable"));
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    try {
      await expect(
        announceDeployOutcome(
          { publisher },
          { result: liveRegisterResult(), conversationId: CONV_ID },
        ),
      ).resolves.toBeUndefined();

      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "live", skillName: "echo", conversationId: CONV_ID }),
        expect.stringContaining("failed to emit skills/deploy/outcome"),
      );
    } finally {
      error.mockRestore();
    }
  });
});
