import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { LlmProvider } from "../../llm/provider.js";
import type { LlmResponse } from "../../llm/types.js";
import { logger } from "../../logger.js";
import { mockFilesService, mockResolver } from "../../test/factories.js";
import { runAgentLoop, type StepRunner } from "../loop.js";
import type { Service } from "../service.js";
import type { SubAgent } from "../store/index.js";
import { ToolRegistry } from "../tools.js";
import { buildSubAgentTools } from "./sub-agent-tool-builder.js";

/**
 * Component-integration test for the headline "two models work together" path:
 * the real `runAgentLoop` drives a turn on model A that calls a `subagent__`
 * tool, whose handler resolves a *different* model B via the shared resolver,
 * and the loop feeds B's text back and lets A finish. Only the two LLM
 * endpoints are mocked — the loop, tool dispatch (incl. the durable `step.run`
 * wrap), `buildSubAgentTools`, and per-model resolver dispatch are all real.
 *
 * The full llmock-fixture integration tier would also pin the wire shapes, but
 * needs recorded fixtures (real upstream calls); this proves the wiring with no
 * keys and runs deterministically.
 */

function stubService(): Service {
  return {
    memory: {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
      retain: vi.fn().mockResolvedValue(undefined),
      reflect: vi.fn().mockResolvedValue({ answer: "" }),
      stageRetain: vi.fn().mockResolvedValue(undefined),
    },
    files: mockFilesService(),
    coreMemory: {
      get: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function textResponse(text: string): LlmResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

/** A provider scripted to return the given responses in order (model A turn). */
function scriptedProvider(responses: LlmResponse[]): LlmProvider {
  const chat = vi.fn();
  for (const r of responses) chat.mockResolvedValueOnce(r);
  return {
    name: "model-a",
    chat,
    chatStream() {
      throw new Error("chatStream not used");
    },
    countTokens: vi.fn(),
  };
}

describe("sub-agent delegation (two models)", () => {
  it("orchestrator (model A) delegates to a sub-agent running model B and uses its text", async () => {
    const row: SubAgent = {
      id: "sa-1",
      name: "writer",
      description: "long-form prose",
      systemPrompt: "Be terse.",
      model: "model-b",
    };

    // Specialist: model B, resolved only through the sub-agent handler.
    const providerB = mock<LlmProvider>();
    providerB.chat.mockResolvedValue(textResponse("SUBAGENT DRAFT"));
    const resolveProvider = mockResolver(new Map([["model-b", providerB]]));

    const registry = new ToolRegistry();
    for (const spec of buildSubAgentTools([row], resolveProvider)) registry.register(spec);

    // Orchestrator: model A — first calls the sub-agent, then replies with its text.
    const providerA = scriptedProvider([
      {
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "subagent__writer",
            input: { task: "Draft a haiku" },
          },
        ],
        stopReason: "tool_use",
        model: "model-a",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      textResponse("Done: SUBAGENT DRAFT"),
    ]);

    // Passthrough step runner — exercises the durable-tool `step.run` wrap.
    const stepRun: StepRunner = (_id, fn) => fn();

    const result = await runAgentLoop({
      provider: providerA,
      model: "model-a",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "write me a haiku" }],
      tools: registry,
      service: stubService(),
      stepRun,
      turnLogger: logger,
    });

    // Dual dispatch: the sub-agent handler ran model B (a different model than
    // the loop's model A) with the curated task and the row's system prompt.
    expect(providerB.chat).toHaveBeenCalledTimes(1);
    const bParams = providerB.chat.mock.calls[0]?.[0];
    expect(bParams?.model).toBe("model-b");
    expect(bParams?.system).toBe("Be terse.");
    expect(JSON.stringify(bParams?.messages)).toContain("Draft a haiku");
    expect(bParams?.tools).toBeUndefined(); // specialist gets no tools

    // Model B's text flowed back as a tool_result and into A's final answer.
    expect(vi.mocked(providerA.chat)).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(providerA.chat).mock.calls[1]?.[0]?.messages)).toContain(
      "SUBAGENT DRAFT",
    );
    expect(result.text).toBe("Done: SUBAGENT DRAFT");
  });
});
