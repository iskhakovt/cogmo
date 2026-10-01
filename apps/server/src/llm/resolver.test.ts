import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentStore } from "../agent/store/index.js";
import type { ProviderAttrs } from "../agent/store/schema.js";
import type { Transactor } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { expectDefined } from "../test/assertions.js";
import { mockProvider } from "../test/factories.js";
import type { ExtraBody } from "./extra-body.js";
import { FallbackLlmProvider } from "./fallback.js";
import { constantResolver, createDbProviderResolver, ProviderConfigError } from "./resolver.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

type ProviderRow = {
  id: string;
  name: string;
  type: string;
  baseUrl: string | null;
  secretId: string;
  attrs: ProviderAttrs;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  extraBody: ExtraBody | null;
};

function row(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: "prov-1",
    name: "anthropic-direct",
    type: "anthropic",
    baseUrl: null,
    secretId: "secret-1",
    attrs: {},
    contextWindow: null,
    maxOutputTokens: null,
    extraBody: null,
    ...overrides,
  };
}

interface DepsOpts {
  rows?: ReadonlyArray<ProviderRow>;
  /** Throw the first N times listProvidersForModel is called. */
  listFailures?: number;
  secret?: string | undefined;
}

function makeDeps(opts: DepsOpts = {}) {
  const rows = opts.rows ?? [row()];
  let listCalls = 0;

  const listProvidersForModel = vi.fn().mockImplementation(async () => {
    listCalls += 1;
    if (opts.listFailures && listCalls <= opts.listFailures) {
      throw new Error(`transient db error #${listCalls}`);
    }
    return rows;
  });

  const getSecretById = vi.fn().mockResolvedValue(opts.secret ?? "test-key");

  const agentStore = { listProvidersForModel } as unknown as AgentStore;
  const secretsStore = { getSecretById } as unknown as SecretsStore;
  return { agentStore, secretsStore, listProvidersForModel, getSecretById };
}

describe("createDbProviderResolver — happy path", () => {
  it("returns a FallbackLlmProvider that wraps the configured chain", async () => {
    const { agentStore, secretsStore } = makeDeps();
    const resolve = createDbProviderResolver({ runInTx: fakeRunInTx, agentStore, secretsStore });
    const { provider } = await resolve("claude-sonnet-4-6");
    expect(provider).toBeInstanceOf(FallbackLlmProvider);
  });

  // Adapter selection is verified via FallbackLlmProvider's name-delegation
  // for single-row chains (`fallback.ts:124-127`): the wrapper takes the
  // sole inner provider's `.name`. AnthropicProvider exposes
  // `.name = "anthropic"`; OpenAICompatibleProvider takes its name from the
  // constructor arg (the row's `name`).

  it("builds an Anthropic adapter for type='anthropic' rows", async () => {
    const { agentStore, secretsStore } = makeDeps({
      rows: [row({ type: "anthropic", baseUrl: "https://custom.anthropic.test" })],
    });
    const resolve = createDbProviderResolver({ runInTx: fakeRunInTx, agentStore, secretsStore });
    const { provider } = await resolve("m");
    expect(provider).toBeInstanceOf(FallbackLlmProvider);
    expect(provider.name).toBe("anthropic");
  });

  it("builds an OpenAI-compatible adapter for type='openai_compatible' rows", async () => {
    const { agentStore, secretsStore } = makeDeps({
      rows: [
        row({
          name: "xai-grok",
          type: "openai_compatible",
          baseUrl: "https://api.x.ai/v1",
          attrs: { cacheDialect: "xai", headers: { "x-test": "1" } },
        }),
      ],
    });
    const resolve = createDbProviderResolver({ runInTx: fakeRunInTx, agentStore, secretsStore });
    const { provider } = await resolve("grok-4");
    expect(provider).toBeInstanceOf(FallbackLlmProvider);
    // Single-row fallback wrapper inherits the inner provider's name; the
    // OpenAI-compatible adapter copies `name` from its constructor arg,
    // which we plumb from the DB row.
    expect(provider.name).toBe("xai-grok");
  });

  describe("an openai_compatible row's cache dialect", () => {
    /** Send one chat with a cache intent through the resolved provider; return what went out. */
    async function sendWithIntent(attrs: ProviderAttrs): Promise<Request> {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              id: "c-1",
              model: "gpt-5.4-nano",
              choices: [
                { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      );
      try {
        const { agentStore, secretsStore } = makeDeps({
          rows: [
            row({
              name: "openai",
              type: "openai_compatible",
              baseUrl: "http://llm.test/v1",
              attrs,
            }),
          ],
        });
        const resolve = createDbProviderResolver({
          runInTx: fakeRunInTx,
          agentStore,
          secretsStore,
        });
        const { provider } = await resolve("gpt-5.4-nano");
        await provider.chat({
          model: "gpt-5.4-nano",
          system: "sys",
          messages: [{ role: "user", content: "hi" }],
          cache: { key: "conv-1", retention: "short" },
        });
        const [input, init] = expectDefined(fetchSpy.mock.calls[0], "fetch call");
        return new Request(input, init);
      } finally {
        fetchSpy.mockRestore();
      }
    }

    it("reaches the adapter", async () => {
      const request = await sendWithIntent({ cacheDialect: "openai" });

      expect(await request.json()).toMatchObject({ prompt_cache_key: "conv-1" });
    });

    it("reads as none when the row has none", async () => {
      const request = await sendWithIntent({});

      const body = z.record(z.string(), z.unknown()).parse(await request.json());
      expect(Object.keys(body)).not.toContain("prompt_cache_key");
      expect(Object.keys(body)).not.toContain("session_id");
      expect(request.headers.get("x-grok-conv-id")).toBeNull();
    });
  });

  describe("a routing row's extra body", () => {
    /** Resolve `model` from `rows`, send one chat and one stream, and return both request bodies. */
    async function sentBodies(
      model: string,
      rows: ReadonlyArray<ProviderRow>,
    ): Promise<Array<Record<string, unknown>>> {
      const bodies: Array<Record<string, unknown>> = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const sent = z.record(z.string(), z.unknown()).parse(await new Request(input, init).json());
        bodies.push(sent);
        if (sent.stream === true) {
          const sse =
            `data: ${JSON.stringify({ id: "c-1", model, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n` +
            "data: [DONE]\n\n";
          return new Response(sse, { headers: { "content-type": "text/event-stream" } });
        }
        return new Response(
          JSON.stringify({
            id: "c-1",
            model,
            choices: [
              { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      });
      try {
        const { agentStore, secretsStore } = makeDeps({ rows });
        const resolve = createDbProviderResolver({
          runInTx: fakeRunInTx,
          agentStore,
          secretsStore,
        });
        const { provider } = await resolve(model);
        const params = {
          model,
          system: "sys",
          messages: [{ role: "user" as const, content: "hi" }],
        };
        await provider.chat(params);
        for await (const _ of provider.chatStream(params)) {
          // Drain.
        }
        return bodies;
      } finally {
        fetchSpy.mockRestore();
      }
    }

    const venice = (extraBody: ExtraBody | null): ProviderRow =>
      row({
        name: "custom",
        type: "openai_compatible",
        baseUrl: "http://llm.test/v1",
        extraBody,
      });

    it("goes out with the model's chat and stream requests", async () => {
      const bodies = await sentBodies("qwen-3-6-plus", [venice({ reasoning: { enabled: false } })]);

      expect(bodies).toHaveLength(2);
      for (const body of bodies) {
        expect(body).toMatchObject({ model: "qwen-3-6-plus", reasoning: { enabled: false } });
      }
    });

    it("adds nothing when the row has none", async () => {
      const bodies = await sentBodies("qwen-3-6-plus", [venice(null)]);

      expect(bodies).toHaveLength(2);
      for (const body of bodies) expect(body).not.toHaveProperty("reasoning");
    });
  });

  describe("an anthropic row's binding controls", () => {
    /** Send one chat to Opus 5.5 through the resolved provider; return what went out. */
    async function sendThrough(overrides: Partial<ProviderRow>): Promise<Request> {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              id: "msg-1",
              type: "message",
              role: "assistant",
              model: "claude-opus-5-5",
              content: [{ type: "text", text: "ok" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      );
      try {
        const { agentStore, secretsStore } = makeDeps({ rows: [row(overrides)] });
        const resolve = createDbProviderResolver({
          runInTx: fakeRunInTx,
          agentStore,
          secretsStore,
        });
        const { provider } = await resolve("claude-opus-5-5");
        await provider.chat({
          model: "claude-opus-5-5",
          system: "sys",
          messages: [{ role: "user", content: "hi" }],
        });
        const [input, init] = expectDefined(fetchSpy.mock.calls[0], "fetch call");
        return new Request(input, init);
      } finally {
        fetchSpy.mockRestore();
      }
    }

    it("sends the row's prefixMismatchBehavior as block_binding, with the header", async () => {
      const request = await sendThrough({ attrs: { prefixMismatchBehavior: "drop_block" } });

      expect(await request.json()).toMatchObject({
        thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      });
      expect(request.headers.get("anthropic-beta")).toBe("thinking-binding-controls-2026-08-01");
    });

    it("sends the header and no thinking parameter when the row sets no behaviour", async () => {
      const request = await sendThrough({});

      expect(await request.json()).not.toHaveProperty("thinking");
      expect(request.headers.get("anthropic-beta")).toBe("thinking-binding-controls-2026-08-01");
    });

    it("follows the base URL the SDK resolves from ANTHROPIC_BASE_URL, and sends that endpoint neither", async () => {
      vi.stubEnv("ANTHROPIC_BASE_URL", "https://openrouter.ai/api");
      try {
        const request = await sendThrough({ attrs: { prefixMismatchBehavior: "drop_block" } });

        expect(new URL(request.url).hostname).toBe("openrouter.ai");
        expect(await request.json()).not.toHaveProperty("thinking");
        expect(request.headers.get("anthropic-beta")).toBeNull();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("treats an empty base URL as Anthropic's own, as the SDK does", async () => {
      vi.stubEnv("ANTHROPIC_BASE_URL", "");
      try {
        const request = await sendThrough({ baseUrl: "" });

        expect(new URL(request.url).hostname).toBe("api.anthropic.com");
        expect(request.headers.get("anthropic-beta")).toBe("thinking-binding-controls-2026-08-01");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("sends a third-party base URL neither", async () => {
      const request = await sendThrough({
        baseUrl: "https://openrouter.ai/api",
        attrs: { prefixMismatchBehavior: "drop_block" },
      });

      expect(await request.json()).not.toHaveProperty("thinking");
      expect(request.headers.get("anthropic-beta")).toBeNull();
    });
  });

  it("multi-row chains expose a composite name", async () => {
    const { agentStore, secretsStore } = makeDeps({
      rows: [
        row({ name: "primary", type: "anthropic" }),
        row({
          id: "prov-2",
          name: "fallback-or",
          type: "openai_compatible",
          baseUrl: "https://openrouter.ai/api/v1",
          secretId: "secret-2",
        }),
      ],
    });
    const resolve = createDbProviderResolver({ runInTx: fakeRunInTx, agentStore, secretsStore });
    const { provider } = await resolve("m");
    // anthropic adapter's inner name is hardcoded to "anthropic"; the second
    // row uses its DB `name` ("fallback-or"). Composite shape proves both
    // adapters were constructed in order.
    expect(provider.name).toBe("fallback(anthropic,fallback-or)");
  });

  it("surfaces the primary row's optional limits alongside the provider", async () => {
    const { agentStore, secretsStore } = makeDeps({
      rows: [row({ contextWindow: 500_000, maxOutputTokens: 16_000 })],
    });
    const resolve = createDbProviderResolver({ runInTx: fakeRunInTx, agentStore, secretsStore });
    const { limits } = await resolve("m");
    expect(limits).toEqual({ contextWindow: 500_000, maxOutputTokens: 16_000 });
  });

  it("surfaces null limits when the primary row has no override", async () => {
    const { agentStore, secretsStore } = makeDeps();
    const resolve = createDbProviderResolver({ runInTx: fakeRunInTx, agentStore, secretsStore });
    const { limits } = await resolve("m");
    expect(limits).toEqual({ contextWindow: null, maxOutputTokens: null });
  });
});

describe("createDbProviderResolver — error matrix", () => {
  // Every config error must be a `ProviderConfigError` so handle-message /
  // observer can rewrap it as `NonRetriableError`. Plain `Error` shape would
  // hit the default retry path and burn Inngest attempts on a permanent
  // misconfiguration — exactly what the typed-error contract prevents.

  it("throws ProviderConfigError when no provider is configured for the model", async () => {
    const { agentStore, secretsStore } = makeDeps({ rows: [] });
    const resolve = createDbProviderResolver({ runInTx: fakeRunInTx, agentStore, secretsStore });
    await expect(resolve("unknown-model")).rejects.toThrow(ProviderConfigError);
    await expect(resolve("unknown-model")).rejects.toThrow(/No provider configured/);
  });

  it("throws ProviderConfigError when the secret lookup returns undefined", async () => {
    const { agentStore, secretsStore } = makeDeps({ secret: undefined });
    (secretsStore.getSecretById as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const resolve = createDbProviderResolver({ runInTx: fakeRunInTx, agentStore, secretsStore });
    await expect(resolve("m")).rejects.toThrow(ProviderConfigError);
    await expect(resolve("m")).rejects.toThrow(/Secret for provider "anthropic-direct" not found/);
  });

  it("throws ProviderConfigError when an openai_compatible row has no baseUrl", async () => {
    const { agentStore, secretsStore } = makeDeps({
      rows: [row({ type: "openai_compatible", baseUrl: null, name: "broken" })],
    });
    const resolve = createDbProviderResolver({ runInTx: fakeRunInTx, agentStore, secretsStore });
    await expect(resolve("m")).rejects.toThrow(ProviderConfigError);
    await expect(resolve("m")).rejects.toThrow(/"broken".*requires a base URL/);
  });

  // Removed: "throws ProviderConfigError on unknown provider type". The
  // `llm_provider_type` pgEnum + the resolver's exhaustive `switch(row.type)`
  // make an unknown runtime value structurally unreachable — Postgres rejects
  // out-of-enum writes (PG code 22P02, covered by image-schema.test.ts), and
  // adding a new enum value without a matching case branch is a compile-time
  // error. The legacy `default: throw new ProviderConfigError(...)` branch is
  // gone (see PR 220 review feedback).

  it("does NOT wrap transient DB errors as ProviderConfigError", async () => {
    // Drives the cache-no-poison test below — a plain Error here proves
    // the resolver only tags operator-fix-needed failures, leaving infra
    // hiccups on the default retry path.
    const { agentStore, secretsStore } = makeDeps({ listFailures: 1 });
    const resolve = createDbProviderResolver({ runInTx: fakeRunInTx, agentStore, secretsStore });
    const caught = await resolve("flaky").catch((e) => e);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ProviderConfigError);
  });
});

describe("createDbProviderResolver — caching", () => {
  it("memoizes by model — second call doesn't re-decrypt", async () => {
    const { agentStore, secretsStore, listProvidersForModel, getSecretById } = makeDeps();
    const resolve = createDbProviderResolver({ runInTx: fakeRunInTx, agentStore, secretsStore });
    const first = await resolve("claude-sonnet-4-6");
    const second = await resolve("claude-sonnet-4-6");
    expect(first).toBe(second);
    expect(listProvidersForModel).toHaveBeenCalledTimes(1);
    expect(getSecretById).toHaveBeenCalledTimes(1);
  });

  it("builds independent chains for different models", async () => {
    const { agentStore, secretsStore, listProvidersForModel } = makeDeps();
    const resolve = createDbProviderResolver({ runInTx: fakeRunInTx, agentStore, secretsStore });
    const a = await resolve("claude-sonnet-4-6");
    const b = await resolve("grok-4");
    expect(a).not.toBe(b);
    expect(listProvidersForModel).toHaveBeenCalledTimes(2);
    expect(listProvidersForModel).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "claude-sonnet-4-6",
    );
    expect(listProvidersForModel).toHaveBeenNthCalledWith(2, expect.anything(), "grok-4");
  });

  it("does not poison the cache on failure — next call retries", async () => {
    const { agentStore, secretsStore, listProvidersForModel } = makeDeps({ listFailures: 1 });
    const resolve = createDbProviderResolver({ runInTx: fakeRunInTx, agentStore, secretsStore });

    await expect(resolve("flaky")).rejects.toThrow(/transient db error/);
    // Second call must retry, not return the cached rejection
    const { provider } = await resolve("flaky");
    expect(provider).toBeInstanceOf(FallbackLlmProvider);
    expect(listProvidersForModel).toHaveBeenCalledTimes(2);
  });

  it("dedups concurrent first-time resolves for the same model (no thundering herd)", async () => {
    const { agentStore, secretsStore, listProvidersForModel, getSecretById } = makeDeps();
    const resolve = createDbProviderResolver({ runInTx: fakeRunInTx, agentStore, secretsStore });
    const [a, b, c] = await Promise.all([resolve("m"), resolve("m"), resolve("m")]);
    // Same memoized ResolvedLlm wrapper across calls.
    expect(a).toBe(b);
    expect(b).toBe(c);
    // Even with three parallel calls, the underlying lookup runs once.
    expect(listProvidersForModel).toHaveBeenCalledTimes(1);
    expect(getSecretById).toHaveBeenCalledTimes(1);
  });
});

describe("constantResolver", () => {
  it("returns the same provider for every model", async () => {
    const provider = mockProvider();
    const resolve = constantResolver(provider);
    expect((await resolve("anything")).provider).toBe(provider);
    expect((await resolve("else")).provider).toBe(provider);
  });

  it("defaults limits to null/null when none are passed", async () => {
    const provider = mockProvider();
    const resolve = constantResolver(provider);
    expect((await resolve("m")).limits).toEqual({ contextWindow: null, maxOutputTokens: null });
  });

  it("propagates explicit limits when passed", async () => {
    const provider = mockProvider();
    const resolve = constantResolver(provider, { contextWindow: 200_000, maxOutputTokens: 8_000 });
    expect((await resolve("m")).limits).toEqual({ contextWindow: 200_000, maxOutputTokens: 8_000 });
  });
});
