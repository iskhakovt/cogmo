### The metric poll in `pipeline.integration.test.ts` accumulates across collects

`collectMetricsWhen` keeps the first sighting of each required metric and returns once all of them have been seen, rather than demanding they appear together in one snapshot.

The harness exports with DELTA temporality, so every `collect()` drains what it reports. Requiring all names in a single snapshot is unsatisfiable whenever two of them land in different polling windows: the first collect takes one and consumes it, the second takes the other, and no snapshot ever holds both. Retrying cannot converge on that — the poll is the thing destroying the evidence — and by the time the budget expires every delta has been drained, which is why the failure read `metric "cogmo.agent.iterations" not yet recorded` with no indication that `cogmo.llm.tokens` had been and gone.

The failure message now names what has been seen alongside what is missing. That distinction is the whole reason this was diagnosable at all: `(nothing)` means the meter never received anything, while `seen so far: cogmo.llm.tokens` means the turn recorded one metric and not the other — different bugs, previously indistinguishable.

This does not make the test deterministic. A second, independent cause remains: a peer fork can win the race to write the assistant row while this fork never reaches `persist-new-messages`, so the iteration count is never recorded in the meter being inspected. `todo.md` carries that with the evidence gathered here, and the function's docstring no longer claims the retry covers it.
