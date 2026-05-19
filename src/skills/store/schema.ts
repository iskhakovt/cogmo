import { sql } from "drizzle-orm";
import { boolean, check, index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
    // CLAUDE.md mandates `created_at` on every table; for an append-only run
    // log the row's creation time IS the start-of-execution time.
    createdAt: ts(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("idx_skill_runs_skill_id").on(t.skillId)],
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
