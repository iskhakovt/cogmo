### `cogmo.agent.iterations` is recorded once per turn

The sample is taken inside the `persist-new-messages` step, ahead of the write.

Inside the step, because Inngest re-invokes the whole function body at every step boundary and memoizes steps rather than the body. A `record()` in the bare body therefore lands a sample on each pass — three to six per turn, all describing the same turn, which skews the histogram the metric exists to read: iteration counts near the loop's limit of 20.

There is no alternative guard. Other durable-execution runtimes expose an `isReplaying` flag to skip instrumentation on replayed passes; Inngest's JS SDK has no equivalent, and `ctx.attempt` is the retry counter, still `0` on every boundary re-invocation of a healthy run. A step body is the mechanism — it fires live and is suppressed on replay.

Ahead of the write, because that orders the sample before the assistant row becomes visible. Anything watching the conversation for the turn to land — `pipeline.integration.test.ts` does exactly this — can then read the metric as a fact rather than polling for it to catch up. `cogmo.llm.tokens` already had this property: the adapters record it inside the `llm-iter<N>` step.

The step is an existing one, so the function's step count and the replay decision tree that `design/crash-recovery.md` pins are unchanged. `buildResult` and `buildDegradedResult` no longer record, and the degraded path keeps its sample — it returns through the same persist step.

Two guards in `handle-message.replay.test.ts`: the sample is taken once with the turn's iteration count and model, and a cached `persist-new-messages` contributes nothing. The second runs the real loop off a cached `llm-iter1`, so it covers a whole turn — with a stubbed loop it would pass without exercising the result builders at all.

What this does not buy is exactly-once. A crash between the record and Inngest persisting the step result re-runs the body and duplicates one sample, which is the standard residual for a side effect inside a step. One duplicate under crash beats three to six every turn.
