import pino from "pino";

// `logger` is bootstrap code, transitively imported from almost every module
// and from entrypoints that don't run the full app (`cogmo seed`, `cogmo
// gen-key`). Reading `process.env` directly here keeps the typed `env`
// validator out of the bootstrap path so an entrypoint that legitimately
// doesn't need infra vars (e.g. seed only needs DATABASE_URL) doesn't get
// blocked by a missing HINDSIGHT_URL.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(process.env.NODE_ENV !== "production" && {
    transport: { target: "pino-pretty" },
  }),
});
