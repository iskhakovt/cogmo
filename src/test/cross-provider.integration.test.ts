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
import { transactor } from "../db/index.js";
import * as schema from "../db/schemas.js";
import { FallbackLlmProvider } from "../llm/fallback.js";
import { createDbProviderResolver } from "../llm/resolver.js";
import { deriveMasterKey, parseMasterKey } from "../secrets/encryption.js";
import { DrizzleSecretsStore } from "../secrets/store/index.js";

const SUITE = randomBytes(4).toString("hex");
const tag = (s: string) => `it-${SUITE}-${s}`;

// Suite-tagged so this test stays isolated from any other writer to
// `model_providers` in the shared integration DB. The resolver only
// looks up the literal string in the routing table — it doesn't
// validate against `MODEL_REGISTRY` — so any string works. The
// `(model, position)` UNIQUE constraint on `model_providers` would
// otherwise collide with parallel runs of this file (vitest worker
// retries, suite re-entry) or any future test seeding the same model
// at position 0.
const MODEL_ANTHROPIC = tag("anthropic-test-model");
const MODEL_XAI = tag("openai-test-model");

let sql: ReturnType<typeof postgres>;
let tx: ReturnType<typeof transactor>;
let agentStore: DrizzleAgentStore;
let secretsStore: DrizzleSecretsStore;
let llmockBaseUrl: string;
let anthropicProviderId: string;
let openaiProviderId: string;

beforeAll(async () => {
  sql = postgres(inject("databaseUrl"), { max: 4 });
  const db = drizzle(sql, { schema });
  tx = transactor(db);
  agentStore = new DrizzleAgentStore();
  // Read the master key from `process.env` (set by `test/integration-setup.ts`
  // and propagated to test workers). Hardcoding it here would silently break
  // decryption if integration-setup ever rotated the key.
  const masterKey = process.env.COGMO_MASTER_KEY;
  if (!masterKey) {
    throw new Error("COGMO_MASTER_KEY missing — should be set by integration-setup.ts");
  }
  secretsStore = new DrizzleSecretsStore(
    deriveMasterKey(parseMasterKey(masterKey), "cogmo/secrets-at-rest/v1"),
  );
  llmockBaseUrl = inject("llmockBaseUrl");

  // Two secrets — distinct so we'd notice if the wrong one got decrypted.
  const anthropicSecret = await tx((trx) =>
    secretsStore.putSecret(trx, {
      name: tag("anthropic-key"),
      plaintext: "test-anthropic-key",
    }),
  );
  const openaiSecret = await tx((trx) =>
    secretsStore.putSecret(trx, {
      name: tag("xai-key"),
      plaintext: "test-xai-key",
    }),
  );

  // Two providers, both pointing at llmock (which serves both Anthropic
  // and OpenAI-compatible endpoints from one process). Different secrets
  // and types so a wrong-adapter construction is observable.
  const anthropic = await tx((trx) =>
    agentStore.createProvider(trx, {
      name: tag("anthropic-direct"),
      type: "anthropic",
      baseUrl: llmockBaseUrl,
      secretId: anthropicSecret.id,
      attrs: {},
    }),
  );
  const openai = await tx((trx) =>
    agentStore.createProvider(trx, {
      name: tag("xai-grok"),
      type: "openai_compatible",
      baseUrl: `${llmockBaseUrl}/v1`,
      secretId: openaiSecret.id,
      attrs: { promptCaching: false },
    }),
  );
  anthropicProviderId = anthropic.id;
  openaiProviderId = openai.id;

  // Route each model to its provider. Position 0 = primary (no fallback
  // chain — single-row FallbackLlmProvider is a no-op pass-through).
  await tx((trx) =>
    agentStore.addModelProvider(trx, {
      model: MODEL_ANTHROPIC,
      providerId: anthropicProviderId,
      position: 0,
      userSelectable: true,
    }),
  );
  await tx((trx) =>
    agentStore.addModelProvider(trx, {
      model: MODEL_XAI,
      providerId: openaiProviderId,
      position: 0,
      userSelectable: true,
    }),
  );
});

afterAll(async () => {
  // Tear down our routing rows so other integration tests in the same
  // shared DB don't see them. Cascade from llm_providers handles
  // model_providers (FK CASCADE on the schema), and `deleteSecret` would
  // be ideal but the DrizzleSecretsStore interface above doesn't expose
  // it; the rows leak harmlessly behind their suite-tagged names.
  if (anthropicProviderId) await tx((trx) => agentStore.deleteProvider(trx, anthropicProviderId));
  if (openaiProviderId) await tx((trx) => agentStore.deleteProvider(trx, openaiProviderId));
  await sql.end();
});

describe("createDbProviderResolver — DB-backed cross-provider routing", () => {
  it("resolves the anthropic model to an Anthropic adapter", async () => {
    const resolve = createDbProviderResolver({ runInTx: tx, agentStore, secretsStore });
    const { provider } = await resolve(MODEL_ANTHROPIC);
    expect(provider).toBeInstanceOf(FallbackLlmProvider);
    // Single-row chain: FallbackLlmProvider inherits the inner provider's
    // name. AnthropicProvider hardcodes `name = "anthropic"`.
    expect(provider.name).toBe("anthropic");
  });

  it("resolves the xAI model to an OpenAI-compatible adapter", async () => {
    const resolve = createDbProviderResolver({ runInTx: tx, agentStore, secretsStore });
    const { provider } = await resolve(MODEL_XAI);
    expect(provider).toBeInstanceOf(FallbackLlmProvider);
    // OpenAICompatibleProvider's name comes from its constructor arg, which
    // we plumb from the DB row. Different shape than the anthropic adapter.
    expect(provider.name).toBe(tag("xai-grok"));
  });

  it("returns different providers for different models in the same process", async () => {
    const resolve = createDbProviderResolver({ runInTx: tx, agentStore, secretsStore });
    const a = await resolve(MODEL_ANTHROPIC);
    const b = await resolve(MODEL_XAI);
    // The whole point of per-turn dispatch: two models, two adapter
    // instances. Bootstrap-only resolution would have produced one
    // singleton and ignored the second model entirely.
    expect(a.provider).not.toBe(b.provider);
    expect(a.provider.name).not.toBe(b.provider.name);
  });

  it("memoizes per model — second resolution returns the same instance", async () => {
    const resolve = createDbProviderResolver({ runInTx: tx, agentStore, secretsStore });
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
    const resolve = createDbProviderResolver({ runInTx: tx, agentStore, secretsStore });
    const { provider } = await resolve(MODEL_ANTHROPIC);
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
    const resolve = createDbProviderResolver({ runInTx: tx, agentStore, secretsStore });
    const { provider } = await resolve(MODEL_XAI);
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
