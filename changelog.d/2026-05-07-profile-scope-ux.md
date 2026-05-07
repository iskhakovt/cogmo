### `/profile scope` — text-spec picker for memory ACL

Slice 3 of the memory privacy work: the operator can now declare a profile's `memoryScope` (compartment + trust ACL filter on recall) from Telegram without dropping into psql. PR #146 added the tags, PR #148 wired the filter into recall/reflect; this PR opens up the UX.

`/profile scope <name>` shows the current scope; `/profile scope <name> clear` removes it (back to unrestricted recall); `/profile scope <name> compartments=work,technical trust=first-party` sets it. Both keys are required when setting and accept comma-separated lists; order doesn't matter. Validation runs through `ProfileMemoryScopeSchema` so unknown enum values, empty arrays, and missing keys all surface concrete errors.

Picked text-spec over inline-keyboard multi-select. Telegram's keyboard surface needs an FSM with editMessageReplyMarkup callback handling for toggleable buttons — that's ~150 LOC and PR #148 explicitly deferred "fiddly multi-select keyboards." Text-spec lands in ~50 LOC, parses into the same Zod schema the API uses, and is scriptable. The `/profile new` and `/profile edit` dialogs stay 3-step (prompt → model → confirm) — most profiles want unrestricted recall (the default `null`), so loading scope into every creation flow would bloat the common path.

`/profile list` now annotates scoped profiles inline: `• personal (you, claude-sonnet-4-6) [scope: work,technical / first-party]`. Unscoped profiles render unchanged.

`ProfileInput` (Transport surface) gained an optional `memoryScope?: ProfileMemoryScope | null`. The store layer already supported it from PR #148; only the Transport pass-through and Telegram commands needed wiring. Org profiles still reject scope changes via `access_denied` (Transport's existing read-only guard), surfaced as "Access denied — org profiles are read-only via Transport".
