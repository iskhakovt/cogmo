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
// stdout and, when telemetry is on, instrumentation-pino's OTLP log stream,
// which receives the same post-hook line.
export const logger = createLogger();

/**
 * Build a logger with cogmo's options. `destination` replaces the default
 * stream (stdout, or pino-pretty outside production) — tests pass one to
 * read what the logger writes.
 */
export function createLogger(destination?: pino.DestinationStream): pino.Logger {
  const options: pino.LoggerOptions = {
    level: process.env.LOG_LEVEL ?? "info",
    hooks: { streamWrite: redactSecretsInText },
  };
  if (destination !== undefined) return pino(options, destination);
  return pino({
    ...options,
    ...(process.env.NODE_ENV !== "production" && {
      transport: { target: "pino-pretty" },
    }),
  });
}
