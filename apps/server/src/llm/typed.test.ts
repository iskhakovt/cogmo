import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { expectDefined } from "../test/assertions.js";
import { ProviderProtocolError } from "./errors.js";
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

  it("recovers from a trailing-comma response via jsonrepair (no retry consumed)", async () => {
    // Trailing comma is a canonical jsonrepair target: bare JSON.parse rejects
    // it, jsonrepair fixes it deterministically without consuming a retry.
    const provider = mockProvider([{ text: '{"name":"Alice","age":30,}' }]);

    const result = await chatTyped({
      provider,
      model: "test-model",
      system: "sys",
      messages: [{ role: "user", content: "Alice is 30" }],
      schema: PersonSchema,
      name: "extract_person",
    });

    expect(result.data).toEqual({ name: "Alice", age: 30 });
    expect(result.retries).toBe(0);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("retries on Zod validation failure with synthetic user turn", async () => {
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

    // Second call: original user + bad assistant + synthetic feedback user turn.
    const secondCall = expectDefined(vi.mocked(provider.chat).mock.calls[1]?.[0], "secondCall");
    expect(secondCall.messages).toHaveLength(3);
    const assistantTurn = expectDefined(secondCall.messages[1], "secondCall.messages[1]");
    const feedbackTurn = expectDefined(secondCall.messages[2], "secondCall.messages[2]");
    expect(assistantTurn.role).toBe("assistant");
    expect(feedbackTurn.role).toBe("user");
    expect(feedbackTurn.content).toContain("didn't match the expected format");
  });

  it("does not persist the synthetic user turn back into the caller's messages array", async () => {
    // The caller passes a messages array — chatTyped must not mutate it. The
    // synthetic feedback turn lives only inside the call's local copy and is
    // never observable outside.
    const provider = mockProvider([
      { text: '{"name":"Alice"}' },
      { text: '{"name":"Alice","age":30}' },
    ]);
    const messages = [{ role: "user" as const, content: "Alice is 30" }];

    await chatTyped({
      provider,
      model: "test-model",
      system: "sys",
      messages,
      schema: PersonSchema,
      name: "extract_person",
    });

    expect(messages).toEqual([{ role: "user", content: "Alice is 30" }]);
  });

  it("throws ProviderProtocolError when jsonrepair cannot recover the response", async () => {
    // An empty string is one of the few inputs jsonrepair refuses outright.
    const provider = mockProvider([{ text: "" }]);

    await expect(
      chatTyped({
        provider,
        model: "test-model",
        system: "sys",
        messages: [{ role: "user", content: "data" }],
        schema: PersonSchema,
        name: "extract_person",
      }),
    ).rejects.toBeInstanceOf(ProviderProtocolError);
  });

  it("propagates Zod error immediately when onZodFailure is 'throw'", async () => {
    const provider = mockProvider([{ text: '{"name":"Alice"}' }]);

    await expect(
      chatTyped({
        provider,
        model: "test-model",
        system: "sys",
        messages: [{ role: "user", content: "data" }],
        schema: PersonSchema,
        name: "extract_person",
        repair: { onZodFailure: "throw" },
      }),
    ).rejects.toThrow(/age/i);

    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("does not retry on Zod failure when maxRetries is 0", async () => {
    const provider = mockProvider([
      { text: '{"name":"Alice"}' },
      { text: '{"name":"Alice","age":30}' },
    ]);

    await expect(
      chatTyped({
        provider,
        model: "test-model",
        system: "sys",
        messages: [{ role: "user", content: "data" }],
        schema: PersonSchema,
        name: "extract_person",
        repair: { maxRetries: 0 },
      }),
    ).rejects.toThrow();

    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("throws Zod error after exhausting the feedback-retry budget", async () => {
    const provider = mockProvider([
      { text: '{"name":"A"}' },
      { text: '{"name":"B"}' },
      { text: '{"name":"C"}' },
    ]);

    await expect(
      chatTyped({
        provider,
        model: "test-model",
        system: "sys",
        messages: [{ role: "user", content: "data" }],
        schema: PersonSchema,
        name: "extract_person",
        repair: { maxRetries: 2 },
      }),
    ).rejects.toThrow();

    expect(provider.chat).toHaveBeenCalledTimes(3);
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

  it("disables jsonrepair pre-pass when repair.jsonrepair is false", async () => {
    // With jsonrepair off, the trailing-comma response goes through bare
    // JSON.parse, which throws, which surfaces as ProviderProtocolError.
    const provider = mockProvider([{ text: '{"name":"Alice","age":30,}' }]);

    await expect(
      chatTyped({
        provider,
        model: "test-model",
        system: "sys",
        messages: [{ role: "user", content: "data" }],
        schema: PersonSchema,
        name: "extract_person",
        repair: { jsonrepair: false },
      }),
    ).rejects.toBeInstanceOf(ProviderProtocolError);
  });
});
