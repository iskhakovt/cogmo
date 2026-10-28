/**
 * What the `plan-cli` and `execute-cli` steps memoize, and how the bare body
 * reads it back. The memo is parsed on every invocation, the one that ran
 * the body included, so a live result and its replay take one path.
 */

import { z } from "zod";
import type { BackendUsage } from "./backend.js";
import { type TaskFailure, TaskFailureSchema } from "./types.js";

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
 * How the session ended: with a failure to record, or with what it produced.
 * The step body returns it as is.
 */
export type SessionResult =
  | { kind: "errored"; failure: TaskFailure }
  | { kind: "completed"; plan?: string; usage?: BackendUsage };

const ErroredSchema = z
  .object({ kind: z.literal("errored"), failure: TaskFailureSchema })
  .strict()
  .transform(({ failure }): SessionResult => ({ kind: "errored", failure }));

const CompletedSchema = z
  .object({
    kind: z.literal("completed"),
    plan: z.string().optional(),
    usage: BackendUsageSchema.optional(),
  })
  .strict()
  .transform(completed);

/**
 * A memo from a run in flight across the deploy of the `kind` shape:
 * `{ isError, plan?, usage?, failure? }`, or older, `failureReason` with the
 * exit text alone, which reads as a `cli_exit_error` with that text as the
 * detail — the only failure a session produces. An errored memo without
 * either is one no session wrote.
 */
const LegacySchema = z
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
    { message: "an errored session memo carries its failure" },
  )
  .transform(({ isError, plan, usage, failure, failureReason }): SessionResult => {
    if (!isError) return completed({ plan, usage });
    return {
      kind: "errored",
      failure: failure ?? { reason: "cli_exit_error", detail: failureReason ?? "" },
    };
  });

const SessionMemoSchema = z.union([ErroredSchema, CompletedSchema, LegacySchema]);

function completed(memo: {
  plan?: string | undefined;
  usage?: BackendUsage | undefined;
}): SessionResult {
  return {
    kind: "completed",
    ...(memo.plan !== undefined && { plan: memo.plan }),
    ...(memo.usage && { usage: memo.usage }),
  };
}

/** Read a memoized session result back. */
export function fromSessionResult(memo: unknown): SessionResult {
  return SessionMemoSchema.parse(memo);
}
