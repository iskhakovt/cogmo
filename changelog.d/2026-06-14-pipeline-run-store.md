Added the `pipeline_runs` table and run store — the persistence spine for the pipeline run engine. A run row is the source of truth for an in-flight execution: it pins the definition version, owns a conversation for gates and progress, tracks the current stage, and accumulates each stage's typed output (`text` / `json` artifacts) in a Zod-validated JSONB map.

The `DrizzlePipelineRunStore` exposes conditional, idempotent transitions designed for durable-execution retries: `advanceStage` and `completeRun` are guarded on the run still sitting at the expected stage (a replayed persist is a no-op `stale`), and the terminal `failRun` / `cancelRunIfActive` paths row-lock so two racing terminations can't both win. The full `pipeline_run_status` enum is declared up front (`queued` and `waiting_event` stay unused until slice 3's admission control and DB-parked waits) to avoid an `ALTER TYPE ADD VALUE` migration later.

No execution yet — this is the store layer the stage runner builds on.
