/// <reference path="../../../test/vitest.d.ts" />
/**
 * Observer integration tests — exercise `runObserver` end-to-end against
 * real Postgres (testcontainer) with a routed stub LLM provider and a
 * recording memory provider. Boundary the test cares about is "Observer
 * makes the right DB writes/reads and asks the memory layer to retain the
 * right shape" — Hindsight's async extraction pipeline is orthogonal and
 * skipping it removes a fixture-record dependency. The real-PG part is
 * load-bearing: composite-FK enforcement on `profiles.profile_class`, the
 * pending_memories LEFT JOIN that derives `profileClass`, and real
 * transactions are exactly what unit-level mocks gloss over.
 *
 * Why a stub provider over llmock fixtures: the test verifies Observer's
 * plumbing — customs flow through to the prompt, `profile_class` lands on
 * emitted tags, pending_memories drain, the right rows clear. LLM
 * behavior is orthogonal; a canned-response stub keeps assertions tight
 * on Cogmo's logic and removes a fixture-record step from the test loop.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { Database } from "../../db/index.js";
import type { LlmProvider } from "../../llm/provider.js";
import type { ChatParams, ChatStreamResult, LlmResponse } from "../../llm/types.js";
import type { MemoryProvider, RetainBatchItem } from "../../memory/provider.js";
import { expectDefined } from "../../test/assertions.js";
import { DrizzleTransportStore } from "../../transport/store/index.js";
import { channelSessions, channels } from "../../transport/store/schema.js";
import { DrizzleAgentStore } from "../store/index.js";
import { conversations, messages, profiles, steeringRules } from "../store/schema.js";
import { type ObserverStepHarness, runObserver } from "./observer.js";

let db: Database;
let pgClient: postgres.Sql;
let store: DrizzleAgentStore;
let transportStore: DrizzleTransportStore;
let userId: string;

beforeAll(async () => {
  const databaseUrl = inject("databaseUrl");
  pgClient = postgres(databaseUrl);
  db = drizzle(pgClient);
  store = new DrizzleAgentStore();
  transportStore = new DrizzleTransportStore();
  // Reuse the seeded default user so FK-constrained inserts
  // (custom_compartments, pending_memories) accept our writes.
  userId = inject("defaultUserId");
});

afterAll(async () => {
  await pgClient.end();
});

beforeEach(cleanupTestState);

// Clean DB state per-test so assertion counts don't drift. Order
// matters for FKs: channel_sessions → messages → steering_rules →
// conversations → test profiles → profile_classes. Channels are
// seeded once by `test/integration-setup.ts` and outlive every test;
// channel_sessions are per-test and cleared here. Test profiles are
// matched by name to avoid touching seeded fixtures.
// pending_memories and custom_compartments are independent.
async function cleanupTestState(): Promise<void> {
  await pgClient.unsafe(
    `DELETE FROM channel_sessions
     WHERE conversation_id IN (
       SELECT id FROM conversations WHERE user_id = $1 AND profile_id IN (
         SELECT id FROM profiles WHERE name LIKE 'it-profile-%'
       )
     )`,
    [userId],
  );
  await pgClient.unsafe(
    `DELETE FROM messages
     WHERE conversation_id IN (
       SELECT id FROM conversations WHERE user_id = $1 AND profile_id IN (
         SELECT id FROM profiles WHERE name LIKE 'it-profile-%'
       )
     )`,
    [userId],
  );
  // Correction/evolution steering rules accumulate across tests via
  // extractCorrections; manually-seeded rules (source='manual') stay
  // untouched. Wide enough not to leak per-test state into the next.
  await pgClient.unsafe(`DELETE FROM steering_rules WHERE source IN ('correction', 'evolution')`);
  await pgClient.unsafe(
    `DELETE FROM conversations
     WHERE user_id = $1 AND profile_id IN (
       SELECT id FROM profiles WHERE name LIKE 'it-profile-%'
     )`,
    [userId],
  );
  await pgClient.unsafe(`DELETE FROM profiles WHERE name LIKE 'it-profile-%'`);
  await pgClient.unsafe(`DELETE FROM profile_classes WHERE user_id = $1`, [userId]);
  await pgClient.unsafe(`DELETE FROM custom_compartments WHERE user_id = $1`, [userId]);
  await pgClient.unsafe(`DELETE FROM pending_memories WHERE user_id = $1`, [userId]);
}

// --- Test helpers ---

const fakeStep: ObserverStepHarness = {
  // Inngest's step.run wraps the closure with retry / memoization /
  // serialization. For integration testing we just invoke it; the
  // payload shapes are JSON-safe (Observer was designed for Inngest
  // step.run, so the values round-trip cleanly anyway).
  async run<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
};

// Mirrors `migrate-untagged-memories.integration.test.ts` — pass through
// to `db.transaction`, which yields the Drizzle Transaction type the
// store methods expect.
const fakeRunInTx: import("../../db/index.js").Transactor = (cb) => db.transaction((tx) => cb(tx));

/**
 * Open an active session on the seeded channel of the given type, linking
 * it to the conversation. Used to drive the Observer's
 * `getActiveChannelTypes` step under real PG. Channels are seeded once by
 * `test/integration-setup.ts` (Telegram, Direct) and queried here by type
 * — same pattern `pipeline.integration.test.ts` uses.
 */
async function openActiveChannelSession(
  conversationId: string,
  channelType: string,
): Promise<void> {
  const [channel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.type, channelType))
    .limit(1);
  const channelId = expectDefined(
    channel,
    `seeded ${channelType} channel — make sure test/integration-setup.ts seeds it`,
  ).id;
  await db.insert(channelSessions).values({
    channelId,
    platformAddress: `addr-${channelType}-${conversationId.slice(0, 8)}`,
    conversationId,
    status: "active",
    receive: "all",
  });
}

/**
 * Seed a profile + conversation + N messages, returning the conversation
 * id. The default profile carries no `profile_class` and unrestricted
 * `memoryScope` so observer paths exercise the most permissive shape;
 * tests override per-case.
 */
async function seedConversation(opts: {
  messageCount: number;
  profileClass?: string;
}): Promise<{ conversationId: string; profileId: string }> {
  const insertedProfile = await db
    .insert(profiles)
    .values({
      userId,
      name: `it-profile-${Date.now()}`,
      basePrompt: "test profile",
      model: "claude-sonnet-4-6",
      toolSet: [],
      ...(opts.profileClass !== undefined && { profileClass: opts.profileClass }),
    })
    .returning({ id: profiles.id });
  const profileId = expectDefined(insertedProfile[0], "inserted profile row").id;

  const insertedConversation = await db
    .insert(conversations)
    .values({ userId, profileId, isPrivate: true })
    .returning({ id: conversations.id });
  const conversationId = expectDefined(insertedConversation[0], "inserted conversation row").id;

  // Alternate user / assistant rows so transcript shape is realistic.
  const rows = Array.from({ length: opts.messageCount }, (_, i) => ({
    conversationId,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `message ${i}`,
    profileId,
    model: "claude-sonnet-4-6",
    lastInboundMessageId: "00000000-0000-0000-0000-000000000000",
    outputTokens: -1,
  }));
  if (rows.length > 0) {
    await db.insert(messages).values(rows);
  }
  return { conversationId, profileId };
}

/**
 * Routed stub LLM provider — inspects the system prompt and routes to one
 * of three canned response producers (corrections / extraction /
 * pending-classification). Exposed `calls` records every invocation so
 * tests can assert on which prompts ran and what they contained.
 */
interface StubProviderHandle {
  provider: LlmProvider;
  calls: Array<{ system: string; userMessage: string }>;
}

function buildStubProvider(opts: {
  extractionMemories?: Array<{
    fact: string;
    network: string;
    compartment: string;
    trust: string;
    context?: string;
  }>;
  pendingClassification?: { network: string; compartment: string; trust: string };
}): StubProviderHandle {
  const calls: Array<{ system: string; userMessage: string }> = [];

  const provider: LlmProvider = {
    name: "stub",
    async chat(params: ChatParams): Promise<LlmResponse> {
      const userMessage = params.messages
        .filter((m) => m.role === "user")
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");
      calls.push({ system: params.system ?? "", userMessage });

      let payload: unknown;
      const sys = params.system ?? "";
      if (sys.includes("memory extraction engine")) {
        payload = { memories: opts.extractionMemories ?? [] };
      } else if (sys.includes("classifying a single fact")) {
        payload = opts.pendingClassification ?? {
          network: "world",
          compartment: "personal",
          trust: "first-party",
        };
      } else if (sys.includes("behavioral correction extractor")) {
        payload = { corrections: [] };
      } else {
        throw new Error(
          `stub provider: no canned response for system prompt starting "${sys.slice(0, 80)}"`,
        );
      }

      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        stopReason: "end_turn",
        model: params.model,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
    chatStream(_params: ChatParams): ChatStreamResult {
      throw new Error("stub provider: chatStream not used in observer tests");
    },
    async countTokens(): Promise<number> {
      return 0;
    },
  };

  return { provider, calls };
}

/**
 * Recording memory mock — captures every `retainBatch` call so assertions
 * can run on the exact items Observer emits. Unused methods throw so a
 * test that drifts onto another path fails loud rather than silently
 * passing. The boundary the test asserts on is "Observer asks the
 * memory layer to retain these specific items"; Hindsight's pipeline
 * is covered separately in `memory.integration.test.ts`.
 */
interface RecordingMemoryHandle {
  memory: Pick<MemoryProvider, "retainBatch">;
  calls: Array<{ bankId: string; items: ReadonlyArray<RetainBatchItem> }>;
}

function buildRecordingMemory(): RecordingMemoryHandle {
  const calls: RecordingMemoryHandle["calls"] = [];
  return {
    calls,
    memory: {
      retainBatch: vi.fn(async (bankId: string, items: ReadonlyArray<RetainBatchItem>) => {
        calls.push({ bankId, items });
      }),
    },
  };
}

// --- Tests ---

describe("runObserver — real PG + recording memory mock", () => {
  it("skips with conversation_not_found when the conversation row doesn't exist", async () => {
    const stub = buildStubProvider({});
    const recorder = buildRecordingMemory();
    const result = await runObserver(
      { data: { conversationId: "00000000-0000-0000-0000-000000000000" } },
      fakeStep,
      {
        runInTx: fakeRunInTx,
        agentStore: store,
        transportStore,
        resolveProvider: () =>
          Promise.resolve({
            provider: stub.provider,
            limits: { contextWindow: null, maxOutputTokens: null },
          }),
        memory: recorder.memory,
      },
    );
    expect(result).toEqual({ status: "skipped", reason: "conversation_not_found" });
    expect(stub.calls).toHaveLength(0);
    expect(recorder.calls).toHaveLength(0);
  });

  // The `profile_not_found` early-return in `runObserver` is defensive code:
  // `conversations.profile_id` carries an FK to `profiles.id`, so the only
  // way `getProfile` can return undefined is via an FK-bypassing manual
  // SQL operation. Reproducing that condition here would require dropping
  // the FK temporarily — more cost than value. The path is unit-testable
  // by stubbing `agentStore.getProfile`; the integration tier doesn't add
  // signal beyond what unit coverage gives.

  it("skips with too_short when history has fewer than MIN_MESSAGES_FOR_EXTRACTION rows — no LLM call", async () => {
    const { conversationId } = await seedConversation({ messageCount: 2 });
    const stub = buildStubProvider({});
    const recorder = buildRecordingMemory();
    const result = await runObserver({ data: { conversationId } }, fakeStep, {
      runInTx: fakeRunInTx,
      agentStore: store,
      transportStore,
      resolveProvider: () =>
        Promise.resolve({
          provider: stub.provider,
          limits: { contextWindow: null, maxOutputTokens: null },
        }),
      memory: recorder.memory,
    });
    expect(result).toEqual({ status: "skipped", reason: "too_short" });
    expect(stub.calls).toHaveLength(0);
    expect(recorder.calls).toHaveLength(0);
  });

  it("happy path: extracts memories with full network/compartment/trust tags via retainBatch", async () => {
    const { conversationId } = await seedConversation({ messageCount: 4 });
    const stub = buildStubProvider({
      extractionMemories: [
        {
          fact: "homelab IP is 10.0.10.10",
          network: "world",
          compartment: "technical",
          trust: "first-party",
        },
      ],
    });
    const recorder = buildRecordingMemory();

    const result = await runObserver({ data: { conversationId } }, fakeStep, {
      runInTx: fakeRunInTx,
      agentStore: store,
      transportStore,
      resolveProvider: () =>
        Promise.resolve({
          provider: stub.provider,
          limits: { contextWindow: null, maxOutputTokens: null },
        }),
      memory: recorder.memory,
    });

    if (result.status !== "processed") throw new Error(`expected processed, got ${result.status}`);
    expect(result.memories.extracted).toBe(1);

    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0];
    expect(call?.bankId).toBe(userId);
    expect(call?.items).toHaveLength(1);
    expect(call?.items[0]?.tags).toEqual([
      "network:world",
      "compartment:technical",
      "trust:first-party",
    ]);
    expect(call?.items[0]?.metadata).toEqual({ source: "conversation" });
  });

  it("stamps profile_class:<class> on every emitted memory when the profile is classed", async () => {
    // Real PG validates the composite FK (user_id, profile_class) →
    // profile_classes(user_id, name) here — the seeded conversation
    // can only carry profileClass: "intimate" if the class is
    // pre-registered. This test covers both the FK happy path AND the
    // tag-emission contract.
    await pgClient.unsafe(
      `INSERT INTO profile_classes (user_id, name, description) VALUES ($1, $2, $3)`,
      [userId, "intimate", "for emotional topics"],
    );

    const { conversationId } = await seedConversation({
      messageCount: 4,
      profileClass: "intimate",
    });

    const stub = buildStubProvider({
      extractionMemories: [
        {
          fact: "wife's birthday is March 15",
          network: "bank",
          compartment: "personal",
          trust: "first-party",
        },
      ],
    });
    const recorder = buildRecordingMemory();

    const result = await runObserver({ data: { conversationId } }, fakeStep, {
      runInTx: fakeRunInTx,
      agentStore: store,
      transportStore,
      resolveProvider: () =>
        Promise.resolve({
          provider: stub.provider,
          limits: { contextWindow: null, maxOutputTokens: null },
        }),
      memory: recorder.memory,
    });

    if (result.status !== "processed") throw new Error("expected processed");
    expect(recorder.calls[0]?.items[0]?.tags).toContain("profile_class:intimate");
  });

  it("templates custom_compartments into the extraction prompt and tags emitted memories with the custom value", async () => {
    await pgClient.unsafe(
      `INSERT INTO custom_compartments (user_id, name, description) VALUES ($1, $2, $3)`,
      [userId, "dnd", "tabletop campaign notes"],
    );

    const { conversationId } = await seedConversation({ messageCount: 4 });
    const stub = buildStubProvider({
      extractionMemories: [
        {
          fact: "campaign uses Stars Without Number rules",
          network: "world",
          compartment: "dnd",
          trust: "first-party",
        },
      ],
    });
    const recorder = buildRecordingMemory();

    const result = await runObserver({ data: { conversationId } }, fakeStep, {
      runInTx: fakeRunInTx,
      agentStore: store,
      transportStore,
      resolveProvider: () =>
        Promise.resolve({
          provider: stub.provider,
          limits: { contextWindow: null, maxOutputTokens: null },
        }),
      memory: recorder.memory,
    });

    if (result.status !== "processed") throw new Error("expected processed");
    // Prompt threading: the extraction system prompt should contain
    // both the custom name and its description, lifted verbatim from
    // the registry — the load-custom-compartments step plus the
    // `buildCompartmentDefinitions` builder must be wired together
    // for the LLM to ever see the custom bucket.
    const extractionCall = stub.calls.find((c) => c.system.includes("memory extraction engine"));
    expect(extractionCall).toBeDefined();
    expect(extractionCall?.system).toContain("**dnd**: tabletop campaign notes");

    expect(recorder.calls[0]?.items[0]?.tags).toContain("compartment:dnd");
  });

  it("templates custom_compartments into the pending-classification prompt too", async () => {
    // Phase 3 must template customs into the SAME prompt-builder so a
    // pending row classified as `dnd` is accepted (the strict schema
    // `[...CORE, ...customs]` enforces this). Without it, the row
    // would be classified successfully against the loose schema but
    // the classifier wouldn't know `dnd` was an option.
    await pgClient.unsafe(
      `INSERT INTO custom_compartments (user_id, name, description) VALUES ($1, $2, $3)`,
      [userId, "dnd", "tabletop campaign notes"],
    );
    const { conversationId, profileId } = await seedConversation({ messageCount: 4 });
    await pgClient.unsafe(
      `INSERT INTO pending_memories (user_id, profile_id, content, source) VALUES ($1, $2, $3, 'live_retain')`,
      [userId, profileId, "campaign uses Stars Without Number"],
    );

    const stub = buildStubProvider({
      pendingClassification: { network: "world", compartment: "dnd", trust: "first-party" },
    });
    const recorder = buildRecordingMemory();

    const result = await runObserver({ data: { conversationId } }, fakeStep, {
      runInTx: fakeRunInTx,
      agentStore: store,
      transportStore,
      resolveProvider: () =>
        Promise.resolve({
          provider: stub.provider,
          limits: { contextWindow: null, maxOutputTokens: null },
        }),
      memory: recorder.memory,
    });

    if (result.status !== "processed") throw new Error("expected processed");
    const classifierCall = stub.calls.find((c) => c.system.includes("classifying a single fact"));
    expect(classifierCall?.system).toContain("**dnd**: tabletop campaign notes");
    expect(result.drained.drained).toBe(1);
  });

  it("drains pending_memories: retains via memory.retainBatch with source=live_retain and clears the staged rows", async () => {
    const { conversationId, profileId } = await seedConversation({ messageCount: 4 });
    // Stage a row directly — same shape `memory_retain` produces in
    // production (live_retain) and `cogmo migrate-memories` produces
    // (migration). `profile_id` set so the LEFT JOIN-derived
    // `profileClass` on the read carries the staging profile's class.
    await pgClient.unsafe(
      `INSERT INTO pending_memories (user_id, profile_id, content, source) VALUES ($1, $2, $3, 'live_retain')`,
      [userId, profileId, "user prefers tabs over spaces"],
    );

    const stub = buildStubProvider({
      extractionMemories: [], // no transcript-extracted facts
      pendingClassification: { network: "bank", compartment: "personal", trust: "first-party" },
    });
    const recorder = buildRecordingMemory();

    const result = await runObserver({ data: { conversationId } }, fakeStep, {
      runInTx: fakeRunInTx,
      agentStore: store,
      transportStore,
      resolveProvider: () =>
        Promise.resolve({
          provider: stub.provider,
          limits: { contextWindow: null, maxOutputTokens: null },
        }),
      memory: recorder.memory,
    });

    if (result.status !== "processed") throw new Error("expected processed");
    expect(result.drained.drained).toBe(1);
    expect(result.drained.byNetwork).toEqual({ bank: 1 });

    // Two retainBatch calls: phase 2 (transcript — empty payload) and
    // phase 3 (pending drain — one item with source: live_retain).
    const drainCall = recorder.calls.find((c) => c.items.length > 0);
    expect(drainCall?.items[0]?.metadata).toEqual({ source: "live_retain" });
    expect(drainCall?.items[0]?.tags).toEqual([
      "network:bank",
      "compartment:personal",
      "trust:first-party",
    ]);

    // pending_memories cleared — Real-PG load-bearing assertion: the
    // delete inside Observer's transaction actually committed.
    const remaining = await pgClient.unsafe<Array<{ count: string }>>(
      `SELECT count(*)::text as count FROM pending_memories WHERE user_id = $1`,
      [userId],
    );
    expect(remaining[0]?.count).toBe("0");
  });

  it("staged-row class lineage flows through: a row staged by a classed profile retains profile_class:<class>", async () => {
    // Speaker-isolation invariant under multi-profile drains. The
    // pending row is staged by profile-A (classed `intimate`); the
    // Observer fire is on a conversation under profile-B (unclassed).
    // The retained row must carry `profile_class:intimate`, not
    // profile-B's (null) class — this comes from
    // `getPendingMemories`'s LEFT JOIN, which is real-PG load-bearing.
    await pgClient.unsafe(
      `INSERT INTO profile_classes (user_id, name, description) VALUES ($1, $2, $3)`,
      [userId, "intimate", "for emotional topics"],
    );
    // Profile-A: classed `intimate`, will stage the pending row.
    const insertedProfileA = await db
      .insert(profiles)
      .values({
        userId,
        name: `it-profile-A-${Date.now()}`,
        basePrompt: "intimate profile",
        model: "claude-sonnet-4-6",
        toolSet: [],
        profileClass: "intimate",
      })
      .returning({ id: profiles.id });
    const profileAId = expectDefined(insertedProfileA[0], "inserted profile-A row").id;
    // Profile-B: unclassed, hosts the conversation that fires the Observer.
    const { conversationId } = await seedConversation({ messageCount: 4 });
    // Stage the pending row under profile-A's lineage.
    await pgClient.unsafe(
      `INSERT INTO pending_memories (user_id, profile_id, content, source) VALUES ($1, $2, $3, 'live_retain')`,
      [userId, profileAId, "wife's birthday is March 15"],
    );

    const stub = buildStubProvider({
      pendingClassification: { network: "bank", compartment: "personal", trust: "first-party" },
    });
    const recorder = buildRecordingMemory();

    const result = await runObserver({ data: { conversationId } }, fakeStep, {
      runInTx: fakeRunInTx,
      agentStore: store,
      transportStore,
      resolveProvider: () =>
        Promise.resolve({
          provider: stub.provider,
          limits: { contextWindow: null, maxOutputTokens: null },
        }),
      memory: recorder.memory,
    });

    if (result.status !== "processed") throw new Error("expected processed");
    const drainCall = recorder.calls.find((c) => c.items.length > 0);
    expect(drainCall?.items[0]?.tags).toContain("profile_class:intimate");
  });

  it("classifier failure on a staged row leaves it in pending_memories — partial-failure recovery", async () => {
    const { conversationId, profileId } = await seedConversation({ messageCount: 4 });
    await pgClient.unsafe(
      `INSERT INTO pending_memories (user_id, profile_id, content, source) VALUES ($1, $2, $3, 'live_retain')`,
      [userId, profileId, "this row will not classify"],
    );

    // Stub provider rejects the classifier prompt — simulates an LLM
    // outage or a stale fixture during the structured-output retry
    // loop. classifyOne should swallow per-row, leaving the pending
    // row for the next drain attempt.
    const provider: LlmProvider = {
      name: "stub",
      async chat(params: ChatParams): Promise<LlmResponse> {
        const sys = params.system ?? "";
        if (sys.includes("classifying a single fact")) {
          throw new Error("classifier outage");
        }
        if (sys.includes("memory extraction engine")) {
          return {
            content: [{ type: "text", text: JSON.stringify({ memories: [] }) }],
            stopReason: "end_turn",
            model: params.model,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        if (sys.includes("behavioral correction extractor")) {
          return {
            content: [{ type: "text", text: JSON.stringify({ corrections: [] }) }],
            stopReason: "end_turn",
            model: params.model,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        throw new Error(`stub: unexpected prompt: "${sys.slice(0, 60)}"`);
      },
      chatStream(): ChatStreamResult {
        throw new Error("not used");
      },
      async countTokens(): Promise<number> {
        return 0;
      },
    };
    const recorder = buildRecordingMemory();

    const result = await runObserver({ data: { conversationId } }, fakeStep, {
      runInTx: fakeRunInTx,
      agentStore: store,
      transportStore,
      resolveProvider: () =>
        Promise.resolve({ provider, limits: { contextWindow: null, maxOutputTokens: null } }),
      memory: recorder.memory,
    });

    if (result.status !== "processed") throw new Error("expected processed");
    expect(result.drained.drained).toBe(0);

    // Real-PG load-bearing: the pending row stayed in the table —
    // delete-pending-memories is only called when classification yields
    // ≥1 successful row.
    const remaining = await pgClient.unsafe<Array<{ count: string }>>(
      `SELECT count(*)::text as count FROM pending_memories WHERE user_id = $1`,
      [userId],
    );
    expect(remaining[0]?.count).toBe("1");
  });

  it("scopes a 'new' correction to the active channel and stamps channel_type on the steering_rules row", async () => {
    // End-to-end channel-scoping path — mirrors the unit test for
    // extractCorrections but validates the wiring chain
    // (transport.getActiveChannelTypes → prompt → upsertCorrection
    // → steering_rules.channel_type) under real PG.
    const { conversationId } = await seedConversation({ messageCount: 4 });
    await openActiveChannelSession(conversationId, "telegram");

    const provider: LlmProvider = {
      name: "stub",
      async chat(params: ChatParams): Promise<LlmResponse> {
        const sys = params.system ?? "";
        if (sys.includes("behavioral correction extractor")) {
          // Assert the prompt actually saw the channel context — the
          // load-active-channel-types step must run before the
          // extractor.
          expect(sys).toContain("`telegram`");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  corrections: [
                    {
                      rule: "Avoid markdown headings in chat replies",
                      category: "style",
                      reasoning: "Telegram-specific formatting preference",
                      matchedExistingRuleId: null,
                      action: "new",
                      channelType: "telegram",
                    },
                  ],
                }),
              },
            ],
            stopReason: "end_turn",
            model: params.model,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        if (sys.includes("memory extraction engine")) {
          return {
            content: [{ type: "text", text: JSON.stringify({ memories: [] }) }],
            stopReason: "end_turn",
            model: params.model,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        throw new Error(`stub: unexpected prompt: "${sys.slice(0, 60)}"`);
      },
      chatStream(): ChatStreamResult {
        throw new Error("not used");
      },
      async countTokens(): Promise<number> {
        return 0;
      },
    };
    const recorder = buildRecordingMemory();

    const result = await runObserver({ data: { conversationId } }, fakeStep, {
      runInTx: fakeRunInTx,
      agentStore: store,
      transportStore,
      resolveProvider: () =>
        Promise.resolve({ provider, limits: { contextWindow: null, maxOutputTokens: null } }),
      memory: recorder.memory,
    });

    if (result.status !== "processed") throw new Error("expected processed");
    expect(result.corrections.extracted).toBe(1);

    const rows = await db
      .select({
        rule: steeringRules.rule,
        channelType: steeringRules.channelType,
        source: steeringRules.source,
      })
      .from(steeringRules)
      .where(eq(steeringRules.source, "correction"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.channelType).toBe("telegram");
    expect(rows[0]?.rule).toBe("Avoid markdown headings in chat replies");
  });
});
