import type { Readable } from "node:stream";
import split2 from "split2";
import { logger } from "../../logger.js";

const log = logger.child({ component: "coding.jsonl" });

/**
 * Iterate a Readable stream as parsed JSONL records. Extracts the
 * outermost balanced `{...}` on each line so terminal control bytes
 * adjacent to claude's JSON events (bash's `\x1b]1;exec\x07` OSC
 * title, trailing cursor-reset on the same line) don't trip the parser.
 * Best-effort extract: lines with no balanced object drop at `debug`;
 * concatenated objects (`{...}{...}`) yield only the first.
 */
export async function* readJsonl(stream: Readable): AsyncIterable<unknown> {
  const splitter = stream.pipe(split2());
  for await (const line of splitter as AsyncIterable<string>) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const candidate = extractBalancedObject(trimmed);
    if (candidate === null) {
      log.debug({ line: trimmed.slice(0, 200) }, "no balanced JSON object on line — dropping");
      continue;
    }
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
 * `null` if no balanced object is found. Tracks JSON string state.
 * Bytes before the first `{` are assumed to be an ANSI/OSC prefix —
 * a CSI sequence containing a literal `{` (rare) would shift the start.
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
