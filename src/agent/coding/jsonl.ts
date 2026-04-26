import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { logger } from "../../logger.js";

const log = logger.child({ component: "coding.jsonl" });

/**
 * Iterate a Readable stream as parsed JSONL records. Backed by
 * `node:readline` — handles partial chunks and CRLF without bespoke buffer
 * management. Malformed lines are logged at warn level and skipped (the CLI
 * occasionally emits diagnostic non-JSON to stdout — failing the whole
 * stream over one bad line is wrong).
 */
export async function* readJsonl(stream: Readable): AsyncIterable<unknown> {
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of rl) {
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
