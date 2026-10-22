# State Machines

Anything with a lifecycle — a task, a run, a turn under observation, an approval — is an explicit state machine. A feature that writes to more than one system (Postgres, Hindsight, an LLM, Inngest's state store) has no transaction spanning them, so every crash point leaves the work in *some* state. Name all of those states up front; a state nobody named grows later as a boolean, a nullable column or a string outcome, and each one is a bug a reviewer finds only by combining two features.

## Design before code

The design doc carries, before any implementation:

- **The unit and its durable id.** Every write is keyed on it. A unit whose bounds can shift on a re-plan (a token-budget chunk, "the next N messages") has no identity, and nothing keyed on it survives a retry.
- **The states**, as a `pgEnum`, with a diagram.
- **A transition table**: each legal transition, its guard, and its writes. Transitions not in the table are illegal.
- **A failure-mode table**: every crash point (inside a step before Inngest records it, between two writes, a step failing after retries, a function retry, a run in flight across a deploy, two runs at once) × the state it leaves × why that state is safe or which residual it is.

`[proposed]` until that review passes.

## In the schema

- **Status is a `pgEnum` column**, never `text`, never inferred from which nullable columns are set.
- **Per-state data** lives in a JSONB column with a Zod schema whose variants follow the status, and a CHECK ties the two together, so a row can't hold a state's data without being in that state. Grouping atomic fields this way is already the rule in [architecture-rules.md](architecture-rules.md).
- **A failed or skipped state records why**, as an enum, not a log line. An outcome nobody can query is invisible.

## In the code

- **Each transition is a conditional UPDATE** — `WHERE id = $1 AND status = <from>` — returning whether it happened, as in `DrizzleCodingStore.transitionTaskStatus` (`{ kind: "transitioned" } | { kind: "stale"; status; claimedByRunId }`). Branch on the result; never read the status in the bare body and write it in a later step ([inngest.md](inngest.md) → re-entry guards).
- **Outcomes are discriminated unions** matched with ts-pattern's `.exhaustive()`, so an unhandled state or outcome is a compile error. Not booleans, not string flags compared with `===`, not a `switch` — `biome-plugins/no-discriminant-switch.grit` flags `switch (x.kind)` and `switch (x.status)`.
- **Expected failures are values** — `Result<T, E>` with a sealed error union that says which failures are terminal for the unit and which only pause the work (auth, billing, an unreachable provider). Exceptions stay for bugs.
- **Idempotency keys come from durable state**: the unit id, a phase, a position in a memoized step result. Never from model output, a clock or a fresh uuid ([inngest.md](inngest.md)).
- **One use-case file per transition** ([store-pattern.md](store-pattern.md)), not one orchestrator that owns every state.

## Review

Review the state machine as a whole, not commit by commit: a per-commit review sees each new state alone and misses the combinations, which is where these bugs live.
