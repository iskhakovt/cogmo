Class D volume-cluster trigger: per-tool invocation budget that intercepts
the `(B+1)`-th `tool_use` block for a tool whose `invocationBudget` is
exhausted within a single `runStreamingAgentLoop` invocation. The
synthetic `is_error: true` `tool_result` carries the intercepted
`tool_use`'s id (Anthropic pairing) and an outcome-aware nudge — all-fail
("every attempt failed, change strategy"), mixed ("K of N produced
results, decide from what you have"), all-success ("you have N results,
synthesize and reply"). The trigger is a *repair*, not a degrade: the
loop continues, the model receives the nudge, and if it ignores it and
emits identical args the existing fingerprint catches the repeat
(cluster → fingerprint → degrade staircase). Counter is **derived** from
the iteration's accumulated message array on each scan, not held in a
closure variable — Inngest function replay re-executes closures from the
top, so a stored counter would silently reset mid-turn; deriving from
the message array always reflects the actual current state regardless of
replay topology. Counter persists across mixed-outcome sequences within
a turn (volume cap, not failure cap: successes dilute attention the same
as failures); resets at turn boundary. Per-tool budgets land on
`ToolSpec.invocationBudget?` with `DEFAULT_INVOCATION_BUDGET = 5`; tools
overriding the default today: `generate_image` (2), `memory_recall` (3),
`read_file` (10), `list_files` (10). New `RepairSubtype` variant
`"volume_cluster"` and a narrower `DegradeSubtype = Exclude<RepairSubtype,
"volume_cluster">` keep the `conversation/degraded` event schema and the
`AgentLoopResult.degraded.subtype` aligned to what actually lands on the
degrade boundary. Telemetry: `agent.repair` with `subtype:
"volume_cluster"`, `tool`, `count`, `budget`, `outcomeMix`. See
`design/agent-resilience.md` → Volume cluster trigger.
