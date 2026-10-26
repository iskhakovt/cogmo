import type { EventEmitter } from "node:events";
import pino from "pino";
import { redactSecretsInText } from "./util/redact-secrets.js";

// Bootstrap-tier code: read `process.env` directly to keep the logger
// independent of the typed env. Anything that imports `env-bootstrap.ts`
// pulls in Zod validation at module load; for a leaf as widely-imported
// as `logger`, that means a misconfigured env (typo'd NODE_ENV, missing
// var) crashes logging — which then masks the real error. Reading raw
// keeps the logger booting under any env state. Pino itself rejects
// malformed `level` strings at runtime, so we still fail fast on a typo.
//
// Symmetric to `with-retry.ts` which reads `process.env.RETRY_DISABLED`
// raw for the same reason.

export type LogStream = "stdout" | "stderr";

const FILE_DESCRIPTORS: Readonly<Record<LogStream, number>> = { stdout: 1, stderr: 2 };

/** A stream the router opens. Pino hands a transport its config as an event on it. */
export interface LogSink extends pino.DestinationStream, Pick<EventEmitter, "emit"> {}

/**
 * A destination that opens its stream when one is selected or, failing that,
 * on the first line, so an entrypoint can choose the stream after modules
 * holding `logger` have loaded.
 */
export interface LogRouter extends pino.DestinationStream {
  /** Opens `stream` for every line; throws if a stream is already open or `stream` fails to open. */
  select(stream: LogStream): void;
  /** Pino emits its config here when the logger is built; the stream receives it once open. */
  emit(event: string, ...args: unknown[]): void;
}

/** `unselected` is the stream the first line opens when none was selected. */
export function createLogRouter(
  open: (stream: LogStream) => LogSink,
  unselected: LogStream,
): LogRouter {
  const emitted: Array<readonly [string, unknown[]]> = [];
  let opened: { stream: LogStream; sink: LogSink } | undefined;

  function openSink(stream: LogStream): LogSink {
    const sink = open(stream);
    for (const [event, args] of emitted) sink.emit(event, ...args);
    opened = { stream, sink };
    return sink;
  }

  return {
    select(stream) {
      if (opened !== undefined) throw new Error(`log stream already open on ${opened.stream}`);
      openSink(stream);
    },
    write(line) {
      (opened?.sink ?? openSink(unselected)).write(line);
    },
    emit(event, ...args) {
      if (opened === undefined) emitted.push([event, args]);
      else opened.sink.emit(event, ...args);
    },
  };
}

const router = createLogRouter(openLogStream, "stdout");

export const logger = createLogger(router);

/**
 * Open the stream `logger` writes to, before its first line. A stream that
 * can't open (pino-pretty missing outside production) fails here, once, at
 * startup. A process that never calls it opens stdout on its first line.
 */
export function sendLogsTo(stream: LogStream): void {
  router.select(stream);
}

/**
 * Build a logger with cogmo's options, writing to `destination`.
 *
 * Every line passes through `redactSecretsInText` on its way to `destination`,
 * after serialization: a Telegram Bot API URL carries the bot token in its
 * path, and node-fetch puts that URL in its error messages, which pino's
 * `err` serializer reaches through grammY's `HttpError.error`. Redacting the
 * serialized line covers every field and nesting depth, and every sink —
 * `destination` and, when telemetry is on, instrumentation-pino's OTLP log
 * stream, which receives the same post-hook line.
 */
export function createLogger(destination: pino.DestinationStream): pino.Logger {
  return pino(
    { level: process.env.LOG_LEVEL ?? "info", hooks: { streamWrite: redactSecretsInText } },
    destination,
  );
}

/** JSON lines in production; pino-pretty, in its worker thread, everywhere else. */
function openLogStream(stream: LogStream): LogSink {
  const fd = FILE_DESCRIPTORS[stream];
  if (process.env.NODE_ENV === "production") return pino.destination(fd);
  return pino.transport({ target: "pino-pretty", options: { destination: fd } });
}
