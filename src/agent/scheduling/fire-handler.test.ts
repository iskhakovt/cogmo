/**
 * Fire-handler unit tests. Drives the Inngest function via
 * `@inngest/test`'s InngestTestEngine, mocks the transport store, and
 * asserts the externally-visible behaviour: which store methods were
 * called, with what arguments, and what event was emitted.
 *
 * Companion to `src/agent/handle-message.replay.test.ts` — same pattern
 * for invoking an Inngest function in isolation. The `_send` stub
 * keeps `step.sendEvent` from trying to reach a real Inngest dev
 * server (and burning ~2s per test on ECONNREFUSED).
 */

import { InngestTestEngine } from "@inngest/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { inngest } from "../../inngest/client.js";
import { mockTransportStore, spyOnInngestSend } from "../../test/factories.js";
import { buildSyntheticInboundContent, createScheduledTaskFireHandler } from "./fire-handler.js";

// Stub Inngest's private `_send` so `step.sendEvent` inside the function
// under test doesn't reach a real dev server. See `spyOnInngestSend` for
// why the cast lives there.
let sendSpy: ReturnType<typeof spyOnInngestSend>;
beforeEach(() => {
  sendSpy = spyOnInngestSend(inngest);
  sendSpy.mockResolvedValue({ ids: ["fake"] });
});
afterEach(() => {
  sendSpy.mockRestore();
});

// In-process transactor — the fire handler doesn't actually need DB; the
// mocked store ignores tx. Cast to Transactor at the seam.
const FAKE_TX = { __mockTx: true } as never;
const runInTx: Transactor = (cb) => cb(FAKE_TX);

const baseEvent = {
  name: "agent/scheduled-task.fire",
  data: {
    taskId: "task-1",
    userId: "user-1",
    profileId: "profile-1",
    scheduledFor: "2026-05-14T09:00:00.000Z",
    prompt: "morning briefing",
  },
} as const;

describe("createScheduledTaskFireHandler", () => {
  it("skips with reason='no_active_session' when the user has no active session", async () => {
    const transportStore = mockTransportStore({
      findActiveSessionForUserProfile: vi.fn().mockResolvedValue(undefined),
    });
    const fn = createScheduledTaskFireHandler({ runInTx, transportStore }, inngest);

    const engine = new InngestTestEngine({ function: fn, events: [baseEvent] });
    const { result } = await engine.execute();

    expect(result).toEqual({ status: "skipped", reason: "no_active_session" });
    expect(transportStore.persistInbound).not.toHaveBeenCalled();
  });

  it("persists synthetic inbound + emits inbound/arrived when an active session exists", async () => {
    const transportStore = mockTransportStore({
      findActiveSessionForUserProfile: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        conversationId: "conv-1",
      }),
      persistInbound: vi.fn().mockResolvedValue({ id: "inbound-7" }),
    });
    const fn = createScheduledTaskFireHandler({ runInTx, transportStore }, inngest);

    const engine = new InngestTestEngine({ function: fn, events: [baseEvent] });
    const { result } = await engine.execute();

    expect(result).toEqual({
      status: "dispatched",
      conversationId: "conv-1",
      inboundId: "inbound-7",
    });

    expect(transportStore.persistInbound).toHaveBeenCalledTimes(1);
    expect(transportStore.persistInbound).toHaveBeenCalledWith(expect.anything(), {
      channelSessionId: "session-1",
      conversationId: "conv-1",
      content: buildSyntheticInboundContent(baseEvent.data.scheduledFor, baseEvent.data.prompt),
      // platformTs uses the scheduled-for timestamp, not now() — pinned
      // as a Date instance with the right epoch.
      platformTs: new Date(baseEvent.data.scheduledFor),
    });

    // Exactly one event emit through Inngest — inbound/arrived for the
    // resolved conversation. `_send({ fn, payload, ... })` so we pluck
    // `payload` and assert the event shape.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          name: "inbound/arrived",
          data: { conversationId: "conv-1", inboundMessageId: "inbound-7" },
        }),
      }),
    );
  });

  it("synthetic content carries the scheduled-for timestamp header", () => {
    // Format lock — the prompt body MUST surface the scheduled-for
    // timestamp so the model can render "this was meant for X, it's
    // now Y" without an extra system-prompt round-trip.
    const content = buildSyntheticInboundContent("2026-05-14T09:00:00.000Z", "morning briefing");
    expect(content).toBe(
      "[Scheduled task — fire time was 2026-05-14T09:00:00.000Z]\n\nmorning briefing",
    );
  });

  it("scopes findActiveSessionForUserProfile to the event's userId+profileId", async () => {
    // Belt-and-braces: the lookup must use the event's identifiers,
    // not anything cached from the deps. A regression here would route
    // fires to the wrong user.
    const find = vi.fn().mockResolvedValue(undefined);
    const transportStore = mockTransportStore({ findActiveSessionForUserProfile: find });
    const fn = createScheduledTaskFireHandler({ runInTx, transportStore }, inngest);

    await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();

    expect(find).toHaveBeenCalledWith(expect.anything(), "user-1", "profile-1");
  });
});
