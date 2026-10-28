/**
 * What the `plan-cli` and `execute-cli` steps memoize, and how the bare body
 * reads it back. The memo is parsed on every invocation, the one that ran
 * the body included, so a live result and its replay take one path.
 */

import { z } from "zod";
import type { BackendUsage } from "./backend.js";
import { type TaskFailure, TaskFailureSchema } from "./types.js";

/** What a session step body returns: an error flag, and the failure when it is set. */
export interface SessionMemo {
  isError: boolean;
  plan?: string;
  usage?: BackendUsage;
  failure?: TaskFailure;
}

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

/** How the session ended: with a failure to record, or with what it produced. */
export type SessionResult =
  | { kind: "errored"; failure: TaskFailure }
  | { kind: "completed"; plan?: string; usage?: BackendUsage };

/**
 * A run in flight may hold a memo with `failureReason`, the exit text alone;
 * it reads as a `cli_exit_error` with that text as the detail, which is the
 * only failure a session produces. An errored memo without either is one no
 * session wrote.
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
  .refine(
    (memo) => !memo.isError || memo.failure !== undefined || memo.failureReason !== undefined,
    {
      message: "an errored session memo carries its failure",
    },
  )
  .transform(({ isError, plan, usage, failure, failureReason }): SessionResult => {
    if (isError) {
      return {
        kind: "errored",
        failure: failure ?? { reason: "cli_exit_error", detail: failureReason ?? "" },
      };
    }
    return { kind: "completed", ...(plan !== undefined && { plan }), ...(usage && { usage }) };
  });

/** Read a memoized session result back. */
export function fromSessionResult(memo: unknown): SessionResult {
  return SessionResultSchema.parse(memo);
}
