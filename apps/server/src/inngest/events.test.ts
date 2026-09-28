import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_GATE_REMINDERS, MAX_SLUG_LENGTH } from "../agent/pipeline/types.js";
import {
  buildConversationCooldownClearedEvent,
  calculateElapsedCooldown,
  deriveCauseClass,
  inboundArrived,
  pipelineGatePending,
  pipelineStageDue,
  responseReady,
  skillsDeployApprovalRequested,
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

describe("skills/deploy/approval-requested", () => {
  const base = {
    pendingId: "deploy-1",
    skillName: "briefing",
    gitSha: "abc1234",
    conversationId: "conv-1",
  };

  it("accepts an event queued before the schedule field existed", () => {
    // Inngest validates event data against the trigger schema before the
    // handler runs, so a queued event without the field must still parse.
    expect(skillsDeployApprovalRequested.schema.safeParse(base).success).toBe(true);
  });

  it("accepts a schedule or null", () => {
    const parse = (schedule: string | null) =>
      skillsDeployApprovalRequested.schema.safeParse({ ...base, schedule }).success;
    expect(parse("0 9 * * *")).toBe(true);
    expect(parse(null)).toBe(true);
  });
});
