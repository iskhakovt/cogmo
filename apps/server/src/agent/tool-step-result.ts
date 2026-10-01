import { err, ok } from "neverthrow";
import { z } from "zod";
import type { ToolOutcome } from "./tools.js";

/**
 * What a durable tool's `tool-iter<N>-<P>` step memoizes. A rejection is a
 * successful step result carrying `ok: false`, so it replays like any other
 * value; only a bug fails the step.
 *
 * A run in flight may hold a bare-string memo; it reads as a success.
 */
const ToolStepResultSchema = z.union([
  z.string().transform((content) => ({ ok: true as const, content })),
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), content: z.string() }),
    z.object({ ok: z.literal(false), message: z.string() }),
  ]),
]);

export type ToolStepResult = z.output<typeof ToolStepResultSchema>;

/** The JSON-serializable form of `outcome`, for a step to return. */
export function toToolStepResult(outcome: ToolOutcome): ToolStepResult {
  return outcome.match<ToolStepResult>(
    (content) => ({ ok: true, content }),
    (rejection) => ({ ok: false, message: rejection.message }),
  );
}

/**
 * Read a memoized step result back. Parsed on every invocation, the one that
 * ran the body included, so a live result and its replay take one path.
 */
export function fromToolStepResult(memo: unknown): ToolOutcome {
  const parsed = ToolStepResultSchema.parse(memo);
  return parsed.ok ? ok(parsed.content) : err({ message: parsed.message });
}
