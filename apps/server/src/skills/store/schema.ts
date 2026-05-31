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
 *   - `started` — row inserted; execute hasn't completed. A retry that
 *     sees this state refuses re-execution: the original may have
 *     crashed mid-execute OR another worker may be currently executing
 *     this same key. Either way, re-executing would risk double-firing
 *     non-idempotent side effects. See `SkillInflightError` in
 *     `runner.ts` for the discrimination rationale.
 *   - `executed` — execute completed and its result is committed
 *     (output/error/rusage/finished_at). Output validation + final
 *     `status` write may not have happened yet. A retry replays only
 *     the cheap finalize step against the cached execute payload.
 *   - `finished` — `status` set, audit row terminal. A retry returns the
 *     cached result without touching the runtime.
 *
 * See `design/skills.md` → Exactly-once invocation. Pattern derives from
 * brandur.org/idempotency-keys (atomic phases + recovery points).
 */
export const skillRunRecoveryPoint = pgEnum("skill_run_recovery_point", [
  "started",
  "executed",
  "finished",
]);

export const skillDeployStatus = pgEnum("skill_deploy_status", [
  "pending_approval",
  "approved",
  "denied",
  "live",
  "rolled_back",
]);

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
  ],
);

/**
 * Append-only deploy history. One row per `register` attempt that produces a
 * classified result. `prior_git_sha` is null on first deploy and used by
 * `rollback` to find the previous live SHA. `approved_by` is null for `auto`
 * and `notify` tiers (no human in the loop) and set when an `approve`-tier
 * deploy resolves via the Telegram approval flow.
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
    createdAt: ts(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("idx_skill_deploys_skill_id").on(t.skillId)],
);

/**
 * Append-only invocation log. `inputs` / `output` are validated at invoke time
 * against the per-skill JSON Schema in the manifest (ajv); the store layer
 * round-trips them as opaque JSON.
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
    output: jsonbZod("output", SkillInvocationOutputSchema), // null on error
    error: text("error"),
    /**
     * Per-run wall-clock + peak-memory metrics. Null while the run is in
     * `status='running'`; written at finalisation time by the host. Shape
     * defined by {@link SkillRunResourceUsageSchema} in `../types.ts`.
     */
    resourceUsage: jsonbZod("resource_usage", SkillRunResourceUsageSchema),
    /**
     * Caller-supplied deterministic-per-fire token. Set when the run is
     * driven by a context that may retry (cron-fire dispatcher, agent-loop
     * tool call); null when the invocation is one-shot (CLI, ad-hoc
     * tests). The partial unique index below makes `runner.invoke` safe
     * against duplicate fires for the same logical trigger.
     */
    idempotencyKey: text("idempotency_key"),
    /**
     * Stripe-pattern phase marker. See `skillRunRecoveryPoint` enum
     * docstring. Defaults to `started` on insert; transitions to
     * `executed` after the worker returns; to `finished` after the row
     * is terminal.
     */
    recoveryPoint: skillRunRecoveryPoint("recovery_point").notNull().default("started"),
    // CLAUDE.md mandates `created_at` on every table; for an append-only run
    // log the row's creation time IS the start-of-execution time.
    createdAt: ts(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_skill_runs_skill_id").on(t.skillId),
    // Plain UNIQUE constraint — Postgres treats NULLs as not-equal under
    // default unique semantics, so multiple null-key rows (CLI / tests)
    // coexist freely while non-null keys are constrained to one row.
    // Concurrent attempts with the same key race here; the loser's
    // INSERT no-ops via `ON CONFLICT DO NOTHING` and the caller
    // re-selects the existing row.
    unique("uniq_skill_runs_idempotency_key").on(t.idempotencyKey),
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
    // CLAUDE.md mandates `created_at`; for this audit log the creation time
    // IS the call time.
    createdAt: ts(),
  },
  (t) => [index("idx_skill_context_calls_run_id").on(t.runId)],
);
