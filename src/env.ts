import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    DATABASE_URL: z.string().default("postgresql://assistant@localhost/assistant"),
    ANTHROPIC_API_KEY: z.string(),
    ANTHROPIC_BASE_URL: z.string().optional(),
    HINDSIGHT_URL: z.string().default("http://localhost:8888"),
    INNGEST_MODE: z.enum(["connect", "serve"]).default("connect"),
    INNGEST_SERVE_PORT: z.coerce.number().default(3000),
    INNGEST_DEV: z.coerce.boolean().default(true),
    INNGEST_EVENT_KEY: z.string().optional(),
    INNGEST_SIGNING_KEY: z.string().optional(),
    INNGEST_BASE_URL: z.string().default("http://localhost:8288"),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_ALLOWED_USERS: z.string().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
