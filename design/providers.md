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

### Call contract

```typescript
interface LlmProvider {
  chat(params: ChatParams, options?: ChatOptions): Promise<LlmResponse>;
  chatStream(params: ChatParams, options?: ChatOptions): AsyncIterable<ChatStreamFrame>;
  countTokens(params: CountTokensParams): Promise<number>;
}
```

`chatStream` yields content frames (`text_delta`, `thinking_delta`, and `tool_start` with complete parsed input), then one `done` frame carrying `{ stopReason, model, usage }`. A failure throws from the iterator. A consumer that stops early, by `break` or a throw in its loop body, returns the iterator: the adapter's generator leaves the SDK stream's loop, which aborts the request, and ends the span.

The metadata rides in the stream because the agent loop, the only consumer, drains every frame anyway: one iterable settles on every path by construction, and the fallback wrapper passes it through with `for await`. It is the provider-level shape of the Vercel AI SDK (`doStream`, whose last part is `finish`) and of OpenAI's final usage chunk. The loop fails an iteration whose stream ends without `done` or sends anything after it.

`ChatOptions.signal` cancels a call: the request is aborted, and the call rejects or the stream throws with `signal.reason` as soon as the signal fires. Both SDKs take the signal as a request option and abort the request when it fires, a retry's backoff included. The adapters close two gaps in how they report it:

- They throw their own `APIUserAbortError`; the adapter throws the reason instead (`src/llm/abort.ts`).
- They end an aborted stream quietly, as if it had finished, and the Anthropic SDK first yields the events it had buffered from the current network chunk (the OpenAI SDK checks the signal between lines). The adapters check the signal after the SDK's last event, and the Anthropic adapter before each one, so nothing past the abort is yielded, a `done` frame for the cut-off response included.

The degraded-reply synthesis is the one caller that passes a signal: its 5-second cap (see [agent-resilience.md](agent-resilience.md) → Tools-free synthesis on degrade).

`OpenAICompatibleProvider` maps three request parameters by OpenAI model family, matched by bare or fine-tuned model id on any host (`modelFamilyParams`):

- **Output cap.** OpenAI's reasoning models (the o-series, GPT-5 onward and the `chat-latest` ids) take it as `max_completion_tokens`; every other id as `max_tokens`.
- **Reasoning effort.** From GPT-5.5, Chat Completions rejects function tools at any effort but `none` (GPT-5.6 onward also at their default), and every reasoning model rejects a `temperature` other than 1 except at `none`. A request with tools or a temperature to a model with a `none` effort (GPT-5.1 onward, except the Astra tier and `chat-latest`) goes at `none`; any other request keeps the model's default. So those models' tool turns run without reasoning, and the degraded-reply synthesis (`temperature: 0`) answers quickly within its 5-second cap.
- **Temperature.** Sent at `none`, and dropped with a once-per-model warning from every other request to a reasoning model.

Reasoning text an endpoint returns outside the reply — `reasoning_content` (DeepSeek, Venice, vLLM) or `reasoning` (OpenRouter), on the message or each stream delta — is not forwarded. The adapter measures it instead: the chat span carries `cogmo.llm.reasoning_chars`, stamped however the call ends, so a stream cut off mid-thought still shows how long the model had been thinking; and a reported `completion_tokens_details.reasoning_tokens` becomes `Usage.reasoningTokens`, a subset of `outputTokens`, on the span as `gen_ai.usage.reasoning.output_tokens` and in the turn's summed usage on the `agent loop complete` log line. `[confirmed]`

The Responses API keeps reasoning on tool calls but is a separate wire protocol this adapter doesn't speak. GPT-6 Astra has no `none` effort and takes tools only there, so it can't serve chat turns.

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

**`attrs`** JSONB for provider-specific config (`ProviderAttrsSchema`): `cacheDialect`, `headers`, `prefixMismatchBehavior`. `cacheDialect` (`openrouter` \| `openai` \| `xai` \| `none`) says which caching and routing hints an OpenAI-compatible endpoint takes for a cache intent. The `openrouter` provider type sets `openrouter`, and `addProvider` derives it from the base URL's host when the caller names none; absent reads as `none`, and Anthropic rows carry none. See [prompt-caching.md](prompt-caching.md) → Adapter mapping. `[confirmed]` An Anthropic row's `prefixMismatchBehavior` (`drop_block` \| `error`, `PrefixMismatchBehaviorSchema`), unset by default, goes out as `thinking.block_binding.prefix_mismatch_behavior` on messages and counts, from a first-party row only, to the models on the adapter's preserved-thinking list; a row pointing elsewhere logs a warning. Absent sends no field and keeps the account's default, and so does a value the API doesn't take, which reads as absent with a warning rather than failing the row ([prompt-caching.md](prompt-caching.md#server-side-controls-confirmed) → Server-side controls).

### Model → Provider routing

```sql
model_providers (
  id              UUID v7 PK,
  model           TEXT NOT NULL,                          -- 'claude-sonnet-4-20250514'
  provider_id     UUID NOT NULL FK → llm_providers CASCADE,
  position        INT NOT NULL,                           -- 0 = primary, 1 = fallback
  user_selectable BOOLEAN NOT NULL,                       -- true = appears in /model picker; false = internal-only (summarization, experimental)
  context_window    INT,                                  -- NULL = resolver falls back (see Limits resolution)
  max_output_tokens INT,                                  -- NULL = resolver falls back
  extra_body      JSONB,                                  -- ExtraBodySchema; NULL = the adapter's fields only
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

### Extra request body `[confirmed]`

`model_providers.extra_body` holds request fields an operator adds to every chat-completions request for the model on an OpenAI-compatible provider, streaming and not: what the endpoint takes beyond the OpenAI shape, such as a reasoning model's thinking controls (Venice's `reasoning: {enabled: false}` or `venice_parameters.disable_thinking`, vLLM's `chat_template_kwargs.enable_thinking`). The resolver builds one adapter per resolved model, so the fields reach that model's calls only. Anthropic rows carry none.

- **On the routing row.** Thinking controls differ by model on one endpoint — one provider row serves a model that turns thinking off with a flag beside one that takes an effort level — so the fields sit with the model × provider pair, like its limits. A provider-level default (a provider-wide flag such as Venice's `include_venice_system_prompt`) is not stored: nothing needs one yet, and when something does it goes in `llm_providers.attrs`, deep-merged under the row's fields.
- **The adapter's keys are reserved.** `ExtraBodySchema` (`src/llm/extra-body.ts`) refuses, when the value is written, a top-level key the adapter sets on any request: `model`, `messages`, `stream`, `stream_options`, `tools`, `tool_choice`, `response_format`, `max_tokens`, `max_completion_tokens`, `temperature`, `reasoning_effort`, `prompt_cache_key`, `session_id` and `cache_control`. An effort level goes through the endpoint's nested form where it has one (`reasoning.effort` on Venice and OpenRouter). Values are any JSON; an empty object is refused, since clearing is its own operation.
- **No merge on the wire.** With the adapter's keys refused, the row's fields and the adapter's never share a key, so the request is the row's object with the adapter's fields after it, and a nested object like `venice_parameters` goes out exactly as written. The adapter's fields come last regardless, so they win if a reserved key ever got into a row.
- **Strict on write, lenient on read.** The store checks each write against `ExtraBodySchema`; the column reads through `StoredExtraBodySchema`, which drops a reserved key written outside the store with a warning instead of failing the lookup — failing it would stop every call to the model and the `cogmo model` commands that fix the row.
- **Operator surface.** `cogmo model add <model> --provider <name> --extra-body '<json>'` sets it on a new row; `cogmo model set <model> --provider <name> --extra-body '<json>'` replaces it and `--clear-extra-body` removes it, keeping the row; `cogmo model list` shows it as a compact JSON column. Both refuse an Anthropic provider. Like every routing change, it takes effect on restart (the resolver caches per process).

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

A call whose abort signal has fired propagates its error whatever the class: the caller cancelled it, and an abort error carries no status, so it would otherwise read as transient.

Permanent errors are propagated immediately because retrying a 401 against the next provider rarely helps and burns quota — each provider has its own credential. Authentication, validation, and invalid-request errors are bugs in configuration or code, not transient infrastructure problems.

### Ordering

Every candidate in `listProvidersForModel(model)` is tried in position-ASC order (primary first, then each fallback). There is no cap on chain length — if the user has configured 5 fallbacks, all 5 can be tried. When every candidate fails transiently, the wrapper raises `AllProvidersFailedError`, which carries the ordered list of `{ provider, error }` attempts so operators can see exactly what failed.

### Streaming

Streaming fallback applies **only to pre-stream failures**. The wrapper iterates the candidate's stream with `for await` inside a try/catch — if it fails with a transient error before its first frame is forwarded, we move to the next candidate. Once a frame has been yielded to the consumer, we are committed: mid-stream errors propagate and the partial output stays in history. A consumer that stops early returns the wrapper's stream, and `for await` returns the candidate's in turn, so the candidate's request is aborted.

This rule avoids two failure modes: yielding duplicated content (the agent sees the primary's tokens then restarts on the fallback), and losing context mid-turn (a tool call emitted by the primary, then a different model continuing from where it didn't start). Pre-stream recovery is safe because nothing has been committed yet.

### Observability

- `logger.warn` per fallback transition — fields: `op`, `fromProvider`, `toProvider`, `errClass`, `errMessage`. One line per hop, easy to grep.
- `logger.error` when the chain exhausts — fields: `op`, ordered `attempts` list with provider names and error descriptions.
- `AllProvidersFailedError.attempts` carries the same list for programmatic inspection.

The wrapper does not deduplicate requests, rate-limit transitions, or track health state — it is stateless. A provider that just returned 500 will be tried again on the next turn. This is intentional for the single-user deployment: complexity that pays off at scale (circuit breakers, health checks) is noise here.

## Structured output `[confirmed]`

`ChatParams.responseFormat` asks for JSON matching a schema. A provider may enforce only part of it, so `chatTyped` (`src/llm/typed.ts`) parses the reply with a `jsonrepair` pre-pass, validates it with Zod, and retries with the validation error. A reply stopped by the output cap is re-requested once at twice the cap, held to the model's maximum output where the LiteLLM snapshot knows it, and spends no feedback retry: a higher cap is Anthropic's documented remedy for a `max_tokens` stop. A reply still cut off, one stopped by the context window (`OutputCutOffError`), or a refusal (`RefusalError`) throws before the parse: `jsonrepair` would close cut-off JSON into a value the model never finished, and a feedback turn would likely meet the same stop.

| Adapter | Request |
|-|-|
| Anthropic | Structured outputs (`output_config.format`), which constrain decoding to the schema. `src/llm/anthropic-output-schema.ts` keeps what Anthropic's JSON Schema limitations list as supported, `enum` and `const` included, closes every object and turns `oneOf` into `anyOf`; every other constraint, such as numeric and length bounds, moves into its node's description. The grammar doesn't guarantee `enum` and `const` casing, so a reply string matching exactly one member case-insensitively, and none exactly, takes that member's casing. A schema the grammar can't express, with an open object (`z.record`, as in a pipeline stage's JSON output schema), an untyped node (`z.unknown()`), a recursive `$ref` (a Zod schema nested in itself) or a tuple (`z.tuple`: the transform keeps only `items`, so a rest schema constrains every position and a plain tuple's `items: false` admits anything), takes the tool path: one synthetic tool carrying the schema and its definitions, left unforced (`tool_choice: auto`) and named in a system block, since forcing it is a 400 on Opus 5.5 and Fable 5.1. `chat` re-sends a schema past the grammar's compile limits (24 optional or 16 union-typed parameters, an internal grammar size, a costly `pattern`) once on the tool path, matching the 400 by message. A reply that makes no call (`MissingToolCallError`) spends `chatTyped`'s feedback retry on a re-ask repeating that instruction, as Anthropic advises for an unforced tool. |
| OpenAI-compatible | `response_format: { type: "json_schema" }` with the schema as given. `strict: true` only when the schema fits the subset OpenAI's strict mode takes (`src/llm/openai-output-schema.ts`): every object closed and every property required, no `oneOf`, `allOf` or untyped node, listed formats only. Otherwise `strict: false`, which takes any schema as unenforced guidance; `chatTyped` validates the reply. Pipeline compilation (an open stage-output object, `oneOf`), correction extraction (`oneOf`) and memory extraction (an optional property) fall outside the subset. |

Models that think by default (adaptive on Sonnet 5 and Sonnet 5.5, always on Opus 5.5 and Fable 5.1) think on these calls too, and the thinking counts toward `max_tokens`.

## Validation

The setup wizard validates each provider by calling `GET /v1/models` (standard across OpenAI-compatible APIs) or Anthropic's equivalent. This is free (no tokens consumed), confirms the API key works, and returns the list of available models — which the wizard uses to auto-populate `model_providers` entries.

Validation status is tracked on the **secret** (`secrets.validated_at`), not on the provider row — the credential is what gets validated, not the provider config.

## Limits resolution

Model limits (context window + max output tokens) come from a three-layer resolver in `src/llm/models.ts:resolveLimits(model, rowLimits)`. Layers, in priority order:

1. **DB row override.** `model_providers.context_window` and `model_providers.max_output_tokens` (nullable). Set by the setup wizard or `cogmo model add` when an operator wants to pin explicit limits. Layered per-column: a row that sets only `max_output_tokens` still falls through to the next layer for `context_window`.
2. **LiteLLM catalog.** LiteLLM's community registry pruned to the two fields we consume (`src/llm/litellm-upstream.ts`), ~3,200 models. It has two copies, consulted in order:
   - **Live.** The `model-catalog-refresh` Inngest function (`src/agent/model-catalog/`) fetches the registry every six hours and on `model-catalog/refresh.requested`, which `cogmo model refresh` sends. It stores the result as the one `model_catalogs` row and installs it in the process that ran the refresh; `cogmo serve` loads the stored row at boot, before its channels start, and `cogmo model list` / `add` load it before reporting limits. A model that ships between releases therefore resolves at the next refresh. A failed fetch retries three times. A registry that isn't a JSON object, or that prunes to under half the bundled snapshot's entries, is rejected without retrying, and the stored catalog stays. `MODEL_CATALOG_URL` points the fetch at an http(s) mirror, or `off` disables both the refresh and the boot-time load. Values apply as upstream publishes them; a limit pinned on the routing row still wins.
   - **Bundled.** `data/litellm-models.json`, regenerated with `pnpm tsx scripts/refresh-litellm-models.ts` and shipped with each release. It answers before the first refresh, when the refresh is off, and for ids the live copy lacks (retired or dropped upstream).

   The loader (`src/llm/litellm-data.ts`) normalizes lookup keys through a small alias ladder — `x-ai/grok-4.3` finds `xai/grok-4.3`, `openrouter/<x>` strips the prefix, etc. — so OpenRouter slugs resolve against vendor-direct entries. The whole ladder runs against the live copy before the bundled one, so a live entry under any alias beats a bundled one.
3. **Conservative default.** 128k context / 4k max output, with a one-time `WARN` log per unknown model. Compaction errs on the side of firing too early rather than overrunning the upstream's real limit.

`resolveLimits` never throws — unknown models silently fall to the default. `getModelLimits` no longer exists; callers receive limits as a `ResolvedLlm` from `LlmProviderResolver` (the resolver loads `model_providers` once per turn and surfaces the primary row's columns alongside the adapter).

`cogmo model list` prints each routing row's effective limits with the source (`db`/`litellm`/`default`), so operators can see why compaction behaves the way it does. On stderr, it says whether `litellm` read a live catalog and when that catalog was fetched, or that the refresh is off.

## Ecosystem context

The routing table pattern follows **LiteLLM** (`model_list` with provider-prefixed model strings and priority), **OpenRouter** (request-time `provider.order` for the same model across upstream providers), and **Dify** (separate `provider_models` table per tenant). Cogmo's schema is the minimal single-user variant — one `model_providers` table with position-based ordering replaces LiteLLM's YAML config and Dify's 7-table schema.
