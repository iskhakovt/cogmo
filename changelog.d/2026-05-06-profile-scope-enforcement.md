Profile-level scope enforcement — every recall and reflect now respects the calling profile's `memory_scope`. The infrastructure planned in PR #146 (compartment + trust tag emission, single-classifier path, `attachProfileTags` filter hook) becomes load-bearing: profiles can be configured to see only certain compartments / trust tiers, and Hindsight's `tag_groups` filter does the enforcement at the query boundary.

`profiles.memory_scope` JSONB column added (migration `0022_abnormal_chameleon.sql`), validated at the store boundary by `ProfileMemoryScopeSchema = { compartments: NonEmpty<MemoryCompartment>, trust: NonEmpty<MemoryTrust> }`. Null = no restriction (the default for every existing profile, behavior identical to before this PR). When set, both arrays must be non-empty — a profile that allows zero compartments or zero trust tiers can recall nothing, which is almost certainly a configuration mistake; the Zod schema rejects the row at the store boundary.

`Service.createService` swaps its third positional from `profileTags: readonly string[]` to `memoryScope: ProfileMemoryScope | null`. The new `attachScopeFilter` helper builds a `tag_groups` AND-of-ORs:

```
{ and: [
    { tags: ["compartment:work", "compartment:technical"], match: "any_strict" },
    { tags: ["trust:first-party"], match: "any_strict" },
    // caller-supplied tags / tagGroups appended here
] }
```

`any_strict` excludes untagged memories — important after the migration script ran every existing memory through the Observer classifier so all rows carry `compartment:*` and `trust:*` tags. Caller-supplied `tags`/`tagsMatch`/`tagGroups` (e.g. from `memory_reflect`) compose into the same AND group as additional leaves. Retain is intentionally not scoped — writes go to Hindsight as-is and tagging happens at extraction time. Auto-recall in `handle-message` was hoisted above the service-construction block so it goes through `service.memory.recall` rather than the raw provider, ensuring the filter applies to every recall path.

`MemoryProvider.RecallOptions` and `ReflectOptions` grow `tagGroups?: TagGroup[]`, mirroring Hindsight's compound-filter shape (`TagGroupLeaf | TagGroupAnd | TagGroupOr | TagGroupNot`). The Hindsight adapter switches recall + reflect from the class wrapper (`HindsightClient.recall(bankId, query, options)`) to the sdk_gen functions (`sdk.recallMemories({ client, path, body })`) because the class options object doesn't expose `tag_groups` — only the raw `RecallRequest` body does. Retain + retainBatch stay on the class wrapper. 4xx detection now reads `res.error` + `res.response.status` rather than catching a `HindsightError`; same `AbortError` retry semantics.

CLAUDE.md gains an architecture rule on `pgEnum` — already shipped in #146, citing `pending_memory_source`; this PR's compartment + trust enums stay as Zod-only for now since they're stored inside JSONB rather than as columns.

Updates `design/memory.md`: "Memory Access Control via Tags" flips `[proposed]` → `[confirmed]`, with the actual `profiles.memory_scope` shape and `Service`-level enforcement documented. Notes UX-for-declaring-scope (Telegram `/profile` picker) as the deferred follow-up.

Tests: store round-trips for `memoryScope` create/update/null/clear plus a Zod-rejection test for empty compartments. Service tests cover scope-null passthrough, scope-set tagGroups construction, caller-tag merging, retain bypassing the filter. Hindsight provider tests rewritten against the sdk_gen mock surface (request body shape, 4xx no-retry, 5xx + 429 retry, query truncation) with new coverage for `tagGroups` passthrough.
