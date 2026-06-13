/// <reference path="../../../test/vitest.d.ts" />
/**
 * Compiler eval set — free-text pipeline descriptions through the real
 * compile path (`compilePipeline` → chatTyped → llmock-recorded Anthropic)
 * asserting the *envelope contract*, not exact JSON: trigger kinds, bounded
 * gates, loop caps, no-event-source steering. This is the slice-1 quality
 * gate for the compiler prompt (design/pipelines.md → Implementation Plan).
 *
 * Assertions are deliberately structural (kinds, bounds, presence) rather
 * than exact-match — re-recording against a newer model must not break on
 * harmless wording differences in stage ids or instructions.
 *
 * Re-record with `pnpm test:record` when the compiler system prompt, the
 * definition schema, or the pinned model changes.
 */

import picomatch from "picomatch";
import { describe, expect, inject, it } from "vitest";
import { AnthropicProvider } from "../../llm/anthropic.js";
import { expectDefined } from "../../test/assertions.js";
import { compilePipeline } from "./compile.js";
import type { PipelineDefinition } from "./types.js";
import { MAX_DURATION_MS, parseDurationMs } from "./types.js";

// Pinned for fixture stability; bump deliberately and re-record.
const COMPILER_MODEL = "claude-sonnet-4-6";

const AVAILABLE_TOOLS = [
  "memory_recall",
  "memory_retain",
  "web_search",
  "read_file",
  "write_file",
  "delegate_coding",
  "schedule_task",
  "generate_image",
];

function compile(sourceText: string) {
  const apiKey = process.env.RECORD === "1" ? process.env.ANTHROPIC_API_KEY : undefined;
  const provider = new AnthropicProvider(apiKey ?? "test-key", inject("llmockBaseUrl"));
  return compilePipeline(
    {
      provider,
      model: COMPILER_MODEL,
      validation: { availableTools: AVAILABLE_TOOLS, knownEventSources: [] },
    },
    { sourceText },
  );
}

function unwrap(result: Awaited<ReturnType<typeof compile>>): PipelineDefinition {
  if (result.isErr()) {
    throw new Error(`compile failed: ${JSON.stringify(result.error.issues, null, 2)}`);
  }
  return result.value.definition;
}

/** Every gate/wait timeout must terminate and stay under the engine ceiling. */
function expectBoundedCheckpoints(def: PipelineDefinition): void {
  for (const stage of def.stages) {
    const checkpoint = stage.gate ?? stage.wait;
    if (!checkpoint) continue;
    expect(parseDurationMs(checkpoint.timeout)).toBeLessThanOrEqual(MAX_DURATION_MS);
    if (checkpoint.onTimeout.kind === "remind") {
      expect(checkpoint.onTimeout.maxReminders).toBeLessThanOrEqual(10);
      expect(["proceed", "abort"]).toContain(checkpoint.onTimeout.finalAction);
    }
  }
}

describe("pipeline compiler eval", () => {
  it("01 canonical issue flow — command trigger, reminded gate, bounded loop", async () => {
    const def = unwrap(
      await compile(
        "When I say 'start the issue pipeline': chat with me to gather context about the issue, " +
          "draft a plan and wait for my approval — remind me if I forget, give up after 3 days — " +
          "then implement it, and redo it based on my feedback, at most 5 times.",
      ),
    );
    expect(def.trigger.kind).toBe("command");
    const gate = expectDefined(
      def.stages.find((s) => s.kind === "gate"),
      "gate stage",
    );
    expect(gate.gate?.onTimeout.kind).toBe("remind");
    const loop = expectDefined(def.stages.find((s) => s.loop !== undefined)?.loop, "loop");
    expect(loop.maxIterations).toBe(5);
    expectBoundedCheckpoints(def);
  });

  it("02 weekday briefing — cron trigger with the stated timezone", async () => {
    const def = unwrap(
      await compile(
        "Every weekday at 9am London time, research what happened in AI overnight and write " +
          "me a short summary.",
      ),
    );
    expect(def.trigger.kind).toBe("cron");
    if (def.trigger.kind === "cron") {
      expect(def.trigger.schedule).toMatch(/^0 9 /);
      expect(def.trigger.timezone).toBe("Europe/London");
    }
    expect(def.stages.some((s) => s.kind === "agentic")).toBe(true);
  });

  it("03 event-shaped request — steered away from event triggers (no sources yet)", async () => {
    const def = unwrap(
      await compile("Whenever one of my PRs gets a review, address the review comments."),
    );
    expect(def.trigger.kind).not.toBe("event");
    expect(def.stages.every((s) => s.kind !== "wait")).toBe(true);
  });

  it("04 review-before-save — gate between work stages", async () => {
    const def = unwrap(
      await compile(
        "On request: draft my weekly status report, show it to me for review, then after " +
          "I approve save it to my files.",
      ),
    );
    const gateIndex = def.stages.findIndex((s) => s.kind === "gate");
    expect(gateIndex).toBeGreaterThan(0);
    expect(gateIndex).toBeLessThan(def.stages.length - 1);
    expectBoundedCheckpoints(def);
  });

  it("05 explicit small loop bound is honored", async () => {
    const def = unwrap(
      await compile("Keep refining the document with me until I'm happy, but at most 3 rounds."),
    );
    const loop = expectDefined(def.stages.find((s) => s.loop !== undefined)?.loop, "loop");
    expect(loop.maxIterations).toBe(3);
  });

  it("06 tool restriction — allowlist stays inside the catalog", async () => {
    const def = unwrap(
      await compile(
        "Research a topic I give you using only web search — no other tools — then write a " +
          "summary.",
      ),
    );
    const restricted = def.stages.filter((s) => s.tools !== undefined);
    expect(restricted.length).toBeGreaterThan(0);
    for (const stage of restricted) {
      for (const glob of stage.tools ?? []) {
        // Same resolution as production validation — a bare "*" must not
        // pass via a degenerate substring check.
        expect(glob).not.toBe("*");
        expect(AVAILABLE_TOOLS.some((t) => picomatch.isMatch(t, glob))).toBe(true);
      }
    }
  });

  it("07 full coding flow — multi-stage with sign-off", async () => {
    const def = unwrap(
      await compile(
        "On my command: pick up the task I describe, plan the work, get my sign-off on the " +
          "plan, implement it via coding delegation, then report back what changed.",
      ),
    );
    expect(def.stages.length).toBeGreaterThanOrEqual(3);
    expect(def.stages.some((s) => s.kind === "gate")).toBe(true);
    expectBoundedCheckpoints(def);
  });

  it("08 weekly tidy — cron with a sane schedule and valid timezone", async () => {
    const def = unwrap(await compile("Every Sunday evening, tidy up and reorganize my notes."));
    expect(def.trigger.kind).toBe("cron");
    if (def.trigger.kind === "cron") {
      expect(def.trigger.schedule).toMatch(/\* \* (0|7|SUN|sun)/i);
    }
  });

  it("09 'wait for CI' — modeled without wait stages while no sources exist", async () => {
    const def = unwrap(
      await compile(
        "After I approve the change, wait until the tests pass, then summarize the outcome " +
          "for me.",
      ),
    );
    expect(def.stages.every((s) => s.kind === "gate" || s.kind === "agentic")).toBe(true);
    expectBoundedCheckpoints(def);
  });

  it("10 'as long as it takes' — still compiles to a bounded gate", async () => {
    const def = unwrap(
      await compile(
        "Prepare the quarterly summary, then ask for my approval and wait as long as it " +
          "takes for me to answer before archiving it.",
      ),
    );
    const gate = expectDefined(
      def.stages.find((s) => s.kind === "gate"),
      "gate stage",
    );
    const gateConfig = expectDefined(gate.gate, "gate config");
    expect(parseDurationMs(gateConfig.timeout)).toBeLessThanOrEqual(MAX_DURATION_MS);
    expect(gateConfig.onTimeout.kind === "remind" || gateConfig.onTimeout.kind === "abort").toBe(
      true,
    );
    expectBoundedCheckpoints(def);
  });
});
