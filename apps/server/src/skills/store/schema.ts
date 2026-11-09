import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { profiles, users } from "../../agent/store/schema.js";
import { jsonbZod, pk, ts } from "../../db/helpers.js";
import { userIdentities } from "../../transport/store/schema.js";
import {
  ClassifierLogSchema,
  SkillEffectsSchema,
  SkillInputsSchema,
  SkillInvocationInputsSchema,
  SkillInvocationOutputSchema,
  SkillIoSchema,
  SkillRunResourceUsageSchema,
  SkillSchemasSchema,
} from "../types.js";

// --- Enums ---

export const skillTier = pgEnum("skill_tier", ["wasm", "container"]);

export const skillRiskTier = pgEnum("skill_risk_tier", ["auto", "notify", "approve"]);

export const skillRunStatus = pgEnum("skill_run_status", ["running", "success", "error"]);

export const skillRunTrigger = pgEnum("skill_run_trigger", ["manual", "cron", "event"]);

/**
 * Stripe-pattern recovery point for `skill_runs`. Drives the
 * idempotency-key replay path inside `runner.invoke`:
 *
 *   - `started` — row inserted; no runtime has sent the task. A retry that
 *     sees this state refuses re-execution: the original may have
 *     crashed OR another worker may be preparing this same key.
 *   - `dispatched` — a runtime moved the row here immediately before
 *     sending `task_invoke`, writing `deadline_at`. The body may be
 *     running or may have acted; a retry refuses it as for `started`.
 *   - `executed` — execute completed and its result is committed
 *     (output/error/error_kind/rusage/finished_at). Output validation +
 *     final `status` write may not have happened yet. A retry replays only
 *     the cheap finalize step against the cached execute payload.
 *   - `finished` — `status` set, audit row terminal. A retry returns the
 *     cached result without touching the runtime.
 *
 * `skill-runs-sweeper` finishes a row stuck at `started` or `dispatched`
 * (design/skills.md → Run failures → Stuck runs). The columns each point
 * sets are pinned by the `chk_skill_runs_*` CHECKs on the table
 * (design/skills.md → At-most-once invocation, per-state data). Pattern
 * derives from brandur.org/idempotency-keys (atomic phases + recovery
 * points).
 */
export const skillRunRecoveryPoint = pgEnum("skill_run_recovery_point", [
  "started",
  "dispatched",
  "executed",
  "finished",
]);

/**
 * Why a run failed, set iff `error` is (design/skills.md → Run failures).
 * Each kind has one class (`skillRunErrorClass`); `unknown` is written only
 * by the migration, on error rows from before the column.
 */
export const skillRunErrorKind = pgEnum("skill_run_error_kind", [
  "skill_raised",
  "output_invalid",
  "load_failed",
  "wall_clock_exceeded",
  "memory_exceeded",
  "skill_failed",
  "input_invalid",
  "skill_retryable",
  "runtime_unavailable",
  "dependency_unavailable",
  "egress_unavailable",
  "credential_unavailable",
  "host_lost",
  "result_lost",
  "unknown",
]);

/**
 * `pending_approval` is the one non-terminal state; `live`, `denied` and
 * `rolled_back` are terminal. Approval puts the deploy `live` in the same
 * transaction, so there is no state between them.
 */
export const skillDeployStatus = pgEnum("skill_deploy_status", [
  "pending_approval",
  "denied",
  "live",
  "rolled_back",
]);

/**
 * Predicate of `idx_skill_runs_running`, spelled as a literal: the sweeper's
 * listing repeats it, and a bound parameter could not prove it under a
 * generic prepared plan.
 */
export const RUNNING_RUN = sql`status = 'running'`;

// --- Tables ---

/**
 * The DB-side projection of `main` in the skills git repo. Authoritative
 * source is the bare repo at `$COGMO_SKILLS_PATH`; rows are written by the
 * register RPC inside the same transaction that advances `main`. `git_sha` is
 * the commit pin — invocation always reads `SKILL.md` and `skill.py` from this
 * sha, not from a working tree.
 */
export const skills = pgTable(
  "skills",
  {
    id: pk(),
    name: text("name").notNull().unique(),
    tier: skillTier("tier").notNull(),
    riskTier: skillRiskTier("risk_tier").notNull(),
    effects: jsonbZod("effects", SkillEffectsSchema).notNull(),
    schedule: text("schedule"), // cron expression; null = not scheduled
    /**
     * Next scheduled fire time in UTC. Populated by register/approve/rollback
     * via `computeNextRun(schedule, env.USER_TIMEZONE, now())` whenever
     * `schedule` is non-null; otherwise null. The ticker (`skill-cron-ticker`)
     * locks rows whose `next_run_at <= now()` and advances the column in the
     * same transaction. The `(schedule IS NULL) = (next_run_at IS NULL)`
     * invariant is enforced by `chk_skills_next_run_at_iff_schedule` below.
     */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    /**
     * Who a cron fire runs as. Set iff the schedule is live — `schedule` set
     * on an enabled row (`chk_skills_run_as_iff_live_schedule`); see
     * design/skills.md → Run-as identity.
     */
    runAsUserId: uuid("run_as_user_id").references(() => users.id),
    runAsProfileId: uuid("run_as_profile_id").references(() => profiles.id),
    /** Last fire timestamp. Null = never fired. */
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    gitSha: text("git_sha").notNull(),
    /**
     * sha256 of `requirements.lock` at `git_sha`. Null when the skill's
     * manifest declares no dependencies. Drives the per-lockfile-hash venv
     * cache key and the reachability sweep: a `<hash>/` cache dir is GC-able
     * iff no enabled-or-disabled skill row carries it. Updated atomically
     * with `git_sha` in the same register/approve/rollback transaction.
     * See `design/skills.md` → Dependencies.
     */
    lockfileHash: text("lockfile_hash"),
    inputs: jsonbZod("inputs", SkillInputsSchema).notNull(),
    outputs: jsonbZod("outputs", SkillIoSchema), // null for side-effect-only skills
    disabled: boolean("disabled").notNull().default(false),
    createdAt: ts(),
  },
  (t) => [
    // Partial index over scheduled, enabled rows — the ticker's hot path. A
    // composite (disabled, next_run_at) index over the full table would scan
    // unscheduled rows on every tick; partial keeps the b-tree to just the
    // O(scheduled) rows that can actually fire.
    index("idx_skills_due").on(t.nextRunAt).where(sql`schedule IS NOT NULL AND disabled = false`),
    check(
      "chk_skills_next_run_at_iff_schedule",
      sql`(${t.schedule} IS NULL) = (${t.nextRunAt} IS NULL)`,
    ),
    check(
      "chk_skills_run_as_iff_live_schedule",
      sql`(${t.schedule} IS NOT NULL AND NOT ${t.disabled}) = (${t.runAsUserId} IS NOT NULL) AND (${t.schedule} IS NOT NULL AND NOT ${t.disabled}) = (${t.runAsProfileId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Append-only deploy history. One row per `register` attempt that produces a
 * classified result. `prior_git_sha` is the live version the deploy replaces
 * (a version with a `live` or `rolled_back` row), null when none was live;
 * the deploy notification shows it. The per-state columns follow
 * `status` (design/skills.md → Deploy lifecycle, per-state data):
 * `resolved_at` is set iff the row is terminal
 * (`chk_skill_deploys_resolved_at_iff_terminal`), and `approved_by` — the
 * identity that approved an `approve`-tier deploy — is set only on a `live`
 * row (`chk_skill_deploys_approved_by_only_live`); it stays null on a row
 * that went live without a human in the loop.
 */
export const skillDeploys = pgTable(
  "skill_deploys",
  {
    id: pk(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id),
    gitSha: text("git_sha").notNull(),
    priorGitSha: text("prior_git_sha"),
    riskTier: skillRiskTier("risk_tier").notNull(),
    status: skillDeployStatus("status").notNull(),
    approvedBy: uuid("approved_by").references(() => userIdentities.id),
    classifierLog: jsonbZod("classifier_log", ClassifierLogSchema).notNull(),
    /**
     * The schemas register checked for this deploy, which approve and
     * rollback put live. Null only on rows from before the column, whose
     * sha's frontmatter carries them.
     */
    schemas: jsonbZod("schemas", SkillSchemasSchema),
    /**
     * A rollback's target: the commit whose skill files the row's restoring
     * commit put back, never itself a restoring commit. Set iff the row is
     * `rolled_back`.
     */
    restoresGitSha: text("restores_git_sha"),
    createdAt: ts(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_skill_deploys_skill_id").on(t.skillId),
    check(
      "chk_skill_deploys_restores_iff_rolled_back",
      sql`(${t.status} = 'rolled_back') = (${t.restoresGitSha} IS NOT NULL)`,
    ),
    check(
      "chk_skill_deploys_resolved_at_iff_terminal",
      sql`(${t.status} = 'pending_approval') = (${t.resolvedAt} IS NULL)`,
    ),
    check(
      "chk_skill_deploys_approved_by_only_live",
      sql`${t.approvedBy} IS NULL OR ${t.status} = 'live'`,
    ),
  ],
);

/**
 * The commit that moved every skill to `skills/<name>/`, written once by
 * `migrateSkillsLayout`. A sha it is an ancestor of (or equal to) keeps a
 * skill's files in `skills/<name>/`; any other keeps them at the repo root
 * (design/skills.md → Per-skill structure).
 */
export const skillsRepoLayout = pgTable(
  "skills_repo_layout",
  {
    id: pk(),
    singleton: boolean("singleton").notNull().unique(),
    layoutCommitSha: text("layout_commit_sha").notNull(),
    createdAt: ts(),
  },
  (t) => [check("chk_skills_repo_layout_singleton", sql`${t.singleton}`)],
);

/**
 * Append-only invocation log. `inputs` / `output` are validated at invoke time
 * against the per-skill JSON Schema in the manifest (ajv); the store layer
 * round-trips them as opaque JSON.
 *
 * The lifecycle is `recovery_point` (the phase) with `status` (the verdict);
 * the `chk_skill_runs_*` CHECKs pin which columns each phase has set
 * (design/skills.md → At-most-once invocation → Per-state data).
 */
export const skillRuns = pgTable(
  "skill_runs",
  {
    id: pk(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id),
    trigger: skillRunTrigger("trigger").notNull(),
    inputs: jsonbZod("inputs", SkillInvocationInputsSchema).notNull(), // pass-through
    status: skillRunStatus("status").notNull(),
    // Null on error, but for an `output_invalid` one, which keeps what the
    // skill returned (`chk_skill_runs_outcome`).
    output: jsonbZod("output", SkillInvocationOutputSchema),
    error: text("error"),
    /** Set iff `error` is (`chk_skill_runs_error_kind_with_error`). */
    errorKind: skillRunErrorKind("error_kind"),
    /**
     * Per-run wall-clock + peak-memory metrics. Null before
     * `recovery_point='executed'`; written with the executed payload, or by
     * the sweeper. Shape defined by {@link SkillRunResourceUsageSchema} in
     * `../types.ts`.
     */
    resourceUsage: jsonbZod("resource_usage", SkillRunResourceUsageSchema),
    /**
     * Caller-supplied deterministic-per-fire token. Set when the run is
     * driven by a context that may retry (cron-fire dispatcher, agent-loop
     * tool call); null when the invocation is one-shot (CLI, ad-hoc
     * tests). The unique constraint below makes `runner.invoke` safe
     * against duplicate fires for the same logical trigger.
     */
    idempotencyKey: text("idempotency_key"),
    /**
     * Stripe-pattern phase marker. See `skillRunRecoveryPoint` enum
     * docstring. Defaults to `started` on insert.
     */
    recoveryPoint: skillRunRecoveryPoint("recovery_point").notNull().default("started"),
    /**
     * When the sweeper may take a dispatched run as lost: the dispatch time
     * plus the wall clock and a grace for the kill and the result frame.
     * Written by the dispatch, so null at `started`; null past it only on a
     * row never dispatched (`chk_skill_runs_deadline_at`).
     */
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    /**
     * The audit of who ran what: the skill's sha the run executed and its
     * run-as user and profile, set together (`chk_skill_runs_audit_together`)
     * on every new row. Null only on rows from before the columns.
     */
    gitSha: text("git_sha"),
    runAsUserId: uuid("run_as_user_id").references(() => users.id),
    runAsProfileId: uuid("run_as_profile_id").references(() => profiles.id),
    /** Whether the run is a shadow fire (design/skills.md → Risk tiers without a human). Written by every insert. */
    shadow: boolean("shadow").notNull(),
    // `architecture-rules.md` mandates `created_at` on every table; for an
    // append-only run log the row's creation time IS the start-of-execution
    // time.
    createdAt: ts(),
    /** When the worker returned, or the sweeper finished the run; null before `executed`. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_skill_runs_skill_id").on(t.skillId),
    // The sweeper's scan: only runs in flight, a handful against an
    // append-only log.
    index("idx_skill_runs_running").on(t.createdAt).where(RUNNING_RUN),
    // `deleteProfile` counts the runs that ran as a profile.
    index("idx_skill_runs_run_as_profile_id").on(t.runAsProfileId),
    // Plain UNIQUE constraint — Postgres treats NULLs as not-equal under
    // default unique semantics, so multiple null-key rows (CLI / tests)
    // coexist freely while non-null keys are constrained to one row.
    unique("uniq_skill_runs_idempotency_key").on(t.idempotencyKey),
    // A terminal verdict exists exactly in the `finished` phase.
    check(
      "chk_skill_runs_status_iff_finished",
      sql`(${t.recoveryPoint} = 'finished') = (${t.status} <> 'running')`,
    ),
    // The executed payload (`finished_at`, `resource_usage`, and whichever of
    // `output` / `error` the worker produced) arrives with the `executed`
    // phase and is absent before it.
    check(
      "chk_skill_runs_executed_payload",
      sql`(${t.recoveryPoint} IN ('executed', 'finished')) = (${t.finishedAt} IS NOT NULL) AND (${t.recoveryPoint} IN ('executed', 'finished')) = (${t.resourceUsage} IS NOT NULL) AND (${t.recoveryPoint} IN ('executed', 'finished') OR (${t.output} IS NULL AND ${t.error} IS NULL))`,
    ),
    // `output` and `error` are alternatives, but for an `output_invalid`
    // verdict, which keeps what the skill returned; an `error` verdict names
    // its reason, a `success` verdict has no error.
    check(
      "chk_skill_runs_outcome",
      sql`(${t.output} IS NULL OR ${t.error} IS NULL OR (${t.status} = 'error' AND ${t.errorKind} = 'output_invalid')) AND (${t.status} <> 'success' OR ${t.error} IS NULL) AND (${t.status} <> 'error' OR ${t.error} IS NOT NULL)`,
    ),
    check(
      "chk_skill_runs_error_kind_with_error",
      sql`(${t.errorKind} IS NULL) = (${t.error} IS NULL)`,
    ),
    // `deadline_at` arrives with the dispatch and stays.
    check(
      "chk_skill_runs_deadline_at",
      sql`(${t.recoveryPoint} <> 'started' OR ${t.deadlineAt} IS NULL) AND (${t.recoveryPoint} IN ('started', 'executed', 'finished') OR ${t.deadlineAt} IS NOT NULL)`,
    ),
    check(
      "chk_skill_runs_audit_together",
      sql`(${t.gitSha} IS NULL) = (${t.runAsUserId} IS NULL) AND (${t.gitSha} IS NULL) = (${t.runAsProfileId} IS NULL)`,
    ),
  ],
);

/**
 * Per-`ctx.*` RPC audit log scoped to a `skill_runs` row. `target` carries the
 * method's *target name* (secret name, memory bank, model id) — never the
 * value. Frame-layer logging in the worker never writes ctx_result payloads;
 * this row is the only persisted trace of what a skill touched.
 */
export const skillContextCalls = pgTable(
  "skill_context_calls",
  {
    id: pk(),
    runId: uuid("run_id")
      .notNull()
      .references(() => skillRuns.id),
    method: text("method").notNull(), // 'secrets.get' | 'memory.recall' | ...
    target: text("target"), // null when the method takes no target (e.g. `now()`)
    ok: boolean("ok").notNull(),
    error: text("error"),
    // `architecture-rules.md` mandates `created_at`; for this audit log the
    // creation time IS the call time.
    createdAt: ts(),
  },
  (t) => [index("idx_skill_context_calls_run_id").on(t.runId)],
);
