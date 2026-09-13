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
 * The file runs its own Inngest dev server. Every integration file that
 * boots the app registers the pipeline functions under its own app id, so on
 * the shared server one event would run this file's stages, gates and
 * resolutions in every such app at once — something production, with one
 * app, never does.
 *
 * The model is a canned stub: stage turns reply with fixed text, so the
 * assertions are about the engine, not model output.
 */

import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { connect } from "inngest/connect";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startPipelineRun } from "../agent/pipeline/start-run.js";
import { pipelineRuns } from "../agent/pipeline/store/schema.js";
import type { PipelineDefinition, Stage } from "../agent/pipeline/types.js";
import { profiles } from "../agent/store/schema.js";
import { db } from "../db/index.js";
import {
  directOutbound,
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
import { asyncIterableOf } from "./factories.js";
import { createIsolatedUser } from "./isolated-user.js";

const DRAFT_REPLY = "Draft: add a retry around the flaky call.";
const BUILD_REPLY = "Built: the retry is in.";

/** The text of the last user message a model call carries. */
function lastUserText(params: ChatParams): string {
  const last = params.messages.findLast((m) => m.role === "user");
  if (last === undefined) return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function replyFor(params: ChatParams): string {
  const prompt = lastUserText(params);
  if (/stage 1 of 3: draft\b/.test(prompt)) return DRAFT_REPLY;
  if (/stage 3 of 3: build\b/.test(prompt)) return BUILD_REPLY;
  return "ok";
}

const usage = { inputTokens: 10, outputTokens: 5 };

const stubProvider: LlmProvider = {
  name: "pipeline-run-stub",
  async chat(params): Promise<LlmResponse> {
    return {
      content: [{ type: "text", text: replyFor(params) }],
      stopReason: "end_turn",
      model: params.model,
      usage,
    };
  },
  chatStream(params) {
    return {
      events: asyncIterableOf([{ type: "text_delta" as const, text: replyFor(params) }]),
      response: Promise.resolve({ stopReason: "end_turn" as const, model: params.model, usage }),
    };
  },
  async countTokens() {
    return 100;
  },
};

let app: Awaited<ReturnType<typeof import("../index.js")["bootstrap"]>>;
let inngestServer: StartedTestContainer | undefined;
let connection: Awaited<ReturnType<typeof connect>>;
let userId: string;
let directChannelId: string;
let telegramChannelId: string;

const outbound: Array<{ platformAddress: string; content: string }> = [];
const settled: Array<{ gateKey: string }> = [];
const stagesDue: Array<{ id: string | undefined; runId: string; stageId: string }> = [];

beforeAll(async () => {
  // Mirrors `dev/containers.ts → inngest(...)`, without the shared network:
  // the app reaches it on mapped host ports.
  inngestServer = await new GenericContainer("mirror.gcr.io/inngest/inngest:v1.41.1")
    .withExposedPorts(8288, 8289)
    .withCommand(["inngest", "dev", "--host", "0.0.0.0", "--port", "8288", "--no-discovery"])
    .withWaitStrategy(Wait.forHttp("/health", 8288))
    .withStartupTimeout(60_000)
    .start();
  const host = inngestServer.getHost();
  process.env.INNGEST_BASE_URL = `http://${host}:${inngestServer.getMappedPort(8288)}`;
  process.env.INNGEST_CONNECT_GATEWAY_URL = `ws://${host}:${inngestServer.getMappedPort(8289)}/v0/connect`;

  // The Inngest client reads its environment when `src/inngest/client.ts`
  // first loads, and none of this file's static imports reach it — so the app
  // loads only now, against this file's server.
  const { bootstrap } = await import("../index.js");
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
  if (inngestServer) await inngestServer.stop();
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

    // Read after the last delivery, so a late duplicate would already be here:
    // the waiter's cancel went out once for this gate, and each stage was
    // scheduled once, under its run-cursor dedup id.
    expect(settled.filter((s) => s.gateKey === gateKey)).toHaveLength(1);
    const dueFor = (stageId: string) =>
      stagesDue.filter((d) => d.runId === runId && d.stageId === stageId).map((d) => d.id);
    expect(dueFor("draft")).toEqual([`pipeline-stage-due-${runId}-draft-0`]);
    expect(dueFor("build")).toEqual([`pipeline-stage-due-${runId}-build-0`]);

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
});
