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

/**
 * Full runtime env, validated at module load. Server entrypoints (`cogmo
 * serve`, `cogmo skills`) import this and get a typed `env` covering all
 * the infrastructure vars they need. Bootstrap-tier code (`logger`,
 * `with-retry`) reads `process.env` directly so a misconfigured env
 * doesn't crash logging before the real error can surface — symmetric
 * across both leaves.
 */
export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "production", "test"]),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    DATABASE_URL: z.string().default("postgresql://cogmo@localhost/cogmo"),
    HINDSIGHT_URL: z.string().url(),
    /**
     * Truncation budget for recall queries, in tokens. Must match the Hindsight
     * server's `HINDSIGHT_API_RECALL_MAX_QUERY_TOKENS` (server default: 500).
     * Bump on both sides simultaneously when long multi-turn context needs to
     * flow into the recall query — semantic search quality degrades past
     * ~1500 tokens regardless of the cap.
     */
    HINDSIGHT_RECALL_MAX_QUERY_TOKENS: z.coerce.number().int().positive().default(500),
    INNGEST_MODE: z.enum(["connect", "serve"]).default("connect"),
    INNGEST_SERVE_PORT: z.coerce.number().default(3000),
    // `z.coerce.boolean()` is JS-truthy on any non-empty string —
    // `INNGEST_DEV=false` or `INNGEST_DEV=0` would both come out `true`,
    // which would force Dev mode in production and disable the SDK's
    // Cloud-mode signature verification. Match the explicit "true" / "1"
    // semantics the original raw-`process.env` check used.
    INNGEST_DEV: z
      .string()
      .optional()
      .transform((v) => v === "true" || v === "1"),
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
     * Selects which sandbox backend the factory wires up. `local-docker`
     * needs `SANDBOX_RUNTIME` set; `daytona` needs `daytona_api_key`
     * in the encrypted `secrets` table. Default `local-docker` matches
     * the historical opt-in-via-`SANDBOX_RUNTIME` behaviour: leaving
     * `SANDBOX_RUNTIME` unset still disables the sandbox module.
     */
    SANDBOX_BACKEND: z.enum(["local-docker", "daytona"]).default("local-docker"),
    /**
     * OCI runtime for sandbox containers. Optional — when unset, the sandbox
     * module does not initialize (coding-delegation features fail with a
     * clear error on first use). No silent fallback to `runc` — explicit
     * configuration only. Prod = `sysbox`; dev/CI integration = `runc`.
     * Only consulted when `SANDBOX_BACKEND=local-docker`.
     */
    SANDBOX_RUNTIME: z.enum(["sysbox", "runc"]).optional(),
    /**
     * Daytona Cloud / self-hosted API base URL. Default = Daytona Cloud
     * (`https://app.daytona.io/api`). Only consulted when
     * `SANDBOX_BACKEND=daytona`.
     */
    DAYTONA_API_URL: z.string().url().optional(),
    /**
     * Daytona organization id. Only needed when the API key is scoped
     * to multiple orgs and the default isn't the right one.
     */
    DAYTONA_ORGANIZATION_ID: z.string().optional(),
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
    /**
     * Directory holding per-task Docker proxy sockets. Created at boot if
     * missing. Each task container gets `${SANDBOX_PROXY_SOCKET_DIR}/<taskId>.sock`
     * bind-mounted at `/var/run/docker.sock` so child container creation
     * flows through the proxy (label injection, runtime override, deny rules).
     */
    SANDBOX_PROXY_SOCKET_DIR: z.string().default("/run/cogmo/sockets"),
    /**
     * Host Docker socket the proxy forwards to. Override only for unusual
     * deployments (rootless docker, snap, etc.).
     */
    SANDBOX_HOST_DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
    /**
     * Host root for per-task git-askpass material. Each task gets
     * `${SANDBOX_ASKPASS_DIR}/<task-id>/` provisioned with a helper script,
     * the bot account's PAT, and the SSH signing key — bind-mounted into
     * the task container at `/.cogmo-askpass/`. Wiped on `stopTask`.
     */
    SANDBOX_ASKPASS_DIR: z.string().default("/run/cogmo/askpass"),
    /**
     * Host path of the bare git repo backing the skill library. Initialized
     * on first boot via `bootstrapSkillsRepo`; advanced exclusively by the
     * `register` RPC (direct pushes to `main` are rejected by a pre-receive
     * hook). See `design/skills.md` → Skill storage.
     */
    COGMO_SKILLS_PATH: z.string().default("/var/lib/cogmo/skills"),
    /**
     * Maximum MCP tools surfaced to the LLM per turn after profile-glob
     * filtering. Cap exists because LLM tool-selection accuracy degrades
     * past ~30 tools (Cursor empirical data) and prompt-token cost is
     * ~250-400 tokens per tool definition. Native + skill tools are not
     * counted against this budget.
     */
    MCP_TOOL_BUDGET: z.coerce.number().int().positive().default(25),
    /** Per-call timeout for MCP tool dispatch (ms). */
    MCP_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    /** MCP connection pool: idle threshold after which a live connection is closed. */
    MCP_IDLE_EVICTION_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 60_000),
    /** MCP connection pool: how often the idle sweep runs. Set 0 to disable. */
    MCP_EVICTION_INTERVAL_MS: z.coerce.number().int().nonnegative().default(60_000),
  },
  runtimeEnv: resolved,
  emptyStringAsUndefined: true,
});
