import { describe, expect, it } from "vitest";
import { pruneOpenRouterModels, withOpenRouterNamespace } from "./openrouter-models.js";

const LIMITS = { contextWindow: 200_000, maxOutputTokens: 8_192 };

function prune(models: ReadonlyArray<unknown>) {
  return pruneOpenRouterModels({ data: models })._unsafeUnwrap();
}

describe("pruneOpenRouterModels", () => {
  it("keys each model under openrouter/ with its top provider's limits", () => {
    const { entries } = prune([
      {
        id: "x-ai/grok-9",
        context_length: 200_000,
        top_provider: { context_length: 200_000, max_completion_tokens: 8_192 },
      },
    ]);

    expect(entries).toEqual({ "openrouter/x-ai/grok-9": LIMITS });
  });

  it("takes the smaller of the model's and its top provider's context window", () => {
    const { entries } = prune([
      {
        id: "a/narrow-provider",
        context_length: 1_048_576,
        top_provider: { context_length: 262_144 },
      },
      {
        id: "a/wide-provider",
        context_length: 131_072,
        top_provider: { context_length: 1_000_000 },
      },
    ]);

    expect(entries["openrouter/a/narrow-provider"]?.contextWindow).toBe(262_144);
    expect(entries["openrouter/a/wide-provider"]?.contextWindow).toBe(131_072);
  });

  it("budgets output from the context window when no provider cap is published", () => {
    const { entries } = prune([
      {
        id: "openrouter/auto",
        context_length: 2_000_000,
        top_provider: { context_length: null, max_completion_tokens: null },
      },
      { id: "a/no-top-provider", context_length: 100_000 },
    ]);

    expect(entries).toEqual({
      "openrouter/openrouter/auto": { contextWindow: 2_000_000, maxOutputTokens: 64_000 },
      "openrouter/a/no-top-provider": { contextWindow: 100_000, maxOutputTokens: 25_000 },
    });
  });

  it("caps a published completion limit at 64k and at a quarter of the context window", () => {
    const { entries } = prune([
      { id: "a/huge", context_length: 1_000_000, top_provider: { max_completion_tokens: 943_717 } },
      { id: "a/small", context_length: 32_000, top_provider: { max_completion_tokens: 32_000 } },
    ]);

    expect(entries["openrouter/a/huge"]?.maxOutputTokens).toBe(64_000);
    expect(entries["openrouter/a/small"]?.maxOutputTokens).toBe(8_000);
  });

  it("skips malformed models, keeping the rest", () => {
    const result = prune([
      null,
      { context_length: 200_000 },
      { id: "a/no-context" },
      { id: "a/string-context", context_length: "200000" },
      { id: "a/kept", context_length: 200_000, top_provider: { max_completion_tokens: 8_192 } },
    ]);

    expect(Object.keys(result.entries)).toEqual(["openrouter/a/kept"]);
    expect(result.skippedNoTokenData).toBe(4);
  });

  it("skips a model whose limits leave no chat budget", () => {
    const result = prune([{ id: "a/tiny", context_length: 8_192 }]);

    expect(result.entries).toEqual({});
    expect(result.skippedUnusable).toBe(1);
  });

  it.each([
    ["an array", [{ id: "a/b", context_length: 200_000 }]],
    ["an object without data", { models: [] }],
    ["null", null],
  ])("fails on %s", (_label, raw) => {
    expect(pruneOpenRouterModels(raw).isErr()).toBe(true);
  });
});

describe("withOpenRouterNamespace", () => {
  it("takes the openrouter/ namespace from OpenRouter and everything else from LiteLLM", () => {
    const litellm = {
      "claude-sonnet-4-6": LIMITS,
      "openrouter/retired/model": LIMITS,
      "openrouter/x-ai/grok-9": { contextWindow: 131_072, maxOutputTokens: 4_096 },
    };
    const openRouter = { "openrouter/x-ai/grok-9": LIMITS };

    expect(withOpenRouterNamespace(litellm, openRouter)).toEqual({
      "claude-sonnet-4-6": LIMITS,
      "openrouter/x-ai/grok-9": LIMITS,
    });
  });
});
