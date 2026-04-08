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
    TAVILY_API_KEY: z.string().optional(),
    OPENROUTER_API_KEY: z.string().optional(),
    USER_TIMEZONE: z.string().default("UTC"),
    S3_ENDPOINT: z.string().optional(),
    S3_BUCKET: z.string().default("assistant-files"),
    S3_ACCESS_KEY: z.string().optional(),
    S3_SECRET_KEY: z.string().optional(),
    S3_REGION: z.string().default("us-east-1"),
    SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().default(60),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_ALLOWED_USERS: z.string().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
