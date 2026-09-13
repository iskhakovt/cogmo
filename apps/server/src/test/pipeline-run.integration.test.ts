/// <reference path="../../test/vitest.d.ts" />

/**
 * The pipeline run engine against a real Inngest dev server and real
 * Postgres: `startPipelineRun` → `pipeline-stage-runner` → a parked gate →
 * `pipeline-gate-resolver` → completion, through the functions `bootstrap()`
 * registers.
 *
 * What this proves over the unit tier: the stage runner and resolver under
 * real step replays, the first stage's wait for the starting chat turn, the
 * event wiring (stage.due dedup ids, `pipeline/gate.settled`, the waiter's
 * timeout), and the gate claim against Postgres rather than PGlite.
 *
 * The model is a canned stub: stage turns reply with fixed text, so the
 * assertions are about the engine, not model output.
 */

import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { connect } from "inngest/connect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startPipelineRun } from "../agent/pipeline/start-run.js";
import { pipelineRuns } from "../agent/pipeline/store/schema.js";
import type { PipelineDefinition, Stage } from "../agent/pipeline/types.js";
import { profiles } from "../agent/store/schema.js";
import { db } from "../db/index.js";
import { bootstrap } from "../index.js";
import {
  directInbound,
  directOutbound,
  inboundReady,
  pipelineGateKey,
  pipelineGateResolved,
  pipelineGateSettled,
  pipelineStageDue,
  responseReady,
} from "../inngest/events.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ChatParams, LlmResponse } from "../llm/types.js";
import { channelSessions, channels, inboundMessages } from "../transport/store/schema.js";
import { expectDefined } from "./assertions.js";
import { createIsolatedUser } from "./isolated-user.js";

const DRAFT_REPLY = "Draft: add a retry around the flaky call.";
const BUILD_REPLY = "Built: the retry is in.";
const CHAT_MARKER = "mid-stage question";
const CHAT_REPLY = "Chat: answered after the stage.";
const DRAFT_PROMPT = /stage 1 of 3: draft\b/;

/** The text of the last user message a model call carries. */
function lastUserText(params: ChatParams): string {
  const last = params.messages.findLast((m) => m.role === "user");
  if (last === undefined) return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function replyFor(prompt: string): string {
  if (DRAFT_PROMPT.test(prompt)) return DRAFT_REPLY;
  if (/stage 3 of 3: build\b/.test(prompt)) return BUILD_REPLY;
  if (prompt.includes(CHAT_MARKER)) return CHAT_REPLY;
  return "ok";
}

/** Model calls in the order they start and end. */
const modelCalls: Array<{ edge: "start" | "end"; prompt: string }> = [];
/** While set, the draft stage's model call waits on it. */
let draftHold: Promise<void> | null = null;

async function respond(params: ChatParams): Promise<string> {
  const prompt = lastUserText(params);
  modelCalls.push({ edge: "start", prompt });
  if (draftHold !== null && DRAFT_PROMPT.test(prompt)) await draftHold;
  modelCalls.push({ edge: "end", prompt });
  return replyFor(prompt);
}

const usage = { inputTokens: 10, outputTokens: 5 };

const stubProvider: LlmProvider = {
  name: "pipeline-run-stub",
  async chat(params): Promise<LlmResponse> {
    return {
      content: [{ type: "text", text: await respond(params) }],
      stopReason: "end_turn",
      model: params.model,
      usage,
    };
  },
  chatStream(params) {
    const text = respond(params);
    return {
      events: (async function* () {
        yield { type: "text_delta" as const, text: await text };
      })(),
      response: text.then(() => ({ stopReason: "end_turn" as const, model: params.model, usage })),
    };
  },
  async countTokens() {
    return 100;
  },
};

let app: Awaited<ReturnType<typeof bootstrap>>;
let connection: Awaited<ReturnType<typeof connect>>;
let userId: string;
let directChannelId: string;
let telegramChannelId: string;

const outbound: Array<{ platformAddress: string; content: string }> = [];
const settled: Array<{ gateKey: string }> = [];
const stagesDue: Array<{ id: string | undefined; runId: string; stageId: string }> = [];
const readyConversations: string[] = [];

beforeAll(async () => {
  app = await bootstrap({ providerOverride: stubProvider });

  const captures = [
    app.inngest.createFunction(
      { id: "test-capture-run-outbound", triggers: [directOutbound] },
      async ({ event }) => {
        outbound.push({ platformAddress: event.data.platformAddress, content: event.data.content });
      },
    ),
    app.inngest.createFunction(
      { id: "test-capture-gate-settled", triggers: [pipelineGateSettled] },
      async ({ event }) => {
        settled.push({ gateKey: event.data.gateKey });
      },
    ),
    app.inngest.createFunction(
      { id: "test-capture-stage-due", triggers: [pipelineStageDue] },
      async ({ event }) => {
        stagesDue.push({ id: event.id, runId: event.data.runId, stageId: event.data.stageId });
      },
    ),
    app.inngest.createFunction(
      { id: "test-capture-inbound-ready", triggers: [inboundReady] },
      async ({ event }) => {
        readyConversations.push(event.data.conversationId);
      },
    ),
  ];
  connection = await connect({
    apps: [{ client: app.inngest, functions: [...app.functions, ...captures] }],
  });

  // Private user: the integration tier runs files in parallel against one
  // Postgres, and every row this file asserts on hangs off this user.
  userId = await createIsolatedUser(db);
  const channelIdOf = async (type: "direct" | "telegram") =>
    expectDefined(
      (
        await db.select({ id: channels.id }).from(channels).where(eq(channels.type, type)).limit(1)
      )[0],
      `${type} channel`,
    ).id;
  directChannelId = await channelIdOf("direct");
  telegramChannelId = await channelIdOf("telegram");
});

afterAll(async () => {
  if (connection) await connection.close();
});

type Gate = NonNullable<Stage["gate"]>;

/**
 * A user profile with a chat conversation reachable on the direct channel
 * (whose deliveries the test captures) and on Telegram (a gate-capable
 * channel, which a pipeline with gates requires), plus an active
 * draft → gate → build definition.
 */
async function seedRunnable(gate: Gate) {
  const suffix = randomUUID().slice(0, 8);
  const name = `it-run-${suffix}`;
  const directAddress = `it-run-${suffix}`;

  const profile = await app.runInTx((tx) =>
    app.agentStore.createProfile(tx, {
      userId,
      name,
      basePrompt: "You run pipeline stages.",
      model: "stub-model",
      toolSet: [],
    }),
  );
  // Recall would reach Hindsight on every stage prompt; the engine doesn't need it.
  await db.update(profiles).set({ autoRecall: "off" }).where(eq(profiles.id, profile.id));

  const origin = await app.runInTx((tx) =>
    app.agentStore.createConversation(tx, { userId, profileId: profile.id, isPrivate: true }),
  );
  await db.insert(channelSessions).values([
    {
      channelId: directChannelId,
      platformAddress: directAddress,
      conversationId: origin.id,
      status: "active",
      receive: "routed",
    },
    {
      channelId: telegramChannelId,
      platformAddress: String(Math.floor(1e9 + Math.random() * 8e9)),
      conversationId: origin.id,
      status: "active",
      receive: "routed",
    },
  ]);

  const compiled: PipelineDefinition = {
    name,
    trigger: { kind: "command", phrase: "run the test pipeline" },
    stages: [
      { id: "draft", kind: "agentic", instructions: "Draft a plan.", output: { kind: "text" } },
      { id: "approve", kind: "gate", instructions: "Approve the plan?", gate },
      { id: "build", kind: "agentic", instructions: "Build it.", output: { kind: "text" } },
    ],
  };
  await app.runInTx(async (tx) => {
    const definition = await app.pipelineStore.insertDefinition(tx, {
      userId,
      name,
      sourceText: "draft, approve, build",
      compiled,
    });
    await app.pipelineStore.activateDefinition(tx, userId, definition.id);
  });

  return { name, profileId: profile.id, originConversationId: origin.id, directAddress };
}

function startRun(args: { name: string; profileId: string; originConversationId?: string }) {
  return startPipelineRun(
    {
      runInTx: app.runInTx,
      pipelineStore: app.pipelineStore,
      runStore: app.pipelineRunStore,
      agentStore: app.agentStore,
      transportStore: app.transportStore,
      inngest: app.inngest,
      gateChannelTypes: new Set(["telegram"]),
    },
    { userId, idempotencyKey: `it-run:${randomUUID()}`, ...args },
  );
}

async function readRun(runId: string) {
  return expectDefined(
    (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1))[0],
    `pipeline run ${runId}`,
  );
}

async function waitForRun(
  runId: string,
  ready: (run: Awaited<ReturnType<typeof readRun>>) => boolean,
  label: string,
  timeoutMs: number,
) {
  return vi.waitFor(
    async () => {
      const run = await readRun(runId);
      if (!ready(run))
        throw new Error(`run ${runId} not ${label} yet (${run.status} at ${run.currentStage})`);
      return run;
    },
    { timeout: timeoutMs, interval: 250 },
  );
}

function waitForOutbound(address: string, text: string) {
  return vi.waitFor(
    () => {
      const match = outbound.find((o) => o.platformAddress === address && o.content.includes(text));
      if (!match)
        throw new Error(`no delivery to ${address} containing ${JSON.stringify(text)} yet`);
      return match;
    },
    { timeout: 45_000, interval: 250 },
  );
}

describe("pipeline run engine", () => {
  it("runs a chat-started pipeline through an approved gate to completion", async () => {
    const seeded = await seedRunnable({ timeout: "1d", onTimeout: { kind: "abort" } });
    const started = await startRun({
      name: seeded.name,
      profileId: seeded.profileId,
      originConversationId: seeded.originConversationId,
    });
    const { runId, conversationId } = started._unsafeUnwrap();

    // The first stage waits for the starting chat turn's `response/ready`.
    // An event only matches a wait registered before it arrives, so keep
    // sending until the stage has run instead of racing the registration.
    const turnFinished = setInterval(() => {
      app.inngest
        .send(
          responseReady.create({
            conversationId: seeded.originConversationId,
            messageId: randomUUID(),
          }),
        )
        .catch(() => {
          // A lost resend is retried on the next tick; the parked wait below
          // bounds a real outage.
        });
    }, 500);
    const parked = await waitForRun(
      runId,
      (run) => run.status === "waiting_gate",
      "parked on its gate",
      // Under the stage runner's 30s origin-turn timeout: parking in time
      // proves the wait was satisfied by a `response/ready`, not timed out.
      20_000,
    ).finally(() => clearInterval(turnFinished));

    expect(parked.currentStage).toBe("approve");
    expect(parked.stageOutputs).toEqual({ draft: { kind: "text", text: DRAFT_REPLY } });
    await waitForOutbound(seeded.directAddress, DRAFT_REPLY);

    const gateKey = pipelineGateKey(runId, "approve", 0);
    await app.inngest.send(
      pipelineGateResolved.create({ runId, gateKey, conversationId, decision: "approved" }),
    );

    const completed = await waitForRun(
      runId,
      (run) => run.status === "completed",
      "completed",
      45_000,
    );
    expect(completed.stageOutputs).toEqual({
      draft: { kind: "text", text: DRAFT_REPLY },
      build: { kind: "text", text: BUILD_REPLY },
    });
    expect(completed.gateResolution).toEqual({ gateKey, resolverRunId: expect.any(String) });
    await waitForOutbound(seeded.directAddress, `✅ Pipeline "${seeded.name}" completed.`);

    // The waiter's cancel went out once for this gate, and each stage was
    // scheduled once, under its run-cursor dedup id. The capture functions run
    // independently of the delivery above, so poll for their records. A
    // duplicate can't land after the match: stage.due is deduped on its id, and
    // this file's server runs no other app that could settle the gate again.
    const dueFor = (stageId: string) =>
      stagesDue.filter((d) => d.runId === runId && d.stageId === stageId).map((d) => d.id);
    await vi.waitFor(
      () => {
        expect(settled.filter((s) => s.gateKey === gateKey)).toHaveLength(1);
        expect(dueFor("draft")).toEqual([`pipeline-stage-due-${runId}-draft-0`]);
        expect(dueFor("build")).toEqual([`pipeline-stage-due-${runId}-build-0`]);
      },
      { timeout: 10_000, interval: 250 },
    );

    // One persisted stage prompt per agentic stage, keyed on the run cursor.
    const prompts = await db
      .select({ key: inboundMessages.idempotencyKey })
      .from(inboundMessages)
      .where(
        and(
          eq(inboundMessages.source, "pipeline"),
          like(inboundMessages.idempotencyKey, `pipeline:${runId}:%`),
        ),
      );
    expect(prompts.map((p) => p.key).sort()).toEqual([
      `pipeline:${runId}:build:0`,
      `pipeline:${runId}:draft:0`,
    ]);
  });

  it("proceeds past a gate whose timeout elapses", async () => {
    // 0.05m = 3s: the waiter's real sleep, kept short.
    const seeded = await seedRunnable({ timeout: "0.05m", onTimeout: { kind: "proceed" } });
    const { runId } = (
      await startRun({ name: seeded.name, profileId: seeded.profileId })
    )._unsafeUnwrap();

    const completed = await waitForRun(
      runId,
      (run) => run.status === "completed",
      "completed",
      45_000,
    );

    expect(completed.stageOutputs).toEqual({
      draft: { kind: "text", text: DRAFT_REPLY },
      build: { kind: "text", text: BUILD_REPLY },
    });
    expect(completed.gateResolution).toEqual({
      gateKey: pipelineGateKey(runId, "approve", 0),
      resolverRunId: expect.any(String),
    });
    await waitForOutbound(
      seeded.directAddress,
      `⏱ Checkpoint timed out — pipeline "${seeded.name}" is proceeding to "build".`,
    );
  });

  it("holds a chat turn on the run conversation until the stage turn finishes", async () => {
    let release = () => {};
    draftHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    modelCalls.length = 0;
    try {
      const seeded = await seedRunnable({ timeout: "1d", onTimeout: { kind: "abort" } });
      const { runId, conversationId } = (
        await startRun({ name: seeded.name, profileId: seeded.profileId })
      )._unsafeUnwrap();

      await vi.waitFor(
        () => {
          if (!modelCalls.some((c) => c.edge === "start" && DRAFT_PROMPT.test(c.prompt)))
            throw new Error("draft stage turn has not reached the model yet");
        },
        { timeout: 20_000, interval: 100 },
      );

      // The user's session is routed onto the run conversation.
      await app.inngest.send(
        directInbound.create({
          platformAddress: seeded.directAddress,
          text: `${CHAT_MARKER} ${randomUUID()}`,
          platformTs: new Date().toISOString(),
        }),
      );
      await vi.waitFor(
        () => {
          if (!readyConversations.includes(conversationId))
            throw new Error("the chat turn has not been scheduled yet");
        },
        { timeout: 20_000, interval: 100 },
      );
      // Room for a concurrent chat turn to reach the model while the stage holds.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      release();

      await waitForOutbound(seeded.directAddress, CHAT_REPLY);
      const draftEnd = modelCalls.findIndex((c) => c.edge === "end" && DRAFT_PROMPT.test(c.prompt));
      const chatStart = modelCalls.findIndex(
        (c) => c.edge === "start" && c.prompt.includes(CHAT_MARKER),
      );
      expect(draftEnd).toBeGreaterThanOrEqual(0);
      expect(chatStart).toBeGreaterThan(draftEnd);

      const parked = await waitForRun(
        runId,
        (run) => run.status === "waiting_gate",
        "parked on its gate",
        20_000,
      );
      expect(parked.stageOutputs).toEqual({ draft: { kind: "text", text: DRAFT_REPLY } });
      await app.inngest.send(
        pipelineGateResolved.create({
          runId,
          gateKey: pipelineGateKey(runId, "approve", 0),
          conversationId,
          decision: "cancelled",
        }),
      );
    } finally {
      release();
      draftHold = null;
    }
  });
});
