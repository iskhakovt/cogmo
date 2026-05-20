import { boolean, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { jsonbZod, pk, ts } from "../../../db/helpers.js";
import { containers } from "../../../sandbox/store/schema.js";
import {
  DevcontainerSpecSchema,
  PrMetadataSchema,
  ResourceUsageSchema,
  WorktreeAssignmentSchema,
} from "../types.js";

// --- Enums ---

export const codingBackend = pgEnum("coding_backend", ["claude", "codex"]);

export const codingTriggerSource = pgEnum("coding_trigger_source", [
  "user",
  "evolution",
  "signal_pipeline",
]);

export const codingTaskStatus = pgEnum("coding_task_status", [
  "queued",
  "planning",
  "awaiting_approval",
  "executing",
  "pending_verify",
  "verifying",
  "pushed",
  "pr_open",
  "failed",
  "cancelled",
]);

// --- Tables ---

/**
 * Admin-registered repositories Cogmo can act on. `verify_command` is
 * `bash -lc`-evaluated inside the task container (login shell PATH covers
 * version-manager shims). `task_token_budget` and `task_wall_time_seconds`
 * are per-task ceilings; `max_concurrent_tasks` is the per-repo cap (default
 * 1, raised in P3 once the install-lock ships).
 */
export const codingRepos = pgTable("coding_repos", {
  id: pk(),
  name: text("name").notNull().unique(),
  localPath: text("local_path").notNull(),
  defaultBranch: text("default_branch").notNull(),
  remoteUrl: text("remote_url").notNull(),
  devcontainer: jsonbZod("devcontainer", DevcontainerSpecSchema), // null = use cogmo/devbase
  allowedBackends: codingBackend("allowed_backends").array().notNull(),
  verifyCommand: text("verify_command").notNull(),
  taskTokenBudget: integer("task_token_budget").notNull(),
  taskWallTimeSeconds: integer("task_wall_time_seconds").notNull(),
  maxConcurrentTasks: integer("max_concurrent_tasks").notNull(),
  // Selects which GitHub identity (PAT + SSH signing key bundle, stored under
  // `github_identity:<name>` in the secrets table) the orchestrator uses for
  // this repo's verify → push → PR pipeline. Default `'default'` covers
  // single-account setups (one bot account for all repos); per-repo overrides
  // are useful when one project's PRs should be authored under a different
  // bot account (e.g. an org with separate per-team review trails).
  identityName: text("identity_name").notNull().default("default"),
  // Wall-clock cap for the post-hoc verify step. The CLI already had
  // `task_wall_time_seconds` during execute; this caps the single-shot verify
  // exec separately so a runaway test suite is killed without affecting the
  // CLI's iteration budget. 600s default covers `pnpm test` for most repos;
  // monorepos override.
  verifyTimeoutSeconds: integer("verify_timeout_seconds").notNull().default(600),
  createdAt: ts(),
});

/**
 * One coding task = one git worktree + one branch + one CLI session +
 * (eventually) one draft PR. Slice 1 fields drive plan-only flows; later
 * slices fill in `pr_url`, `pending_verify`/`verifying`/`pushed`/`pr_open`
 * statuses, etc.
 */
export const codingTasks = pgTable("coding_tasks", {
  id: pk(),
  repoId: uuid("repo_id")
    .notNull()
    .references(() => codingRepos.id),
  // Conversation that triggered this task — null for non-conversation triggers
  // (evolution, signal_pipeline). Drives `/repo list` scoping and slice-2
  // Telegram delivery. Not declared as an FK to conversations because the
  // FK would cross module boundaries (transport store) and the link is
  // informational, not referential.
  conversationId: uuid("conversation_id"),
  goal: text("goal").notNull(),
  triggerSource: codingTriggerSource("trigger_source").notNull(),
  triggerRef: text("trigger_ref"), // pointer into the originating subsystem (evolution proposal id, etc.)
  backend: codingBackend("backend").notNull(),
  // Worktree assignment — branch + host path derived from the task id by the
  // orchestrator's `allocate-worktree` step (per design/coding-delegation.md
  // → Inngest step boundaries). Stored as one JSONB blob with a Zod-validated
  // shape so the two fields are atomic by construction (no "half-allocated"
  // state). Null until allocate-worktree runs — same lifecycle pattern as
  // session_id, container_id, plan, etc. on this table.
  worktreeAssignment: jsonbZod("worktree_assignment", WorktreeAssignmentSchema),
  sessionId: text("session_id"), // CLI session id captured on first event
  containerId: uuid("container_id").references(() => containers.id), // set after sandbox.createTaskContainer
  allowPrivilegedRunc: boolean("allow_privileged_runc").notNull(), // explicit at insert (no default)
  plan: text("plan"),
  planApprovedAt: timestamp("plan_approved_at", { withTimezone: true }),
  // Slice 4.0g: PrMetadataSchema = { url, number, branchSha, openedAt };
  // null until the draft PR step populates it. Replaces the prior
  // `pr_url TEXT` column (no in-flight data — slice 4 is the first to
  // populate PR state).
  prMetadata: jsonbZod("pr_metadata", PrMetadataSchema),
  status: codingTaskStatus("status").notNull(),
  failureReason: text("failure_reason"),
  resourceUsage: jsonbZod("resource_usage", ResourceUsageSchema), // null = no stats poll yet
  createdAt: ts(),
});
