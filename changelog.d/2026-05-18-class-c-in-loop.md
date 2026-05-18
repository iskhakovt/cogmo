In-loop Class C repair: the streaming agent loop now classifies empty `end_turn`,
truncated tool-arg JSON (`ProviderProtocolError`), and explicit refusals
(`stop_reason: "refusal"` / `RefusalError`) and routes each through a
per-subtype repair budget — one continuation-prompt retry for empty turns, one
non-streaming replay for stream truncations, immediate degrade for refusals.
On budget exhaustion or backstop (iteration cap), the orchestrator posts a
user-facing apology, persists it as the final assistant message, and emits a
new `conversation/degraded` event via `step.sendEvent` right after the
durable persist step (mirroring `conversation/errored`).
Conversation status stays `active`; synthetic continuation prompts and the
failing iteration's content are excluded from persistence. Telemetry rides on
`turnLogger` as structured `agent.repair` / `agent.degrade` log lines so the
evolution failure-reflector can join by `runId` + `conversationId`. See
`design/agent-resilience.md` → Class C.
