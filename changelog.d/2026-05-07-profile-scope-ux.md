### `/profile scope` — text-spec picker for memory ACL

The operator can now declare a profile's `memoryScope` (compartment + trust ACL filter on recall) from Telegram without dropping into psql. The infrastructure for compartment + trust tag emission and the `tag_groups` filter on recall already shipped; this opens up the UX.

`/profile scope <name>` shows the current scope; `/profile scope <name> clear` removes it (back to unrestricted recall); `/profile scope <name> compartments=work,technical trust=first-party` sets it. Both keys are required when setting and accept comma-separated lists; order doesn't matter. Validation runs through `ProfileMemoryScopeSchema` so unknown enum values, empty arrays, and missing keys all surface concrete errors. Profile names with spaces are addressable — the dispatcher walks tokens from the tail collecting scope-shape atoms (`clear` literal or `<key>=<value>`), the prefix joins as the name. Caveat: profiles literally named `clear` or with `=` in the name can't be addressed by `/profile scope` and need renaming via `/profile edit`.

Picked text-spec over inline-keyboard multi-select. Telegram's keyboard surface needs an FSM with editMessageReplyMarkup callback handling for toggleable buttons — that's ~150 LOC. Text-spec lands in ~50 LOC, parses into the same Zod schema the API uses, and is scriptable. The `/profile new` and `/profile edit` dialogs stay 3-step (prompt → model → confirm) — most profiles want unrestricted recall (the default `null`), so loading scope into every creation flow would bloat the common path.

`/profile list` now annotates scoped profiles inline using the same `formatScope` helper as the show reply: `• personal (you, claude-sonnet-4-6) [compartments: work, technical / trust: first-party]`. Unscoped profiles render unchanged. Single source of truth so the two views can't drift.

`ProfileInput` (Transport surface) gained an optional `memoryScope?: ProfileMemoryScope | null`. The store layer already supported it; only the Transport pass-through and Telegram commands needed wiring. Org profiles reject scope changes via the existing `access_denied` read-only guard.
