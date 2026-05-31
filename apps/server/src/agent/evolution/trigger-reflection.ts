/**
 * Sync wrapper around `runObserver` for the `/reflect` manual trigger.
 *
 * The autonomous path runs the Observer inside an Inngest function — durable
 * steps, per-conversationId concurrency cap, retry budget. The manual path
 * sidesteps Inngest entirely: it's an explicitly user-initiated debug-shaped
 * command, the user is waiting for the reply, and a sync direct call returns
 * the digest in the same Telegram reply rather than asking the user to poll
 * `/learned`. Single-user scale makes this safe — there's no concurrent
 * idle-fire to race with, and an in-process LLM/DB error surfaces to the
 * caller as a thrown Error rather than disappearing into Inngest's retry log.
 *
 * The `step` harness is a no-op that just calls the closure, so the Observer's
 * `step.run("…", fn)` calls execute serially in-process with no memoization.
 */

import {
  type ObserverDeps,
  type ObserverResult,
  type ObserverStepHarness,
  runObserver,
} from "./observer.js";

export type TriggerReflectionDeps = ObserverDeps;
export type TriggerReflectionResult = ObserverResult;

const SYNC_HARNESS: ObserverStepHarness = {
  run: (_name, fn) => fn(),
};

export async function triggerReflection(
  conversationId: string,
  deps: TriggerReflectionDeps,
): Promise<TriggerReflectionResult> {
  return runObserver({ data: { conversationId } }, SYNC_HARNESS, deps, "manual");
}
