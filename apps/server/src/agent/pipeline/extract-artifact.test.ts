import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../llm/provider.js";
import { expectDefined } from "../../test/assertions.js";
import { extractStageArtifact } from "./extract-artifact.js";

const SCHEMA = {
  type: "object",
  required: ["title", "hours"],
  properties: { title: { type: "string" }, hours: { type: "number" } },
};

function providerReplying(...texts: string[]): LlmProvider & { chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn();
  for (const text of texts) {
    chat.mockResolvedValueOnce({
      content: [{ type: "text", text }],
      stopReason: "end_turn",
      model: "test-model",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }
  return { name: "test", chat, chatStream: vi.fn(), countTokens: vi.fn() };
}

const base = {
  finalText: "Fix login, about 3 hours.",
  model: "test-model",
  stageId: "gather-context",
};

describe("extractStageArtifact", () => {
  it("returns null without an LLM call when the stage declares no output", async () => {
    const provider = providerReplying();
    const result = await extractStageArtifact({ ...base, output: undefined, provider });
    expect(result._unsafeUnwrap()).toBeNull();
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("uses the final reply verbatim for a text output", async () => {
    const provider = providerReplying();
    const result = await extractStageArtifact({ ...base, output: { kind: "text" }, provider });
    expect(result._unsafeUnwrap()).toEqual({ kind: "text", text: "Fix login, about 3 hours." });
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("extracts a schema-valid json artifact from a prompted reply, without provider structured output", async () => {
    // User-shaped schemas are not strict-mode compatible, so the schema rides
    // in the prompt and ajv does the checking.
    const provider = providerReplying('```json\n{"title":"Fix login","hours":3}\n```');
    const result = await extractStageArtifact({
      ...base,
      output: { kind: "json", schema: SCHEMA },
      provider,
    });
    expect(result._unsafeUnwrap()).toEqual({
      kind: "json",
      value: { title: "Fix login", hours: 3 },
    });
    const params = expectDefined(provider.chat.mock.calls[0], "chat call")[0];
    expect(params.responseFormat).toBeUndefined();
    expect(params.tools).toBeUndefined();
    expect(JSON.stringify(params.messages)).toContain('\\"required\\":[\\"title\\",\\"hours\\"]');
  });

  it("compiles a schema carrying an $id on every extraction", async () => {
    const schema = { ...SCHEMA, $id: "issue-summary" };
    for (let i = 0; i < 2; i++) {
      const provider = providerReplying('{"title":"Fix login","hours":3}');
      const result = await extractStageArtifact({
        ...base,
        output: { kind: "json", schema },
        provider,
      });
      expect(result.isOk()).toBe(true);
    }
  });

  it("retries once with the validation errors fed back", async () => {
    const provider = providerReplying('{"title":"Fix login"}', '{"title":"Fix login","hours":3}');
    const result = await extractStageArtifact({
      ...base,
      output: { kind: "json", schema: SCHEMA },
      provider,
    });
    expect(result.isOk()).toBe(true);
    expect(provider.chat).toHaveBeenCalledTimes(2);
    const retry = expectDefined(provider.chat.mock.calls[1], "retry call")[0];
    const feedback = retry.messages.at(-1);
    expect(feedback?.role).toBe("user");
    expect(feedback?.content).toContain("must have required property 'hours'");
  });

  it("fails with the last attempt's validation detail once the retry is spent", async () => {
    // The two attempts fail differently, so the detail proves which one is reported.
    const provider = providerReplying("not json", '{"title":"Fix login","hours":"three"}');
    const result = await extractStageArtifact({
      ...base,
      output: { kind: "json", schema: SCHEMA },
      provider,
    });
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "artifact_invalid",
      detail: "/hours must be number",
    });
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it("reports a schema that can't be compiled instead of throwing", async () => {
    const provider = providerReplying();
    const result = await extractStageArtifact({
      ...base,
      output: {
        kind: "json",
        schema: { type: "object", properties: { owner: { $ref: "#/$defs/missing" } } },
      },
      provider,
    });
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "artifact_invalid" });
    expect(result._unsafeUnwrapErr().detail).toContain("could not be compiled");
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("refuses a non-object top-level schema without calling the provider", async () => {
    const provider = providerReplying();
    const result = await extractStageArtifact({
      ...base,
      output: { kind: "json", schema: { type: "array" } },
      provider,
    });
    expect(result._unsafeUnwrapErr().detail).toContain('top-level "type": "object"');
    expect(provider.chat).not.toHaveBeenCalled();
  });
});
