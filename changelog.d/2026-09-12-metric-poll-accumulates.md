### The metric poll in `pipeline.integration.test.ts` accumulates across collects

`collectMetricsWhen` returns every data point collected across its polls, once all the required metrics have been seen, rather than demanding they appear together in one snapshot. Assertions read through `pointsFor(name)`, which aggregates across sightings.

The harness exports with DELTA temporality, so every `collect()` drains what it reports. Requiring all names in a single snapshot is unsatisfiable whenever two of them land in different polling windows: the first collect takes one and consumes it, the second takes the other, and no snapshot ever holds both. Retrying cannot converge on that, because the poll is what destroys the evidence — so the polls are accumulated instead. Every sighting is kept, not just the first: a drained delta is gone, so discarding later ones would let unrelated in-process work satisfy a name while the turn's own measurements were collected and thrown away, and would split a multi-iteration turn whose points arrive across several collects.

The failure message names what has been seen alongside what is missing. `(nothing)` means the meter received no measurements at all; `seen so far: cogmo.llm.tokens` means the turn recorded one metric and not the other. Those are different bugs, and the message distinguishes them.

This does not make the test deterministic. A second, independent cause remains: a peer fork can win the race to write the assistant row while this fork never reaches `persist-new-messages`, so the iteration count is never recorded in the meter being inspected. `todo.md` tracks it, and the function's docstring bounds what the retry covers.
