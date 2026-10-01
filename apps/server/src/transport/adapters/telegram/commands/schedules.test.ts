import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { mkCtx, transportWith } from "../../../../test/telegram/command-fixtures.js";
import { handleSchedules } from "./schedules.js";

describe("handleSchedules", () => {
  const TASK_ID_A = "019e2900-0000-7000-8000-000000000001";
  const TASK_ID_B = "019e2900-0000-7000-8000-000000000002";

  // --- /schedules (list) ---

  it("renders a numbered list with full ids and a per-task block", async () => {
    const transport = transportWith({
      scheduling: {
        list: vi.fn().mockResolvedValue(
          ok([
            {
              id: TASK_ID_A,
              kind: "recurring",
              cron: "0 9 * * *",
              prompt: "morning briefing",
              timezone: "Europe/London",
              nextRunAt: new Date("2026-06-01T08:00:00Z"),
              lastRunAt: null,
              enabled: true,
            },
          ]),
        ),
      },
    });
    const ctx = mkCtx();
    await handleSchedules(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain("Scheduled tasks (1):");
    expect(reply).toContain(TASK_ID_A);
    expect(reply).toContain("cron '0 9 * * *' (Europe/London)");
    expect(reply).toContain("morning briefing");
    expect(reply).toContain("next: 2026-06-01T08:00:00.000Z");
    // Enabled rows have no marker (only disabled ones do).
    expect(reply).not.toContain("[disabled]");
  });

  it("nudges the user when there are no tasks", async () => {
    const transport = transportWith({
      scheduling: { list: vi.fn().mockResolvedValue(ok([])) },
    });
    const ctx = mkCtx();
    await handleSchedules(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("No scheduled tasks");
  });

  it("marks disabled rows and sinks them to the end", async () => {
    const transport = transportWith({
      scheduling: {
        list: vi.fn().mockResolvedValue(
          ok([
            // Earlier nextRunAt but DISABLED — should sink to the end.
            {
              id: TASK_ID_A,
              kind: "recurring",
              cron: "0 1 * * *",
              prompt: "disabled-first-by-time",
              timezone: "UTC",
              nextRunAt: new Date("2026-06-01T01:00:00Z"),
              lastRunAt: null,
              enabled: false,
            },
            // Later nextRunAt but ENABLED — should win the top slot.
            {
              id: TASK_ID_B,
              kind: "one_off",
              cron: null,
              prompt: "enabled-but-later",
              timezone: "UTC",
              nextRunAt: new Date("2026-06-01T09:00:00Z"),
              lastRunAt: null,
              enabled: true,
            },
          ]),
        ),
      },
    });
    const ctx = mkCtx();
    await handleSchedules(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    const enabledIdx = reply.indexOf(TASK_ID_B);
    const disabledIdx = reply.indexOf(TASK_ID_A);
    expect(enabledIdx).toBeGreaterThan(-1);
    expect(disabledIdx).toBeGreaterThan(enabledIdx);
    expect(reply).toContain("[disabled]");
  });

  it("maps identity_rejected to a friendly error", async () => {
    const transport = transportWith({
      scheduling: { list: vi.fn().mockResolvedValue(err({ code: "identity_rejected" })) },
    });
    const ctx = mkCtx();
    await handleSchedules(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("not authorized");
  });

  it("truncates the list at 15 entries and surfaces the hidden count + agent nudge", async () => {
    // Telegram's 4096-char per-message cap would 400 with MESSAGE_TOO_LONG
    // if we rendered all 200 cap'd tasks (each ~210 chars worst case).
    // Cap the rendered list at 15 and tell the user the rest is reachable
    // via the agent's `list_tasks` (no display cap).
    const total = 50;
    const tasks = Array.from({ length: total }, (_, i) => ({
      id: `019e2900-0000-7000-8000-${String(i).padStart(12, "0")}`,
      kind: "recurring" as const,
      cron: "0 9 * * *",
      prompt: "x",
      timezone: "UTC",
      // Earlier index → earlier fire so sort is deterministic.
      nextRunAt: new Date(2026, 5, 1 + i),
      lastRunAt: null,
      enabled: true,
    }));
    const transport = transportWith({
      scheduling: { list: vi.fn().mockResolvedValue(ok(tasks)) },
    });
    const ctx = mkCtx();
    await handleSchedules(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;

    // Header carries the FULL count, not the displayed count.
    expect(reply).toContain(`Scheduled tasks (${total}):`);
    // First 15 rendered (numbered 1..15). The 16th-onwards IDs are not in the body.
    expect(reply).toContain(tasks[14]!.id);
    expect(reply).not.toContain(tasks[15]!.id);
    // Footer surfaces the hidden count + steers to the agent tool.
    expect(reply).toContain(`... and ${total - 15} more`);
    expect(reply).toContain("list_tasks");
    // Stays comfortably under Telegram's 4096-char cap.
    expect(reply.length).toBeLessThan(4096);
  });

  it("doesn't print the truncation footer when all tasks fit", async () => {
    const tasks = Array.from({ length: 3 }, (_, i) => ({
      id: `019e2900-0000-7000-8000-${String(i).padStart(12, "0")}`,
      kind: "recurring" as const,
      cron: "0 9 * * *",
      prompt: "x",
      timezone: "UTC",
      nextRunAt: new Date(2026, 5, 1 + i),
      lastRunAt: null,
      enabled: true,
    }));
    const transport = transportWith({
      scheduling: { list: vi.fn().mockResolvedValue(ok(tasks)) },
    });
    const ctx = mkCtx();
    await handleSchedules(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    // Match the truncation-footer pattern specifically, not the
    // bare word "and " (which could appear in future copy).
    expect(reply).not.toMatch(/and \d+ more/);
  });

  // --- /schedules disable <id> ---

  it("disable: dispatches to transport.scheduling.disable and confirms success", async () => {
    const disable = vi.fn().mockResolvedValue(ok({ id: TASK_ID_A, alreadyAtState: false }));
    const transport = transportWith({ scheduling: { disable } });
    const ctx = mkCtx(`disable ${TASK_ID_A}`);
    await handleSchedules(transport, ctx);
    expect(disable).toHaveBeenCalledWith("1", TASK_ID_A);
    expect(ctx.reply.mock.calls[0]?.[0]).toMatch(/disabled\.?$/);
  });

  it("disable: reports idempotent 'already disabled' when alreadyAtState=true", async () => {
    const disable = vi.fn().mockResolvedValue(ok({ id: TASK_ID_A, alreadyAtState: true }));
    const transport = transportWith({ scheduling: { disable } });
    const ctx = mkCtx(`disable ${TASK_ID_A}`);
    await handleSchedules(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("already disabled");
  });

  it("disable: maps schedule_not_found to a friendly error that hints at /schedules", async () => {
    const transport = transportWith({
      scheduling: {
        disable: vi.fn().mockResolvedValue(err({ code: "schedule_not_found", id: TASK_ID_A })),
      },
    });
    const ctx = mkCtx(`disable ${TASK_ID_A}`);
    await handleSchedules(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain("No scheduled task");
    expect(reply).toContain("/schedules");
  });

  it("disable: maps schedule_id_malformed to a friendly error", async () => {
    const transport = transportWith({
      scheduling: {
        disable: vi.fn().mockResolvedValue(err({ code: "schedule_id_malformed", id: "garbage" })),
      },
    });
    const ctx = mkCtx("disable garbage");
    await handleSchedules(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain("doesn't look like a valid task id");
  });

  // --- /schedules enable <id> ---

  it("enable: dispatches and confirms 'enabled'", async () => {
    const enable = vi.fn().mockResolvedValue(ok({ id: TASK_ID_A, alreadyAtState: false }));
    const transport = transportWith({ scheduling: { enable } });
    const ctx = mkCtx(`enable ${TASK_ID_A}`);
    await handleSchedules(transport, ctx);
    expect(enable).toHaveBeenCalledWith("1", TASK_ID_A);
    expect(ctx.reply.mock.calls[0]?.[0]).toMatch(/enabled\.?$/);
  });

  it("enable: reports 'already enabled' when alreadyAtState=true", async () => {
    const enable = vi.fn().mockResolvedValue(ok({ id: TASK_ID_A, alreadyAtState: true }));
    const transport = transportWith({ scheduling: { enable } });
    const ctx = mkCtx(`enable ${TASK_ID_A}`);
    await handleSchedules(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("already enabled");
  });

  // --- /schedules delete <id> ---

  it("delete: dispatches and confirms removal", async () => {
    const del = vi.fn().mockResolvedValue(ok({ id: TASK_ID_A }));
    const transport = transportWith({ scheduling: { delete: del } });
    const ctx = mkCtx(`delete ${TASK_ID_A}`);
    await handleSchedules(transport, ctx);
    expect(del).toHaveBeenCalledWith("1", TASK_ID_A);
    expect(ctx.reply.mock.calls[0]?.[0]).toMatch(/removed\.?$/);
  });

  // --- usage / argument parsing ---

  it("prints USAGE on unknown subcommand", async () => {
    const transport = transportWith();
    const ctx = mkCtx("frobnicate xyz");
    await handleSchedules(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /schedules");
  });

  it("prints USAGE on missing id for disable/enable/delete", async () => {
    const transport = transportWith();
    for (const sub of ["disable", "enable", "delete"]) {
      const ctx = mkCtx(sub);
      await handleSchedules(transport, ctx);
      expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /schedules");
    }
  });
});
