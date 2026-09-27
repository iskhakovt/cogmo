import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { expectDefined } from "../test/assertions.js";
import { MissingToolCallError, OutputCutOffError, ProviderProtocolError } from "./errors.js";
import { RefusalError } from "./fallback.js";
import type { LlmProvider } from "./provider.js";
import { type ChatTypedRepair, chatTyped } from "./typed.js";
import type { StopReason } from "./types.js";

function mockProvider(responses: Array<{ text: string; stopReason?: StopReason }>): LlmProvider {
  const chatFn = vi.fn();
  for (const r of responses) {
    chatFn.mockResolvedValueOnce({
      content: [{ type: "text", text: r.text }],
      stopReason: r.stopReason ?? "end_turn",
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

  it("sums usage across a feedback retry, cache reads and writes included", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"name":"Alice"}' }],
        stopReason: "end_turn",
        model: "test-model",
        usage: { inputTokens: 900, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 800 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"name":"Alice","age":30}' }],
        stopReason: "end_turn",
        model: "test-model",
        usage: { inputTokens: 950, outputTokens: 7, cacheReadTokens: 800, cacheCreationTokens: 40 },
      });
    const provider: LlmProvider = { name: "test", chat, chatStream: vi.fn(), countTokens: vi.fn() };

    const result = await chatTyped({
      provider,
      model: "test-model",
      system: "sys",
      messages: [{ role: "user", content: "Alice is 30" }],
      schema: PersonSchema,
      name: "extract_person",
    });

    expect(result.retries).toBe(1);
    expect(result.usage).toEqual({
      inputTokens: 1850,
      outputTokens: 12,
      cacheReadTokens: 800,
      cacheCreationTokens: 840,
    });
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

  it.each<[string, string, StopReason]>([
    // jsonrepair closes this into a Zod-valid value the model never finished.
    ["that jsonrepair would complete", '{"name":"Alice","age":30', "max_tokens"],
    ["that fails validation", '{"name":"Alice","ag', "max_tokens"],
    ["at the context window", '{"name":"Alice","age":30', "context_overflow"],
  ])("refuses a reply cut off %s, spending no retry", async (_label, text, stopReason) => {
    const provider = mockProvider([{ text, stopReason }, { text: '{"name":"Alice","age":30}' }]);

    await expect(
      chatTyped({
        provider,
        model: "test-model",
        system: "sys",
        messages: [{ role: "user", content: "Alice is 30" }],
        schema: PersonSchema,
        name: "extract_person",
      }),
    ).rejects.toBeInstanceOf(OutputCutOffError);

    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("refuses a refusal, even one whose text validates, spending no retry", async () => {
    const provider = mockProvider([
      { text: '{"name":"Alice","age":30}', stopReason: "refusal" },
      { text: '{"name":"Alice","age":30}' },
    ]);

    await expect(
      chatTyped({
        provider,
        model: "test-model",
        system: "sys",
        messages: [{ role: "user", content: "Alice is 30" }],
        schema: PersonSchema,
        name: "extract_person",
      }),
    ).rejects.toBeInstanceOf(RefusalError);

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

  it("spends the feedback retry on a prose reply, which jsonrepair reads as a JSON string", async () => {
    const provider = mockProvider([
      { text: "Who do you mean?" },
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
  });

  describe("a reply that makes no tool call", () => {
    const INSTRUCTION = "Respond by calling the extract_person tool.";

    function missedCall(reply: string): MissingToolCallError {
      return new MissingToolCallError("extract_person", {
        reply,
        instruction: INSTRUCTION,
        usage: { inputTokens: 40, outputTokens: 6 },
      });
    }

    function providerWith(chat: LlmProvider["chat"]): LlmProvider {
      return { name: "test", chat, chatStream: vi.fn(), countTokens: vi.fn() };
    }

    const VALID = {
      content: [{ type: "text" as const, text: '{"name":"Alice","age":30}' }],
      stopReason: "end_turn" as const,
      model: "test-model",
      usage: { inputTokens: 10, outputTokens: 5 },
    };

    function call(provider: LlmProvider, repair?: ChatTypedRepair) {
      return chatTyped({
        provider,
        model: "test-model",
        system: "sys",
        messages: [{ role: "user", content: "Alice is 30" }],
        schema: PersonSchema,
        name: "extract_person",
        ...(repair !== undefined && { repair }),
      });
    }

    it("is re-asked with the adapter's instruction, spending the feedback retry", async () => {
      const chat = vi
        .fn()
        .mockRejectedValueOnce(missedCall("Alice is thirty."))
        .mockResolvedValueOnce(VALID);

      const result = await call(providerWith(chat));

      expect(result.data).toEqual({ name: "Alice", age: 30 });
      expect(result.retries).toBe(1);
      expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 11 });
      expect(expectDefined(chat.mock.calls[1], "re-ask")[0].messages).toEqual([
        { role: "user", content: "Alice is 30" },
        { role: "assistant", content: "Alice is thirty." },
        { role: "user", content: INSTRUCTION },
      ]);
    });

    it("is re-asked without an assistant turn when the reply had no text", async () => {
      const chat = vi.fn().mockRejectedValueOnce(missedCall(" ")).mockResolvedValueOnce(VALID);

      await call(providerWith(chat));

      expect(expectDefined(chat.mock.calls[1], "re-ask")[0].messages).toEqual([
        { role: "user", content: "Alice is 30" },
        { role: "user", content: INSTRUCTION },
      ]);
    });

    it("fails after the one retry when the re-ask makes no tool call either", async () => {
      const chat = vi
        .fn()
        .mockRejectedValueOnce(missedCall("Alice is thirty."))
        .mockRejectedValueOnce(missedCall("Thirty."))
        .mockResolvedValueOnce(VALID);

      await expect(call(providerWith(chat))).rejects.toBeInstanceOf(MissingToolCallError);
      expect(chat).toHaveBeenCalledTimes(2);
    });

    it("leaves no retry for a Zod failure after the re-ask", async () => {
      const chat = vi
        .fn()
        .mockRejectedValueOnce(missedCall("Alice is thirty."))
        .mockResolvedValueOnce({ ...VALID, content: [{ type: "text", text: '{"name":"Alice"}' }] })
        .mockResolvedValueOnce(VALID);

      await expect(call(providerWith(chat))).rejects.toThrow(/age/i);
      expect(chat).toHaveBeenCalledTimes(2);
    });

    it.each<[string, ChatTypedRepair]>([
      ["maxRetries is 0", { maxRetries: 0 }],
      ["onZodFailure is 'throw'", { onZodFailure: "throw" }],
    ])("is not re-asked when %s", async (_label, repair) => {
      const chat = vi
        .fn()
        .mockRejectedValueOnce(missedCall("Alice is thirty."))
        .mockResolvedValueOnce(VALID);

      await expect(call(providerWith(chat), repair)).rejects.toBeInstanceOf(MissingToolCallError);
      expect(chat).toHaveBeenCalledTimes(1);
    });
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
