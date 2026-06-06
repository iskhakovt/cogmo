/// <reference path="../../test/vitest.d.ts" />

/**
 * Sub-agent two-model integration coverage. Proves the headline path through
 * real infrastructure (Postgres + secrets store + the per-turn resolver + real
 * SDK adapters + the wire to llmock): a sub-agent whose `model` points at a
 * DIFFERENT provider than the orchestrator resolves to its own adapter and
 * round-trips a completion over that adapter's URL.
 *
 * Test 1 (adapter resolution) is fixtureless — it asserts the resolver builds a
 * distinct OpenAI-compatible adapter for the sub-agent's model vs. the Anthropic
 * orchestrator, mirroring `cross-provider.integration.test.ts`.
 *
 * Test 2 replays ONE recorded specialist chat fixture: the handler drives the
 * sub-agent's real OpenAI-compatible adapter over the wire with a FIXED request,
 * so the recording is stable (re-record only if the task/system/model change) —
 * unlike a full orchestrator-turn fixture, which would churn on every prompt or
 * tool-description tweak. The orchestrator→tool→sub-agent→final flow is covered
 * deterministically by `sub-agent-delegation.test.ts` (mocked providers).
 *
 * Re-record: RECORD=1 pnpm test:integration src/test/sub-agent-dispatch.integration.test.ts
 */

import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Service } from "../agent/service.js";
import { DrizzleAgentStore } from "../agent/store/index.js";
import { buildSubAgentTools } from "../agent/subagent/sub-agent-tool-builder.js";
import { transactor } from "../db/index.js";
import * as schema from "../db/schemas.js";
import { FallbackLlmProvider } from "../llm/fallback.js";
import { createDbProviderResolver } from "../llm/resolver.js";
import { deriveMasterKey, parseMasterKey } from "../secrets/encryption.js";
import { DrizzleSecretsStore } from "../secrets/store/index.js";

const SUITE = randomBytes(4).toString("hex");
const tag = (s: string) => `it-${SUITE}-${s}`;

const MODEL_ORCHESTRATOR = tag("anthropic-orchestrator");
// Real model id — the specialist call hits the OpenAI-compatible upstream
// during RECORD=1 (api.openai.com via llmock), so the model must be one the
// upstream accepts. Replay serves the recorded fixture; the id is never sent
// to a real API in CI.
const MODEL_SPECIALIST = "gpt-4o-mini";
const SUB_AGENT_NAME = "writer";

let sql: ReturnType<typeof postgres>;
let tx: ReturnType<typeof transactor>;
let agentStore: DrizzleAgentStore;
let secretsStore: DrizzleSecretsStore;
let userId: string;
let anthropicProviderId: string;
let openaiProviderId: string;
let openaiProviderName: string;

beforeAll(async () => {
  sql = postgres(inject("databaseUrl"), { max: 4 });
  const db = drizzle(sql, { schema });
  tx = transactor(db);
  agentStore = new DrizzleAgentStore();
  userId = inject("defaultUserId");

  const masterKey = process.env.COGMO_MASTER_KEY;
  if (!masterKey) throw new Error("COGMO_MASTER_KEY missing — set by integration-setup.ts");
  secretsStore = new DrizzleSecretsStore(
    deriveMasterKey(parseMasterKey(masterKey), "cogmo/secrets-at-rest/v1"),
  );
  const llmockBaseUrl = inject("llmockBaseUrl");

  const orchestratorSecret = await tx((trx) =>
    secretsStore.putSecret(trx, { name: tag("orch-key"), plaintext: "test-key" }),
  );
  // Real key only when recording the specialist fixture; replay/CI uses a dummy
  // (llmock serves the recorded response and never reaches the upstream).
  const specialistSecret = await tx((trx) =>
    secretsStore.putSecret(trx, {
      name: tag("spec-key"),
      plaintext: process.env.RECORD === "1" ? (process.env.OPENAI_API_KEY ?? "") : "test-key",
    }),
  );

  // Orchestrator on Anthropic, specialist on an OpenAI-compatible provider —
  // both at llmock, which serves both endpoints from one process.
  const anthropic = await tx((trx) =>
    agentStore.createProvider(trx, {
      name: tag("anthropic-direct"),
      type: "anthropic",
      baseUrl: llmockBaseUrl,
      secretId: orchestratorSecret.id,
      attrs: {},
    }),
  );
  openaiProviderName = tag("openai-compat");
  const openai = await tx((trx) =>
    agentStore.createProvider(trx, {
      name: openaiProviderName,
      type: "openai_compatible",
      baseUrl: `${llmockBaseUrl}/v1`,
      secretId: specialistSecret.id,
      attrs: { promptCaching: false },
    }),
  );
  anthropicProviderId = anthropic.id;
  openaiProviderId = openai.id;

  await tx((trx) =>
    agentStore.addModelProvider(trx, {
      model: MODEL_ORCHESTRATOR,
      providerId: anthropicProviderId,
      position: 0,
      userSelectable: true,
    }),
  );
  await tx((trx) =>
    agentStore.addModelProvider(trx, {
      model: MODEL_SPECIALIST,
      providerId: openaiProviderId,
      position: 0,
      userSelectable: true,
    }),
  );

  await tx((trx) =>
    agentStore.createSubAgent(trx, {
      userId,
      name: SUB_AGENT_NAME,
      description: "long-form writing specialist",
      systemPrompt: "Be terse.",
      model: MODEL_SPECIALIST,
    }),
  );
});

afterAll(async () => {
  await tx((trx) => agentStore.deleteSubAgent(trx, userId, SUB_AGENT_NAME));
  if (anthropicProviderId) await tx((trx) => agentStore.deleteProvider(trx, anthropicProviderId));
  if (openaiProviderId) await tx((trx) => agentStore.deleteProvider(trx, openaiProviderId));
  await sql.end();
});

describe("sub-agent dispatch — orchestrator and specialist on different providers", () => {
  it("resolves the sub-agent's model to a distinct OpenAI-compatible adapter, not the orchestrator's", async () => {
    const resolve = createDbProviderResolver({ runInTx: tx, agentStore, secretsStore });
    const orchestrator = await resolve(MODEL_ORCHESTRATOR);
    const specialist = await resolve(MODEL_SPECIALIST);

    expect(orchestrator.provider).toBeInstanceOf(FallbackLlmProvider);
    expect(specialist.provider).toBeInstanceOf(FallbackLlmProvider);
    // AnthropicProvider hardcodes name "anthropic"; OpenAICompatibleProvider
    // takes its name from the DB row. Distinct names == distinct adapters.
    expect(orchestrator.provider.name).toBe("anthropic");
    expect(specialist.provider.name).toBe(openaiProviderName);
    expect(orchestrator.provider).not.toBe(specialist.provider);
  });

  it("runs the sub-agent's model over its real adapter + the wire and returns text", async () => {
    const resolve = createDbProviderResolver({ runInTx: tx, agentStore, secretsStore });
    const rows = await tx((trx) => agentStore.listSubAgents(trx, userId));
    const tools = buildSubAgentTools(
      rows.filter((r) => r.name === SUB_AGENT_NAME),
      resolve,
    );
    expect(tools).toHaveLength(1);

    // Real handler → real OpenAICompatibleProvider → POST llmock
    // /v1/chat/completions → default completion. A non-empty result proves the
    // sub-agent's second model dispatched over its own adapter and the text
    // round-tripped back (an Anthropic-adapter mis-route would 404 the path).
    const out = await tools[0]?.handler({ task: "Write a haiku about the sea." }, mock<Service>());
    expect(typeof out).toBe("string");
    expect((out ?? "").length).toBeGreaterThan(0);
  });
});
