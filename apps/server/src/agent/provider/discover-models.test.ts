import { describe, expect, it, vi } from "vitest";
import { discoverModels } from "./discover-models.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("discoverModels — OpenRouter shape", () => {
  it("extracts inline limits from top_provider.max_completion_tokens", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "x-ai/grok-4.3",
            name: "xAI: Grok 4.3",
            context_length: 1_000_000,
            top_provider: { max_completion_tokens: 32_000 },
          },
          {
            id: "openai/gpt-5.5",
            name: "OpenAI: GPT-5.5",
            context_length: 1_050_000,
            top_provider: { max_completion_tokens: 128_000 },
          },
        ],
      }),
    );

    const result = await discoverModels({
      type: "openai_compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-test",
    });

    expect(result._unsafeUnwrap()).toEqual([
      {
        id: "x-ai/grok-4.3",
        name: "xAI: Grok 4.3",
        contextWindow: 1_000_000,
        maxOutputTokens: 32_000,
      },
      {
        id: "openai/gpt-5.5",
        name: "OpenAI: GPT-5.5",
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
      },
    ]);
  });
});

describe("discoverModels — OpenAI / generic shape", () => {
  it("returns just ids when the response has no inline limits", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "gpt-5.5", object: "model", created: 1_700_000_000, owned_by: "openai" },
          { id: "gpt-5.4", object: "model", created: 1_700_000_000, owned_by: "openai" },
        ],
      }),
    );

    const result = await discoverModels({
      type: "openai_compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });

    expect(result._unsafeUnwrap()).toEqual([{ id: "gpt-5.5" }, { id: "gpt-5.4" }]);
  });
});

describe("discoverModels — Anthropic shape", () => {
  it("uses display_name as the optional name field", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "claude-opus-4-7",
            type: "model",
            display_name: "Claude Opus 4.7",
            created_at: "2026-04-30T00:00:00Z",
          },
        ],
      }),
    );

    const result = await discoverModels({
      type: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
    });

    expect(result._unsafeUnwrap()).toEqual([{ id: "claude-opus-4-7", name: "Claude Opus 4.7" }]);
  });
});

describe("discoverModels — error handling", () => {
  const args = { type: "openai_compatible", baseUrl: "https://x", apiKey: "x" } as const;

  it("is unavailable on 404 (endpoint not exposed)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    const result = await discoverModels({ ...args, baseUrl: "https://corp.example.test" });
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "unavailable" });
  });

  it("is unavailable on a malformed body shape", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ wrong: "shape" }));
    const result = await discoverModels(args);
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "unavailable" });
  });

  it("is unavailable on a body that isn't JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>gateway</html>", { status: 200 }));
    const result = await discoverModels(args);
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "unavailable",
      message: "non-JSON response from https://x/models",
    });
  });

  it("is rejected on a non-2xx that isn't 404 (auth, rate limit)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    const result = await discoverModels(args);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "rejected",
      message: expect.stringContaining("401"),
    });
  });

  it("is unavailable on a network error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const result = await discoverModels(args);
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "unavailable" });
  });

  it("reads the Anthropic endpoint's failures the same way", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 403 }));
    const result = await discoverModels({ ...args, type: "anthropic" });
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "rejected",
      message: expect.stringContaining("403"),
    });
  });
});
