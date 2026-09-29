**Model limits refresh without a release.** A new model's context window and output limit used to arrive only when someone regenerated `data/litellm-models.json` and shipped a release. Until then, a profile on the new model fell back to 128k/4k and compacted early. Cogmo now keeps a live copy of LiteLLM's registry in the new `model_catalogs` table.

- **Every six hours** (`17 */6 * * *`), the `model-catalog-refresh` Inngest function fetches the registry, prunes it the way the bundled snapshot is pruned, stores it, and installs it in the running process. It logs how many models the catalog holds and which ids are new.
- **On demand**, `cogmo model refresh` sends `model-catalog/refresh.requested` for a model that shipped since the last tick.
- **At boot**, `cogmo serve` loads the stored catalog before its channels start, and `cogmo model list` and `add` load it before reporting limits. With `MODEL_CATALOG_URL=off` nothing loads, so an old row can't outlive the setting.

The resolver tries the live copy first, then the bundled snapshot, then the 128k/4k default. The whole alias ladder runs against the live copy before the bundled one. `cogmo model list` now writes a line to stderr saying whether a live catalog is installed and when it was fetched, or that the refresh is off.

Chat and stage turns freeze the resolved limits in a new `freeze-model-limits` step. Otherwise a refresh landing between two invocations of one turn could change the budget, and with it which compaction steps the turn plans. A run in flight across the deploy carries the same one-attempt `step-not-found` residual as the earlier freeze steps (design/crash-recovery.md).

A failed fetch retries three times. A registry that isn't a JSON object, or that prunes to under half the bundled snapshot's entries, fails without retrying and leaves the stored catalog in place. Any id the live copy lacks still resolves from the bundled snapshot.

A stored row that stops parsing after a schema change is skipped at boot with a warning. The next refresh replaces it, because computing the new ids reads only the old row's keys.

Values are applied as upstream publishes them, so an upstream error reaches installs at the next refresh rather than through a reviewed snapshot diff. A limit pinned on the routing row (`cogmo model add --context/--max-output`) still wins.

Pruning skips entries whose limits aren't positive integers (moderation endpoints report an output limit of 0), which drops two `omni-moderation` entries from the bundled snapshot (3,180 entries).

`MODEL_CATALOG_URL` (default: LiteLLM's file on `raw.githubusercontent.com`) points the fetch at an http(s) mirror, and refuses one with embedded credentials; `off` disables it. Errors name the URL without its query string. The integration and e2e tiers set `off`, because the Inngest dev server fires crons on schedule. The pruning moved from `scripts/refresh-litellm-models.ts` into `src/llm/litellm-upstream.ts`, shared with the refresh. `design/context-management.md`'s Model Registry section, which still said an unknown model fails, now describes the resolver.
