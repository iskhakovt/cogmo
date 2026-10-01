/**
 * Fire-handler unit tests via `InngestTestEngine`. Covers the dispatch
 * branch matrix: success, runner-side error (run row persisted, no retry),
 * the skipped reasons (skill_not_found / not_scheduled / skill_disabled /
 * invalid_inputs / sandbox_unavailable / inflight), the run-as identity read from the
 * skill row, and the replay-safety contract on the `dispatch` step.
 */

import { InngestTestEngine } from "@inngest/test";
import { err, ok } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { inngest } from "../inngest/client.js";
import { fakeRunInTx, mockFilesService } from "../test/factories.js";
import { createSkillCronFireHandler, type SkillCronFireDeps } from "./cron-fire-handler.js";
import type { SkillRunAs, SkillRunServices } from "./run-as.js";
import type { SkillRunner } from "./runner.js";
import type { SkillRow, SkillStore } from "./store/index.js";

const baseEvent = {
  name: "skills/cron.fire",
  data: {
    skillId: "skill-1",
    skillName: "morning-brief",
    gitSha: "0123456789abcdef0123456789abcdef01234567",
    scheduledFor: "2026-06-01T09:00:00.000Z",
  },
} as const;

afterEach(() => {
  vi.useRealTimers();
});

const RUN_AS_USER = "019d0000-0000-7000-8000-0000000000a7";
const RUN_AS_PROFILE = "019d0000-0000-7000-8000-0000000000b7";

function skillRow(overrides: Partial<SkillRow> = {}): SkillRow {
  return {
    id: "skill-1",
    name: "morning-brief",
    tier: "wasm",
    riskTier: "auto",
    effects: [],
    schedule: "0 9 * * *",
    nextRunAt: new Date("2026-06-02T09:00:00Z"),
    runAsUserId: RUN_AS_USER,
    runAsProfileId: RUN_AS_PROFILE,
    lastFiredAt: null,
    gitSha: baseEvent.data.gitSha,
    lockfileHash: null,
    inputs: { type: "object", properties: {} },
    outputs: null,
    disabled: false,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    ...overrides,
  };
}

const RUN_AS: SkillRunAs = {
  userId: RUN_AS_USER,
  service: { memory: mock<SkillRunServices["memory"]>(), files: mockFilesService() },
};

/** Deps around `runner`, with the skill row stored as `row` (absent when null). */
function deps(runner: SkillRunner, row: SkillRow | null = skillRow()) {
  const store = mock<SkillStore>();
  store.getSkillById.mockResolvedValue(row ?? undefined);
  const resolveRunAs = vi.fn<SkillCronFireDeps["resolveRunAs"]>().mockResolvedValue(RUN_AS);
  return { runner, runInTx: fakeRunInTx, store, resolveRunAs };
}

describe("createSkillCronFireHandler", () => {
  it("invokes the runner with empty inputs and trigger='cron', returns completed/success", async () => {
    const runner = mock<SkillRunner>();
    runner.invoke.mockResolvedValue(
      ok({ runId: "run-7", status: "success", output: { message: "ok" } }),
    );
    const fn = createSkillCronFireHandler(deps(runner), inngest);

    const { result } = await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();

    expect(result).toEqual({ status: "completed", runId: "run-7", runStatus: "success" });
    expect(runner.invoke).toHaveBeenCalledWith({
      name: "morning-brief",
      inputs: {},
      trigger: "cron",
      // Deterministic per fire (skillId + scheduledFor). Same key the
      // event-bus dedup uses, so a retry after bus-dedup miss still
      // resolves to the same run row in `runner.invoke`'s
      // recovery_point branch.
      idempotencyKey: `skill-cron:${baseEvent.data.skillId}:${baseEvent.data.scheduledFor}`,
      runAs: RUN_AS,
    });
  });

  it("runs as the identity stored on the skill, with that identity's scoped services", async () => {
    const runner = mock<SkillRunner>();
    runner.invoke.mockResolvedValue(ok({ runId: "run-8", status: "success", output: {} }));
    const d = deps(runner);
    const fn = createSkillCronFireHandler(d, inngest);

    await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();

    expect(d.store.getSkillById).toHaveBeenCalledWith(expect.anything(), "skill-1");
    expect(d.resolveRunAs).toHaveBeenCalledWith({
      userId: RUN_AS_USER,
      profileId: RUN_AS_PROFILE,
    });
    expect(runner.invoke).toHaveBeenCalledWith(expect.objectContaining({ runAs: RUN_AS }));
  });

  it("skips with reason 'skill_disabled' when the skill was disabled between tick and fire", async () => {
    const runner = mock<SkillRunner>();
    const d = deps(runner, skillRow({ disabled: true, runAsUserId: null, runAsProfileId: null }));
    const fn = createSkillCronFireHandler(d, inngest);

    const { result } = await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();

    expect(result).toMatchObject({ status: "skipped", reason: "skill_disabled" });
    expect(runner.invoke).not.toHaveBeenCalled();
  });

  it("skips with reason 'not_scheduled' when the schedule was dropped between tick and fire", async () => {
    const runner = mock<SkillRunner>();
    const d = deps(
      runner,
      skillRow({ schedule: null, nextRunAt: null, runAsUserId: null, runAsProfileId: null }),
    );
    const fn = createSkillCronFireHandler(d, inngest);

    const { result } = await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();

    expect(result).toMatchObject({ status: "skipped", reason: "not_scheduled" });
    expect(d.resolveRunAs).not.toHaveBeenCalled();
    expect(runner.invoke).not.toHaveBeenCalled();
  });

  it("propagates a failure to build the run-as services, so Inngest retries without invoking", async () => {
    const runner = mock<SkillRunner>();
    const d = deps(runner);
    d.resolveRunAs.mockRejectedValue(new Error("skill run-as profile p-1 not found"));
    const fn = createSkillCronFireHandler(d, inngest);

    const { error } = await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();

    expect((error as { message?: string } | undefined)?.message).toMatch(/profile p-1 not found/);
    expect(runner.invoke).not.toHaveBeenCalled();
  });

  it("skips with reason 'skill_not_found' when the row is gone before its identity is read", async () => {
    const runner = mock<SkillRunner>();
    const d = deps(runner, null);
    const fn = createSkillCronFireHandler(d, inngest);

    const { result } = await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();

    expect(result).toMatchObject({ status: "skipped", reason: "skill_not_found" });
    expect(runner.invoke).not.toHaveBeenCalled();
  });

  it("returns completed/error when the skill itself fails — does NOT throw, doesn't burn retries", async () => {
    // runner.invoke writes the failure into skill_runs; the handler reflects
    // it back as runStatus='error' so the cron continues firing tomorrow.
    const runner = mock<SkillRunner>();
    runner.invoke.mockResolvedValue(ok({ runId: "run-err", status: "error", error: "boom" }));
    const fn = createSkillCronFireHandler(deps(runner), inngest);

    const { result } = await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();

    expect(result).toEqual({ status: "completed", runId: "run-err", runStatus: "error" });
  });

  it("skips with reason 'skill_not_found' when the row was deregistered between tick and fire", async () => {
    const runner = mock<SkillRunner>();
    runner.invoke.mockResolvedValue(err({ kind: "not_found", name: "morning-brief" }));
    const fn = createSkillCronFireHandler(deps(runner), inngest);

    const { result } = await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();

    expect(result).toEqual({
      status: "skipped",
      reason: "skill_not_found",
      detail: "skill not found: morning-brief",
    });
  });

  it("skips with reason 'skill_disabled' when the row was disabled between tick and fire", async () => {
    const runner = mock<SkillRunner>();
    runner.invoke.mockResolvedValue(err({ kind: "disabled", name: "morning-brief" }));
    const fn = createSkillCronFireHandler(deps(runner), inngest);

    const { result } = await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();

    expect(result).toMatchObject({ status: "skipped", reason: "skill_disabled" });
  });

  it("skips with reason 'sandbox_unavailable' when a container-tier skill fires without a sandbox wired", async () => {
    // Permanent misconfiguration (deployment without SANDBOX_RUNTIME).
    // Without classifying this we'd burn the full retries: 2 budget every
    // tick for a condition that won't self-heal between attempts.
    const runner = mock<SkillRunner>();
    runner.invoke.mockResolvedValue(err({ kind: "sandbox_unavailable", name: "morning-brief" }));
    const fn = createSkillCronFireHandler(deps(runner), inngest);

    const { result } = await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();

    expect(result).toMatchObject({ status: "skipped", reason: "sandbox_unavailable" });
  });

  it("propagates a thrown Error even when its message reads like a rejection", async () => {
    // A deeper-layer error whose text mentions "skill not found" is not a
    // `not_found` rejection; only the runner's rejection value skips.
    const runner = mock<SkillRunner>();
    runner.invoke.mockRejectedValue(new Error("registry lookup failed: skill not found in cache"));
    const fn = createSkillCronFireHandler(deps(runner), inngest);

    const { error } = await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();
    expect((error as { message?: string } | undefined)?.message).toMatch(/registry lookup failed/);
  });

  it("skips with reason 'invalid_inputs' when the manifest required inputs the cron path can't supply", async () => {
    // Manifest-author foot-gun: declaring required inputs on a cron-triggered
    // skill. Surfaces here as a non-retrying skipped result so the operator
    // sees the misconfiguration in logs instead of an Inngest retry storm.
    const runner = mock<SkillRunner>();
    runner.invoke.mockResolvedValue(
      err({
        kind: "invalid_inputs",
        name: "morning-brief",
        issues: ["<root> must have required property 'x'"],
      }),
    );
    const fn = createSkillCronFireHandler(deps(runner), inngest);

    const { result } = await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();

    expect(result).toMatchObject({ status: "skipped", reason: "invalid_inputs" });
  });

  it("skips with reason 'inflight' when a prior attempt under the fire's key is still marked started", async () => {
    const runner = mock<SkillRunner>();
    runner.invoke.mockResolvedValue(
      err({ kind: "inflight", name: "morning-brief", runId: "run-stuck" }),
    );
    const fn = createSkillCronFireHandler(deps(runner), inngest);

    const { result, error } = await new InngestTestEngine({
      function: fn,
      events: [baseEvent],
    }).execute();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({
      status: "skipped",
      reason: "inflight",
      detail: expect.stringContaining("run-stuck"),
    });
  });

  it("propagates unknown errors so Inngest's retry budget catches transient failures", async () => {
    const runner = mock<SkillRunner>();
    runner.invoke.mockRejectedValue(new Error("docker daemon unreachable"));
    const fn = createSkillCronFireHandler(deps(runner), inngest);

    const { error } = await new InngestTestEngine({
      function: fn,
      events: [baseEvent],
    }).execute();
    // Inngest's test engine surfaces the thrown error as a plain object
    // (serialised through its run-state JSON pipe), not a real Error
    // instance — assert the message directly.
    expect((error as { message?: string } | undefined)?.message).toMatch(
      /docker daemon unreachable/,
    );
  });

  it("pins the function configuration (event trigger, retries, concurrency)", () => {
    const fn = createSkillCronFireHandler(deps(mock<SkillRunner>()), inngest);
    expect(fn.opts.id).toBe("skill-cron-fire");
    expect(fn.opts.retries).toBe(2);
    expect(fn.opts.concurrency).toEqual({ limit: 1, key: "event.data.skillId" });
    expect(fn.opts.triggers).toHaveLength(1);
    expect(fn.opts.triggers?.[0]).toMatchObject({ event: "skills/cron.fire" });
  });

  it("does NOT re-run dispatch when Inngest replays with a cached step result", async () => {
    const runner = mock<SkillRunner>();
    runner.invoke.mockRejectedValue(new Error("must not run"));
    const d = deps(runner);
    const fn = createSkillCronFireHandler(d, inngest);

    await new InngestTestEngine({
      function: fn,
      events: [baseEvent],
      steps: [
        {
          id: "dispatch",
          handler: () => ({ status: "completed", runId: "run-cached", runStatus: "success" }),
        },
      ],
    }).execute();

    expect(runner.invoke).not.toHaveBeenCalled();
    // The identity read and service build live inside the step too.
    expect(d.store.getSkillById).not.toHaveBeenCalled();
    expect(d.resolveRunAs).not.toHaveBeenCalled();
  });
});
