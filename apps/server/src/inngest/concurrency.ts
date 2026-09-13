/**
 * One agent turn at a time per conversation, across every function that runs
 * one: `handle-message` (chat turns) and `pipeline-stage-runner` (stage turns
 * on a run's conversation). `scope: "env"` puts both functions in one queue
 * per key, so a message sent mid-stage waits for the stage turn and a stage
 * waits for a chat turn in flight. The key is namespaced so no other
 * env-scoped limit shares the queue.
 *
 * Functions share the queue only through an identical key expression: one
 * that evaluates to the same value (a `has()` fallback, a split string) gets a
 * queue of its own. Use this object, never a copy of the key.
 *
 * Inngest counts executing steps, not runs. Best-effort FIFO keeps a started
 * run's steps ahead of a newer run's, but a run parked in `step.sleep` or
 * `step.waitForEvent` frees the slot while it waits.
 */
export const conversationTurnConcurrency = {
  limit: 1,
  key: `"conversation-turn:" + event.data.conversationId`,
  scope: "env",
} as const;
