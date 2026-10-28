/**
 * What the `plan-cli` and `execute-cli` steps memoize: whether the CLI
 * session errored, and the failure to record when it did. Parsed on every
 * invocation, the one that ran the body included, so a live result and its
 * replay take one path.
 */

import { z } from "zod";
import type { BackendUsage } from "./backend.js";
import { TaskFailureSchema } from "./types.js";

/** `BackendUsage`, each field present only when the backend reported it. */
const BackendUsageSchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    costUsd: z.number().optional(),
  })
  .strict()
  .transform(
    ({ inputTokens, outputTokens, costUsd }): BackendUsage => ({
      ...(inputTokens !== undefined && { inputTokens }),
      ...(outputTokens !== undefined && { outputTokens }),
      ...(costUsd !== undefined && { costUsd }),
    }),
  );

/**
 * A run in flight may hold a memo with `failureReason`, the exit text alone;
 * it reads as a `cli_exit_error` with that text as the detail, which is the
 * only failure a session produces.
 */
const SessionResultSchema = z
  .object({
    isError: z.boolean(),
    plan: z.string().optional(),
    usage: BackendUsageSchema.optional(),
    failure: TaskFailureSchema.optional(),
    failureReason: z.string().optional(),
  })
  .strict()
  .transform(({ failure, failureReason, ...rest }) => {
    const resolved =
      failure ??
      (failureReason === undefined
        ? undefined
        : { reason: "cli_exit_error" as const, detail: failureReason });
    return { ...rest, ...(resolved && { failure: resolved }) };
  });

export type SessionResult = z.output<typeof SessionResultSchema>;

/** Read a memoized session result back. */
export function fromSessionResult(memo: unknown): SessionResult {
  return SessionResultSchema.parse(memo);
}
