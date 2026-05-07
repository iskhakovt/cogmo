import type { Readable } from "node:stream";
import split2 from "split2";
import { logger } from "../../logger.js";

const log = logger.child({ component: "coding.jsonl" });

/**
 * Iterate a Readable stream as parsed JSONL records. Backed by `split2`
 * (Node-TSC-maintained, ISC, zero deps — the line splitter pino is built
 * on). It owns line framing across partial chunks and emits any
 * unterminated final chunk at end-of-stream. Malformed lines are logged at
 * warn level and skipped (the CLI occasionally emits diagnostic non-JSON
 * to stdout — failing the whole stream over one bad line is wrong).
 */
export async function* readJsonl(stream: Readable): AsyncIterable<unknown> {
  const splitter = stream.pipe(split2());
  for await (const line of splitter as AsyncIterable<string>) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch (err) {
      log.warn(
        { err: (err as Error).message, line: trimmed.slice(0, 200) },
        "skipping malformed JSONL line",
      );
    }
  }
}
