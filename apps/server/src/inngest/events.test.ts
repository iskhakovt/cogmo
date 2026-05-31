import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildConversationCooldownClearedEvent,
  calculateElapsedCooldown,
  deriveCauseClass,
  inboundArrived,
  responseReady,
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
