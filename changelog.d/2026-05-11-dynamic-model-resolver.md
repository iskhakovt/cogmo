Stop hardcoding model context limits — let operators bring any model id without code changes.

**What changes for operators.** `MODEL_REGISTRY` (the closed allowlist in `src/llm/models.ts`) is deleted. Models with unknown ids no longer throw on resolve — the new layered resolver always returns *something*, in priority order:

1. **DB row override** on `model_providers.context_window` / `max_output_tokens` (both new, nullable). Set via the wizard's new model picker or `cogmo model add --context N --max-output N`.
2. **Bundled LiteLLM snapshot** — `data/litellm-models.json` (~2,200 models, pruned to just the two fields we consume). Refresh manually via `pnpm tsx scripts/refresh-litellm-models.ts`. Lookup normalizes `x-ai/` → `xai/`, strips `openrouter/` prefixes, etc., so OpenRouter slugs resolve against vendor-direct entries.
3. **Conservative default** — 128k context / 4k max output with a one-time `WARN` log per unknown model. Compaction errs on the side of firing too early.

`cogmo model list` shows each row's effective limits and source (`db`/`litellm`/`default`) so operators can debug "why is compaction so aggressive on this model."

**Setup wizard gains a model picker step.** After validating the provider key, the wizard fetches `<base>/v1/models` and shows a searchable `autocomplete` picker over the returned ids. OpenRouter responses include inline `context_length` / `max_completion_tokens` that flow straight into the row override; other providers return ids only, and the resolver layers limits at request time via LiteLLM. Custom endpoints that don't expose `/v1/models` fall back to free-form text input. External-API failures prompt `retry / skip / abort`. Loops so a single wizard pass can wire up multiple models on the same provider (e.g. Sonnet + Haiku on one Anthropic key).

**New CLI: `cogmo provider` and `cogmo model`.** Operator workflows that previously required psql:

- `cogmo provider add|list|remove` — register/list/remove `llm_providers` rows. `add` validates the key the same way the wizard does.
- `cogmo model add|list|remove` — manage `model_providers` rows. `add` accepts optional `--context` / `--max-output` overrides; `list` surfaces the resolved limits + source.

Both surfaces share their domain functions with the wizard (`src/agent/provider/add-provider.ts`, `add-model-routing.ts`) — no duplicated business logic between interactive and non-interactive paths.

**Non-interactive setup gains three env vars** (all optional): `COGMO_LLM_MODEL` (defaults to the seeded profile's `model`), `COGMO_LLM_CONTEXT_WINDOW`, `COGMO_LLM_MAX_OUTPUT_TOKENS`.

**Resolver wiring.** `LlmProviderResolver` now returns `{ provider, limits }` so the caller gets the row override columns in the same memoized DB read that built the adapter chain. `computeBudget` takes resolved `ModelLimits` directly; the `/status` endpoint elides `contextBudget` when the resolver fell back to the conservative default, so the UI doesn't display a guess as fact.

**Schema migration** is additive (two nullable `integer` columns on `model_providers`); existing installs keep working without backfill.
