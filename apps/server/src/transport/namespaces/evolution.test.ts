import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { createEvolution } from "./evolution.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

describe("evolution namespace", () => {
  function buildEvolutionTransport(
    opts: {
      identity?: { userId: string } | null;
      session?: { conversationId: string } | null;
      conv?: { id: string; userId: string } | null;
      events?: ReadonlyArray<unknown>;
      event?: unknown | null;
      triggerReflection?: (id: string) => Promise<never>;
    } = {},
  ) {
    const listEvolutionEvents = vi.fn().mockResolvedValue(opts.events ?? []);
    const getEvolutionEvent = vi.fn().mockResolvedValue(opts.event ?? null);
    const getConversation = vi.fn().mockResolvedValue(opts.conv ?? null);
    const agentStore = mockAgentStore({
      listEvolutionEvents,
      getEvolutionEvent,
      getConversation,
    });
    const transportStore = mockTransportStore({
      resolveUser: vi
        .fn()
        .mockResolvedValue(opts.identity === undefined ? { userId: "user-1" } : opts.identity),
      resolveSession: vi.fn().mockResolvedValue(opts.session ?? null),
    });
    const evolution = createEvolution({
      channelId: "ch-1",
      runInTx: fakeRunInTx,
      transportStore,
      agentStore,
      triggerReflection: opts.triggerReflection,
    });
    return { evolution, listEvolutionEvents, getEvolutionEvent };
  }

  it("listEvents: rejects unknown identity", async () => {
    const { evolution } = buildEvolutionTransport({ identity: null });
    const res = await evolution.listEvents("ghost", { limit: 10 });
    expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
  });

  it("listEvents: returns mapped rows when identity resolves", async () => {
    const { evolution, listEvolutionEvents } = buildEvolutionTransport({
      events: [
        {
          id: "evt-1",
          userId: "user-1",
          conversationId: "c1",
          triggeredBy: "idle",
          payload: {},
          createdAt: new Date(),
        },
      ],
    });
    const res = await evolution.listEvents("h", { limit: 10 });
    expect(res.isOk()).toBe(true);
    expect(listEvolutionEvents).toHaveBeenCalled();
  });

  it("getEvent: returns null when no row found", async () => {
    const { evolution } = buildEvolutionTransport({ event: null });
    const res = await evolution.getEvent("h", "evt-x");
    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap()).toBeNull();
  });

  it("getEvent: returns identity_rejected when identity missing", async () => {
    const { evolution } = buildEvolutionTransport({ identity: null });
    const res = await evolution.getEvent("h", "evt-x");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
  });

  it("triggerReflection: evolution_unavailable when wiring missing", async () => {
    const { evolution } = buildEvolutionTransport({});
    const res = await evolution.triggerReflection("h", "addr");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "evolution_unavailable" });
  });

  it("triggerReflection: identity_rejected", async () => {
    const trigger = vi.fn();
    const { evolution } = buildEvolutionTransport({ identity: null, triggerReflection: trigger });
    const res = await evolution.triggerReflection("h", "addr");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("triggerReflection: no_session when no session", async () => {
    const trigger = vi.fn();
    const { evolution } = buildEvolutionTransport({
      identity: { userId: "user-1" },
      session: null,
      triggerReflection: trigger,
    });
    const res = await evolution.triggerReflection("h", "addr");
    expect(res._unsafeUnwrap()).toEqual({ status: "no_session" });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("triggerReflection: no_session when conversation owner mismatches", async () => {
    const trigger = vi.fn();
    const { evolution } = buildEvolutionTransport({
      identity: { userId: "user-1" },
      session: { conversationId: "c1" },
      conv: { id: "c1", userId: "other-user" },
      triggerReflection: trigger,
    });
    const res = await evolution.triggerReflection("h", "addr");
    expect(res._unsafeUnwrap()).toEqual({ status: "no_session" });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("triggerReflection: skipped reason passes through", async () => {
    const trigger = vi.fn().mockResolvedValue({ status: "skipped", reason: "drained_zero" });
    const { evolution } = buildEvolutionTransport({
      identity: { userId: "user-1" },
      session: { conversationId: "c1" },
      conv: { id: "c1", userId: "user-1" },
      triggerReflection: trigger,
    });
    const res = await evolution.triggerReflection("h", "addr");
    expect(res._unsafeUnwrap()).toEqual({ status: "skipped", reason: "drained_zero" });
  });

  it("triggerReflection: processed → emits eventId + counts", async () => {
    const trigger = vi.fn().mockResolvedValue({
      status: "processed",
      eventId: "evt-99",
      corrections: { extracted: 1, reinforced: 2, promoted: 3, retired: 6, reset: 9 },
      memories: { extracted: 4, skippedForUnseenRules: 1 },
      drained: { drained: 5, withheld: 7, deferredToFirstParty: 8 },
    });
    const { evolution } = buildEvolutionTransport({
      identity: { userId: "user-1" },
      session: { conversationId: "c1" },
      conv: { id: "c1", userId: "user-1" },
      triggerReflection: trigger,
    });
    const res = await evolution.triggerReflection("h", "addr");
    expect(res._unsafeUnwrap()).toMatchObject({
      status: "processed",
      eventId: "evt-99",
      memoryCount: 4,
      drained: 5,
      withheld: 7,
      skippedForUnseenRules: 1,
      deferredToFirstParty: 8,
      ruleChanges: { extracted: 1, reinforced: 2, promoted: 3, retired: 6, reset: 9 },
    });
  });
});
