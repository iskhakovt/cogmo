import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LlmProvider } from "./provider.js";
import { chatTyped } from "./typed.js";

function mockProvider(responses: Array<{ text: string }>): LlmProvider {
  const chatFn = vi.fn();
  for (const r of responses) {
    chatFn.mockResolvedValueOnce({
      content: [{ type: "text", text: r.text }],
      stopReason: "end_turn",
      model: "test-model",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  }
  return {
    name: "test",
    chat: chatFn,
    chatStream: vi.fn(),
    countTokens: vi.fn(),
  };
}

const PersonSchema = z.object({
  name: z.string(),
  age: z.number(),
});

describe("chatTyped", () => {
  it("parses valid JSON response", async () => {
    const provider = mockProvider([{ text: '{"name":"Alice","age":30}' }]);

    const result = await chatTyped({
      provider,
      model: "test-model",
      system: "Extract data",
      messages: [{ role: "user", content: "Alice is 30" }],
      schema: PersonSchema,
      name: "extract_person",
    });

    expect(result.data).toEqual({ name: "Alice", age: 30 });
    expect(result.retries).toBe(0);
    expect(result.model).toBe("test-model");
    expect(result.usage.inputTokens).toBe(10);
  });

  it("passes responseFormat to provider", async () => {
    const provider = mockProvider([{ text: '{"name":"Bob","age":25}' }]);

    await chatTyped({
      provider,
      model: "test-model",
      system: "sys",
      messages: [{ role: "user", content: "Bob is 25" }],
      schema: PersonSchema,
      name: "extract_person",
    });

    expect(provider.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        responseFormat: expect.objectContaining({
          type: "json_schema",
          name: "extract_person",
        }),
      }),
    );
  });

  it("retries on invalid JSON and succeeds", async () => {
    const provider = mockProvider([
      { text: "not json at all" },
      { text: '{"name":"Alice","age":30}' },
    ]);

    const result = await chatTyped({
      provider,
      model: "test-model",
      system: "sys",
      messages: [{ role: "user", content: "Alice is 30" }],
      schema: PersonSchema,
      name: "extract_person",
    });

    expect(result.data).toEqual({ name: "Alice", age: 30 });
    expect(result.retries).toBe(1);
    expect(result.usage.inputTokens).toBe(20); // aggregated
  });

  it("retries on Zod validation failure", async () => {
    const provider = mockProvider([
      { text: '{"name":"Alice"}' }, // missing required 'age'
      { text: '{"name":"Alice","age":30}' },
    ]);

    const result = await chatTyped({
      provider,
      model: "test-model",
      system: "sys",
      messages: [{ role: "user", content: "Alice is 30" }],
      schema: PersonSchema,
      name: "extract_person",
    });

    expect(result.data).toEqual({ name: "Alice", age: 30 });
    expect(result.retries).toBe(1);

    // Second call should include error feedback
    const secondCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[1]![0];
    expect(secondCall.messages).toHaveLength(3); // original + assistant + feedback
    expect(secondCall.messages[1].role).toBe("assistant");
    expect(secondCall.messages[2].role).toBe("user");
    expect(secondCall.messages[2].content).toContain("didn't match");
  });

  it("throws after exceeding max retries", async () => {
    const provider = mockProvider([{ text: "bad1" }, { text: "bad2" }, { text: "bad3" }]);

    await expect(
      chatTyped({
        provider,
        model: "test-model",
        system: "sys",
        messages: [{ role: "user", content: "data" }],
        schema: PersonSchema,
        name: "extract_person",
        maxRetries: 2,
      }),
    ).rejects.toThrow();
  });

  it("passes maxTokens through to provider", async () => {
    const provider = mockProvider([{ text: '{"name":"A","age":1}' }]);

    await chatTyped({
      provider,
      model: "test-model",
      system: "sys",
      messages: [{ role: "user", content: "data" }],
      schema: PersonSchema,
      name: "extract_person",
      maxTokens: 2048,
    });

    expect(provider.chat).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 2048 }));
  });
});
