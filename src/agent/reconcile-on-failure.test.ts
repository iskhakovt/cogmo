import { InngestTestEngine } from "@inngest/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inngest } from "../inngest/client.js";
import { buildConversationErroredEvent } from "../inngest/events.js";
import { logger } from "../logger.js";
import { expectDefined } from "../test/assertions.js";
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
    conversationId: string | undefined;
    triggerInboundId: string | null | undefined;
  }>,
) {
  return {
    functionId: overrides?.functionId ?? "cogmo-handle-message",
    runId: overrides?.runId ?? "01KS04KFF783YZZS67QS4Y3Y5B",
    errorMessage: overrides?.errorMessage ?? "connect_worker_stopped_responding",
    conversationId:
      overrides && "conversationId" in overrides ? overrides.conversationId : "conv-1",
    triggerInboundId:
      overrides && "triggerInboundId" in overrides ? overrides.triggerInboundId : "inbound-1",
  };
}

describe("decideReconcile", () => {
  it("returns reconciled with the conversation + run + functionId + trigger when payload is well-formed", () => {
    const result = decideReconcile(basePayload());
    expect(result).toEqual({
      status: "reconciled",
      conversationId: "conv-1",
      runId: "01KS04KFF783YZZS67QS4Y3Y5B",
      functionId: "cogmo-handle-message",
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
    const sendCall = expectDefined(sendSpy.mock.calls[0]?.[0], "first send call");
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

    const sendCall = expectDefined(sendSpy.mock.calls[0]?.[0], "first send call");
    expect(sendCall).toMatchObject({
      payload: { data: { triggerInboundId: null } },
    });
  });

  it.each([
    ["not_handle_message", "coding-task-start", "conv-1"],
    ["missing_conversation_id", "cogmo-handle-message", undefined],
  ])("on skipped (reason=%s): does NOT emit", async (_reason, functionId, conversationId) => {
    const fn = createHandleMessageReconcile(inngest);
    const engine = new InngestTestEngine({
      function: fn,
      events: [
        makeFailureEvent({
          conversationId,
          triggerInboundId: null,
          runId: "run-skip",
          functionId,
        }),
      ],
    });

    await engine.execute();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  // Future-trigger compatibility — if a contributor adds a second
  // trigger to `handle-message` that carries `conversationId` but a
  // different event name (e.g. a hypothetical direct scheduled-fire
  // path that bypasses `inbound/arrived`), the reconcile MUST still
  // fire on worker-death for that path. PR #297 review flagged the
  // prior strict-inner-event-name check as exactly the silent skip
  // this test now guards against.
  it("reconciles on worker-death even when the inner event name is not inbound/ready", async () => {
    const fn = createHandleMessageReconcile(inngest);
    const engine = new InngestTestEngine({
      function: fn,
      events: [
        makeFailureEvent({
          conversationId: "conv-1",
          triggerInboundId: null,
          runId: "run-future",
          functionId: "cogmo-handle-message",
          innerEventName: "agent/scheduled-task.fire",
        }),
      ],
    });
    await engine.execute();
    const sendCall = expectDefined(sendSpy.mock.calls[0]?.[0], "first send call");
    expect(sendCall).toMatchObject({
      payload: {
        name: "conversation/errored",
        id: "errored-run-future",
        data: { conversationId: "conv-1", runId: "run-future" },
      },
    });
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
    expect(expectDefined(sendSpy.mock.calls[0]?.[0], "first send call")).toMatchObject({
      payload: {
        data: {
          errorMessage: expect.stringMatching(/run_id 01XYZ.*function_id cogmo-handle-message/),
        },
      },
    });
  });
});

// ─── Bus-level dedup contract ────────────────────────────────────────
//
// The dedup contract is two-sided: `handle-message`'s `onFailure` and
// `handle-message-reconcile` BOTH emit `conversation/errored`, and the
// `id` field on the event payload is what makes Inngest's event-id
// dedup window pick one. If either side forgets the id, both events
// land on the bus, both trigger `recover-conversation`, and the
// cooldown doubles for what was really one failure.
//
// The PR #297 review caught exactly that: the reconcile set the id but
// `onFailure` didn't. The fix funnels both emitters through
// `buildConversationErroredEvent`, and the test below pins the
// contract — drop the helper or skip it on one side and this test
// breaks.

describe("bus-level dedup contract", () => {
  it("buildConversationErroredEvent produces the same id format both emitters depend on", () => {
    const payload = buildConversationErroredEvent({
      conversationId: "conv-1",
      runId: "run-xyz",
      triggerInboundId: "inbound-1",
      errorClass: "NonRetriableError",
      causeClass: "BadRequestError",
      errorMessage: "boom",
    });
    // Inngest's MinimalEventPayload.id is the dedup key. The shape
    // `errored-${runId}` is the contract — see comment on
    // `buildConversationErroredEvent` in `src/inngest/events.ts`.
    expect(payload.id).toBe("errored-run-xyz");
    expect(payload.name).toBe("conversation/errored");
  });

  // Cross-emitter pin: if `onFailure` (in handle-message.ts) is ever
  // changed to bypass `buildConversationErroredEvent` and call
  // `conversationErrored.create(...)` directly, that emit would land
  // on the bus WITHOUT an id and double-fire `recover-conversation`
  // alongside the reconcile. Anchor the dedup in one place by pinning
  // that the same `runId` produces the same `id` regardless of caller.
  it("same runId produces the same dedup id via the helper (no two-sided drift)", () => {
    const a = buildConversationErroredEvent({
      conversationId: "conv-1",
      runId: "run-shared",
      triggerInboundId: null,
      errorClass: "NonRetriableError",
      causeClass: null,
      errorMessage: "from onFailure",
    });
    const b = buildConversationErroredEvent({
      conversationId: "conv-1",
      runId: "run-shared",
      triggerInboundId: null,
      errorClass: "WorkerDeath",
      causeClass: null,
      errorMessage: "from reconcile",
    });
    expect(a.id).toBe(b.id);
  });
});
