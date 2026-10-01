/**
 * LLM provider resolver — model → `{ provider, limits }` lookup, evaluated
 * per call.
 *
 * The agent loop reads `profiles.model` from the per-turn snapshot, so the
 * provider that serves it must be chosen **after** the snapshot is loaded,
 * not at bootstrap. The resolver type abstracts that lookup; the DB-backed
 * implementation in {@link createDbProviderResolver} reads `model_providers`,
 * decrypts each row's API key, wraps the ordered candidate list in a
 * `FallbackLlmProvider` (single-row chains stay no-op pass-throughs), and
 * surfaces the primary row's optional context-window / max-output overrides
 * alongside the provider so the caller can resolve effective limits without
 * a second DB read.
 *
 * Per-model results are memoized for the process lifetime — provider
 * adapters and decrypted secrets are immutable for a given row, and the
 * single-user deployment never has competing writers. DB changes to
 * `model_providers` / `llm_providers` / `secrets` require a process restart
 * to take effect.
 */
import type { AgentStore } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { AnthropicProvider } from "./anthropic.js";
import { FallbackLlmProvider } from "./fallback.js";
import type { PartialLimits } from "./models.js";
import { OpenAICompatibleProvider } from "./openai-compat.js";
import type { LlmProvider } from "./provider.js";

/**
 * One resolved (model → provider) routing decision. The primary row's
 * optional limit columns ride along so callers don't have to make a second
 * DB read to compute the context budget. `limits.contextWindow` /
 * `maxOutputTokens` are `null` when the operator hasn't set an override —
 * the caller hands them to {@link resolveLimits} which layers the LiteLLM
 * snapshot and conservative default.
 */
export interface ResolvedLlm {
  provider: LlmProvider;
  limits: PartialLimits;
}

export type LlmProviderResolver = (model: string) => Promise<ResolvedLlm>;

/**
 * Permanent provider-resolution failures — missing routing row, missing
 * secret, malformed `llm_providers` row, unknown adapter type. These are
 * all operator-fix-needed config errors, not transient infrastructure
 * problems, so the agent runtime should rewrap them as `NonRetriableError`
 * before letting Inngest see them. Using a dedicated subclass (rather than
 * a duck-typed marker on `Error`) keeps the producer/consumer contract
 * type-safe — `instanceof` is the discriminator.
 *
 * Transient errors (DB blip, secret rotation race, network) keep the plain
 * `Error` shape so the existing retry path stays default.
 */
export class ProviderConfigError extends Error {
  override readonly name = "ProviderConfigError";
}

export interface DbResolverDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  secretsStore: SecretsStore;
}

/**
 * DB-backed resolver — reads `model_providers` rows for the model, builds
 * one adapter per row, wraps in `FallbackLlmProvider`. Memoizes by model
 * string. Throws `ProviderConfigError` for permanent operator-fix-needed
 * failures (missing routing row, missing secret, malformed row); plain
 * `Error` for transient infrastructure problems. The agent runtime
 * rewraps the former as `NonRetriableError`.
 */
export function createDbProviderResolver(deps: DbResolverDeps): LlmProviderResolver {
  const cache = new Map<string, Promise<ResolvedLlm>>();

  return (model: string) => {
    const cached = cache.get(model);
    if (cached) return cached;

    const promise = buildResolved(model, deps).catch((err) => {
      // Don't poison the cache on transient errors (DB blip, secret missing
      // mid-rotation) — drop the entry so the next turn retries.
      cache.delete(model);
      throw err;
    });
    cache.set(model, promise);
    return promise;
  };
}

async function buildResolved(model: string, deps: DbResolverDeps): Promise<ResolvedLlm> {
  const rows = await deps.runInTx((tx) => deps.agentStore.listProvidersForModel(tx, model));
  // Limits come from the primary row (position 0). Fallback rows can carry
  // their own limits in the schema, but only the primary's apply — the
  // fallback wrapper picks one chain per turn and the budget isn't
  // recomputed mid-turn if it switches providers.
  const [primary] = rows;
  if (primary === undefined) {
    throw new ProviderConfigError(
      `No provider configured for model "${model}". Run \`cogmo setup\` to configure one.`,
    );
  }

  // Resolve every row in parallel — each is an independent secret-decrypt +
  // adapter construction. Promise.all rejects on the first failing row
  // (which surfaces the operator-fix-needed message); other in-flight
  // decrypts complete harmlessly.
  const providers = await Promise.all(rows.map((row) => buildAdapter(row, deps)));
  return {
    provider: new FallbackLlmProvider(providers),
    limits: {
      contextWindow: primary.contextWindow,
      maxOutputTokens: primary.maxOutputTokens,
    },
  };
}

type ProviderRow = Awaited<ReturnType<AgentStore["listProvidersForModel"]>>[number];

async function buildAdapter(row: ProviderRow, deps: DbResolverDeps): Promise<LlmProvider> {
  const apiKey = await deps.runInTx((tx) => deps.secretsStore.getSecretById(tx, row.secretId));
  if (!apiKey) {
    throw new ProviderConfigError(
      `Secret for provider "${row.name}" not found. Re-run \`cogmo setup\` to reconfigure.`,
    );
  }

  // `row.type` is narrowed to `LlmProviderTypeValue` via the `pgEnum` —
  // switch is exhaustive without a `default` branch. Adding a new enum value
  // is a code-and-migration change in one PR; the compiler flags this switch
  // before the new value can ship silently mis-routed.
  switch (row.type) {
    case "anthropic":
      return new AnthropicProvider(apiKey, row.baseUrl ?? undefined, {
        ...(row.attrs.prefixMismatchBehavior && {
          prefixMismatchBehavior: row.attrs.prefixMismatchBehavior,
        }),
      });
    case "openai_compatible": {
      if (!row.baseUrl) {
        throw new ProviderConfigError(
          `Provider "${row.name}" (openai_compatible) requires a base URL. Re-run \`cogmo setup\` to reconfigure.`,
        );
      }
      // Each resolved model gets its own adapter, so the routing row's extra
      // request fields apply to this model's calls only.
      return new OpenAICompatibleProvider(row.name, {
        apiKey,
        baseURL: row.baseUrl,
        ...(row.attrs.headers && { headers: row.attrs.headers }),
        cacheDialect: row.attrs.cacheDialect ?? "none",
        ...(row.extraBody !== null && { extraBody: row.extraBody }),
      });
    }
  }
}

/**
 * Trivial resolver that returns the same provider for every model. Used by
 * tests and by the `providerOverride` bootstrap option. Limits default to
 * `{ null, null }` — the caller's resolver layer falls through to LiteLLM
 * or the conservative default. Pass an explicit `limits` to pin them.
 */
export function constantResolver(
  provider: LlmProvider,
  limits?: PartialLimits,
): LlmProviderResolver {
  const resolved: ResolvedLlm = {
    provider,
    limits: limits ?? { contextWindow: null, maxOutputTokens: null },
  };
  return () => Promise.resolve(resolved);
}
