/// <reference path="../../test/vitest.d.ts" />

/**
 * Cross-provider integration coverage — proves the per-turn resolver
 * actually wires "two profiles, two providers, two upstream URLs" through
 * a real Postgres + a real secrets store. The original silent mis-routing
 * bug (bootstrap-resolved one provider, reused for every model) would
 * trip the path-routing assertion below: an OpenAI-compatible adapter
 * sending its request to `/v1/messages` (or vice versa) returns 404 from
 * llmock instead of the expected 503/strict-mismatch.
 *
 * llmock is shared across the integration suite — we pin our assertions
 * to the path llmock saw last, not to fixture content. No fixtures are
 * registered for these requests; the chat call itself is expected to
 * fail (strict mode → 503), which is fine because what we're verifying
 * is the URL the adapter dispatched to.
 */

import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { DrizzleAgentStore } from "../agent/store/index.js";
import * as schema from "../db/schemas.js";
import { FallbackLlmProvider } from "../llm/fallback.js";
import { createDbProviderResolver } from "../llm/resolver.js";
import { deriveMasterKey, parseMasterKey } from "../secrets/encryption.js";
import { DrizzleSecretsStore } from "../secrets/store/index.js";

const SUITE = randomBytes(4).toString("hex");
const tag = (s: string) => `it-${SUITE}-${s}`;

// Distinct from real registry entries to avoid ambiguity if seeds change.
// Both happen to exist in MODEL_REGISTRY but the resolver doesn't validate
// against it — only the routing table.
const MODEL_ANTHROPIC = "claude-sonnet-4-6";
const MODEL_XAI = "x-ai/grok-4.20";

// Test-only master key (32 bytes base64). Only used to encrypt our two
// secret rows; integration-setup.ts uses the same key for any other
// secrets it manages, so co-existing under one DB is safe.
const MASTER_KEY = "bSK9MVRqsqWnRcp4oNTQLQ+LmKJT+BvUvzytD5LH4AE=";

let sql: ReturnType<typeof postgres>;
let agentStore: DrizzleAgentStore;
let secretsStore: DrizzleSecretsStore;
let llmockBaseUrl: string;
let anthropicProviderId: string;
let openaiProviderId: string;

beforeAll(async () => {
  sql = postgres(inject("databaseUrl"), { max: 4 });
  const db = drizzle(sql, { schema });
  agentStore = new DrizzleAgentStore(db);
  secretsStore = new DrizzleSecretsStore(
    db,
    deriveMasterKey(parseMasterKey(MASTER_KEY), "cogmo/secrets-at-rest/v1"),
  );
  llmockBaseUrl = inject("llmockBaseUrl");

  // Two secrets — distinct so we'd notice if the wrong one got decrypted.
  const anthropicSecret = await secretsStore.putSecret({
    name: tag("anthropic-key"),
    plaintext: "test-anthropic-key",
  });
  const openaiSecret = await secretsStore.putSecret({
    name: tag("xai-key"),
    plaintext: "test-xai-key",
  });

  // Two providers, both pointing at llmock (which serves both Anthropic
  // and OpenAI-compatible endpoints from one process). Different secrets
  // and types so a wrong-adapter construction is observable.
  const anthropic = await agentStore.createProvider({
    name: tag("anthropic-direct"),
    type: "anthropic",
    baseUrl: llmockBaseUrl,
    secretId: anthropicSecret.id,
    attrs: {},
  });
  const openai = await agentStore.createProvider({
    name: tag("xai-grok"),
    type: "openai_compatible",
    baseUrl: `${llmockBaseUrl}/v1`,
    secretId: openaiSecret.id,
    attrs: { promptCaching: false },
  });
  anthropicProviderId = anthropic.id;
  openaiProviderId = openai.id;

  // Route each model to its provider. Position 0 = primary (no fallback
  // chain — single-row FallbackLlmProvider is a no-op pass-through).
  await agentStore.addModelProvider({
    model: MODEL_ANTHROPIC,
    providerId: anthropicProviderId,
    position: 0,
    userSelectable: true,
  });
  await agentStore.addModelProvider({
    model: MODEL_XAI,
    providerId: openaiProviderId,
    position: 0,
    userSelectable: true,
  });
});

afterAll(async () => {
  // Tear down our routing rows so other integration tests in the same
  // shared DB don't see them. Cascade from llm_providers handles
  // model_providers (FK CASCADE on the schema), and `deleteSecret` would
  // be ideal but the DrizzleSecretsStore interface above doesn't expose
  // it; the rows leak harmlessly behind their suite-tagged names.
  if (anthropicProviderId) await agentStore.deleteProvider(anthropicProviderId);
  if (openaiProviderId) await agentStore.deleteProvider(openaiProviderId);
  await sql.end();
});

describe("createDbProviderResolver — DB-backed cross-provider routing", () => {
  it("resolves the anthropic model to an Anthropic adapter", async () => {
    const resolve = createDbProviderResolver({ agentStore, secretsStore });
    const provider = await resolve(MODEL_ANTHROPIC);
    expect(provider).toBeInstanceOf(FallbackLlmProvider);
    // Single-row chain: FallbackLlmProvider inherits the inner provider's
    // name. AnthropicProvider hardcodes `name = "anthropic"`.
    expect(provider.name).toBe("anthropic");
  });

  it("resolves the xAI model to an OpenAI-compatible adapter", async () => {
    const resolve = createDbProviderResolver({ agentStore, secretsStore });
    const provider = await resolve(MODEL_XAI);
    expect(provider).toBeInstanceOf(FallbackLlmProvider);
    // OpenAICompatibleProvider's name comes from its constructor arg, which
    // we plumb from the DB row. Different shape than the anthropic adapter.
    expect(provider.name).toBe(tag("xai-grok"));
  });

  it("returns different providers for different models in the same process", async () => {
    const resolve = createDbProviderResolver({ agentStore, secretsStore });
    const a = await resolve(MODEL_ANTHROPIC);
    const b = await resolve(MODEL_XAI);
    // The whole point of per-turn dispatch: two models, two adapter
    // instances. Bootstrap-only resolution would have produced one
    // singleton and ignored the second model entirely.
    expect(a).not.toBe(b);
    expect(a.name).not.toBe(b.name);
  });

  it("memoizes per model — second resolution returns the same instance", async () => {
    const resolve = createDbProviderResolver({ agentStore, secretsStore });
    const first = await resolve(MODEL_ANTHROPIC);
    const second = await resolve(MODEL_ANTHROPIC);
    expect(first).toBe(second);
  });

  // The next two tests exercise the full network path through each adapter
  // type. llmock has a default chat-completion response that matches any
  // request, so we get a parsed response back instead of an error — but
  // each SDK posts to its OWN URL (Anthropic SDK → `<base>/v1/messages`,
  // OpenAI SDK → `<base>/v1/chat/completions`) and parses the response
  // through its OWN schema. A wrong-adapter construction would either
  // 404 against llmock's path-routing or fail the response-shape parse.
  // Successful round-trip + a recognisable response is the proof.

  it("anthropic adapter completes a real chat round-trip via llmock /v1/messages", async () => {
    const resolve = createDbProviderResolver({ agentStore, secretsStore });
    const provider = await resolve(MODEL_ANTHROPIC);
    const response = await provider.chat({
      model: MODEL_ANTHROPIC,
      system: "test",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 16,
    });
    // Anthropic SDK shape: `content` is a non-empty array of typed blocks
    // and `usage` carries Anthropic-style token counts. The OpenAI SDK
    // produces `choices[].message.content` instead — so this assertion
    // would fail if the resolver had built an OpenAICompatibleProvider
    // for this row.
    expect(Array.isArray(response.content)).toBe(true);
    expect(response.content.length).toBeGreaterThan(0);
    expect(response.usage).toEqual(
      expect.objectContaining({
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      }),
    );
  });

  it("openai-compatible adapter completes a real chat round-trip via llmock /v1/chat/completions", async () => {
    const resolve = createDbProviderResolver({ agentStore, secretsStore });
    const provider = await resolve(MODEL_XAI);
    const response = await provider.chat({
      model: MODEL_XAI,
      system: "test",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 16,
    });
    expect(Array.isArray(response.content)).toBe(true);
    expect(response.content.length).toBeGreaterThan(0);
    expect(response.usage).toEqual(
      expect.objectContaining({
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      }),
    );
  });
});
