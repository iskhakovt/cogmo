# LLM Providers `[confirmed]`

How cogmo routes LLM calls to different providers and manages their credentials.

## Problem

A user may want to call Claude via Anthropic directly, via OpenRouter (cheaper, different rate limits), or use OpenAI/xAI/DeepSeek entirely. The provider choice, credentials, and endpoint differ — but the agent loop, prompt assembly, and tool system are provider-agnostic. The system needs a config layer that maps "profile wants model X" → "call provider Y with credentials Z."

## Architecture

Two provider adapters exist:

| Adapter | Class | Covers |
|-|-|-|
| `AnthropicProvider` | Native Anthropic SDK | Anthropic direct (best feature support: prompt caching, extended thinking, native token counting) |
| `OpenAICompatibleProvider` | OpenAI SDK with configurable `baseURL` | OpenRouter, OpenAI, xAI, Together, Groq, DeepSeek, any Chat-Completions-compatible endpoint |

Both implement `LlmProvider` — the agent loop and orchestrator are provider-agnostic.

## Data Model

Three concerns, three tables:

```
profiles.model ──→ model_providers.model ──→ llm_providers ──→ secrets
  "what I want"     "who serves it"           "credentials"     "encrypted key"
```

### Provider table

```sql
llm_providers (
  id            UUID v7 PK,
  name          TEXT NOT NULL UNIQUE,             -- 'anthropic-direct', 'openrouter'
  type          llm_provider_type NOT NULL,       -- pgEnum: 'anthropic' | 'openai_compatible'
  base_url      TEXT,                             -- NULL = SDK default endpoint
  secret_id     UUID NOT NULL FK → secrets,       -- encrypted API key
  attrs         JSONB NOT NULL,                   -- provider-specific config
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

**`type`** is a `pgEnum` adapter discriminator — maps to which class to instantiate. Two values today; a third (e.g., `"google"` for Gemini) adds one constructor branch *and* an `ALTER TYPE ... ADD VALUE` migration, both shipped together (no runtime cost). The enum gives the TS column a literal-union type and makes `switch(row.type)` in `buildProvider` exhaustive without `assertNever`.

**`base_url`** is NULL for providers that use their SDK's default endpoint (Anthropic). Required for OpenAI-compatible providers (OpenRouter, xAI, custom).

**`secret_id`** references the `secrets` table (see [infrastructure.md](infrastructure.md) → Secrets). Decoupled from the provider row so the same key can serve multiple providers (e.g., one OpenRouter key for both Claude-via-OpenRouter and GPT-via-OpenRouter).

**`attrs`** JSONB for provider-specific config: `promptCaching`, `headers`, `organization`.

### Model → Provider routing

```sql
model_providers (
  id              UUID v7 PK,
  model           TEXT NOT NULL,                          -- 'claude-sonnet-4-20250514'
  provider_id     UUID NOT NULL FK → llm_providers CASCADE,
  position        INT NOT NULL,                           -- 0 = primary, 1 = fallback
  user_selectable BOOLEAN NOT NULL,                       -- true = appears in /model picker; false = internal-only (summarization, experimental)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (model, provider_id),                            -- one entry per pair
  UNIQUE (model, position)                                -- ordered, no ties
)
```

Provider routing is a **system-level concern**, not a per-profile setting. The routing table maps models to providers with explicit ordering:

- A profile says "I want `claude-sonnet-4`" (via `profiles.model`)
- `model_providers` says "`claude-sonnet-4` is served by `anthropic-direct` at position 0, `openrouter` at position 1"
- The system picks the lowest-position provider

The `UNIQUE (model, position)` constraint prevents ambiguous ties. Adding a fallback provider = inserting at position 1. Reordering = updating the position column. The wizard auto-assigns `MAX(position) + 1` for new entries.

**Why not on the profile:** Provider routing changes for operational reasons (key rotation, provider outage, cost optimization), not behavioral reasons. Coupling it to profiles would require updating every profile to switch providers. The routing table changes once and affects all profiles using that model.

**Why not on the provider:** A provider doesn't know about other providers — priority is a relative ranking across providers for a given model. It belongs on the relationship, not on either entity.

### Profile model configuration

```sql
profiles (
  ...
  model               TEXT NOT NULL,      -- main conversational model
  summarization_model  TEXT,              -- null = use main model
  ...
)
```

Profiles declare **what model** they want, not **which provider** serves it. Named columns for well-known roles (default, summarization). Adding a role = adding a nullable column. If roles proliferate beyond 3-4, promote to a `profile_models` join table.

`summarization_model` replaces the `SUMMARIZATION_MODEL` env var — it's a per-profile concern, not a system-wide one.

**Editing `profiles.model`:** the wizard seeds initial values, but profiles are also editable at runtime via `Transport.profiles.update` (e.g., Telegram `/model <model>`). Updates validate that the chosen model exists in `model_providers` AND has `user_selectable = true` — anything else returns `model_unavailable`. Each `messages` row records the model that produced it (`messages.model`), so changing `profiles.model` doesn't lose history. See [transport/adapters.md](transport/adapters.md) → Profile admin and [transport/overview.md](transport/overview.md) → Profile and Model Stamping.

## Model policy

`model_providers.user_selectable` is the org-level policy gate. Two consumers care:

- **`Transport.models.list()`** filters to `user_selectable = true` for the `/model` picker.
- **`Transport.profiles.update({ model })`** validates the new model is `user_selectable`.

Use cases for `user_selectable = false`:

- **Internal models** — a cheap haiku used for summarization or extraction shouldn't appear as a user-pickable conversational model.
- **Experimental/preview models** — admin wants to route them via `model_providers` without exposing them to users until validated.
- **Deprecation** — flip the flag to retire a model from the picker without removing the routing entry; existing profiles keep working until the user picks a different one.

Admin toggles via psql or the wizard. There is no Transport mutation for `user_selectable` in v0 — model policy is out-of-band.

`profile.summarization_model` is not gated by `user_selectable` — it's an internal field set at profile creation/edit time, and admins control whether end users can edit profile fields beyond `model` via the broader profile ACL (see [transport/adapters.md](transport/adapters.md) → Profile admin).

## Provider dispatch

Dispatch is **per turn**, not per bootstrap. Bootstrap builds a resolver — a function `(model: string) => Promise<LlmProvider>` — and hands it to `handle-message` and the Observer. Each turn reads the snapshot's model and calls the resolver, so a profile that targets `claude-sonnet-4-6` lands on `AnthropicProvider` while a sibling profile that targets `x-ai/grok-4` on the same conversation table lands on `OpenAICompatibleProvider` — both running in the same process. This is what makes per-profile cross-provider configuration actually work; bootstrap-only resolution silently mis-routes the moment `/model` switches to a model the bootstrap provider can't serve.

The resolver memoizes by model. The first time a model is seen the resolver reads `model_providers`, decrypts each row's secret, and constructs the adapter chain; every subsequent turn for the same model is a `Map` lookup. Adapter instances and decrypted secrets are immutable for a given row, and the single-user deployment never has competing writers, so cache invalidation is unnecessary — DB changes to `model_providers` / `llm_providers` / `secrets` take effect on next process restart. Hot-reload is deferred until there's a workflow that demands it.

Every candidate in `listProvidersForModel(model)` is wrapped in a `FallbackLlmProvider` (see [Fallback](#fallback-confirmed)) — consumers receive a plain `LlmProvider` and never see the chain, even when there is only one row (in which case the wrapper is a no-op pass-through).

```typescript
type LlmProviderResolver = (model: string) => Promise<LlmProvider>;

function createDbProviderResolver(deps: {
  agentStore: AgentStore;
  secretsStore: SecretsStore;
}): LlmProviderResolver {
  const cache = new Map<string, Promise<LlmProvider>>();
  return (model) => {
    const hit = cache.get(model);
    if (hit) return hit;
    const built = buildProvider(model, deps).catch((err) => {
      cache.delete(model); // don't poison on transient failures
      throw err;
    });
    cache.set(model, built);
    return built;
  };
}

async function buildProvider(model: string, deps): Promise<LlmProvider> {
  // 1. Find every provider for this model, ordered by position (primary first)
  const rows = await deps.agentStore.listProvidersForModel(model);
  if (rows.length === 0) throw new Error(`No provider configured for "${model}"`);

  // 2. Construct an adapter per row (each has its own credential)
  const providers = await Promise.all(rows.map(async (row) => {
    const apiKey = await deps.secretsStore.getSecretById(row.secretId);
    return row.type === "anthropic"
      ? new AnthropicProvider(apiKey, row.baseUrl)
      : new OpenAICompatibleProvider(row.name, { apiKey, baseURL: row.baseUrl, ... });
  }));

  // 3. Wrap the ordered list in a fallback provider
  return new FallbackLlmProvider(providers);
}
```

`handle-message` calls the resolver immediately after `load-turn-snapshot` and uses the returned provider for streaming, summarization, and `countTokens`. When `summarization_model` differs from `model`, summarization gets its own resolution — which can land on a different provider entirely (e.g., main turn on Anthropic, summarization on a cheap haiku via OpenRouter). The Observer resolves once per fire against its fixed extraction model.

## Fallback `[confirmed]`

When a model has more than one row in `model_providers`, cogmo builds a `FallbackLlmProvider` that wraps every candidate in position-ASC order and transparently retries transient failures against the next one. The agent loop, typed calls, and observer all consume a plain `LlmProvider` — they never see the chain.

**The SDK retries come first.** The Anthropic and OpenAI SDKs both retry HTTP errors internally (exponential backoff, a few attempts). The fallback wrapper is the OUTER layer — it only engages after those in-SDK retries have exhausted. This is deliberate: retrying against the same provider is almost always the right first move (same cache state, same routing, usually cheaper). Cross-provider fallback only helps when the current provider is genuinely unhealthy.

### Classification

Errors are classified by duck-typing a numeric `status` field on the thrown `Error` — both SDKs expose this on their `APIError` shape, so no SDK-specific imports are needed.

| Class | Statuses | Behaviour |
|-|-|-|
| **transient** | no status (network/DNS/TLS/timeout), 408, 425, 429, all 5xx | try the next candidate |
| **permanent** | 400, 401, 403, 404, 409, 422, any other 4xx | propagate (no fallback) |

Non-Error throws (strings, objects) are treated as **permanent** — the caller is misusing the SDK. The classifier (`isRetriableProviderError`) is a pure function and is covered by a table-driven test.

Permanent errors are propagated immediately because retrying a 401 against the next provider rarely helps and burns quota — each provider has its own credential. Authentication, validation, and invalid-request errors are bugs in configuration or code, not transient infrastructure problems.

### Ordering

Every candidate in `listProvidersForModel(model)` is tried in position-ASC order (primary first, then each fallback). There is no cap on chain length — if the user has configured 5 fallbacks, all 5 can be tried. When every candidate fails transiently, the wrapper raises `AllProvidersFailedError`, which carries the ordered list of `{ provider, error }` attempts so operators can see exactly what failed.

### Streaming

Streaming fallback applies **only to pre-stream failures**. The wrapper establishes the candidate's stream and pulls the first event inside a try/catch — if that fails with a transient error, we move to the next candidate. Once the first byte has been yielded to the consumer, we are committed: mid-stream errors propagate and the partial output stays in history.

This rule avoids two failure modes: yielding duplicated content (the agent sees the primary's tokens then restarts on the fallback), and losing context mid-turn (a tool call emitted by the primary, then a different model continuing from where it didn't start). Pre-stream recovery is safe because nothing has been committed yet.

### Observability

- `logger.warn` per fallback transition — fields: `fromProvider`, `toProvider`, `errClass`, `errMessage`. One line per hop, easy to grep.
- `logger.error` when the chain exhausts — fields: `op`, ordered `attempts` list with provider names and error descriptions.
- `AllProvidersFailedError.attempts` carries the same list for programmatic inspection.

The wrapper does not deduplicate requests, rate-limit transitions, or track health state — it is stateless. A provider that just returned 500 will be tried again on the next turn. This is intentional for the single-user deployment: complexity that pays off at scale (circuit breakers, health checks) is noise here.

## Validation

The setup wizard validates each provider by calling `GET /v1/models` (standard across OpenAI-compatible APIs) or Anthropic's equivalent. This is free (no tokens consumed), confirms the API key works, and returns the list of available models — which the wizard uses to auto-populate `model_providers` entries.

Validation status is tracked on the **secret** (`secrets.validated_at`), not on the provider row — the credential is what gets validated, not the provider config.

## Limits resolution

Model limits (context window + max output tokens) come from a three-layer resolver in `src/llm/models.ts:resolveLimits(model, rowLimits)`. Layers, in priority order:

1. **DB row override.** `model_providers.context_window` and `model_providers.max_output_tokens` (nullable). Set by the setup wizard or `cogmo model add` when an operator wants to pin explicit limits. Layered per-column: a row that sets only `max_output_tokens` still falls through to the next layer for `context_window`.
2. **Bundled LiteLLM snapshot.** `data/litellm-models.json`, refreshed manually via `pnpm tsx scripts/refresh-litellm-models.ts`. Pruned to the two fields we consume; ~2,200 models covered. The loader (`src/llm/litellm-data.ts`) normalizes lookup keys through a small alias ladder — `x-ai/grok-4.3` finds `xai/grok-4.3`, `openrouter/<x>` strips the prefix, etc. — so OpenRouter slugs resolve against vendor-direct entries.
3. **Conservative default.** 128k context / 4k max output, with a one-time `WARN` log per unknown model. Compaction errs on the side of firing too early rather than overrunning the upstream's real limit.

`resolveLimits` never throws — unknown models silently fall to the default. `getModelLimits` no longer exists; callers receive limits as a `ResolvedLlm` from `LlmProviderResolver` (the resolver loads `model_providers` once per turn and surfaces the primary row's columns alongside the adapter).

`cogmo model list` prints each routing row's effective limits with the source (`db`/`litellm`/`default`) so operators can see why compaction behaves the way it does. Re-record the LiteLLM snapshot when a new flagship lands by running the refresh script and committing the diff.

## Ecosystem context

The routing table pattern follows **LiteLLM** (`model_list` with provider-prefixed model strings and priority), **OpenRouter** (request-time `provider.order` for the same model across upstream providers), and **Dify** (separate `provider_models` table per tenant). Cogmo's schema is the minimal single-user variant — one `model_providers` table with position-based ordering replaces LiteLLM's YAML config and Dify's 7-table schema.
