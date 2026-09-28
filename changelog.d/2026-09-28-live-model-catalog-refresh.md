**Model limits refresh without a release.** A new model's context window and output limit used to arrive only when someone regenerated `data/litellm-models.json` and shipped a release. Until then, a profile on the new model fell back to 128k/4k and compacted early. Cogmo now keeps a live copy of LiteLLM's registry in the new `model_catalogs` table.

- **Every six hours** (`17 */6 * * *`), the `model-catalog-refresh` Inngest function fetches the registry, prunes it the way the bundled snapshot is pruned, stores it, and installs it in the running process. It logs how many models the catalog holds and which ids are new.
- **On demand**, `cogmo model refresh` sends `model-catalog/refresh.requested` for a model that shipped since the last tick.
- **At boot**, every process, including each `cogmo` CLI command, loads the stored catalog.

The resolver tries the live copy first, then the bundled snapshot, then the 128k/4k default. The whole alias ladder runs against the live copy before the bundled one. `cogmo model list` now ends with a line saying whether a live catalog is installed and when it was fetched.

The refresh never makes limits worse than the bundled snapshot. A failed fetch retries three times. A registry that isn't a JSON object, or that prunes to under half the bundled snapshot's entries, fails without retrying and leaves the stored catalog in place. Any id the live copy lacks still resolves from the bundled snapshot. A stored row that stops parsing after a schema change is skipped at boot with a warning.

`MODEL_CATALOG_URL` (default: LiteLLM's file on `raw.githubusercontent.com`) points the fetch at a mirror; `off` disables it. The integration and e2e tiers set `off`, because the Inngest dev server fires crons on schedule. The pruning moved from `scripts/refresh-litellm-models.ts` into `src/llm/litellm-upstream.ts`. It is shared with the refresh and produces a byte-identical snapshot. `design/context-management.md`'s Model Registry section, which still said an unknown model fails, now describes the resolver.
