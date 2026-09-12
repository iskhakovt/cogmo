### `cogmo.agent.iterations` is recorded once per turn

The sample is taken inside the `persist-new-messages` step, after the write.

It lives inside a step because Inngest re-invokes the whole function body at every step boundary and memoizes steps rather than the body, so a `record()` in the bare body lands a sample on each pass — three to six per turn, all describing the same turn, which skews the histogram the metric exists to read: iteration counts near the loop's limit of 20.

There is no alternative guard. Other durable-execution runtimes expose an `isReplaying` flag to skip instrumentation on replayed passes; Inngest's JS SDK has no equivalent, and `ctx.attempt` is the retry counter, still `0` on every boundary re-invocation of a healthy run. A step body is the mechanism — it fires live and is suppressed on replay.

It sits after the write because a step body also re-runs on every retry, so a sample taken ahead of the transaction repeats whenever the transaction is the thing failing. After it, the turn is durably persisted before the sample is taken and the step has not yet returned, so nothing downstream has moved on.

That ordering re-scopes the metric, which is worth naming rather than leaving implicit: a turn whose persist fails irrecoverably is never sampled, so the histogram counts turns that produced a persisted reply rather than every turn the loop ran. `metrics.ts` says so at the declaration. Recording ahead of the write buys back less than it looks — a turn that fails before reaching the step is unsampled either way, so the two orderings differ only when the transaction itself is failing — and it pays in duplicates: N identical samples across the retry chain. For a histogram read to spot runaway iteration counts, repeated copies of one value are worse than a missing one, because they invent the pattern it exists to detect.

The step is an existing one, so the function's step count and the replay decision tree that `design/crash-recovery.md` pins are unchanged. `buildResult` and `buildDegradedResult` do not record, and the degraded path keeps its sample — it returns through the same persist step.

Three guards in `handle-message.replay.test.ts`: the sample is taken once with the turn's iteration count and model, it is taken after `insertMessages` rather than before, and a cached `persist-new-messages` contributes nothing. The last runs the real loop off a cached `llm-iter1`, so it covers a whole turn — with a stubbed loop it would pass without exercising the result builders at all.

What this does not buy is exactly-once. A crash after the write and the sample but before Inngest persists the step result re-runs the body and duplicates one sample, the standard residual for a side effect inside a step.
