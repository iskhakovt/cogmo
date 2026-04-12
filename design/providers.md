# LLM Providers `[proposed]`

How cogmo routes LLM calls to different providers and manages their credentials.

## Problem

A user may want to call Claude via Anthropic directly, via OpenRouter (cheaper, different rate limits), or use OpenAI/xAI/DeepSeek entirely. The provider choice, credentials, and endpoint differ — but the agent loop, prompt assembly, and tool system are provider-agnostic. The gap is configuration: today `bootstrap()` hard-codes `AnthropicProvider`. There's no way to choose a provider at setup time, and no way to use multiple providers across profiles.

## Architecture

Two provider adapters already exist and are fully implemented:

| Adapter | Class | Covers |
|-|-|-|
| `AnthropicProvider` | Native Anthropic SDK | Anthropic direct (best feature support: prompt caching, extended thinking, native token counting) |
| `OpenAICompatibleProvider` | OpenAI SDK with configurable `baseURL` | OpenRouter, OpenAI, xAI, Together, Groq, DeepSeek, any Chat-Completions-compatible endpoint |

Both implement `LlmProvider` — the agent loop and orchestrator are already provider-agnostic. The missing piece is a **config layer** that maps "which provider to use" to "construct this adapter with these credentials."

## Data Model

```sql
llm_providers (
  id            UUID v7 PK,
  name          TEXT NOT NULL UNIQUE,           -- 'anthropic-direct', 'openrouter-main'
  type          TEXT NOT NULL,                  -- 'anthropic' | 'openai_compatible'
  base_url      TEXT,                           -- NULL = SDK default endpoint
  secret_id     UUID NOT NULL FK → secrets,     -- encrypted API key
  attrs         JSONB NOT NULL DEFAULT '{}',    -- provider-specific config
  is_valid      BOOLEAN NOT NULL DEFAULT false, -- set after successful validation call
  validated_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

### Column rationale

**`type`** is the adapter discriminator — maps to which class to instantiate. Two values today; a third (e.g., `"google"` for Gemini) adds one constructor branch, not a schema change.

**`base_url`** is NULL for providers that use their SDK's default endpoint (Anthropic, OpenAI). Non-NULL for OpenRouter (`https://openrouter.ai/api/v1`), self-hosted endpoints, or proxies.

**`secret_id`** references the `secrets` table (see [infrastructure.md](infrastructure.md) → Secrets). Decoupled from the provider row so the same key can serve multiple providers (e.g., one OpenRouter key for both a Claude-via-OpenRouter and a GPT-via-OpenRouter provider).

**`attrs`** JSONB for provider-specific config that doesn't warrant its own column:
- `promptCaching: true` — OpenRouter → Claude (passes `cache_control` extension)
- `headers: { "HTTP-Referer": "..." }` — OpenRouter app attribution
- `organization: "..."` — OpenAI org ID

**`is_valid` + `validated_at`** — set by the setup wizard after a successful `GET /v1/models` call. Lets re-run show "Validated 3 days ago."

### Profile → Provider

```sql
ALTER TABLE profiles ADD COLUMN provider_id UUID REFERENCES llm_providers(id);
```

The profile's existing `model` field stays a **plain model string** (`claude-sonnet-4-20250514`, `gpt-4o`). The FK `provider_id` determines which API to call. Changing the provider for a profile is a FK update — the model string doesn't change.

This decouples "which model" from "which provider." The same model via Anthropic vs. OpenRouter is a `provider_id` change, not a model rename. The LiteLLM convention of `provider/model` prefixes conflates two concerns — we avoid it.

### Provider dispatch

At bootstrap, read all configured providers and construct adapter instances:

```typescript
const providerRow = await store.getProvider(profile.providerId);
const apiKey = await resolver.getSecret(providerRow.secretName);

const provider = providerRow.type === "anthropic"
  ? new AnthropicProvider(apiKey, providerRow.baseUrl)
  : new OpenAICompatibleProvider(providerRow.name, {
      apiKey,
      baseURL: providerRow.baseUrl!,
      headers: providerRow.attrs.headers,
      promptCaching: providerRow.attrs.promptCaching,
    });
```

Provider instances are constructed per bootstrap, not per turn. If hot-swap is needed later, a lazy-loading wrapper can reconstruct on DB change without touching the dispatch logic.

### Model registry

`MODEL_REGISTRY` in `src/llm/models.ts` maps model strings → context window limits. It stays provider-agnostic and code-level — a model's limits don't depend on which provider serves it. If the set of supported models grows beyond a small hardcoded map, promote to DB rows. Not in scope for this work.

## Validation

The setup wizard validates each provider by calling `GET /v1/models` (standard across OpenAI-compatible APIs) or Anthropic's equivalent. This is free (no tokens consumed), confirms the API key works, and returns the list of available models — useful for confirming the user's chosen model is accessible on their key.

For Telegram channels, validation uses `GET /bot<TOKEN>/getMe` — free, returns the bot username for UX confirmation.

## Ecosystem context

This design follows the pattern used by **LiteLLM** (when `store_model_in_db` is enabled), **n8n** (credential system), and **Dify** (provider table). All three store provider configs in DB rows with encrypted credentials, referenced by the consuming entity (LiteLLM model deployment, n8n workflow node, Dify app). Cogmo's schema is the minimal single-user variant — no multi-tenant columns, no quota tracking, no model-per-provider tables.
