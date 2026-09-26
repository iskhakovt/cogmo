/**
 * Pure checks and summaries for the live evals (`src/test/live-eval.ts`).
 * Nothing here calls a model, so `eval-checks.test.ts` pins them in the unit
 * tier.
 */

import * as R from "remeda";
import type { CoreMemoryBlock } from "../agent/service.js";

// --- Reply checks: whether a reply follows a correction ---

export type ReplyCheck = "no-list-lines" | "no-imperial-units" | "max-100-words" | "no-bold";

/** Words and numbers; markdown, list markers and dashes don't count. */
export function wordCount(reply: string): number {
  return (reply.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

/** A number followed by an imperial unit. Naming a unit ("not Fahrenheit") is fine. */
const IMPERIAL_MEASUREMENT =
  /\d[\d,.]*[\s-]*(?:(?:miles?|feet|foot|ft|inch(?:es)?|lbs?|mph)\b|°\s?F\b|(?:degrees?\s+)?fahrenheit\b)/i;

export const REPLY_CHECKS: Record<ReplyCheck, (reply: string) => boolean> = {
  "no-list-lines": (reply) => !/^\s*(?:[-*•+]|\d+[.)])\s+\S/m.test(reply),
  "no-imperial-units": (reply) => !IMPERIAL_MEASUREMENT.test(reply),
  "max-100-words": (reply) => wordCount(reply) < 100,
  "no-bold": (reply) => !/\*\*[^*\n]+\*\*|__[^_\n]+__/.test(reply),
};

// --- Core-memory content ---

/** Words that mark a line as history rather than the current value. */
const PAST_MARKER =
  /\b(?:previous(?:ly)?|former(?:ly)?|used to|until|(?:moved|relocated) from|left|was|before|prior|done|completed?|finished|ex-)(?:\b|(?<=-))/i;

export type StaleStatus = "absent" | "past" | "current";

/** How the blocks state the value `pattern` matches: not at all, only as history, or as current. */
export function staleStatus(blocks: ReadonlyArray<CoreMemoryBlock>, pattern: string): StaleStatus {
  const re = new RegExp(pattern, "i");
  const lines = blocks.flatMap((b) => b.content.split("\n")).filter((line) => re.test(line));
  if (lines.length === 0) return "absent";
  return lines.every((line) => PAST_MARKER.test(line)) ? "past" : "current";
}

// --- Summary rates ---

/** A summary row: the completed samples in `of` for which `hit` holds. */
export interface EvalMetric<O> {
  name: string;
  of: (o: O) => boolean;
  hit: (o: O) => boolean;
}

/** A sample that threw or degraded before producing an outcome. */
export interface EvalFailure {
  repeat: number;
  failure: string;
}

export function isFailure<O extends object>(sample: O | EvalFailure): sample is EvalFailure {
  return "failure" in sample;
}

/**
 * Each metric's rate per group, as `hits/samples` over every repeat, followed
 * by each repeat's own rate in brackets when there is more than one. A
 * `completed` row comes first; a failed sample counts against it and is left
 * out of every other row, which has no outcome to read from it.
 */
export function summariseRates<O extends { repeat: number }>(
  metrics: ReadonlyArray<EvalMetric<O>>,
  groups: Readonly<Record<string, ReadonlyArray<O | EvalFailure>>>,
  repeats: number,
): Record<string, Record<string, string>> {
  const row = (
    of: (s: O | EvalFailure) => boolean,
    hit: (s: O | EvalFailure) => boolean,
  ): Record<string, string> =>
    R.mapValues(groups, (group) => {
      const rate = (samples: ReadonlyArray<O | EvalFailure>) => {
        const population = samples.filter(of);
        return `${population.filter(hit).length}/${population.length}`;
      };
      if (repeats === 1) return rate(group);
      const perRepeat = R.range(0, repeats).map((i) => rate(group.filter((s) => s.repeat === i)));
      return `${rate(group)} [${perRepeat.join(" ")}]`;
    });

  return {
    completed: row(
      () => true,
      (s) => !isFailure(s),
    ),
    ...Object.fromEntries(
      metrics.map((m) => [
        m.name,
        row(
          (s) => !isFailure(s) && m.of(s),
          (s) => !isFailure(s) && m.hit(s),
        ),
      ]),
    ),
  };
}
