/**
 * Fire-handler unit tests via `InngestTestEngine`. Covers the dispatch
 * branch matrix: success, runner-side error (run row persisted, no retry),
 * the four skipped reasons (skill_not_found / skill_disabled /
 * invalid_inputs / sandbox_unavailable), and the replay-safety contract
 * on the `dispatch` step.
 */

import { InngestTestEngine } from "@inngest/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { inngest } from "../inngest/client.js";
import { createSkillCronFireHandler } from "./cron-fire-handler.js";
import {
  InputValidationError,
  SandboxUnavailableError,
  SkillDisabledError,
  SkillNotFoundError,
  type SkillRunner,
} from "./runner.js";

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

describe("createSkillCronFireHandler", () => {
  it("invokes the runner with empty inputs and trigger='cron', returns completed/success", async () => {
    const runner = mock<SkillRunner>();
    runner.invoke.mockResolvedValue({
      runId: "run-7",
      status: "success",
      output: { message: "ok" },
    });
    const fn = createSkillCronFireHandler({ runner }, inngest);

    const { result } = await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();

    expect(result).toEqual({ status: "completed", runId: "run-7", runStatus: "success" });
    expect(runner.invoke).toHaveBeenCalledWith({
      name: "morning-brief",
      inputs: {},
      trigger: "cron",
    });
  });

  it("returns completed/error when the skill itself fails — does NOT throw, doesn't burn retries", async () => {
    // runner.invoke writes the failure into skill_runs; the handler reflects
    // it back as runStatus='error' so the cron continues firing tomorrow.
    const runner = mock<SkillRunner>();
    runner.invoke.mockResolvedValue({ runId: "run-err", status: "error", error: "boom" });
    const fn = createSkillCronFireHandler({ runner }, inngest);

    const { result } = await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();

    expect(result).toEqual({ status: "completed", runId: "run-err", runStatus: "error" });
  });

  it("skips with reason 'skill_not_found' when the row was deregistered between tick and fire", async () => {
    const runner = mock<SkillRunner>();
    runner.invoke.mockRejectedValue(new SkillNotFoundError("morning-brief"));
    const fn = createSkillCronFireHandler({ runner }, inngest);

    const { result } = await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();

    expect(result).toMatchObject({ status: "skipped", reason: "skill_not_found" });
  });

  it("skips with reason 'skill_disabled' when the row was disabled between tick and fire", async () => {
    const runner = mock<SkillRunner>();
    runner.invoke.mockRejectedValue(new SkillDisabledError("morning-brief"));
    const fn = createSkillCronFireHandler({ runner }, inngest);

    const { result } = await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();

    expect(result).toMatchObject({ status: "skipped", reason: "skill_disabled" });
  });

  it("skips with reason 'sandbox_unavailable' when a container-tier skill fires without a sandbox wired", async () => {
    // Permanent misconfiguration (deployment without SANDBOX_RUNTIME).
    // Without classifying this we'd burn the full retries: 2 budget every
    // tick for a condition that won't self-heal between attempts.
    const runner = mock<SkillRunner>();
    runner.invoke.mockRejectedValue(new SandboxUnavailableError("morning-brief"));
    const fn = createSkillCronFireHandler({ runner }, inngest);

    const { result } = await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();

    expect(result).toMatchObject({ status: "skipped", reason: "sandbox_unavailable" });
  });

  it("propagates a plain Error whose message coincidentally contains 'skill not found' — discriminates by class, not substring", async () => {
    // Regression guard for the old `msg.includes("skill not found")`
    // matcher: a deeper-layer error whose text mentions the phrase must
    // NOT be classified as skill_not_found. Only `SkillNotFoundError`
    // counts.
    const runner = mock<SkillRunner>();
    runner.invoke.mockRejectedValue(new Error("registry lookup failed: skill not found in cache"));
    const fn = createSkillCronFireHandler({ runner }, inngest);

    const { error } = await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();
    expect((error as { message?: string } | undefined)?.message).toMatch(/registry lookup failed/);
  });

  it("skips with reason 'invalid_inputs' when the manifest required inputs the cron path can't supply", async () => {
    // Manifest-author foot-gun: declaring required inputs on a cron-triggered
    // skill. Surfaces here as a non-retrying skipped result so the operator
    // sees the misconfiguration in logs instead of an Inngest retry storm.
    const runner = mock<SkillRunner>();
    runner.invoke.mockRejectedValue(
      new InputValidationError("inputs failed schema validation: missing required field 'x'"),
    );
    const fn = createSkillCronFireHandler({ runner }, inngest);

    const { result } = await new InngestTestEngine({ function: fn, events: [baseEvent] }).execute();

    expect(result).toMatchObject({ status: "skipped", reason: "invalid_inputs" });
  });

  it("propagates unknown errors so Inngest's retry budget catches transient failures", async () => {
    const runner = mock<SkillRunner>();
    runner.invoke.mockRejectedValue(new Error("docker daemon unreachable"));
    const fn = createSkillCronFireHandler({ runner }, inngest);

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
    const fn = createSkillCronFireHandler({ runner: mock<SkillRunner>() }, inngest);
    expect(fn.opts.id).toBe("skill-cron-fire");
    expect(fn.opts.retries).toBe(2);
    expect(fn.opts.concurrency).toEqual({ limit: 1, key: "event.data.skillId" });
    expect(fn.opts.triggers).toHaveLength(1);
    expect(fn.opts.triggers?.[0]).toMatchObject({ event: "skills/cron.fire" });
  });

  it("does NOT re-run dispatch when Inngest replays with a cached step result", async () => {
    const runner = mock<SkillRunner>();
    runner.invoke.mockRejectedValue(new Error("must not run"));
    const fn = createSkillCronFireHandler({ runner }, inngest);

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
  });
});
