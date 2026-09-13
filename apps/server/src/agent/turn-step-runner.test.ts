import { NonRetriableError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { asNonRetriable, createTurnStepRunner } from "./turn-step-runner.js";

/** A `step.run` stand-in that runs the body inline, recording the id. */
function inlineRun() {
  const ids: string[] = [];
  const run = vi.fn((id: string, fn: () => Promise<unknown>) => {
    ids.push(id);
    return fn();
  });
  return { ids, run };
}

function withStatus(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe("createTurnStepRunner", () => {
  it("runs the body under the given step id and returns its value", async () => {
    const { ids, run } = inlineRun();
    const stepRun = createTurnStepRunner(run);

    await expect(stepRun("llm-iter1", async () => ({ ok: true }))).resolves.toEqual({ ok: true });
    expect(ids).toEqual(["llm-iter1"]);
  });

  it.each([
    ["a deterministic failure", new Error("zod: expected string")],
    ["an outage", withStatus(503)],
  ])("makes %s in a tool step non-retriable — the model is the retry", async (_label, error) => {
    const stepRun = createTurnStepRunner(inlineRun().run);

    const thrown = await stepRun("tool-iter2-0", async () => {
      throw error;
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(NonRetriableError);
    expect(thrown).toMatchObject({ cause: error });
  });

  it("fails fast on a deterministic provider error outside tool steps", async () => {
    const stepRun = createTurnStepRunner(inlineRun().run);
    const error = withStatus(400);

    const thrown = await stepRun("llm-iter1", async () => {
      throw error;
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(NonRetriableError);
    expect(thrown).toMatchObject({ cause: error, message: "HTTP 400" });
  });

  it.each([
    ["a rate limit", withStatus(429)],
    ["a server error", withStatus(502)],
    ["a network failure", new Error("ECONNRESET")],
  ])("rethrows %s unchanged so Inngest retries the step", async (_label, error) => {
    const stepRun = createTurnStepRunner(inlineRun().run);

    await expect(
      stepRun("summarize-prefix-outcome", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});

describe("asNonRetriable", () => {
  it("keeps the message and the original as the cause", () => {
    const original = new TypeError("bad config");
    const wrapped = asNonRetriable(original);
    expect(wrapped).toBeInstanceOf(NonRetriableError);
    expect(wrapped.message).toBe("bad config");
    expect(wrapped.cause).toBe(original);
  });

  it("stringifies a non-Error value", () => {
    expect(asNonRetriable("plain failure").message).toBe("plain failure");
  });
});
