Auto-repair cooldown telemetry — the final slice of
[`design/agent-resilience.md` → Auto-repair](design/agent-resilience.md).
Two durable Inngest events fire on every cooldown transition so the
evolution failure-reflector and future alerting / metrics sinks can
observe state changes without polling.

`conversation/cooldown/entered` fires from `recover-conversation` after
the durable cooldown write. Payload:
`{ conversationId, runId, lastErroredAt, cooldownSeconds, consecutiveFailures, causeClass }`.
`causeClass: "A" | "B" | "invariant" | "bug"` is derived from the
inbound `conversation/errored.errorClass` via `deriveCauseClass`:
`"NonRetriableError" → "B"` (provider-permanent),
`"WorkerDeath" → "A"` (worker-disconnect via the reconcile path), else
`"bug"` (residual bucket — refine when a typed `HistoryInvariantError`
lands and/or retriable-class names need precise `"A"` mapping). Bus
dedup via `id: "cooldown-entered-${runId}"`.

`conversation/cooldown/cleared` fires from every clear-trigger site
AFTER the tx commits (in-tx emit would risk phantom events on
rollback). Payload:
`{ conversationId, clearedBy, elapsedCooldownSeconds }` with
`clearedBy: "success" | "model_switch" | "profile_switch" | "user_repair" | "secrets_rotated"`.
`secrets_rotated` is reserved for the deferred `/secrets rotate`
trigger so future subscribers don't need a schema change when that
command ships.

Sites:
- `handle-message` half-open-success — `step.sendEvent` after the
  persist step, only when the entry guard saw prior cooldown_state.
- `transport.conversations.repair` — `inngest.send` after the tx,
  only when a clear actually happened (`priorState !== null`).
- `transport.conversations.setProfile` — same shape, `clearedBy: "profile_switch"`.
- `transport.profiles.update` w/ `clearCooldownForConversation` —
  same shape, `clearedBy: "model_switch"`. UniqueViolation rollback
  path correctly suppresses the emit (no phantom event when the clear
  was rolled back).

`elapsedCooldownSeconds` is `now() - lastErroredAt`. Can be less than
the prior `cooldownSeconds` (clear mid-window via `/repair` or context
switch) OR greater (half-open success — probe ran after the window
elapsed). Subscribers compare against the prior `entered` event's
`cooldownSeconds` to discriminate.

Design markers in `design/agent-resilience.md`:
- `## Auto-repair` (overall section header) — `[proposed]` → `[confirmed]`
- `### Telemetry` — `[proposed]` → `[confirmed]`
- `### Where this composes` — `[proposed]` → `[confirmed]`
- `### Non-goals` — `[proposed]` → `[confirmed]`

Auto-repair design fully shipped end-to-end. Remaining work is the
explicit `[proposed]` deferred-follow-ups list (per-conversation
repair budget, repair-attempts column, per-provider rate counters,
OpenAI-compat refusal decoder, telemetry-driven degrade→cooldown
escalation) — all gated on real-traffic telemetry signals.
