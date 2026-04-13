import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { resolveEnvFile } from "./secrets/env-file.js";

// Apply _FILE convention for Docker secrets before Zod validation.
// Only specific vars support this — not a global wrapper.
const resolved: Record<string, string | undefined> = { ...process.env };
for (const name of ["COGMO_MASTER_KEY", "DATABASE_URL"]) {
  const val = resolveEnvFile(process.env, name);
  if (val !== undefined) resolved[name] = val;
}

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    DATABASE_URL: z.string().default("postgresql://cogmo@localhost/cogmo"),
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
    S3_BUCKET: z.string().default("cogmo-files"),
    S3_ACCESS_KEY: z.string().optional(),
    S3_SECRET_KEY: z.string().optional(),
    S3_REGION: z.string().default("us-east-1"),
    SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().default(60),
    DEBOUNCE_IDLE_SECONDS: z.coerce.number().default(3),
    DEBOUNCE_MAXWAIT_SECONDS: z.coerce.number().default(30),
    DEBOUNCE_RESUME_POLICY: z.enum(["debounce", "flush", "await_input"]).default("debounce"),
    EXTRACTION_MODEL: z.string().optional(),
    COGMO_MASTER_KEY: z.string().optional(),
  },
  runtimeEnv: resolved,
  emptyStringAsUndefined: true,
});
