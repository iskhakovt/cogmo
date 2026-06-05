import { NonRetriableError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { type LlmProviderResolver, ProviderConfigError } from "../../llm/resolver.js";
import { composeTurnTools } from "../../skills/skill-tool-builder.js";
import { expectDefined } from "../../test/assertions.js";
import { mockProvider, mockResolver } from "../../test/factories.js";
import type { Service } from "../service.js";
import type { SubAgent } from "../store/index.js";
import { buildSubAgentTools } from "./sub-agent-tool-builder.js";

function row(overrides: Partial<SubAgent> = {}): SubAgent {
  return {
    id: "sa-1",
    name: "writer",
    description: "long-form prose",
    systemPrompt: "Be terse.",
    model: "claude-test",
    ...overrides,
  };
}

/** A chat mock returning the given text as a single text block. */
function chatReturning(text: string) {
  return vi.fn().mockResolvedValue({
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    model: "claude-test",
    usage: { inputTokens: 1, outputTokens: 1 },
  });
}

describe("buildSubAgentTools", () => {
  it("creates one subagent__<name> tool per row with delegation metadata", () => {
    const tools = buildSubAgentTools(
      [row(), row({ id: "sa-2", name: "reasoner" })],
      mockResolver(),
    );
    expect(tools.map((t) => t.name)).toEqual(["subagent__writer", "subagent__reasoner"]);
    const spec = expectDefined(tools[0], "first spec");
    expect(spec.description).toBe("long-form prose");
    expect(spec.parallelSafe).toBe(true);
    expect(spec.sideEffectful).toBe(false);
    expect(spec.invocationBudget).toBe(3);
    expect(spec.durable).toBe(true);
  });

  it("delegates to the row's model with NO tools and returns the joined text", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "DRAFT" },
        { type: "text", text: " more" },
      ],
      stopReason: "end_turn",
      model: "claude-test",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const tools = buildSubAgentTools([row()], mockResolver(mockProvider({ chat })));
    const out = await expectDefined(tools[0], "spec").handler(
      { task: "Write a haiku" },
      mock<Service>(),
    );

    expect(out).toBe("DRAFT more");
    const params = expectDefined(chat.mock.calls[0], "chat call")[0];
    // The whole point: the specialist is handed no tools, so it physically
    // cannot tool-call — the orchestrator acts on the text it returns.
    expect(params.tools).toBeUndefined();
    expect(params.system).toBe("Be terse.");
    expect(params.model).toBe("claude-test");
    expect(params.messages).toEqual([{ role: "user", content: "Write a haiku" }]);
  });

  it("sends an empty system prompt for a null persona (pure model-as-tool)", async () => {
    const chat = chatReturning("x");
    const tools = buildSubAgentTools(
      [row({ systemPrompt: null })],
      mockResolver(mockProvider({ chat })),
    );
    await expectDefined(tools[0], "spec").handler({ task: "t" }, mock<Service>());
    expect(expectDefined(chat.mock.calls[0], "call")[0].system).toBe("");
  });

  it("appends caller-supplied context to the task", async () => {
    const chat = chatReturning("x");
    const tools = buildSubAgentTools([row()], mockResolver(mockProvider({ chat })));
    await expectDefined(tools[0], "spec").handler(
      { task: "Summarize", context: "PROJECT NOTES" },
      mock<Service>(),
    );
    expect(expectDefined(chat.mock.calls[0], "call")[0].messages[0].content).toBe(
      "Summarize\n\nContext:\nPROJECT NOTES",
    );
  });

  it("extracts only text blocks, ignoring non-text content", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: [
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "text", text: "answer" },
      ],
      stopReason: "end_turn",
      model: "claude-test",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const tools = buildSubAgentTools([row()], mockResolver(mockProvider({ chat })));
    const out = await expectDefined(tools[0], "spec").handler({ task: "t" }, mock<Service>());
    expect(out).toBe("answer");
  });

  it("throws on empty specialist output instead of fabricating content", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: [],
      stopReason: "end_turn",
      model: "claude-test",
      usage: { inputTokens: 1, outputTokens: 0 },
    });
    const tools = buildSubAgentTools([row()], mockResolver(mockProvider({ chat })));
    await expect(
      expectDefined(tools[0], "spec").handler({ task: "t" }, mock<Service>()),
    ).rejects.toThrow(/no text output/);
  });

  it("throws NonRetriableError on a permanent config error (loop makes an isError result, no retry)", async () => {
    const resolveProvider: LlmProviderResolver = () =>
      Promise.reject(new ProviderConfigError('No provider configured for model "ghost".'));
    const tools = buildSubAgentTools([row({ model: "ghost" })], resolveProvider);
    await expect(
      expectDefined(tools[0], "spec").handler({ task: "t" }, mock<Service>()),
    ).rejects.toBeInstanceOf(NonRetriableError);
  });

  it("rethrows a transient resolve error so the durable step can retry", async () => {
    const resolveProvider: LlmProviderResolver = () => Promise.reject(new Error("network blip"));
    const tools = buildSubAgentTools([row()], resolveProvider);
    await expect(
      expectDefined(tools[0], "spec").handler({ task: "t" }, mock<Service>()),
    ).rejects.toThrow("network blip");
  });

  it("is gated per-profile by tool_set globs (same path as every other tool source)", () => {
    const spec = expectDefined(buildSubAgentTools([row()], mockResolver())[0], "spec");
    const present = composeTurnTools({
      builtIns: [spec],
      skillTools: [],
      mcpTools: [],
      toolSetGlobs: ["subagent__*"],
    });
    expect(present.get("subagent__writer")).toBeDefined();
    const absent = composeTurnTools({
      builtIns: [spec],
      skillTools: [],
      mcpTools: [],
      toolSetGlobs: [],
    });
    expect(absent.get("subagent__writer")).toBeUndefined();
  });
});
