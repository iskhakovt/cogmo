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
import type { ScheduledTaskSummary, SchedulingError } from "./scheduling-service.js";

const recurringSchema = z.object({
  kind: z.literal("recurring"),
  cron: z
    .string()
    .describe(
      "Standard 5-field cron expression (minute hour day-of-month month day-of-week). " +
        "Examples: '0 9 * * *' (every day at 09:00), '0 9 * * 1-5' (weekdays at 09:00), " +
        "'0 17 * * 5' (every Friday at 17:00). 6-field crons with seconds are not " +
        "supported — the minimum interval is one minute.",
    ),
});

const oneOffSchema = z.object({
  kind: z.literal("one_off"),
  runAt: z
    .string()
    .describe(
      "Future ISO 8601 timestamp with an explicit timezone marker. " +
        "Examples: '2026-06-01T15:00:00Z' (UTC), '2026-06-01T15:00:00+01:00' " +
        "(with offset). A bare local string like '2026-06-01T15:00:00' is rejected " +
        "because the timezone would be ambiguous.",
    ),
});

const scheduleTaskSchema = z.object({
  schedule: z.discriminatedUnion("kind", [recurringSchema, oneOffSchema]),
  prompt: z
    .string()
    .describe(
      "The prompt to run when the task fires. Treated as a user-role message into " +
        "the agent loop with the scheduled-for timestamp embedded, so the model " +
        "knows it's running on a schedule and what it was supposed to do.",
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
});

export const scheduleTask = defineTool({
  name: "schedule_task",
  description:
    "Schedule a future action to run on a cron schedule or at a specific timestamp. " +
    "The action re-enters the agent loop as a user-role message containing the prompt " +
    "you provide, delivered to whatever channel the user is currently online on. " +
    "Use this for reminders, recurring check-ins, scheduled briefings, and any " +
    "agent-initiated nudge. Cancel via `remove_task`, view via `list_tasks`.",
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
            ...(input.catchupMissed !== undefined && { catchupMissed: input.catchupMissed }),
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
  id: z.string().describe("The scheduled task id (from `list_tasks` or `schedule_task` output)."),
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
 * the id (truncated to 8 chars for readability — the LLM passes the
 * full id from the JSON tool input on `remove_task`, not from this
 * text), kind/schedule, prompt, next fire, and enabled state.
 *
 * Format guidelines applied:
 *  - Newest-first (matches store ordering).
 *  - ISO timestamps for `nextRunAt` so the LLM can do exact-date math.
 *  - Truncate prompts at 80 chars so a list of 50 tasks doesn't blow
 *    the context budget on prompt repetition.
 */
function formatTaskList(tasks: ReadonlyArray<ScheduledTaskSummary>): string {
  const header = `You have ${tasks.length} scheduled task${tasks.length === 1 ? "" : "s"}:`;
  const lines = tasks.map((t, i) => {
    const schedule =
      t.kind === "recurring" ? `cron '${t.cron}' (${t.timezone})` : `one-off (${t.timezone})`;
    const promptPreview = t.prompt.length > 80 ? `${t.prompt.slice(0, 77)}...` : t.prompt;
    const state = t.enabled ? "enabled" : "disabled";
    return `${i + 1}. [${t.id}] ${schedule} — '${promptPreview}' — next: ${t.nextRunAt.toISOString()} (${state}).`;
  });
  return [header, ...lines].join("\n");
}
