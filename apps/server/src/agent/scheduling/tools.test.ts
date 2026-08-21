/**
 * Agent-tool tests for schedule_task / list_tasks / remove_task.
 *
 * Mocks `service.scheduling` (the SchedulingService) — the underlying
 * service is tested separately in `scheduling-service.test.ts`. These
 * tests focus on:
 *   1. Zod schema parsing (each tool rejects malformed input loudly)
 *   2. Service dispatch (each tool calls the right method with the right shape)
 *   3. Result formatting (errors render as helpful LLM-readable text;
 *      success returns a structured summary)
 *   4. Service-absent path (tools return a graceful error instead of crashing)
 */

import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Service } from "../service.js";
import type {
  ScheduledTaskSummary,
  SchedulingError,
  SchedulingService,
} from "./scheduling-service.js";
import { listTasks, removeTask, scheduleTask } from "./tools.js";

/**
 * Hand-built Service stub with `scheduling` populated. Per CLAUDE.md →
 * Testing, optional sub-namespaces are spread conditionally rather
 * than assigned to a `mock<Service>()` Proxy — `mock<Service>()`
 * auto-mocks every field on access (including the optional ones),
 * which makes the absent-sub-namespace path untestable. Pair with
 * `buildServiceWithoutScheduling()` for the graceful-error branch.
 */
function buildService(overrides?: Partial<SchedulingService>): Service {
  const scheduling = mock<SchedulingService>();
  if (overrides) Object.assign(scheduling, overrides);
  return {
    memory: mock<Service["memory"]>(),
    files: mock<Service["files"]>(),
    coreMemory: mock<Service["coreMemory"]>(),
    scheduling,
  };
}

/** Service stub WITHOUT the `scheduling` namespace — drives the
 * graceful-error branch in each tool. */
function buildServiceWithoutScheduling(): Service {
  return {
    memory: mock<Service["memory"]>(),
    files: mock<Service["files"]>(),
    coreMemory: mock<Service["coreMemory"]>(),
  };
}

describe("scheduleTask tool", () => {
  it("dispatches recurring create to service.scheduling.create", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(ok({ id: "task-1", nextRunAt: new Date("2026-06-01T09:00:00Z") }));
    const service = buildService({ create });

    const result = await scheduleTask.handler(
      {
        schedule: { kind: "recurring", cron: "0 9 * * *" },
        prompt: "morning briefing",
      },
      service,
    );

    expect(create).toHaveBeenCalledWith({
      kind: "recurring",
      cron: "0 9 * * *",
      prompt: "morning briefing",
    });
    expect(result).toContain("Scheduled task task-1");
    expect(result).toContain("2026-06-01T09:00:00.000Z");
  });

  it("forwards the call context's idempotency key, and omits it when absent", async () => {
    // A duplicate schedule fires on every tick from then on, so this is the
    // durable tool whose crash window matters most.
    const create = vi
      .fn()
      .mockResolvedValue(ok({ id: "task-1", nextRunAt: new Date("2026-06-01T09:00:00Z") }));
    const args = {
      schedule: { kind: "recurring" as const, cron: "0 9 * * *" },
      prompt: "morning briefing",
    };

    await scheduleTask.handler(args, buildService({ create }), {
      idempotencyKey: "inbound-42:deadbeefdeadbeef",
    });
    expect(create).toHaveBeenLastCalledWith(
      expect.anything(),
      "schedule_task:inbound-42:deadbeefdeadbeef",
    );

    // No context (CLI, wizard, loops outside Inngest): the service sees a
    // one-argument call, so an unkeyed row is inserted as before.
    await scheduleTask.handler(args, buildService({ create }));
    expect(create).toHaveBeenLastCalledWith(expect.anything());
  });

  it("dispatches one-off create with runAt + threading optional fields", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(ok({ id: "task-2", nextRunAt: new Date("2026-06-01T15:00:00Z") }));
    const service = buildService({ create });

    await scheduleTask.handler(
      {
        schedule: { kind: "one_off", runAt: "2026-06-01T15:00:00Z" },
        prompt: "remind me",
        timezone: "Europe/London",
      },
      service,
    );

    expect(create).toHaveBeenCalledWith({
      kind: "one_off",
      runAt: "2026-06-01T15:00:00Z",
      prompt: "remind me",
      timezone: "Europe/London",
    });
  });

  it("threads catchupMissed through to the service (nested in recurring schedule)", async () => {
    const create = vi.fn().mockResolvedValue(ok({ id: "task-3", nextRunAt: new Date() }));
    const service = buildService({ create });

    // catchupMissed now lives inside `schedule` (recurring branch) — see
    // tools.ts schema. Passing it at top level would fail Zod parse
    // (handled in the schema-rejection tests below).
    await scheduleTask.handler(
      {
        schedule: { kind: "recurring", cron: "0 9 * * *", catchupMissed: true },
        prompt: "x",
      },
      service,
    );

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ catchupMissed: true }));
  });

  it("omits optional fields from the service call when not provided (no undefined props)", async () => {
    const create = vi.fn().mockResolvedValue(ok({ id: "t", nextRunAt: new Date() }));
    const service = buildService({ create });

    await scheduleTask.handler(
      { schedule: { kind: "recurring", cron: "0 9 * * *" }, prompt: "x" },
      service,
    );

    const [args] = create.mock.calls[0] ?? [];
    expect(args).not.toHaveProperty("timezone");
    expect(args).not.toHaveProperty("catchupMissed");
  });

  // --- Error rendering: each SchedulingError kind produces helpful LLM-readable text ---

  it.each<[string, SchedulingError, RegExp]>([
    [
      "malformed cron",
      { kind: "validation", cause: { kind: "malformed", message: "bad" } },
      /cron expression is malformed: bad/,
    ],
    [
      "unsupported field count",
      { kind: "validation", cause: { kind: "unsupported_field_count", got: 6, expected: 5 } },
      /6 field\(s\), expected 5/,
    ],
    [
      "invalid timezone",
      { kind: "validation", cause: { kind: "invalid_timezone", timezone: "Atlantis" } },
      /timezone 'Atlantis' is not recognised/,
    ],
    [
      "interval too short",
      {
        kind: "validation",
        cause: { kind: "interval_too_short", periodSeconds: 30, minSeconds: 60 },
      },
      /fires every 30s.*minimum allowed interval is 60s/,
    ],
    [
      "no future occurrence",
      { kind: "validation", cause: { kind: "no_next_occurrence" } },
      /no future occurrence/,
    ],
    [
      "invalid runAt",
      { kind: "invalid_run_at", runAt: "nope", message: "not parseable" },
      /invalid runAt 'nope'.*not parseable/,
    ],
    [
      "task cap exceeded",
      { kind: "task_cap_exceeded", limit: 200, current: 200 },
      /scheduled-task cap \(200\/200\).*Remove an unused task/,
    ],
  ])("formats SchedulingError kind=%s", async (_label, error, pattern) => {
    const service = buildService({ create: vi.fn().mockResolvedValue(err(error)) });
    const result = await scheduleTask.handler(
      { schedule: { kind: "recurring", cron: "0 9 * * *" }, prompt: "x" },
      service,
    );
    expect(result).toMatch(pattern);
  });

  it("returns a graceful message when service.scheduling is absent", async () => {
    const result = await scheduleTask.handler(
      { schedule: { kind: "recurring", cron: "0 9 * * *" }, prompt: "x" },
      buildServiceWithoutScheduling(),
    );
    expect(result).toMatch(/Scheduling is not available/);
  });
});

describe("listTasks tool", () => {
  function mkTask(overrides: Partial<ScheduledTaskSummary>): ScheduledTaskSummary {
    return {
      id: "task-x",
      kind: "recurring",
      cron: "0 9 * * *",
      prompt: "x",
      timezone: "UTC",
      nextRunAt: new Date("2026-06-01T09:00:00Z"),
      lastRunAt: null,
      enabled: true,
      ...overrides,
    };
  }

  it("returns 'No scheduled tasks.' when the list is empty", async () => {
    const service = buildService({ list: vi.fn().mockResolvedValue([]) });
    expect(await listTasks.handler({}, service)).toBe("No scheduled tasks.");
  });

  it("renders one task as a numbered line with id, schedule, prompt, next, state", async () => {
    const service = buildService({
      list: vi.fn().mockResolvedValue([
        mkTask({
          id: "task-1",
          kind: "recurring",
          cron: "0 9 * * *",
          timezone: "Europe/London",
          prompt: "morning briefing",
        }),
      ]),
    });

    const result = await listTasks.handler({}, service);
    expect(result).toContain("You have 1 scheduled task:");
    expect(result).toContain("[task-1]");
    expect(result).toContain("cron '0 9 * * *' (Europe/London)");
    expect(result).toContain("morning briefing");
    expect(result).toContain("2026-06-01T09:00:00.000Z");
    expect(result).toContain("(enabled)");
  });

  it("renders multiple tasks pluralised", async () => {
    const service = buildService({
      list: vi
        .fn()
        .mockResolvedValue([mkTask({ id: "a" }), mkTask({ id: "b" }), mkTask({ id: "c" })]),
    });
    expect(await listTasks.handler({}, service)).toContain("You have 3 scheduled tasks:");
  });

  it("marks disabled rows clearly", async () => {
    const service = buildService({
      list: vi.fn().mockResolvedValue([mkTask({ enabled: false })]),
    });
    expect(await listTasks.handler({}, service)).toContain("(disabled)");
  });

  it("describes one-off tasks differently (no cron, just tz)", async () => {
    const service = buildService({
      list: vi.fn().mockResolvedValue([mkTask({ kind: "one_off", cron: null, timezone: "UTC" })]),
    });
    expect(await listTasks.handler({}, service)).toContain("one-off (UTC)");
  });

  it("truncates long prompts at 80 chars to keep the listing scannable", async () => {
    const longPrompt = "a".repeat(200);
    const service = buildService({
      list: vi.fn().mockResolvedValue([mkTask({ prompt: longPrompt })]),
    });
    const result = await listTasks.handler({}, service);
    // 77 chars of original + "..." = 80
    expect(result).toContain(`${"a".repeat(77)}...`);
    // The full 200-char version is NOT in the output.
    expect(result).not.toContain("a".repeat(81));
  });

  it("returns a graceful message when service.scheduling is absent", async () => {
    expect(await listTasks.handler({}, buildServiceWithoutScheduling())).toMatch(
      /Scheduling is not available/,
    );
  });
});

describe("removeTask tool", () => {
  // The tool schema enforces `.uuid()` on `id`, so test inputs must
  // be UUID-shaped. Pinned constants keep the tests readable.
  const VALID_ID_A = "019e2900-0000-7000-8000-000000000001";
  const VALID_ID_MISSING = "019e2900-0000-7000-8000-000000000002";

  it("dispatches to service.scheduling.remove and reports success", async () => {
    const remove = vi.fn().mockResolvedValue(ok(undefined));
    const service = buildService({ remove });

    const result = await removeTask.handler({ id: VALID_ID_A }, service);

    expect(remove).toHaveBeenCalledWith(VALID_ID_A);
    expect(result).toBe(`Removed task ${VALID_ID_A}.`);
  });

  it("renders not_found cleanly", async () => {
    const service = buildService({
      remove: vi.fn().mockResolvedValue(err({ kind: "not_found", id: VALID_ID_MISSING })),
    });
    const result = await removeTask.handler({ id: VALID_ID_MISSING }, service);
    expect(result).toMatch(new RegExp(`no scheduled task with id '${VALID_ID_MISSING}'`));
  });

  it("returns a graceful message when service.scheduling is absent", async () => {
    expect(
      await removeTask.handler(
        { id: "00000000-0000-7000-8000-000000000001" },
        buildServiceWithoutScheduling(),
      ),
    ).toMatch(/Scheduling is not available/);
  });
});

describe("Tool schemas reject malformed input", () => {
  // The defineTool wrapper runs schema.parse on raw input before
  // invoking the handler — these tests prove the Zod gate fires.
  // `ToolSpec.handler` is typed as `(input: Record<string, unknown>, ...)`
  // so structurally-bad inputs are type-valid; the rejection is a
  // pure runtime contract from Zod. No casts needed.

  it("scheduleTask: rejects schedule.kind outside the union", async () => {
    const service = buildService({ create: vi.fn() });
    await expect(
      scheduleTask.handler({ schedule: { kind: "weekly" }, prompt: "x" }, service),
    ).rejects.toThrow();
  });

  it("scheduleTask: rejects when prompt is missing", async () => {
    const service = buildService({ create: vi.fn() });
    await expect(
      scheduleTask.handler({ schedule: { kind: "recurring", cron: "0 9 * * *" } }, service),
    ).rejects.toThrow();
  });

  it("scheduleTask: rejects when prompt exceeds the max length", async () => {
    // Regression guard for the new `prompt.max(MAX_PROMPT_LENGTH)` cap
    // — a multi-KB prompt would balloon every fire as it's replayed
    // verbatim into the agent loop.
    const service = buildService({ create: vi.fn() });
    const tooLong = "a".repeat(5000);
    await expect(
      scheduleTask.handler(
        { schedule: { kind: "recurring", cron: "0 9 * * *" }, prompt: tooLong },
        service,
      ),
    ).rejects.toThrow();
  });

  it("scheduleTask: rejects catchupMissed on the one_off branch (schema-unrepresentable)", async () => {
    // catchupMissed lives inside the recurring schema. Passing it
    // alongside `kind: "one_off"` should fail Zod discriminator parse.
    const service = buildService({ create: vi.fn() });
    await expect(
      scheduleTask.handler(
        {
          schedule: { kind: "one_off", runAt: "2099-01-01T00:00:00Z", catchupMissed: true },
          prompt: "x",
        },
        service,
      ),
    ).rejects.toThrow();
  });

  it("removeTask: rejects when id is missing", async () => {
    const service = buildService({ remove: vi.fn() });
    await expect(removeTask.handler({}, service)).rejects.toThrow();
  });

  it("removeTask: rejects when id is not a UUID", async () => {
    // Regression guard: a non-UUID id at the tool boundary would
    // otherwise reach `getScheduledTask`'s WHERE-on-uuid-column query
    // and raise PG 22P02, escaping the Result envelope.
    const service = buildService({ remove: vi.fn() });
    await expect(removeTask.handler({ id: "not-a-uuid" }, service)).rejects.toThrow();
  });
});
