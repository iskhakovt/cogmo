### `cogmo.memory.recall.failures` counts auto-recall failures

A new OTel counter, labeled by `bank_id`, counts each auto-recall the turn degraded past. The turn still runs without a `# Recalled Context` block rather than failing, because failing the `auto-recall` step would send the turn into Inngest retries. The counter is what makes a memory outage visible. Without it the only symptom is an agent that seems to have forgotten things, and the `memory.recall` span's exception is invisible to anyone not reading traces. Hindsight is not fail-open on a dead reranker, so one bad reranker config fails every recall rather than a sample, and that config lives in the deploy env where no test here can reach it. `DEPLOYMENT.md` lists the counter and says to alert on a sustained non-zero rate.

The increment sits in the `.catch` inside the `auto-recall` step body, next to the warn log. A step body runs live once and is replayed from cache on every later re-invocation, so a failed recall counts once per turn. A count taken in the bare body would count it on every pass. The catch never rethrows, so no step retry re-enters it either. The residual is the usual one for a side effect inside a step: a crash after the increment but before Inngest records the result counts it twice.

Only auto-recall counts. The `memory_recall` tool passes its failure to the model as an `is_error` tool_result, which the `tool.execute` span already marks. A missing bank (a user with nothing retained yet) is an empty recall in `HindsightMemoryProvider`, not a failure, so it does not count.

Tests:

- `handle-message.test.ts`: the degrade path (a rejected recall counts once against `user-1` and the loop gets the bare assembled prompt) and the success path (neither a recall with memories nor an empty one counts, and the memories reach the prompt).
- `handle-message.replay.test.ts`: under `InngestTestEngine`'s re-invocation model, a failed recall counts once per turn. It fails if the count moves into the bare body, which runs on every pass.
- `metrics.test.ts`: pins the exported instrument name and its monotonic-sum shape, which is what an alert rule keys on.

The counter reports broken recall. The reranker failover chain is what keeps recall working, and `DEPLOYMENT.md` → "Hindsight reranker" now tells operators to set it. Hindsight's default reranker is `local`, which the slim image doesn't ship, and by default a failing reranker fails the whole recall. The section gives the chain to set instead:

- an explicit primary with a 2s timeout. Hindsight's OpenRouter default is 60s, and a recalling turn waits on it.
- `HINDSIGHT_API_RERANKER_MAX_RETRIES=0`.
- `HINDSIGHT_API_RERANKER_1_PROVIDER=rrf`, so an unreachable reranker falls back to the retrieval order instead of failing the recall.

It warns that indexed members inherit nothing from the primary. It also warns that the OpenRouter primary needs an OpenRouter key, because the key it falls back to may not be one, and then every rerank silently fails over to `rrf`. It notes that the counter only sees turns that recall, and that a failover is a successful recall: the counter stays at zero, and a primary that stays down shows up only in Hindsight's `WARNING` logs. The settings and defaults are those of Hindsight 0.10.1's configuration reference. `design/memory.md` → Reranking keeps the model comparison and the reasoning behind the chain.
