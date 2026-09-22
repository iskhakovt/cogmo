### `cogmo.memory.recall.failures` counts auto-recall failures

A new OTel counter, labeled by `bank_id`, counts each auto-recall the turn degraded past. The turn still runs without a `# Recalled Context` block rather than failing, because failing the `auto-recall` step would send the turn into Inngest retries. The counter is what makes a memory outage visible. Without it the only symptom is an agent that seems to have forgotten things, and the `memory.recall` span's exception is invisible to anyone not reading traces. Hindsight is not fail-open on a dead reranker, so one bad reranker config fails every recall rather than a sample, and that config lives in the deploy env where no test here can reach it. `DEPLOYMENT.md` lists the counter and says to alert on a sustained non-zero rate.

The increment sits in the `.catch` inside the `auto-recall` step body, next to the warn log. A step body runs live once and is replayed from cache on every later re-invocation, so a failed recall counts once per turn. A count taken in the bare body would count it on every pass. The catch never rethrows, so no step retry re-enters it either. The residual is the usual one for a side effect inside a step: a crash after the increment but before Inngest records the result counts it twice.

Only auto-recall counts. The `memory_recall` tool passes its failure to the model as an `is_error` tool_result, which the `tool.execute` span already marks. A missing bank (a user with nothing retained yet) is an empty recall in `HindsightMemoryProvider`, not a failure, so it does not count.

Tests:

- `handle-message.test.ts`: the degrade path (a rejected recall counts once against `user-1` and the loop gets the bare assembled prompt) and the success path (neither a recall with memories nor an empty one counts, and the memories reach the prompt).
- `handle-message.replay.test.ts`: under `InngestTestEngine`'s re-invocation model, a failed recall counts once per turn. Moving the count into the bare body makes this test see six.
- `metrics.test.ts`: pins the exported instrument name and its monotonic-sum shape, which is what an alert rule keys on.

Every assertion on the count was checked to fail with the increment removed.

The fix that actually restores recall is on the deploy side: the `HINDSIGHT_API_RERANKER_1_PROVIDER=rrf` failover member in `design/memory.md`'s production config, so an unreachable reranker degrades to fusion order instead of failing the recall. This repo has no production Hindsight env to change.
