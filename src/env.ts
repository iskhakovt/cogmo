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
    HINDSIGHT_URL: z.string().url(),
    INNGEST_MODE: z.enum(["connect", "serve"]).default("connect"),
    INNGEST_SERVE_PORT: z.coerce.number().default(3000),
    INNGEST_DEV: z.coerce.boolean().default(true),
    INNGEST_EVENT_KEY: z.string().optional(),
    INNGEST_SIGNING_KEY: z.string().optional(),
    INNGEST_BASE_URL: z.string().url(),
    TAVILY_API_KEY: z.string().optional(),
    OPENROUTER_API_KEY: z.string().optional(),
    FAL_API_KEY: z.string().optional(),
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
    COGMO_MASTER_KEY: z.string().optional(),
    /** Semver set at build time (Dockerfile `ARG VERSION`). `dev` when unset. */
    VERSION: z.string().default("dev"),
    /** Short git SHA, set at build time via Dockerfile `ARG GIT_SHA`. Optional. */
    GIT_SHA: z.string().optional(),
    /**
     * OCI runtime for sandbox containers. Optional — when unset, the sandbox
     * module does not initialize (coding-delegation features fail with a
     * clear error on first use). No silent fallback to `runc` — explicit
     * configuration only. Prod = `sysbox`; dev/CI integration = `runc`.
     */
    SANDBOX_RUNTIME: z.enum(["sysbox", "runc"]).optional(),
    /** Default base image for task containers when a repo has no `.devcontainer/`. */
    COGMO_DEVBASE_IMAGE: z.string().default("ghcr.io/iskhakovt/cogmo-devbase:slice1"),
    /** Host root for git clones registered via `/repo add`. */
    COGMO_REPOS_DIR: z.string().default("/var/lib/cogmo/repos"),
    /** Host root for per-task git worktrees. */
    COGMO_WORKTREES_DIR: z.string().default("/var/lib/cogmo/worktrees"),
    /** Idle TTL after which a task container is reaped. */
    CODING_TASK_IDLE_TTL_MINUTES: z.coerce.number().default(20),
    /** Grace period after a task reaches a terminal status before container teardown. */
    CODING_TASK_GRACE_SECONDS: z.coerce.number().default(120),
  },
  runtimeEnv: resolved,
  emptyStringAsUndefined: true,
});
