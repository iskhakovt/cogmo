import type { Readable } from "node:stream";
import split2 from "split2";
import { logger } from "../../logger.js";

const log = logger.child({ component: "coding.jsonl" });

/**
 * Iterate a Readable stream as parsed JSONL records. Parses from the
 * first `{` on each line — bash's transition-out-of-interactive OSC
 * (`\x1b]1;exec\x07`) arrives on the SAME PTY line as claude's first
 * `{"type":"system",...}` with no newline separator. Lines without
 * `{` are dropped silently (echoed input, bash prompt, OSC titles).
 */
export async function* readJsonl(stream: Readable): AsyncIterable<unknown> {
  const splitter = stream.pipe(split2());
  for await (const line of splitter as AsyncIterable<string>) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const braceIdx = trimmed.indexOf("{");
    if (braceIdx < 0) continue;
    const jsonStart = trimmed.slice(braceIdx);
    try {
      yield JSON.parse(jsonStart);
    } catch (err) {
      log.warn(
        { err: (err as Error).message, line: jsonStart.slice(0, 200) },
        "skipping malformed JSONL line",
      );
    }
  }
}
