import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { mkCtx, transportWith } from "../../../../test/telegram/command-fixtures.js";
import { handleLearned, handleReflect } from "./evolution.js";

describe("handleLearned", () => {
  const EVT_A = "019e2900-0000-7000-8000-0000000000aa";
  const EVT_B = "019e2900-0000-7000-8000-0000000000bb";

  function makePayload(overrides?: {
    extracted?: number;
    reinforced?: number;
    promoted?: number;
    memories?: number;
  }) {
    return {
      corrections: {
        extracted: overrides?.extracted ?? 1,
        reinforced: overrides?.reinforced ?? 0,
        contradictions: 0,
        retired: 0,
        reset: 0,
        promoted: overrides?.promoted ?? 0,
        outOfScopeReinforcementsSkipped: 0,
        outOfScopeContradictionsSkipped: 0,
        unknownRuleReinforcementsSkipped: 0,
        consolidationNeeded: false,
      },
      consolidation: null,
      memories: { extracted: overrides?.memories ?? 0, byNetwork: {}, skippedForUnseenRules: 0 },
      drained: { drained: 0, byNetwork: {}, withheld: 0, deferredToFirstParty: 0 },
      messageCount: 8,
      profileId: "11111111-1111-7111-8111-111111111111",
    };
  }

  it("renders a digest with id, timestamp, and rule/memory counts", async () => {
    const transport = transportWith({
      evolution: {
        listEvents: vi.fn().mockResolvedValue(
          ok([
            {
              id: EVT_B,
              conversationId: "c1",
              triggeredBy: "manual",
              payload: makePayload({ extracted: 2, memories: 3 }),
              createdAt: new Date("2026-06-01T10:00:00Z"),
            },
            {
              id: EVT_A,
              conversationId: "c1",
              triggeredBy: "idle",
              payload: makePayload({ extracted: 1, memories: 1 }),
              createdAt: new Date("2026-05-30T08:00:00Z"),
            },
          ]),
        ),
      },
    });
    const ctx = mkCtx();
    await handleLearned(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain("Evolution events (2):");
    expect(reply).toContain(EVT_B);
    expect(reply).toContain("[manual]");
    expect(reply).toContain("2 rule change(s)");
    expect(reply).toContain("3 memory write(s)");
  });

  it("counts a retirement as a rule change and names withheld rows on a digest line", async () => {
    const payload = makePayload({ extracted: 1 });
    const transport = transportWith({
      evolution: {
        listEvents: vi.fn().mockResolvedValue(
          ok([
            {
              id: EVT_A,
              conversationId: "c1",
              triggeredBy: "idle",
              payload: {
                ...payload,
                corrections: { ...payload.corrections, retired: 2 },
                drained: { ...payload.drained, withheld: 4, deferredToFirstParty: 5 },
              },
              createdAt: new Date("2026-05-30T08:00:00Z"),
            },
          ]),
        ),
      },
    });
    const ctx = mkCtx();
    await handleLearned(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain("3 rule change(s), 0 memory write(s), 4 withheld, 5 deferred");
  });

  it("names the failed phases on a digest line, and nothing on a fire without them", async () => {
    const transport = transportWith({
      evolution: {
        listEvents: vi.fn().mockResolvedValue(
          ok([
            {
              id: EVT_B,
              conversationId: "c1",
              triggeredBy: "idle",
              payload: { ...makePayload(), failedPhases: ["memories", "drain"] },
              createdAt: new Date("2026-06-01T10:00:00Z"),
            },
            {
              id: EVT_A,
              conversationId: "c1",
              triggeredBy: "idle",
              payload: { ...makePayload(), failedPhases: [] },
              createdAt: new Date("2026-05-30T08:00:00Z"),
            },
          ]),
        ),
      },
    });
    const ctx = mkCtx();
    await handleLearned(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    const [lineB, lineA] = reply.split(/\n(?=\d+\. )/).slice(1);
    expect(lineB).toContain("failed: memories, drain");
    expect(lineA).not.toContain("failed");
  });

  it("nudges the user to /reflect when there are no events", async () => {
    const transport = transportWith({
      evolution: { listEvents: vi.fn().mockResolvedValue(ok([])) },
    });
    const ctx = mkCtx();
    await handleLearned(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("/reflect");
  });

  it("renders detail when given a valid uuid arg", async () => {
    const transport = transportWith({
      evolution: {
        getEvent: vi.fn().mockResolvedValue(
          ok({
            id: EVT_A,
            conversationId: "c1",
            triggeredBy: "idle",
            payload: makePayload({ extracted: 2, reinforced: 1, memories: 4 }),
            createdAt: new Date("2026-05-30T08:00:00Z"),
          }),
        ),
      },
    });
    const ctx = mkCtx(EVT_A);
    await handleLearned(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain(`Event ${EVT_A}`);
    expect(reply).toContain("Triggered by: idle");
    expect(reply).toContain("extracted:    2");
    expect(reply).toContain("reinforced:   1");
    expect(reply).toContain("Memories: 4 extracted");
  });

  it("reports a clear miss when the event id is unknown", async () => {
    const transport = transportWith({
      evolution: { getEvent: vi.fn().mockResolvedValue(ok(null)) },
    });
    const ctx = mkCtx(EVT_A);
    await handleLearned(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toMatch(/No evolution event/);
  });

  it("rejects non-uuid arguments with USAGE", async () => {
    const transport = transportWith();
    const ctx = mkCtx("not-a-uuid");
    await handleLearned(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /learned");
  });
});

describe("handleReflect", () => {
  it("renders processed digest with rule, memory, and event-id breadcrumb", async () => {
    const transport = transportWith({
      evolution: {
        triggerReflection: vi.fn().mockResolvedValue(
          ok({
            status: "processed",
            eventId: "019e2900-0000-7000-8000-0000000000cc",
            ruleChanges: { extracted: 2, reinforced: 1, promoted: 1, retired: 0, reset: 0 },
            memoryCount: 3,
            drained: 0,
            withheld: 0,
            skippedForUnseenRules: 0,
            deferredToFirstParty: 0,
          }),
        ),
      },
    });
    const ctx = mkCtx();
    await handleReflect(transport, ctx);
    // First reply is the "Reflecting…" pre-message; second is the digest.
    const digest = (ctx.reply.mock.calls[1]?.[0] ?? "") as string;
    expect(digest).toMatch(/Reflected/);
    expect(digest).toContain("2 new");
    expect(digest).toContain("1 reinforced");
    expect(digest).toContain("3 extracted");
    expect(digest).toContain("/learned 019e2900");
    expect(digest).not.toContain("retired");
    expect(digest).not.toContain("withheld");
  });

  it("reports a retirement and withheld rows, which alone are changes", async () => {
    const transport = transportWith({
      evolution: {
        triggerReflection: vi.fn().mockResolvedValue(
          ok({
            status: "processed",
            eventId: "019e2900-0000-7000-8000-0000000000ee",
            ruleChanges: { extracted: 0, reinforced: 0, promoted: 0, retired: 1, reset: 2 },
            memoryCount: 0,
            drained: 0,
            withheld: 2,
            skippedForUnseenRules: 0,
            deferredToFirstParty: 0,
          }),
        ),
      },
    });
    const ctx = mkCtx();
    await handleReflect(transport, ctx);
    const digest = (ctx.reply.mock.calls[1]?.[0] ?? "") as string;
    expect(digest).toContain("0 new, 0 reinforced, 0 promoted, 1 retired, 2 reset");
    expect(digest).toContain("0 extracted, 0 drained, 2 withheld");
  });

  it("reports an extraction skipped and rows deferred for a first-party fire", async () => {
    const transport = transportWith({
      evolution: {
        triggerReflection: vi.fn().mockResolvedValue(
          ok({
            status: "processed",
            eventId: "019e2900-0000-7000-8000-0000000000ff",
            ruleChanges: { extracted: 0, reinforced: 0, promoted: 0, retired: 0, reset: 0 },
            memoryCount: 0,
            drained: 0,
            withheld: 0,
            skippedForUnseenRules: 1,
            deferredToFirstParty: 3,
          }),
        ),
      },
    });
    const ctx = mkCtx();
    await handleReflect(transport, ctx);
    const digest = (ctx.reply.mock.calls[1]?.[0] ?? "") as string;
    expect(digest).toContain(
      "Memories: extraction skipped (a user's memory rule this profile can't see), 0 drained, 3 deferred.",
    );
  });

  it("reports too-short conversations clearly", async () => {
    const transport = transportWith({
      evolution: {
        triggerReflection: vi
          .fn()
          .mockResolvedValue(ok({ status: "skipped", reason: "too_short" })),
      },
    });
    const ctx = mkCtx();
    await handleReflect(transport, ctx);
    expect(ctx.reply.mock.calls[1]?.[0]).toMatch(/too short/i);
  });

  it("reports no-session when there's no active conversation", async () => {
    const transport = transportWith({
      evolution: {
        triggerReflection: vi.fn().mockResolvedValue(ok({ status: "no_session" })),
      },
    });
    const ctx = mkCtx();
    await handleReflect(transport, ctx);
    expect(ctx.reply.mock.calls[1]?.[0]).toMatch(/No active conversation/);
  });

  it("renders a 'no changes' digest when nothing was extracted", async () => {
    const transport = transportWith({
      evolution: {
        triggerReflection: vi.fn().mockResolvedValue(
          ok({
            status: "processed",
            eventId: "019e2900-0000-7000-8000-0000000000dd",
            ruleChanges: { extracted: 0, reinforced: 0, promoted: 0, retired: 0, reset: 0 },
            memoryCount: 0,
            drained: 0,
            withheld: 0,
            skippedForUnseenRules: 0,
            deferredToFirstParty: 0,
          }),
        ),
      },
    });
    const ctx = mkCtx();
    await handleReflect(transport, ctx);
    const digest = (ctx.reply.mock.calls[1]?.[0] ?? "") as string;
    expect(digest).toContain("no rule changes");
    expect(digest).toContain("no memories");
  });

  it("surfaces TransportError messages", async () => {
    const transport = transportWith({
      evolution: {
        triggerReflection: vi.fn().mockResolvedValue(err({ code: "evolution_unavailable" })),
      },
    });
    const ctx = mkCtx();
    await handleReflect(transport, ctx);
    expect(ctx.reply.mock.calls[1]?.[0]).toMatch(/Evolution isn't wired/i);
  });

  // Coverage for the "row vanished mid-call" branches — exercised when
  // the Observer returns skipped with reason `conversation_not_found` or
  // `profile_not_found`. Both should fall through to the same soft-error
  // copy without throwing.
  for (const reason of ["conversation_not_found", "profile_not_found"] as const) {
    it(`reports Couldn't-load on skipped/${reason}`, async () => {
      const transport = transportWith({
        evolution: {
          triggerReflection: vi.fn().mockResolvedValue(ok({ status: "skipped", reason })),
        },
      });
      const ctx = mkCtx();
      await handleReflect(transport, ctx);
      expect(ctx.reply.mock.calls[1]?.[0]).toMatch(/Couldn't load the conversation/);
    });
  }

  it("interpolates the live MIN_MESSAGES_FOR_EXTRACTION threshold into the too-short copy", async () => {
    const transport = transportWith({
      evolution: {
        triggerReflection: vi
          .fn()
          .mockResolvedValue(ok({ status: "skipped", reason: "too_short" })),
      },
    });
    const ctx = mkCtx();
    await handleReflect(transport, ctx);
    // The renderer imports MIN_MESSAGES_FOR_EXTRACTION from the
    // Observer; this regression test catches a future drift where the
    // copy hardcodes a number again.
    const { MIN_MESSAGES_FOR_EXTRACTION } = await import("../../../../agent/evolution/index.js");
    expect(ctx.reply.mock.calls[1]?.[0]).toContain(`${MIN_MESSAGES_FOR_EXTRACTION} messages`);
  });
});

describe("handleLearned detail rendering", () => {
  const EVT = "019e2900-0000-7000-8000-0000000000aa";

  function makePayload(overrides: {
    outOfScope?: number;
    unknownRule?: number;
    durationMs?: number;
    contradictions?: number;
    retired?: number;
    reset?: number;
    withheld?: number;
    skipped?: number;
    deferred?: number;
  }) {
    return {
      corrections: {
        extracted: 1,
        reinforced: 1,
        contradictions: overrides.contradictions ?? 0,
        retired: overrides.retired ?? 0,
        reset: overrides.reset ?? 0,
        promoted: 0,
        outOfScopeReinforcementsSkipped: overrides.outOfScope ?? 0,
        outOfScopeContradictionsSkipped: 0,
        unknownRuleReinforcementsSkipped: overrides.unknownRule ?? 0,
        consolidationNeeded: false,
      },
      consolidation: null,
      memories: { extracted: 0, byNetwork: {}, skippedForUnseenRules: overrides.skipped ?? 0 },
      drained: {
        drained: 0,
        byNetwork: {},
        withheld: overrides.withheld ?? 0,
        deferredToFirstParty: overrides.deferred ?? 0,
      },
      messageCount: 8,
      profileId: "11111111-1111-7111-8111-111111111111",
      ...(overrides.durationMs !== undefined && { durationMs: overrides.durationMs }),
    };
  }

  async function detailOf(payload: ReturnType<typeof makePayload>): Promise<string> {
    const transport = transportWith({
      evolution: {
        getEvent: vi.fn().mockResolvedValue(
          ok({
            id: EVT,
            conversationId: "c1",
            triggeredBy: "idle",
            payload,
            createdAt: new Date("2026-05-30T08:00:00Z"),
          }),
        ),
      },
    });
    const ctx = mkCtx(EVT);
    await handleLearned(transport, ctx);
    return (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
  }

  it("shows retired learning rules and withheld rows only when there are some", async () => {
    const reply = await detailOf(
      makePayload({ contradictions: 3, retired: 1, reset: 1, withheld: 2 }),
    );
    expect(reply).toContain("contradicted: 3");
    expect(reply).toContain("reset:        1 (learning, contradicted once)");
    expect(reply).toContain("retired:      1 (learning, contradicted twice)");
    expect(reply).toContain("Pending drained: 0");
    expect(reply).toContain("withheld by a memory rule: 2");

    const quiet = await detailOf(makePayload({}));
    expect(quiet).not.toContain("retired:");
    expect(quiet).not.toContain("reset:");
    expect(quiet).not.toContain("Pending drained");
    expect(quiet).not.toContain("profile can't see");
  });

  it("shows an extraction skipped and rows deferred for rules the profile can't see", async () => {
    const reply = await detailOf(makePayload({ skipped: 1, deferred: 3 }));
    expect(reply).toContain(
      "Memories: skipped; a user's memory rule binds it and this profile can't see it",
    );
    expect(reply).toContain("Pending drained: 0");
    expect(reply).toContain("  deferred to a first-party fire: 3");
  });

  it("surfaces skipped counters when non-zero", async () => {
    const transport = transportWith({
      evolution: {
        getEvent: vi.fn().mockResolvedValue(
          ok({
            id: EVT,
            conversationId: "c1",
            triggeredBy: "idle",
            payload: makePayload({ outOfScope: 3, unknownRule: 1 }),
            createdAt: new Date("2026-05-30T08:00:00Z"),
          }),
        ),
      },
    });
    const ctx = mkCtx(EVT);
    await handleLearned(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain("skipped:      4");
    expect(reply).toContain("3 out-of-scope");
    expect(reply).toContain("1 unknown-rule");
  });

  it("shows out-of-scope contradictions as a part of contradicted, apart from skipped reinforcements", async () => {
    const payload = makePayload({ contradictions: 3, retired: 1, outOfScope: 2 });
    const reply = await detailOf({
      ...payload,
      corrections: { ...payload.corrections, outOfScopeContradictionsSkipped: 2 },
    });
    expect(reply).toContain("contradicted: 3");
    expect(reply).toContain("retired:      1 (learning, contradicted twice)");
    expect(reply).toContain("not applied:  2 (learning, on another channel)");
    expect(reply).toContain("skipped:      2 reinforcement(s) (2 out-of-scope, 0 unknown-rule)");
  });

  it("omits the skipped line when both counters are zero", async () => {
    const transport = transportWith({
      evolution: {
        getEvent: vi.fn().mockResolvedValue(
          ok({
            id: EVT,
            conversationId: "c1",
            triggeredBy: "idle",
            payload: makePayload({}),
            createdAt: new Date("2026-05-30T08:00:00Z"),
          }),
        ),
      },
    });
    const ctx = mkCtx(EVT);
    await handleLearned(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).not.toContain("skipped:");
  });

  it("renders durationMs as a compact 'Took:' line when stamped", async () => {
    const transport = transportWith({
      evolution: {
        getEvent: vi.fn().mockResolvedValue(
          ok({
            id: EVT,
            conversationId: "c1",
            triggeredBy: "idle",
            payload: makePayload({ durationMs: 32500 }),
            createdAt: new Date("2026-05-30T08:00:00Z"),
          }),
        ),
      },
    });
    const ctx = mkCtx(EVT);
    await handleLearned(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toMatch(/Took: 33s/);
  });

  it("shows a failed phase as failed instead of its fallback counts", async () => {
    const transport = transportWith({
      evolution: {
        getEvent: vi.fn().mockResolvedValue(
          ok({
            id: EVT,
            conversationId: "c1",
            triggeredBy: "idle",
            payload: {
              ...makePayload({}),
              corrections: {
                extracted: 0,
                reinforced: 0,
                contradictions: 0,
                retired: 0,
                reset: 0,
                promoted: 0,
                outOfScopeReinforcementsSkipped: 0,
                outOfScopeContradictionsSkipped: 0,
                unknownRuleReinforcementsSkipped: 0,
                consolidationNeeded: false,
              },
              failedPhases: ["corrections", "memories", "drain"],
            },
            createdAt: new Date("2026-05-30T08:00:00Z"),
          }),
        ),
      },
    });
    const ctx = mkCtx(EVT);
    await handleLearned(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain("Corrections: failed after retries");
    expect(reply).toContain("Memories: failed after retries");
    expect(reply).toContain("Pending drain: failed after retries");
    expect(reply).not.toContain("extracted:    0");
    expect(reply).not.toContain("Memories: 0 extracted");
    expect(reply).not.toContain("Consolidation");
  });

  it("shows a failed consolidation beside the corrections that asked for it", async () => {
    const payload = makePayload({});
    const transport = transportWith({
      evolution: {
        getEvent: vi.fn().mockResolvedValue(
          ok({
            id: EVT,
            conversationId: "c1",
            triggeredBy: "idle",
            payload: {
              ...payload,
              corrections: { ...payload.corrections, consolidationNeeded: true },
              failedPhases: ["consolidation"],
            },
            createdAt: new Date("2026-05-30T08:00:00Z"),
          }),
        ),
      },
    });
    const ctx = mkCtx(EVT);
    await handleLearned(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain("Consolidation: failed after retries");
    expect(reply).toContain("extracted:    1");
  });

  it("renders counts as before for a row without recorded phase outcomes", async () => {
    const transport = transportWith({
      evolution: {
        getEvent: vi.fn().mockResolvedValue(
          ok({
            id: EVT,
            conversationId: "c1",
            triggeredBy: "idle",
            payload: makePayload({}),
            createdAt: new Date("2026-05-30T08:00:00Z"),
          }),
        ),
      },
    });
    const ctx = mkCtx(EVT);
    await handleLearned(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain("extracted:    1");
    expect(reply).toContain("Memories: 0 extracted");
    expect(reply).not.toContain("failed");
  });

  it("omits the Took line when durationMs is absent", async () => {
    const transport = transportWith({
      evolution: {
        getEvent: vi.fn().mockResolvedValue(
          ok({
            id: EVT,
            conversationId: "c1",
            triggeredBy: "idle",
            payload: makePayload({}),
            createdAt: new Date("2026-05-30T08:00:00Z"),
          }),
        ),
      },
    });
    const ctx = mkCtx(EVT);
    await handleLearned(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).not.toContain("Took:");
  });
});
