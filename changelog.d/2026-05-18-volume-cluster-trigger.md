Class D volume-cluster trigger: per-tool **batch** budget that intercepts
the model's whole same-tool batch when prior-iteration count for that
tool exceeds `ToolSpec.invocationBudget`. One iteration that emits any
number of `tool_use` blocks for tool `T` counts as one batch — the
trigger targets the across-iteration *decision pattern* (model
re-deciding to call `T`, the stuck-loop signature), not within-iteration
parallelism. A user asking "generate 10 images" producing one iteration
with 10 parallel `tool_use` blocks → one batch, admitted; ten sequential
iterations → ten batches, intercepted at the budget. Per-block counting
would conflate user-explicit batches with stuck loops; per-iteration
counting keeps the trigger surgical.

When a batch trips: every `tool_use` block in the iteration that targets
the over-budget tool is replaced with a synthetic `is_error: true`
`tool_result` carrying that block's `id` (Anthropic pairing). The
handlers never run. The nudge text branches on outcome mix (all-fail,
mixed, all-success) and forbids further calls to `T` this turn. The
trigger is a repair, not a degrade: the loop continues with the model's
next response; if it ignores the nudge and emits identical args, the
existing fingerprint catches the repeat and degrades on `stuck_loop`.
Cluster → fingerprint → degrade is the staircase.

Counter is **derived** from the iteration's accumulated message array
(scan-once per check, no closure state) — Inngest function replay
re-executes everything outside `step.run` from the top, so a stored
counter would silently reset mid-turn. Persists across mixed-outcome
sequences within a turn (volume cap, not failure cap — successes dilute
attention the same as failures); resets at turn boundary.

Per-tool budgets land on `ToolSpec.invocationBudget?` with
`DEFAULT_INVOCATION_BUDGET = 5`. Tools overriding the default today:
`generate_image` (2), `memory_recall` (3), `read_file` (10), `list_files`
(10). Budgets cap iterations, not individual calls — an admitted batch
can contain arbitrarily many parallel blocks. Per-call cost ceilings
belong elsewhere; the trigger's job is loop-pathology detection.
`defineTool` rejects non-positive-integer budgets at registration time
so a typo can't ship a tool that's effectively disabled. Both the
streaming and non-streaming agent-loop variants apply the trigger
(`runStreamingAgentLoop` and `runAgentLoop` use the same
`computeVolumeClusterInterceptions` pre-pass).

New `RepairSubtype` variant `"volume_cluster"` and a narrower
`DegradeSubtype = Exclude<RepairSubtype, "volume_cluster">` keep the
`conversation/degraded` event schema and the
`AgentLoopResult.degraded.subtype` aligned to what actually lands on the
degrade boundary. Telemetry: `agent.repair` with `subtype:
"volume_cluster"`, `tool`, `batchCount` (the count compared to budget),
`callCount` (total `tool_use` blocks the model emitted — what the nudge
text shows), `blocksInBatch` (1 for sequential intercepts, N for
parallel-batch intercepts), `budget`, `outcomeMix`. One emission per
intercepted batch, not per blocked block. See
`design/agent-resilience.md` → Volume cluster trigger.
