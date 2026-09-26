import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import type { LlmProvider } from "../../llm/provider.js";
import type { ToolDefinition } from "../../llm/types.js";
import { logger } from "../../logger.js";
import type { SkillRunner } from "../../skills/runner.js";
import { expectDefined } from "../../test/assertions.js";
import {
  FAKE_TX,
  fakeRunInTx,
  mockAgentStore,
  mockDeliveryHandle,
  mockDeliveryRouter,
  mockFilesService,
  mockMemoryProvider,
  mockTransportStore,
} from "../../test/factories.js";
import { canonicalKeyOrder } from "../../util/canonical-key-order.js";
import type { AgentLoopResult, StepRunner } from "../loop.js";
import { defineTool, ToolRegistry } from "../tools.js";
import {
  type AgenticStageArgs,
  type AgenticStageDeps,
  runAgenticStage,
  stageInboundKey,
} from "./run-agentic-stage.js";
import type { PipelineDefinition, Stage } from "./types.js";

const log = logger.child({ component: "test" });

const DEFINITION: PipelineDefinition = {
  name: "plan-then-build",
  trigger: { kind: "command", phrase: "plan then build" },
  stages: [
    {
      id: "draft",
      kind: "agentic",
      instructions: "Draft a plan.",
      tools: ["web_search", "start_pipeline"],
      output: { kind: "text" },
    },
    { id: "build", kind: "agentic", instructions: "Build it." },
  ],
};

function stageArgs(stage: Stage = expectDefined(DEFINITION.stages[0], "draft")): AgenticStageArgs {
  return {
    runId: "run-1",
    stageId: stage.id,
    iteration: 0,
    conversationId: "conv-1",
    definition: DEFINITION,
    stage,
    stageOutputs: {},
    inngestRunId: "inngest-run-1",
  };
}

function loopResult(overrides: Partial<AgentLoopResult> = {}): AgentLoopResult {
  return {
    text: "Here is the plan.",
    messages: [],
    newMessages: [{ role: "assistant", content: [{ type: "text", text: "Here is the plan." }] }],
    usage: { inputTokens: 10, outputTokens: 5 },
    model: "claude-sonnet-4-6",
    iterations: 1,
    streamed: { text: "Here is the plan.", toolUseIds: [] },
    ...overrides,
  };
}

function toolNamed(name: string) {
  return defineTool({ name, description: name, schema: z.object({}), handler: async () => "ok" });
}

/** Step runners that execute bodies inline and record the ids they were given. */
function recordingSteps() {
  const ids: string[] = [];
  const runner: StepRunner = (id, fn) => {
    ids.push(id);
    return fn();
  };
  return { ids, steps: { run: runner, stepRun: runner } };
}

/**
 * Step runners that memoize by id across calls, so a second `runAgenticStage`
 * over the same instance behaves as a re-invocation of the same run. `memo`
 * is exposed so a test can hand a replay what the server would return.
 */
function memoizingSteps() {
  const memo = new Map<string, unknown>();
  const runner: StepRunner = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    if (memo.has(id)) return memo.get(id) as T;
    const result = await fn();
    memo.set(id, result);
    return result;
  };
  return { memo, steps: { run: runner, stepRun: runner } };
}

function providerReplying(...texts: string[]): LlmProvider {
  const chat = vi.fn();
  for (const text of texts) {
    chat.mockResolvedValueOnce({
      content: [{ type: "text", text }],
      stopReason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }
  return { name: "test", chat, chatStream: vi.fn(), countTokens: vi.fn().mockResolvedValue(10) };
}

async function harness(opts: { existingInbound?: { id: string; conversationId: string } } = {}) {
  const agentStore = mockAgentStore();
  // The factory's default profile, with every tool visible to it.
  const defaultProfile = expectDefined(
    await agentStore.getProfile(FAKE_TX, "profile-1"),
    "default profile",
  );
  vi.mocked(agentStore.getProfile).mockResolvedValue({ ...defaultProfile, toolSet: ["*"] });
  const transportStore = mockTransportStore({
    // Keyed on the stage cursor, so recovery only happens for the right key.
    findInboundByIdempotencyKey: vi
      .fn()
      .mockImplementation(async (_tx: unknown, key: string) =>
        key === stageInboundKey("run-1", "draft", 0) ? opts.existingInbound : undefined,
      ),
    persistInbound: vi.fn().mockResolvedValue({ id: "inbound-1" }),
  });
  const delivery = mockDeliveryHandle({ hasBatchTargets: vi.fn().mockReturnValue(true) });
  const deliveryRouter = mockDeliveryRouter({ prepare: vi.fn().mockResolvedValue(delivery) });
  const tools = new ToolRegistry();
  for (const name of ["web_search", "read_file", "start_pipeline"]) tools.register(toolNamed(name));
  const runStreamingAgentLoop = vi.fn().mockResolvedValue(loopResult());
  const provider = providerReplying();

  const deps: AgenticStageDeps = {
    runInTx: fakeRunInTx,
    agentStore,
    transportStore,
    resolveProvider: vi.fn().mockResolvedValue({ provider, limits: {} }),
    tools,
    memory: mockMemoryProvider(),
    promptSource: { assemble: vi.fn().mockResolvedValue("SYSTEM PROMPT") },
    fileService: mockFilesService(),
    deliveryRouter,
    runStreamingAgentLoop,
    userTimezone: "UTC",
  };
  return { deps, agentStore, transportStore, delivery, deliveryRouter, runStreamingAgentLoop };
}

describe("runAgenticStage", () => {
  it("persists the stage prompt, runs the loop under the stage allowlist, and returns the text artifact", async () => {
    const h = await harness();
    const { steps } = recordingSteps();

    const outcome = await runAgenticStage(h.deps, stageArgs(), steps, log);

    expect(outcome).toEqual({
      kind: "completed",
      artifact: { kind: "text", text: "Here is the plan." },
    });

    const persisted = expectDefined(
      vi.mocked(h.transportStore.persistInbound).mock.calls[0],
      "persist",
    )[1];
    expect(persisted).toMatchObject({
      source: "pipeline",
      idempotencyKey: stageInboundKey("run-1", "draft", 0),
      conversationId: "conv-1",
      content: expect.stringContaining("Draft a plan."),
    });
    expect(h.agentStore.insertMessage).toHaveBeenCalledWith(expect.anything(), {
      conversationId: "conv-1",
      role: "user",
      content: persisted.content,
      profileId: "profile-1",
      model: "claude-sonnet-4-6",
      lastInboundMessageId: "inbound-1",
    });

    const loopParams = expectDefined(h.runStreamingAgentLoop.mock.calls[0], "loop call")[0];
    expect(loopParams.turnKey).toBe("inbound-1");
    expect(loopParams.systemPrompt).toBe("SYSTEM PROMPT");
    // Same intent as a chat turn: stage and chat turns share the run
    // conversation's transcript.
    expect(loopParams.cache).toEqual({ key: "conv-1", retention: "short" });
    // Narrowed to the stage allowlist, with the pipeline tool dropped even
    // though the allowlist names it.
    expect(loopParams.tools.snapshot().map((t: { name: string }) => t.name)).toEqual([
      "web_search",
    ]);
    expect(loopParams.service.pipelines).toBeUndefined();

    expect(h.deliveryRouter.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        runId: "inngest-run-1",
        kind: "broadcast",
        maxInboundId: "inbound-1",
        prevCursor: null,
      }),
    );
    expect(h.delivery.finish).toHaveBeenCalled();
    expect(h.agentStore.insertMessages).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: "conv-1",
        lastInboundMessageId: "inbound-1",
        lastMessageInputTokens: 10,
        lastMessageOutputTokens: 5,
      }),
    );
  });

  it("delivers the stage's reply to batch targets", async () => {
    const h = await harness();

    await runAgenticStage(h.deps, stageArgs(), recordingSteps().steps, log);

    expect(h.delivery.deliverBatch).toHaveBeenCalledWith("Here is the plan.");
  });

  it("recovers an already-persisted stage prompt instead of writing it again", async () => {
    const h = await harness({
      existingInbound: { id: "inbound-earlier", conversationId: "conv-1" },
    });

    await runAgenticStage(h.deps, stageArgs(), recordingSteps().steps, log);

    expect(h.transportStore.persistInbound).not.toHaveBeenCalled();
    expect(h.agentStore.insertMessage).not.toHaveBeenCalled();
    expect(expectDefined(h.runStreamingAgentLoop.mock.calls[0], "loop call")[0].turnKey).toBe(
      "inbound-earlier",
    );
  });

  it("plans the same step ids on every invocation", async () => {
    const first = recordingSteps();
    const second = recordingSteps();

    await runAgenticStage((await harness()).deps, stageArgs(), first.steps, log);
    await runAgenticStage((await harness()).deps, stageArgs(), second.steps, log);

    expect(first.ids).toEqual(second.ids);
    expect(first.ids).toEqual(
      expect.arrayContaining([
        "load-stage-context",
        "persist-stage-prompt",
        "load-turn-history",
        "freeze-turn-inputs",
        "assemble-prompt",
        "load-last-tokens",
        "persist-new-messages",
        "batch-delivery",
        "extract-artifact",
      ]),
    );
  });

  it("sends the tools it froze on every invocation when a skill stops loading", async () => {
    const h = await harness();
    const skillRunner = mock<SkillRunner>();
    skillRunner.listToolDefs
      .mockResolvedValueOnce([
        {
          name: "echo",
          description: "echo a number",
          inputs: { type: "object", properties: {} },
          tier: "wasm",
          riskTier: "notify",
          gitSha: "abc1234",
        },
      ])
      .mockResolvedValue([]);
    h.deps.skillRunner = skillRunner;
    const stage: Stage = {
      id: "draft",
      kind: "agentic",
      instructions: "Draft a plan.",
      tools: ["web_search", "echo"],
      output: { kind: "text" },
    };
    const { steps } = memoizingSteps();

    await runAgenticStage(h.deps, stageArgs(stage), steps, log);
    await runAgenticStage(h.deps, stageArgs(stage), steps, log);

    const [first, second] = h.runStreamingAgentLoop.mock.calls.map(([params]): ToolDefinition[] =>
      params.tools.definitions(),
    );
    expect(first?.map((d) => d.name)).toEqual(["web_search", "echo"]);
    expect(second).toEqual(first);
  });

  it("sends byte-identical tools when replayed from the server's copy of its frozen table", async () => {
    // The server returns memoized step output with object keys sorted at every
    // depth (as `canonicalKeyOrder` does) and strings unchanged. A table
    // returned as an object fails this; one returned as JSON text passes.
    const h = await harness();
    const { memo, steps } = memoizingSteps();

    await runAgenticStage(h.deps, stageArgs(), steps, log);
    memo.set("freeze-turn-inputs", canonicalKeyOrder(memo.get("freeze-turn-inputs")));
    await runAgenticStage(h.deps, stageArgs(), steps, log);

    const [first, second] = h.runStreamingAgentLoop.mock.calls.map(([params]): string =>
      JSON.stringify(params.tools.definitions()),
    );
    // Non-vacuous: sorted, these definitions serialize differently.
    const sent = expectDefined(first, "first invocation's tools");
    expect(JSON.stringify(canonicalKeyOrder(JSON.parse(sent)))).not.toBe(sent);
    expect(second).toBe(sent);
  });

  it("fails the stage when the loop degrades, after persisting what it produced", async () => {
    const h = await harness();
    h.runStreamingAgentLoop.mockResolvedValue(
      loopResult({ text: "", degraded: { reason: "iteration_cap", subtype: null } }),
    );

    const outcome = await runAgenticStage(h.deps, stageArgs(), recordingSteps().steps, log);

    expect(outcome).toEqual({
      kind: "failed",
      reason: "the stage's agent turn could not finish (iteration_cap)",
    });
    expect(h.agentStore.insertMessages).toHaveBeenCalled();
    // Nothing to deliver: a degraded turn's text is empty.
    expect(h.delivery.deliverBatch).not.toHaveBeenCalled();
  });

  // The degrade dropped the iteration that streamed this output — here a tool
  // call cut off at the output cap, which never ran — so the stage's sessions
  // must not keep showing it.
  it("retracts a degraded turn's dropped output before closing the stream", async () => {
    const h = await harness();
    h.runStreamingAgentLoop.mockResolvedValue(
      loopResult({
        text: "",
        newMessages: [],
        streamed: { text: "Writing it now.", toolUseIds: ["t1"] },
        degraded: {
          reason: "reply hit the output token limit during a tool call",
          subtype: "max_tokens",
        },
      }),
    );
    const steps = recordingSteps();

    await runAgenticStage(h.deps, stageArgs(), steps.steps, log);

    expect(h.delivery.push).toHaveBeenCalledWith({
      type: "retract",
      text: "Writing it now.",
      toolUseIds: ["t1"],
    });
    expect(steps.ids).toContain("retract-degraded-output");
    const pushed = vi.mocked(h.delivery.push).mock.invocationCallOrder.at(-1) ?? 0;
    const finished = vi.mocked(h.delivery.finish).mock.invocationCallOrder[0] ?? 0;
    expect(pushed).toBeLessThan(finished);
  });

  it("pushes no retraction when a degraded turn persists everything it streamed", async () => {
    const h = await harness();
    h.runStreamingAgentLoop.mockResolvedValue(
      loopResult({ text: "", degraded: { reason: "iteration_cap", subtype: null } }),
    );
    const steps = recordingSteps();

    await runAgenticStage(h.deps, stageArgs(), steps.steps, log);

    expect(h.delivery.push).not.toHaveBeenCalledWith(expect.objectContaining({ type: "retract" }));
    expect(steps.ids).not.toContain("retract-degraded-output");
  });

  it("fails the stage when the reply was cut off at the output cap, after persisting and delivering it", async () => {
    // A truncated reply is still what the user was streamed, so it lands in
    // the transcript and reaches batch targets — but it is not the stage's
    // output, and extracting an artifact from half a document would hand
    // the next stage a result that looks finished.
    const h = await harness();
    const partial = "Here is the pl\n\n[Reply cut off: it reached the model's output limit.]";
    h.runStreamingAgentLoop.mockResolvedValue(loopResult({ text: partial, truncated: true }));
    const steps = recordingSteps();

    const outcome = await runAgenticStage(h.deps, stageArgs(), steps.steps, log);

    expect(outcome).toEqual({
      kind: "failed",
      reason: "the stage's reply was cut off at the model's output limit",
    });
    expect(h.agentStore.insertMessages).toHaveBeenCalled();
    expect(h.delivery.deliverBatch).toHaveBeenCalledWith(partial);
    expect(steps.ids).not.toContain("extract-artifact");
  });

  it("fails the stage when its json artifact doesn't satisfy the declared schema", async () => {
    const h = await harness();
    const provider = providerReplying('{"title": 1}', '{"title": 2}');
    h.deps.resolveProvider = vi.fn().mockResolvedValue({ provider, limits: {} });
    const stage: Stage = {
      id: "build",
      kind: "agentic",
      instructions: "Build it.",
      output: {
        kind: "json",
        schema: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
      },
    };

    const outcome = await runAgenticStage(h.deps, stageArgs(stage), recordingSteps().steps, log);

    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.reason).toContain("/title must be string");
  });

  it("aborts delivery and rethrows when the loop throws", async () => {
    const h = await harness();
    const boom = new Error("stream reset");
    h.runStreamingAgentLoop.mockRejectedValue(boom);

    await expect(runAgenticStage(h.deps, stageArgs(), recordingSteps().steps, log)).rejects.toBe(
      boom,
    );
    expect(h.delivery.abort).toHaveBeenCalledWith("stream reset");
    expect(h.agentStore.insertMessages).not.toHaveBeenCalled();
  });
});
