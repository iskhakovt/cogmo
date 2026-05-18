Evolution audit log + manual trigger. Every processed Observer fire now writes
one append-only row to a new `evolution_events` table — Zod-validated JSONB
payload (`ObserverResult` shape plus `messageCount` + `profileId`), denormalised
`user_id` for the digest-path index, and `triggered_by ∈ {idle, manual}` to
distinguish autonomous fires from `/reflect`. Two new Telegram commands sit on
top: `/learned` lists the 10 most recent events with rule/memory deltas per row
(`/learned <id>` for a full detail view — corrections breakdown, consolidation
counts, memory networks, pending drain); `/reflect` runs the Observer
synchronously for the current conversation and replies with a one-line digest
plus a `/learned <id>` breadcrumb to the persisted row. The autonomous idle
path keeps the full Inngest pipeline (concurrency limit, retry budget,
memoisation) — manual trigger goes through a no-op step harness that just
calls the Observer's closures, since single-user scale makes "immediate reply
in the chat" beat "queue and check later" for an explicitly debug-shaped
command. Industry validation in `design/decisions.md` (ChatGPT memory pill,
Claude Code `/dream`, DGM version archive, Zep provenance, ACE Curator
deltas); inline notification pill / undo / per-rule revert deliberately
deferred until the digest UX proves itself in real use — see
`design/evolution.md` → Audit Log & Manual Trigger.
