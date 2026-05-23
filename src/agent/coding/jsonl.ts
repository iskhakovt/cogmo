import type { Readable } from "node:stream";
import split2 from "split2";
import { logger } from "../../logger.js";

const log = logger.child({ component: "coding.jsonl" });

/**
 * Iterate a Readable stream as parsed JSONL records. Extracts the
 * outermost balanced `{...}` on each line: bash's transition-out-of-
 * interactive OSC title (`\x1b]1;exec\x07`) can sit adjacent to the
 * first `{"type":"system",...}` event with no newline separator, and
 * later lines occasionally carry trailing terminal control bytes after
 * a closing brace. Lines without a balanced object are dropped
 * silently (echoed input, bash prompt, OSC titles). String values
 * containing `{` / `}` are respected — the scan tracks string state
 * and escape sequences so `{"k":"}"}` parses correctly.
 */
export async function* readJsonl(stream: Readable): AsyncIterable<unknown> {
  const splitter = stream.pipe(split2());
  for await (const line of splitter as AsyncIterable<string>) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const candidate = extractBalancedObject(trimmed);
    if (candidate === null) continue;
    try {
      yield JSON.parse(candidate);
    } catch (err) {
      log.warn(
        { err: (err as Error).message, line: candidate.slice(0, 200) },
        "skipping malformed JSONL line",
      );
    }
  }
}

/**
 * Scan `s` for the first balanced `{...}` and return that slice, or
 * `null` if no balanced object is found. Tracks JSON string state so
 * `{` and `}` inside strings don't shift the depth counter.
 */
function extractBalancedObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
