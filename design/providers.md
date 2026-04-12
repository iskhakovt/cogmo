# LLM Providers `[proposed]`

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
  name          TEXT NOT NULL UNIQUE,           -- 'anthropic-direct', 'openrouter'
  type          TEXT NOT NULL,                  -- 'anthropic' | 'openai_compatible'
  base_url      TEXT,                           -- NULL = SDK default endpoint
  secret_id     UUID NOT NULL FK → secrets,     -- encrypted API key
  attrs         JSONB NOT NULL,                 -- provider-specific config
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

**`type`** is the adapter discriminator — maps to which class to instantiate. Two values today; a third (e.g., `"google"` for Gemini) adds one constructor branch, not a schema change.

**`base_url`** is NULL for providers that use their SDK's default endpoint (Anthropic). Required for OpenAI-compatible providers (OpenRouter, xAI, custom).

**`secret_id`** references the `secrets` table (see [infrastructure.md](infrastructure.md) → Secrets). Decoupled from the provider row so the same key can serve multiple providers (e.g., one OpenRouter key for both Claude-via-OpenRouter and GPT-via-OpenRouter).

**`attrs`** JSONB for provider-specific config: `promptCaching`, `headers`, `organization`.

### Model → Provider routing

```sql
model_providers (
  id            UUID v7 PK,
  model         TEXT NOT NULL,                          -- 'claude-sonnet-4-20250514'
  provider_id   UUID NOT NULL FK → llm_providers CASCADE,
  position      INT NOT NULL,                           -- 0 = primary, 1 = fallback
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (model, provider_id),                          -- one entry per pair
  UNIQUE (model, position)                              -- ordered, no ties
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

## Provider dispatch

At bootstrap, resolve the model → provider → credentials chain:

```typescript
async function resolveProviderForModel(model: string, store: AgentStore): Promise<LlmProvider> {
  // 1. Find the best provider for this model (lowest position)
  const row = await store.resolveProviderForModel(model);
  // → SELECT lp.* FROM model_providers mp
  //   JOIN llm_providers lp ON mp.provider_id = lp.id
  //   WHERE mp.model = $model ORDER BY mp.position LIMIT 1

  // 2. Decrypt the API key
  const apiKey = await secretsStore.getSecretById(row.secretId);

  // 3. Construct the adapter
  return row.type === "anthropic"
    ? new AnthropicProvider(apiKey, row.baseUrl)
    : new OpenAICompatibleProvider(row.name, { apiKey, baseURL: row.baseUrl, ... });
}
```

Provider instances are constructed per bootstrap, not per turn. If hot-swap is needed later, a lazy-loading wrapper can reconstruct on DB change.

## Validation

The setup wizard validates each provider by calling `GET /v1/models` (standard across OpenAI-compatible APIs) or Anthropic's equivalent. This is free (no tokens consumed), confirms the API key works, and returns the list of available models — which the wizard uses to auto-populate `model_providers` entries.

Validation status is tracked on the **secret** (`secrets.validated_at`), not on the provider row — the credential is what gets validated, not the provider config.

## Model registry

`MODEL_REGISTRY` in `src/llm/models.ts` maps model strings → context window limits. It stays provider-agnostic and code-level — a model's limits don't depend on which provider serves it. If the set of supported models grows beyond a small hardcoded map, promote to DB rows.

## Ecosystem context

The routing table pattern follows **LiteLLM** (`model_list` with provider-prefixed model strings and priority), **OpenRouter** (request-time `provider.order` for the same model across upstream providers), and **Dify** (separate `provider_models` table per tenant). Cogmo's schema is the minimal single-user variant — one `model_providers` table with position-based ordering replaces LiteLLM's YAML config and Dify's 7-table schema.
