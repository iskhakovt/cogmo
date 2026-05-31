import pino from "pino";

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
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(process.env.NODE_ENV !== "production" && {
    transport: { target: "pino-pretty" },
  }),
});
