Context-management Strategy 0: count-based same-tool supersession
compaction. Runs unconditionally at the top of the compaction pipeline,
before the budget-pressure-triggered Strategies 1–3, with three
parameters: `retainRecent` (default 2), `retainFirst` (default 1,
sticky), `triggerCount` (default 5 = `retainRecent + retainFirst + 2`
so first fire compacts 2 results).

For each tool whose `tool_result` blocks in the slice reach
`triggerCount`, the middle results (between the first and the last
`retainRecent`) get their content replaced with a single summary
string of the form `[Same-tool cluster: N prior \`T\` results
compacted — calls: <arg shapes>. Latest 2 verbatim below.]`. Arg
shapes are pulled from the paired `tool_use.input` via an id-to-name
index, so previously-compacted blocks still contribute the original
call's args to the new summary on subsequent passes. Pair-aware —
`tool_use` blocks are left intact; only `tool_result.content` is
mutated. Anthropic's pairing invariant holds by construction.

**Sticky first slot:** the earliest-positioned `tool_result` for each
tool is preserved verbatim across all subsequent passes. The strategy
never re-evaluates which result counts as "first" — the original
message-array position is the anchor. Cache-prefix consequence: the
prefix up to and including the first sticky result (plus its
`tool_use` pair) stays byte-identical across compactions, so
Anthropic's prompt cache keeps its hit on that span. The summary
block past the first slot is rewritten on each fire, invalidating
cache past that position — accepted trade-off because the
high-attention prefix slot is preserved.

**Pipeline integration:** runs every turn as an O(N) scan; the
mutation only fires when a per-tool cluster has reached `triggerCount`,
so most turns are no-ops. The transform never increases token count,
so the subsequent budget-pressure thresholds (Strategies 1–3) still
compare against a clean count.

**Telemetry:** new fields on `CompactionEvent` — `sameToolClustersCompacted`
(number of distinct tools whose cluster tripped this turn) and
`sameToolResultsSuperseded` (total results replaced with summary
content). The `strategies` array gains a new variant
`"compact_same_tool_clusters"` ordered first.

Tests cover: trigger fires only at `triggerCount`, retainRecent
results stay verbatim, first-per-series remains the *original* first
across multiple compactions (stickiness invariant), pair invariant
preserved, cache-prefix up to and including the first sticky result
is byte-identical across compactions, summary content is
deterministic, per-tool independence, orphaned tool_results (no
matching tool_use) are skipped gracefully, plus integration tests
through `compactMessages` itself.

Design marker `design/context-management.md` → Strategy 0 promoted
from `[proposed]` to `[confirmed]`; top-level doc marker also
promoted now that all four strategies are implemented.
