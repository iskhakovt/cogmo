/**
 * LLM provider resolver — model → `LlmProvider` lookup, evaluated per
 * call.
 *
 * The agent loop reads `profiles.model` from the per-turn snapshot, so the
 * provider that serves it must be chosen **after** the snapshot is loaded,
 * not at bootstrap. The resolver type abstracts that lookup; the DB-backed
 * implementation in {@link createDbProviderResolver} reads `model_providers`,
 * decrypts each row's API key, and wraps the ordered candidate list in a
 * `FallbackLlmProvider` (single-row chains stay no-op pass-throughs).
 *
 * Per-model results are memoized for the process lifetime — provider
 * adapters and decrypted secrets are immutable for a given row, and the
 * single-user deployment never has competing writers. DB changes to
 * `model_providers` / `llm_providers` / `secrets` require a process restart
 * to take effect.
 */
import type { AgentStore } from "../agent/store/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { AnthropicProvider } from "./anthropic.js";
import { FallbackLlmProvider } from "./fallback.js";
import { OpenAICompatibleProvider } from "./openai-compat.js";
import type { LlmProvider } from "./provider.js";

export type LlmProviderResolver = (model: string) => Promise<LlmProvider>;

export interface DbResolverDeps {
  agentStore: AgentStore;
  secretsStore: SecretsStore;
}

/**
 * DB-backed resolver — reads `model_providers` rows for the model, builds
 * one adapter per row, wraps in `FallbackLlmProvider`. Memoizes by model
 * string. Throws when no provider is configured for a model (should
 * propagate to the caller, who can rewrap it as a NonRetriable Inngest
 * error so the user gets a clear message).
 */
export function createDbProviderResolver(deps: DbResolverDeps): LlmProviderResolver {
  const cache = new Map<string, Promise<LlmProvider>>();

  return (model: string) => {
    const cached = cache.get(model);
    if (cached) return cached;

    const promise = buildProvider(model, deps).catch((err) => {
      // Don't poison the cache on transient errors (DB blip, secret missing
      // mid-rotation) — drop the entry so the next turn retries.
      cache.delete(model);
      throw err;
    });
    cache.set(model, promise);
    return promise;
  };
}

async function buildProvider(model: string, deps: DbResolverDeps): Promise<LlmProvider> {
  const rows = await deps.agentStore.listProvidersForModel(model);
  if (rows.length === 0) {
    throw new Error(
      `No provider configured for model "${model}". Run \`cogmo setup\` to configure one.`,
    );
  }

  const providers: LlmProvider[] = [];
  for (const row of rows) {
    const apiKey = await deps.secretsStore.getSecretById(row.secretId);
    if (!apiKey) {
      throw new Error(
        `Secret for provider "${row.name}" not found. Re-run \`cogmo setup\` to reconfigure.`,
      );
    }

    switch (row.type) {
      case "anthropic":
        providers.push(new AnthropicProvider(apiKey, row.baseUrl ?? undefined));
        break;
      case "openai_compatible": {
        if (!row.baseUrl) {
          throw new Error(
            `Provider "${row.name}" (openai_compatible) requires a base URL. Re-run \`cogmo setup\` to reconfigure.`,
          );
        }
        providers.push(
          new OpenAICompatibleProvider(row.name, {
            apiKey,
            baseURL: row.baseUrl,
            ...(row.attrs.headers && { headers: row.attrs.headers }),
            promptCaching: row.attrs.promptCaching ?? false,
          }),
        );
        break;
      }
      default:
        throw new Error(`Unknown provider type: ${row.type}`);
    }
  }

  return new FallbackLlmProvider(providers);
}

/**
 * Trivial resolver that returns the same provider for every model. Used by
 * tests and by the `providerOverride` bootstrap option.
 */
export function constantResolver(provider: LlmProvider): LlmProviderResolver {
  return () => Promise.resolve(provider);
}
