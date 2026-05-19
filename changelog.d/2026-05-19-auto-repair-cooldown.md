Auto-repair cooldown — `handle-message`'s entry guard now derives "is
this conversation stuck?" from `conversations.cooldown_state` (JSONB
`{ lastErroredAt, cooldownSeconds, consecutiveFailures }`, validated via
`jsonbZod` at the store boundary) instead of a binary
`conversation_status` enum. While the cooldown window is open the
guard returns `{ status: "skipped", reason: "cooldown" }`, delivers a
terse hand-built reply with a coarse retry-time estimate (no LLM
invocation), and leaves inbounds unbatched so the next probe turn loads
the backlog as one batch. Once `now() >= lastErroredAt + cooldownSeconds`
the cooldown becomes implicit-half-open: the next inbound runs
`handle-message` normally and either clears `cooldown_state` on success
or re-arms it through `recover-conversation` on failure.

`recover-conversation` no longer writes a binary `status='errored'`; it
reads the prior `cooldown_state`, feeds it to `nextCooldownState` (60s
base → 2× per consecutive failure → 1h cap), and writes the new blob
inside `runInTx` (REPEATABLE READ snapshot prevents the lost-update
race if `conversation/errored` bus dedup were ever bypassed). A
successful turn started from cooling-down state clears `cooldown_state`
in the same transaction that persists the assistant reply (no per-turn
write on Closed-state conversations).

`/repair` keeps its user-facing contract — "this conversation is stuck,
let it try again" — but now `transport.conversations.repair` calls
`agentStore.clearCooldown` instead of flipping a status enum.
`{ wasErrored }` becomes `{ wasCoolingDown }` to match the new
predicate. `/status` derives the conversation status line from
`cooldown_state` (showing remaining time when Open, or
"awaiting probe" when the window has elapsed but no inbound has yet
landed).

Schema: the `conversation_status` pgEnum and `conversations.status`
column are dropped (single-value enums after auto-repair lands — pure
noise); `cooldown_state` is added as a nullable JSONB column.
Migrations `0039_drop_conversation_status.sql` and
`0040_add_cooldown_state.sql`. **Migration story:** any conversation
sitting at `status='errored'` at upgrade time becomes implicitly clear
(`cooldown_state IS NULL`) — the migration drops the column without
seeding `cooldown_state`, so a previously-stuck conversation will
accept the next inbound and run a full turn. Re-run `/repair` if
behavior surprises you; at single-user scale this is the right
trade-off vs. backfilling a synthetic cooldown blob. Tests: `cooldown.test.ts` pins the curve
+ predicates + retry-time formatter; `recover-conversation.test.ts`,
`handle-message.test.ts`, `transport.test.ts`, and `store.test.ts`
cover the new write paths, the cooldown / half-open / closed entry-guard
states, and the half-open-success-clears-cooldown invariant. See
`design/agent-resilience.md` → Auto-repair.
