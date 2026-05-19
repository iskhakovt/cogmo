import { InngestTestEngine } from "@inngest/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inngest } from "../inngest/client.js";
import { logger } from "../logger.js";
import { spyOnInngestSend } from "../test/factories.js";
import {
  createHandleMessageReconcile,
  decideReconcile,
  matchesHandleMessage,
} from "./reconcile-on-failure.js";

describe("matchesHandleMessage", () => {
  it.each([
    ["handle-message", true],
    ["cogmo-handle-message", true],
    ["cogmo/handle-message", true],
    ["coding-task-start", false],
    ["handle-message-suffix", false], // strict — only suffix match
    ["", false],
  ])("matches %s → %s", (id, expected) => {
    expect(matchesHandleMessage(id)).toBe(expected);
  });
});

function basePayload(
  overrides?: Partial<{
    functionId: string;
    runId: string;
    errorMessage: string;
    innerEventName: string;
    conversationId: string | undefined;
    triggerInboundId: string | null | undefined;
  }>,
) {
  return {
    functionId: overrides?.functionId ?? "cogmo-handle-message",
    runId: overrides?.runId ?? "01KS04KFF783YZZS67QS4Y3Y5B",
    errorMessage: overrides?.errorMessage ?? "connect_worker_stopped_responding",
    innerEventName: overrides?.innerEventName ?? "inbound/ready",
    conversationId:
      overrides && "conversationId" in overrides ? overrides.conversationId : "conv-1",
    triggerInboundId:
      overrides && "triggerInboundId" in overrides ? overrides.triggerInboundId : "inbound-1",
  };
}

describe("decideReconcile", () => {
  it("returns reconciled with the conversation + run + trigger when payload is well-formed", () => {
    const result = decideReconcile(basePayload());
    expect(result).toEqual({
      status: "reconciled",
      conversationId: "conv-1",
      runId: "01KS04KFF783YZZS67QS4Y3Y5B",
      triggerInboundId: "inbound-1",
      errorMessage: "connect_worker_stopped_responding",
    });
  });

  it("normalises undefined triggerInboundId to null on the reconciled payload", () => {
    const result = decideReconcile(basePayload({ triggerInboundId: undefined }));
    if (result.status !== "reconciled") throw new Error("expected reconciled");
    expect(result.triggerInboundId).toBeNull();
  });

  it("preserves null triggerInboundId (flush-event-triggered run that died)", () => {
    const result = decideReconcile(basePayload({ triggerInboundId: null }));
    if (result.status !== "reconciled") throw new Error("expected reconciled");
    expect(result.triggerInboundId).toBeNull();
  });

  it("skips when functionId does not match handle-message", () => {
    expect(decideReconcile(basePayload({ functionId: "coding-task-start" }))).toEqual({
      status: "skipped",
      reason: "not_handle_message",
    });
  });

  // `handle-message` is triggered exclusively by `inbound/ready`. A failed
  // run with any other inner event name means something is upstream-broken;
  // synthesising `conversation/errored` from a payload that may not carry
  // `conversationId` by contract would be a worse failure than skipping.
  it("skips and warns when the inner event name is unexpected", () => {
    const warnSpy = vi.spyOn(logger, "warn");
    const result = decideReconcile(basePayload({ innerEventName: "something/else" }));
    expect(result).toEqual({ status: "skipped", reason: "wrong_inner_event" });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips and warns when conversationId is missing from the inner event data", () => {
    const warnSpy = vi.spyOn(logger, "warn");
    const result = decideReconcile(basePayload({ conversationId: undefined }));
    expect(result).toEqual({ status: "skipped", reason: "missing_conversation_id" });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips when conversationId is the empty string (defensive — schema allows it via passthrough)", () => {
    const result = decideReconcile(basePayload({ conversationId: "" }));
    expect(result).toEqual({ status: "skipped", reason: "missing_conversation_id" });
  });
});

// ─── Wrapper-level: createHandleMessageReconcile ─────────────────────
//
// The wrapper makes ONE durable call — `step.sendEvent("emit-errored", ...)` —
// only on the reconciled branch. The decision function is pure (no DB)
// so there's no `step.run("reconcile", ...)` like the coding variant has.
// These tests pin (a) the emit fires only on reconciled, (b) the explicit
// `id: "errored-${runId}"` is the SAME id `onFailure` uses so bus dedup
// keeps `recover-conversation` running exactly once.

function makeFailureEvent(args: {
  conversationId: string | undefined;
  triggerInboundId: string | null;
  runId: string;
  functionId: string;
  innerEventName?: string;
}) {
  return {
    name: "inngest/function.failed" as const,
    data: {
      function_id: args.functionId,
      run_id: args.runId,
      error: { name: "Error", message: "decoy failure" },
      event: {
        name: args.innerEventName ?? "inbound/ready",
        data: { conversationId: args.conversationId, triggerInboundId: args.triggerInboundId },
      },
    },
  };
}

describe("createHandleMessageReconcile — durable wrapper", () => {
  let sendSpy: ReturnType<typeof spyOnInngestSend>;

  beforeEach(() => {
    sendSpy = spyOnInngestSend(inngest);
    sendSpy.mockResolvedValue({ ids: [] });
  });
  afterEach(() => {
    sendSpy.mockRestore();
  });

  it("on reconciled: emits conversation/errored exactly once with idempotency id 'errored-' + run_id", async () => {
    const fn = createHandleMessageReconcile(inngest);
    const engine = new InngestTestEngine({
      function: fn,
      events: [
        makeFailureEvent({
          conversationId: "conv-1",
          triggerInboundId: "inbound-1",
          runId: "run-aaa",
          functionId: "cogmo-handle-message",
        }),
      ],
    });

    await engine.execute();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sendCall = sendSpy.mock.calls[0]?.[0] as unknown;
    expect(sendCall).toMatchObject({
      payload: {
        name: "conversation/errored",
        // SAME id `onFailure` uses — bus-level dedup ensures
        // `recover-conversation` runs exactly once regardless of whether
        // `onFailure` or this reconcile got to the event bus first.
        id: "errored-run-aaa",
        data: {
          conversationId: "conv-1",
          runId: "run-aaa",
          triggerInboundId: "inbound-1",
          errorClass: "WorkerDeath",
          causeClass: null,
          errorMessage: expect.stringContaining("decoy failure"),
        },
      },
    });
  });

  it("propagates null triggerInboundId (flush-triggered run that died) into the emitted event", async () => {
    const fn = createHandleMessageReconcile(inngest);
    const engine = new InngestTestEngine({
      function: fn,
      events: [
        makeFailureEvent({
          conversationId: "conv-1",
          triggerInboundId: null,
          runId: "run-bbb",
          functionId: "cogmo-handle-message",
        }),
      ],
    });

    await engine.execute();

    const sendCall = sendSpy.mock.calls[0]?.[0] as unknown;
    expect(sendCall).toMatchObject({
      payload: { data: { triggerInboundId: null } },
    });
  });

  it.each([
    ["not_handle_message", "coding-task-start", "conv-1", "inbound/ready"],
    ["missing_conversation_id", "cogmo-handle-message", undefined, "inbound/ready"],
    ["wrong_inner_event", "cogmo-handle-message", "conv-1", "something/else"],
  ])("on skipped (reason=%s): does NOT emit", async (_reason, functionId, conversationId, innerEventName) => {
    const fn = createHandleMessageReconcile(inngest);
    const engine = new InngestTestEngine({
      function: fn,
      events: [
        makeFailureEvent({
          conversationId,
          triggerInboundId: null,
          runId: "run-skip",
          functionId,
          innerEventName,
        }),
      ],
    });

    await engine.execute();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  // Forensic record: a human reading `conversation/errored.errorMessage`
  // days later needs to know it came from the reconcile path, not from
  // a regular `onFailure`. Pin the prefix so future edits don't drop the
  // run_id / function_id markers.
  it("errorMessage carries run_id and function_id for traceability", async () => {
    const fn = createHandleMessageReconcile(inngest);
    const engine = new InngestTestEngine({
      function: fn,
      events: [
        makeFailureEvent({
          conversationId: "conv-1",
          triggerInboundId: "inbound-1",
          runId: "01XYZ",
          functionId: "cogmo-handle-message",
        }),
      ],
    });
    await engine.execute();
    const sendCall = sendSpy.mock.calls[0]?.[0] as unknown as {
      payload: { data: { errorMessage: string } };
    };
    expect(sendCall.payload.data.errorMessage).toMatch(/run_id 01XYZ/);
    expect(sendCall.payload.data.errorMessage).toMatch(/function_id cogmo-handle-message/);
  });
});
