import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODING_TASK_FAILURE_REASONS } from "../agent/coding/types.js";
import { MAX_GATE_REMINDERS, MAX_SLUG_LENGTH } from "../agent/pipeline/types.js";
import { SKILL_RISK_REASONS } from "../skills/risk-reasons.js";
import { skillRiskTier } from "../skills/store/schema.js";
import { SKILL_EFFECTS } from "../skills/types.js";
import {
  buildConversationCooldownClearedEvent,
  calculateElapsedCooldown,
  codingTaskFailed,
  deriveCauseClass,
  inboundArrived,
  pipelineGatePending,
  pipelineStageDue,
  responseReady,
  skillsDeployOutcome,
} from "./events.js";

describe("inboundArrived", () => {
  it("creates a valid event", () => {
    const event = inboundArrived.create({
      conversationId: "conv-1",
      inboundMessageId: "inbound-1",
    });

    expect(event.name).toBe("inbound/arrived");
    expect(event.data.conversationId).toBe("conv-1");
    expect(event.data.inboundMessageId).toBe("inbound-1");
  });
});

describe("responseReady", () => {
  it("creates a valid event", () => {
    const event = responseReady.create({
      conversationId: "conv-1",
      messageId: "msg-1",
    });

    expect(event.name).toBe("response/ready");
    expect(event.data.messageId).toBe("msg-1");
  });
});

describe("deriveCauseClass", () => {
  it("maps NonRetriableError to B", () => {
    expect(deriveCauseClass("NonRetriableError")).toBe("B");
  });
  it("maps WorkerDeath to A", () => {
    expect(deriveCauseClass("WorkerDeath")).toBe("A");
  });
  it("defaults unrecognised errorClass to bug", () => {
    expect(deriveCauseClass("RandomError")).toBe("bug");
    expect(deriveCauseClass("")).toBe("bug");
  });
});

describe("calculateElapsedCooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns wall-clock seconds since lastErroredAt", () => {
    expect(calculateElapsedCooldown("2026-05-19T11:55:00.000Z")).toBe(300);
  });

  it("clamps to 0 when the anchor is in the future (clock skew defense)", () => {
    // Without Math.max(0, ...), a host whose clock moved backward after
    // the cooldown was written would produce a negative value on the
    // bus — downstream consumers shouldn't have to special-case that.
    expect(calculateElapsedCooldown("2026-05-19T12:01:00.000Z")).toBe(0);
  });

  it("returns 0 for now-equals-anchor", () => {
    expect(calculateElapsedCooldown("2026-05-19T12:00:00.000Z")).toBe(0);
  });
});

describe("buildConversationCooldownClearedEvent", () => {
  it("bakes in the required dedup id", () => {
    const event = buildConversationCooldownClearedEvent(
      {
        conversationId: "conv-1",
        clearedBy: "success",
        elapsedCooldownSeconds: 42,
      },
      "cooldown-cleared-conv-1-2026-05-19T12:00:00.000Z",
    );
    expect(event.name).toBe("conversation/cooldown/cleared");
    expect(event.id).toBe("cooldown-cleared-conv-1-2026-05-19T12:00:00.000Z");
  });
});

describe("pipeline/stage.due", () => {
  it("accepts an event without the run's conversation id", () => {
    const data = { runId: "run-1", stageId: "draft", iteration: 0 };
    expect(pipelineStageDue.schema.safeParse(data).success).toBe(true);
  });
});

describe("pipeline/gate.pending bounds", () => {
  const base = {
    runId: "run-1",
    gateKey: "run-1:approve:0",
    conversationId: "conv-1",
    pipelineName: "p",
    stageId: "s",
    prompt: "Approve?",
    timeoutMs: 60_000,
    onTimeout: { kind: "abort" as const },
  };
  const accepts = (data: object) => pipelineGatePending.schema.safeParse(data).success;

  it("allows exactly the name and stage-id length a definition allows", () => {
    expect(accepts({ ...base, pipelineName: "p".repeat(MAX_SLUG_LENGTH) })).toBe(true);
    expect(accepts({ ...base, pipelineName: "p".repeat(MAX_SLUG_LENGTH + 1) })).toBe(false);
    expect(accepts({ ...base, stageId: "s".repeat(MAX_SLUG_LENGTH) })).toBe(true);
    expect(accepts({ ...base, stageId: "s".repeat(MAX_SLUG_LENGTH + 1) })).toBe(false);
  });

  it("allows exactly the reminder count a definition allows", () => {
    const remind = (maxReminders: number) => ({
      ...base,
      onTimeout: { kind: "remind" as const, maxReminders, finalAction: "abort" as const },
    });
    expect(accepts(remind(MAX_GATE_REMINDERS))).toBe(true);
    expect(accepts(remind(MAX_GATE_REMINDERS + 1))).toBe(false);
  });
});

describe("coding/task/failed", () => {
  it("accepts exactly the reasons coding_tasks.failure_reason stores", () => {
    expect(codingTaskFailed.schema.shape.reason.options).toEqual([...CODING_TASK_FAILURE_REASONS]);
    expect(
      codingTaskFailed.schema.safeParse({ taskId: "t", reason: "verify_failed", detail: "exit 1" })
        .success,
    ).toBe(true);
    expect(
      codingTaskFailed.schema.safeParse({
        taskId: "t",
        reason: "verify failed (exit 1)",
        detail: "",
      }).success,
    ).toBe(false);
  });
});

describe("skills/deploy/outcome", () => {
  const deployed = {
    conversationId: "conv-1",
    skillId: "skill-1",
    deployId: "deploy-1",
    skillName: "briefing",
    riskTier: "notify",
    reasons: ["wasm_unhardened"],
    gitSha: "abc1234",
    priorGitSha: null,
    description: "A morning briefing.",
    effects: { declared: ["reads_memory"], detected: [] },
    hosts: ["api.example.com"],
    secrets: [{ name: "api_key", bound: true }],
    dependencies: ["httpx==0.27.0"],
    schedule: "0 9 * * *",
  };
  const rejected = {
    outcome: "rejected",
    conversationId: "conv-1",
    skillName: "",
    gitSha: "abc1234",
    errors: ["missing_skill_md: SKILL.md not found at branch tip"],
  };
  const parse = (data: unknown) => skillsDeployOutcome.schema.safeParse(data).success;

  it("accepts each outcome", () => {
    expect(parse({ outcome: "live", ...deployed })).toBe(true);
    expect(parse({ outcome: "pending_approval", ...deployed })).toBe(true);
    expect(parse({ outcome: "live", ...deployed, schedule: null, priorGitSha: null })).toBe(true);
    expect(parse(rejected)).toBe(true);
  });

  it("rejects a mixed outcome", () => {
    // A rejection carrying a deploy's fields, and a deploy missing its facts.
    expect(parse({ ...rejected, deployId: "deploy-1", facts: {} })).toBe(false);
    expect(parse({ ...rejected, outcome: "live" })).toBe(false);
    expect(parse({ ...deployed, outcome: "rejected", errors: [] })).toBe(false);
    expect(parse({ outcome: "no_op", ...deployed })).toBe(false);
  });

  it("names exactly the domain's effects and risk reasons", () => {
    const live = skillsDeployOutcome.schema.options[0];
    expect(live.shape.riskTier.options).toEqual([...skillRiskTier.enumValues]);
    expect(live.shape.reasons.element.options).toEqual([...SKILL_RISK_REASONS]);
    expect(live.shape.effects.shape.declared.element.options).toEqual([...SKILL_EFFECTS]);
    expect(live.shape.effects.shape.detected.element.options).toEqual([...SKILL_EFFECTS]);
  });
});
