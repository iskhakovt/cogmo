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
//
// Every line passes through `redactSecretsInText` on its way to the stream,
// after serialization: a Telegram Bot API URL carries the bot token in its
// path, and node-fetch puts that URL in its error messages, which pino's
// `err` serializer reaches through grammY's `HttpError.error`. Redacting the
// serialized line covers every field and nesting depth, and every sink —
// the log stream and, when telemetry is on, instrumentation-pino's OTLP log
// stream, which receives the same post-hook line.

export type LogStream = "stdout" | "stderr";

const FILE_DESCRIPTORS: Readonly<Record<LogStream, number>> = { stdout: 1, stderr: 2 };

/**
 * A destination that opens its stream on the first line, so an entrypoint can
 * choose the stream after modules holding `logger` have loaded.
 */
export interface LogRouter extends pino.DestinationStream {
  /** Throws once a line has been written: that line went to the stream chosen before. */
  select(stream: LogStream): void;
}

export function createLogRouter(open: (stream: LogStream) => pino.DestinationStream): LogRouter {
  let selected: LogStream = "stdout";
  let sink: pino.DestinationStream | undefined;
  return {
    select(stream) {
      if (sink !== undefined) {
        throw new Error(`log stream selected after the first line went to ${selected}`);
      }
      selected = stream;
    },
    write(line) {
      sink ??= open(selected);
      sink.write(line);
    },
  };
}

const router = createLogRouter(openLogStream);

export const logger = createLogger(router);

/**
 * Choose the stream `logger` writes to; call it before the first line. A
 * process that never calls it logs to stdout.
 */
export function sendLogsTo(stream: LogStream): void {
  router.select(stream);
}

/** Build a logger with cogmo's options. Tests pass a destination to read what it writes. */
export function createLogger(destination: pino.DestinationStream): pino.Logger {
  return pino(
    { level: process.env.LOG_LEVEL ?? "info", hooks: { streamWrite: redactSecretsInText } },
    destination,
  );
}

/** JSON lines in production; pino-pretty, in its worker thread, everywhere else. */
function openLogStream(stream: LogStream): pino.DestinationStream {
  const fd = FILE_DESCRIPTORS[stream];
  if (process.env.NODE_ENV === "production") return pino.destination(fd);
  return pino.transport({ target: "pino-pretty", options: { destination: fd } });
}
