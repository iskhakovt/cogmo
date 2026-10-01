/**
 * The durable-step wrapper an agent turn's in-turn steps run through
 * (`llm-iter<N>`, `tool-iter<N>-<P>`, `auto-recall`, `summarize-prefix-outcome`,
 * `load-last-tokens`, `count-tokens-<n>`, …). Shared by every orchestrator
 * that drives `runStreamingAgentLoop` — `handle-message` and the pipeline
 * stage turn — so the retry policy has one definition.
 *
 * It injects Inngest's `step.run` without making the loop depend on Inngest,
 * and applies the retry policy per step kind INSIDE the body:
 *
 * - `tool-iter*` gets NO step retries at all. A tool's expected failures
 *   never reach here: the handler rejects, and the step returns that
 *   rejection as its result. What does reach here is a throw — a bug, or an
 *   outage the handler didn't map — and the loop answers it with an
 *   `is_error` tool_result too. The agent loop is the retry mechanism (the
 *   model re-decides with that result in context); blind re-runs of the same
 *   handler only delay the feedback by the backoff schedule. A fresh
 *   tool_use from the model creates a fresh step, which IS the retry.
 * - Everything else keeps Inngest's per-step retries for transient failures,
 *   with deterministic provider errors (4xx that aren't 408/425/429)
 *   translated to NonRetriableError so Inngest fails fast instead of burning
 *   attempts on a call that fails identically.
 */

import { NonRetriableError } from "inngest";
import { isRetriableProviderError } from "../llm/fallback.js";
import type { StepRunner } from "./loop.js";

/** Single conversion point for "this failure gains nothing from a blind retry". */
export function asNonRetriable(err: unknown): NonRetriableError {
  const message = err instanceof Error ? err.message : String(err);
  return new NonRetriableError(message, { cause: err });
}

export function createTurnStepRunner(
  run: (id: string, fn: () => Promise<unknown>) => Promise<unknown>,
): StepRunner {
  // The cast erases Inngest's `Jsonify<T>` return type: every payload passed
  // through this wrapper is JSON-safe by construction (see
  // design/crash-recovery.md → State serialization), so `Jsonify<T>` and `T`
  // coincide at runtime but not for the compiler.
  return <T>(id: string, fn: () => Promise<T>): Promise<T> =>
    run(id, async () => {
      try {
        return await fn();
      } catch (err) {
        if (id.startsWith("tool-iter")) throw asNonRetriable(err);
        if (!isRetriableProviderError(err)) throw asNonRetriable(err);
        throw err;
      }
    }) as Promise<T>;
}
