/**
 * Agent tools for self-scheduling. The LLM calls these to schedule
 * future actions, list current schedules, and cancel one.
 *
 * All three tools delegate to `service.scheduling` (the per-conversation
 * scoped `SchedulingService`). Validation, cap enforcement, and timezone
 * defaulting live in the service, so the tools are dumb adapters that
 * parse Zod input, call the service, and format the result back into
 * LLM-readable text.
 *
 * On error, the tools render the structured `SchedulingError` into a
 * short instructive message so the LLM can self-correct from a single
 * `tool_result` round-trip without an infinite-retry loop (cf.
 * openclaw#9283).
 */

import { z } from "zod";
import { defineTool } from "../tools.js";
import type { CronValidationError } from "./cron.js";
import { MIN_CRON_INTERVAL_SECONDS } from "./cron.js";
import {
  MAX_PROMPT_LENGTH,
  type ScheduledTaskSummary,
  type SchedulingError,
} from "./scheduling-service.js";

// `.strict()` on both branches so an LLM hallucination (e.g.
// `catchupMissed` on a `one_off`, or any typo'd field) produces a
// Zod parse error rather than silently dropping the field. The
// error propagates back as a `tool_result` so the LLM self-corrects.
const recurringSchema = z
  .object({
    kind: z.literal("recurring"),
    cron: z
      .string()
      .describe(
        "Standard 5-field cron expression (minute hour day-of-month month day-of-week). " +
          "Examples: '0 9 * * *' (every day at 09:00), '0 9 * * 1-5' (weekdays at 09:00), " +
          "'0 17 * * 5' (every Friday at 17:00). 6-field crons with seconds are not " +
          "supported — the minimum interval is one minute.",
      ),
    // catchupMissed lives inside `recurring` rather than top-level so
    // the schema makes `kind: "one_off"` + `catchupMissed` unrepresentable.
    // Combined with `.strict()`, the LLM gets a clear Zod error instead
    // of silently dropping a flag it thought it had set.
    catchupMissed: z
      .boolean()
      .optional()
      .describe(
        "Recurring only. When false (default), an outage causes one fire with the " +
          "missed timestamp and then skip ahead to the next future occurrence. When " +
          "true, every missed occurrence fires one-at-a-time on subsequent ticker " +
          "ticks. Set true for tasks where backfill matters (e.g. daily report " +
          "generation); leave false for reminders and briefings where 'one fire is " +
          "enough'.",
      ),
  })
  .strict();

const oneOffSchema = z
  .object({
    kind: z.literal("one_off"),
    runAt: z
      .string()
      .describe(
        "Future ISO 8601 timestamp with an explicit timezone marker. " +
          "Examples: '2026-06-01T15:00:00Z' (UTC), '2026-06-01T15:00:00+01:00' " +
          "(with offset). A bare local string like '2026-06-01T15:00:00' is rejected " +
          "because the timezone would be ambiguous.",
      ),
  })
  .strict();

const scheduleTaskSchema = z.object({
  schedule: z.discriminatedUnion("kind", [recurringSchema, oneOffSchema]),
  prompt: z
    .string()
    .min(1)
    .max(MAX_PROMPT_LENGTH)
    .describe(
      "The prompt to run when the task fires. Treated as a user-role message into " +
        "the agent loop with the scheduled-for timestamp embedded, so the model " +
        "knows it's running on a schedule and what it was supposed to do. " +
        `Max ${MAX_PROMPT_LENGTH} characters.`,
    ),
  timezone: z
    .string()
    .optional()
    .describe(
      "IANA timezone for cron interpretation (e.g. 'Europe/London', 'America/New_York'). " +
        "Optional — defaults to the user's configured timezone. For one-off tasks, " +
        "this is only used for display in `list_tasks`; the runAt instant itself " +
        "carries the timezone via its offset marker.",
    ),
});

export const scheduleTask = defineTool({
  name: "schedule_task",
  description:
    "Schedule a future action to run on a cron schedule or at a specific timestamp. " +
    "The action re-enters the agent loop as a user-role message containing the prompt " +
    "you provide, delivered to whatever channel the user is currently online on. " +
    "Use this for reminders, recurring check-ins, scheduled briefings, and any " +
    "agent-initiated nudge. Cancel via `remove_task`, view via `list_tasks`. " +
    // The offline-drop behavior is load-bearing for what the LLM should
    // promise the user. Surface it so "I'll remind you in 5 min" doesn't
    // imply guaranteed delivery if the user is about to close the chat.
    "Note: fires are only delivered when the user has an active channel session " +
    "for this profile. If the user is offline at fire time, the fire is logged " +
    "but NOT delivered — there's no retry and no catch-up on next sign-in. " +
    "Tell the user this if a reminder time is at risk of being offline.",
  schema: scheduleTaskSchema,
  handler: async (input, service) => {
    if (!service.scheduling) {
      return "Scheduling is not available in this conversation.";
    }
    const args =
      input.schedule.kind === "recurring"
        ? ({
            kind: "recurring" as const,
            cron: input.schedule.cron,
            prompt: input.prompt,
            ...(input.timezone !== undefined && { timezone: input.timezone }),
            ...(input.schedule.catchupMissed !== undefined && {
              catchupMissed: input.schedule.catchupMissed,
            }),
          } as const)
        : ({
            kind: "one_off" as const,
            runAt: input.schedule.runAt,
            prompt: input.prompt,
            ...(input.timezone !== undefined && { timezone: input.timezone }),
          } as const);

    const result = await service.scheduling.create(args);
    if (result.isErr()) {
      return formatSchedulingError(result.error);
    }
    return `Scheduled task ${result.value.id}. First fire: ${result.value.nextRunAt.toISOString()}.`;
  },
});

const listTasksSchema = z.object({});

export const listTasks = defineTool({
  name: "list_tasks",
  description:
    "List all scheduled tasks for the user, including disabled ones. Use to find " +
    "task ids for `remove_task`, or to answer the user's 'what's scheduled?' " +
    "question. Returns a numbered list with id, schedule, prompt, next fire, " +
    "and enabled state.",
  sideEffectful: false,
  schema: listTasksSchema,
  handler: async (_input, service) => {
    if (!service.scheduling) {
      return "Scheduling is not available in this conversation.";
    }
    const tasks = await service.scheduling.list();
    if (tasks.length === 0) {
      return "No scheduled tasks.";
    }
    return formatTaskList(tasks);
  },
});

const removeTaskSchema = z.object({
  // `.uuid()` here rejects non-UUID strings at the tool boundary
  // (before the DB hit). Without it, `getScheduledTask`'s WHERE
  // against a uuid column raises PG 22P02 invalid_text_representation,
  // which escapes the Result envelope and surfaces to the LLM as a
  // raw exception.
  id: z
    .string()
    .uuid()
    .describe("The scheduled task id (from `list_tasks` or `schedule_task` output)."),
});

export const removeTask = defineTool({
  name: "remove_task",
  description:
    "Cancel a scheduled task by id. Permanent — there's no undo. Get the id from " +
    "`list_tasks`. Returns success or a clear error if the task didn't exist or " +
    "belongs to another user.",
  schema: removeTaskSchema,
  handler: async (input, service) => {
    if (!service.scheduling) {
      return "Scheduling is not available in this conversation.";
    }
    const result = await service.scheduling.remove(input.id);
    if (result.isErr()) {
      return formatSchedulingError(result.error);
    }
    return `Removed task ${input.id}.`;
  },
});

export const schedulingTools = [scheduleTask, listTasks, removeTask];

/** Render a `SchedulingError` into LLM-readable text. */
function formatSchedulingError(err: SchedulingError): string {
  switch (err.kind) {
    case "validation":
      return `Error validating schedule: ${formatCronValidationError(err.cause)}`;
    case "invalid_run_at":
      return `Error: invalid runAt '${err.runAt}'. ${err.message}`;
    case "prompt_too_long":
      return (
        `Error: prompt is ${err.length} characters but max is ${err.maxLength}. ` +
        "Shorten the prompt — the model gets context from conversation history when the fire lands, so the prompt only needs to be the trigger instruction."
      );
    case "task_cap_exceeded":
      return (
        `Error: you've hit the scheduled-task cap (${err.current}/${err.limit}). ` +
        "Remove an unused task with `remove_task` before scheduling another."
      );
    case "not_found":
      return `Error: no scheduled task with id '${err.id}' found for this user.`;
  }
}

function formatCronValidationError(err: CronValidationError): string {
  switch (err.kind) {
    case "unsupported_field_count":
      return (
        `cron expression has ${err.got} field(s), expected ${err.expected}. ` +
        "Use a standard 5-field cron — minute hour day-of-month month day-of-week."
      );
    case "invalid_timezone":
      return (
        `timezone '${err.timezone}' is not recognised. Use an IANA name like ` +
        "'Europe/London', 'America/New_York', or 'UTC'."
      );
    case "malformed":
      return `cron expression is malformed: ${err.message}`;
    case "interval_too_short":
      return (
        `cron fires every ${err.periodSeconds}s, but the minimum allowed interval ` +
        `is ${err.minSeconds}s (${MIN_CRON_INTERVAL_SECONDS}). Widen the schedule.`
      );
    case "no_next_occurrence":
      return "cron expression has no future occurrence (year-range exhausted).";
  }
}

/**
 * Render a list of scheduled tasks for the LLM. One line per task with
 * the full id, kind/schedule, prompt preview, next fire, and enabled
 * state. The full id is included so the LLM can copy it directly into
 * `remove_task` without a separate lookup.
 *
 * Format guidelines applied:
 *  - Sorted by `nextRunAt` ascending so "what fires next" reads top-down.
 *    Disabled rows sink to the end (their `nextRunAt` is frozen at the
 *    last fire time and isn't meaningful for ordering).
 *  - ISO timestamps for `nextRunAt` so the LLM can do exact-date math.
 *  - Truncate prompts at 80 chars so a list of 50 tasks doesn't blow
 *    the context budget on prompt repetition.
 */
function formatTaskList(tasks: ReadonlyArray<ScheduledTaskSummary>): string {
  // Re-sort here (store returns newest-first by createdAt) so the LLM
  // sees what fires next at the top. Secondary sort is "enabled before
  // disabled" — a disabled row's `nextRunAt` is the last-fired time, not
  // upcoming, so disabled rows sink to the end regardless of timestamp.
  const sorted = [...tasks].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.nextRunAt.getTime() - b.nextRunAt.getTime();
  });
  const header = `You have ${tasks.length} scheduled task${tasks.length === 1 ? "" : "s"}:`;
  const lines = sorted.map((t, i) => {
    const schedule =
      t.kind === "recurring" ? `cron '${t.cron}' (${t.timezone})` : `one-off (${t.timezone})`;
    const promptPreview = t.prompt.length > 80 ? `${t.prompt.slice(0, 77)}...` : t.prompt;
    const state = t.enabled ? "enabled" : "disabled";
    return `${i + 1}. [${t.id}] ${schedule} — '${promptPreview}' — next: ${t.nextRunAt.toISOString()} (${state}).`;
  });
  return [header, ...lines].join("\n");
}
