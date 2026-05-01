import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Bootstrap-tier env validation. Holds only the variables that bootstrap
 * code (logger, retry helper, seed entrypoint) needs to read — kept in a
 * separate schema from `env.ts` so importing one of those modules doesn't
 * cascade validation of runtime infra vars (HINDSIGHT_URL, INNGEST_BASE_URL).
 *
 * The full runtime schema in `src/env.ts` extends this one, so server
 * entrypoints get a single typed `env` object covering both tiers.
 *
 * Every var here is either required (NODE_ENV — every consumer including
 * tests sets it explicitly) or has a safe default. That guarantees this
 * schema parses successfully in any context that imports it: `cogmo seed`
 * with only DATABASE_URL, `cogmo gen-key` with no env at all, unit tests.
 *
 * `runtimeEnv: process.env` is read at import time, so consumers must
 * ensure NODE_ENV is set in their process before this module loads.
 */
export const bootstrapEnv = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "production", "test"]),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
