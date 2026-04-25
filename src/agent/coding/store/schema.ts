import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { pk, ts } from "../../../db/helpers.js";
import { containers } from "../../../sandbox/store/schema.js";

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
  devcontainer: jsonb("devcontainer"), // DevcontainerSpecSchema; null = use cogmo/devbase
  allowedBackends: codingBackend("allowed_backends").array().notNull(),
  verifyCommand: text("verify_command").notNull(),
  taskTokenBudget: integer("task_token_budget").notNull(),
  taskWallTimeSeconds: integer("task_wall_time_seconds").notNull(),
  maxConcurrentTasks: integer("max_concurrent_tasks").notNull(),
  createdAt: ts(),
});

/**
 * One coding task = one git worktree + one branch + one CLI session +
 * (eventually) one draft PR. Slice 1 fields drive plan-only flows; later
 * slices fill in `pr_url`, `verifying`/`pushed`/`pr_open` statuses, etc.
 */
export const codingTasks = pgTable("coding_tasks", {
  id: pk(),
  repoId: uuid("repo_id")
    .notNull()
    .references(() => codingRepos.id),
  goal: text("goal").notNull(),
  triggerSource: codingTriggerSource("trigger_source").notNull(),
  triggerRef: text("trigger_ref"), // pointer into the originating subsystem (evolution proposal id, etc.)
  backend: codingBackend("backend").notNull(),
  branch: text("branch").notNull(),
  worktreePath: text("worktree_path").notNull(),
  sessionId: text("session_id"), // CLI session id captured on first event
  containerId: uuid("container_id").references(() => containers.id), // set after sandbox.createTaskContainer
  allowPrivilegedRunc: boolean("allow_privileged_runc").notNull(), // explicit at insert (no default)
  plan: text("plan"),
  planApprovedAt: timestamp("plan_approved_at", { withTimezone: true }),
  prUrl: text("pr_url"),
  status: codingTaskStatus("status").notNull(),
  failureReason: text("failure_reason"),
  resourceUsage: jsonb("resource_usage"), // ResourceUsageSchema; null = no stats poll yet
  createdAt: ts(),
});
