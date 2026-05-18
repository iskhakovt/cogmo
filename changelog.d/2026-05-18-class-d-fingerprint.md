Class D loop-pathology detection: each streaming-loop iteration now produces a
fingerprint over its `(tool_name, canonical-json(args))` tuples (sorted, so
parallel-tool emission order doesn't move the hash; text excluded, so hedging
preambles don't either). The loop tracks side-effect-free occurrences against
two layered triggers — three consecutive identical fingerprints (`stuck_loop`)
or five total occurrences regardless of consecutiveness (`stuck_loop_cumulative`,
catching alternating `A, B, A, B, A` patterns). Either trip exits through the
existing degraded off-ramp from PR #263: same `buildDegradedResult` helper,
same `conversation/degraded` event with the new subtype, same user-facing
apology. `agent.degrade` telemetry on `turnLogger` carries
`subtype` + `consecutiveCount` + `cumulativeCount` so the failure-reflector
can bucket. The side-effect gate honors `ToolSpec.sideEffectful ?? true`
(fail-safe — unknown / handler-errored / explicitly-side-effectful tool calls
keep the loop alive); errored tool calls (Zod rejections, handler throws)
contribute no side effect, which is the design's "free upside" — runaway
identical-malformed-args sequences now trip Class D rather than burning to the
iteration cap. Also: `ClassCSubtype` → `RepairSubtype` rename across
`repair.ts` + `loop.ts` + tests; loop test titles that referenced bare
"Class A/C" taxonomy labels switched to self-descriptive phrasing. See
`design/agent-resilience.md` → Class D.
