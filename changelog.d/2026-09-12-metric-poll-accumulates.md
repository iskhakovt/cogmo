### The metric poll in `pipeline.integration.test.ts` accumulates across collects

`collectMetricsWhen` keeps the first sighting of each required metric and returns once all of them have been seen, rather than demanding they appear together in one snapshot.

The harness exports with DELTA temporality, so every `collect()` drains what it reports. Requiring all names in a single snapshot is unsatisfiable whenever two of them land in different polling windows: the first collect takes one and consumes it, the second takes the other, and no snapshot ever holds both. Retrying cannot converge on that, because the poll is what destroys the evidence — so the sightings are accumulated instead.

The failure message names what has been seen alongside what is missing. `(nothing)` means the meter received no measurements at all; `seen so far: cogmo.llm.tokens` means the turn recorded one metric and not the other. Those are different bugs, and the message distinguishes them.

This does not make the test deterministic. A second, independent cause remains: a peer fork can win the race to write the assistant row while this fork never reaches `persist-new-messages`, so the iteration count is never recorded in the meter being inspected. `todo.md` tracks it, and the function's docstring bounds what the retry covers.
