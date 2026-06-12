import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../llm/provider.js";
import { expectDefined } from "../../test/assertions.js";
import { type CompileDeps, compilePipeline, MAX_VALIDATION_RETRIES } from "./compile.js";
import { FIXTURE_TOOLS, validPipelineDefinition } from "./test-fixtures.js";
import type { PipelineDefinition } from "./types.js";

function mockProvider(responses: ReadonlyArray<object>): {
  provider: LlmProvider;
  chat: ReturnType<typeof vi.fn>;
} {
  const chat = vi.fn();
  for (const r of responses) {
    chat.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify(r) }],
      stopReason: "end_turn",
      model: "test-model",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  }
  return { provider: { name: "test", chat, chatStream: vi.fn(), countTokens: vi.fn() }, chat };
}

function deps(provider: LlmProvider): CompileDeps {
  return {
    provider,
    model: "test-model",
    validation: { availableTools: FIXTURE_TOOLS, knownEventSources: [] },
  };
}

describe("compilePipeline", () => {
  it("returns the definition when the first attempt is clean", async () => {
    const { provider, chat } = mockProvider([validPipelineDefinition()]);
    const result = await compilePipeline(deps(provider), { sourceText: "do the issue flow" });

    const ok = expectDefined(result.isOk() ? result.value : undefined, "ok result");
    expect(ok.definition.name).toBe("issue-to-pr");
    expect(ok.validationRetries).toBe(0);
    expect(chat).toHaveBeenCalledTimes(1);
    // System prompt carries the tool catalog so the model can't invent allowlists.
    const call = expectDefined(chat.mock.calls[0]?.[0], "chat call args");
    expect(call.system).toContain("delegate_coding");
  });

  it("feeds deterministic-validation issues back and succeeds on retry", async () => {
    const bad = validPipelineDefinition();
    const badStage = expectDefined(bad.stages[0], "stage");
    badStage.tools = ["made_up_tool"];
    const { provider, chat } = mockProvider([bad, validPipelineDefinition()]);

    const result = await compilePipeline(deps(provider), { sourceText: "do the issue flow" });

    const ok = expectDefined(result.isOk() ? result.value : undefined, "ok result");
    expect(ok.validationRetries).toBe(1);
    expect(chat).toHaveBeenCalledTimes(2);
    // The retry turn carries the issue list verbatim.
    const retryCall = expectDefined(chat.mock.calls[1]?.[0], "retry call args");
    const lastMessage = retryCall.messages.at(-1);
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content).toContain("made_up_tool");
  });

  it("returns validation_failed with the final issues after the retry budget", async () => {
    const bad = (): PipelineDefinition => {
      const def = validPipelineDefinition();
      const stage = expectDefined(def.stages[0], "stage");
      stage.tools = ["made_up_tool"];
      return def;
    };
    const { provider, chat } = mockProvider(
      Array.from({ length: MAX_VALIDATION_RETRIES + 1 }, bad),
    );

    const result = await compilePipeline(deps(provider), { sourceText: "do the issue flow" });

    const error = expectDefined(result.isErr() ? result.error : undefined, "error result");
    expect(error.kind).toBe("validation_failed");
    expect(error.issues.some((i) => i.message.includes("made_up_tool"))).toBe(true);
    expect(chat).toHaveBeenCalledTimes(MAX_VALIDATION_RETRIES + 1);
  });

  it("propagates structural (Zod) exhaustion from chatTyped as a throw", async () => {
    // chatTyped's own budget is 1 feedback retry — two structurally-invalid
    // responses exhaust it and the ZodError surfaces to the tool layer.
    const { provider } = mockProvider([{ nonsense: true }, { nonsense: true }]);
    await expect(
      compilePipeline(deps(provider), { sourceText: "do the issue flow" }),
    ).rejects.toThrow();
  });
});
