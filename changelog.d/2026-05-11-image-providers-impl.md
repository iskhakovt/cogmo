Image generation gets the user-configurable runtime to match the schema landed in PR #220.

`createImageTools` is rewritten to consume `{ models, providers, attachments }` loaded at bootstrap from `image_models` + `image_providers`. The Zod `model` enum and the per-model description block in the tool prose are now built from `image_models WHERE user_selectable = true` — no more hardcoded `MODEL_CATALOG`. When zero models are configured, the tool is not registered at all (no "configured-but-unavailable" middle state).

`buildImageProvider` (new — `src/llm/image-providers.ts`) dispatches on `image_provider_type` to construct either `@ai-sdk/fal`'s `createFal` or `@ai-sdk/openai-compatible`'s `createOpenAICompatible`, decrypting the row's secret via `SecretsStore.getSecretById`. Returns a `{ kind: "fal" | "oai", provider, row }` discriminated union the handler narrows over.

`ensureFalImageDefaults` (new — `src/setup/seed.ts`) idempotently seeds the canonical fal model catalog (~9 models, same set as the legacy `MODEL_CATALOG`) when a `fal_api_key` secret exists. Materializes `env.FAL_API_KEY` into a secret first if needed — preserves the dev-convenience env-var path. Re-running preserves operator edits via `ON CONFLICT (name) DO NOTHING`.

Bootstrap (`src/index.ts`) replaces the eager `createFal({ apiKey: core.falKey })` block with: call the seed, load image providers, build adapter map, load user-selectable models joined with their provider, hand to `createImageTools`. The `core.falKey` surface is gone — the secret is now read by the seed and by `buildImageProvider` directly.

Two new CLI surfaces mirror the existing `cogmo provider` / `cogmo model` shape:

- `cogmo image-provider {add,list,remove}` — manages `image_providers` rows. `add fal <name> <api-key>` and `add openai_compatible <name> <api-key> <base-url>` are the canonical forms. URL hygiene rejected at the store boundary as `InvalidProviderConfigError` (https only, no trailing slash, parseable URL) on top of the DB-level CHECK that pins `openai_compatible ↔ NOT NULL`, `fal ↔ NULL`.
- `cogmo image-model {add,list,remove}` — manages `image_models` rows. `--ratios 1:1,16:9` parses into `capabilities.aspectRatios`, `--seed` flips `capabilities.seed = true`, `--no-selectable` stages experimental rows hidden from the LLM.

`buildProvider` in the LLM resolver (`src/llm/resolver.ts`) now has an exhaustive switch — the legacy `default: throw new ProviderConfigError("Unknown provider type: …")` branch is gone now that `llm_providers.type` is a `pgEnum`. Adding a new value is a compile-time error rather than a runtime branch. Store return types tighten from `type: string` to `type: LlmProviderTypeValue` correspondingly.

New unit and store tests cover all of the above (CHECK accept/reject, UNIQUE → typed errors, ON DELETE CASCADE, `upsertImageModelsByName` idempotence, `userSelectableOnly` filter, the seed's three behaviours — skip / materialize-from-env / preserve-edits, `buildImageProvider` branch dispatch with secret-missing failure, `createImageTools` empty-catalog / per-model narrowing / `provider.image()` vs `.imageModel()` routing).

A recorded-fixture integration test (`src/test/openai-image-gen.integration.test.ts`) pins the openai_compatible image branch against an actual recorded OpenAI `gpt-image-1` response. Routes through the shared llmock (which supports `/v1/images/generations` natively) — no new mock infrastructure. Record once locally via `RECORD=1 OPENAI_API_KEY=sk-... pnpm test:integration src/test/openai-image-gen.integration.test.ts`; CI replays.

`@ai-sdk/openai-compatible@^2.0.47` added as a runtime dep — verified at install time that the pinned version exposes `.imageModel()`.
