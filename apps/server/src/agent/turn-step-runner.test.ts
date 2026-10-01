import { InngestTestEngine } from "@inngest/test";
import { NonRetriableError } from "inngest";
import { errors, InngestExecutionEngine, ServerTiming, types } from "inngest/internals";
import { describe, expect, it, vi } from "vitest";
import { inngest } from "../inngest/client.js";
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

/**
 * Pins the SDK behaviour the agent loop's `runOne` relies on to turn a
 * tool's thrown rejection into an `is_error` tool_result: a `tool-iter*`
 * step fails once and for good, and a later invocation gets the rejection
 * back — message intact — at the `step.run` call site, where catching it
 * lets the run carry on.
 */
describe("inngest step.run — a failed tool step (upstream behavior)", () => {
  const REJECTION = "model m does not support aspect ratio 9:16.";
  const EVENT = { name: "test/tool-step", data: {} };

  /** A function that runs one tool step through the turn runner and catches it the way `runOne` does. */
  function probe(body: () => Promise<string>) {
    return inngest.createFunction(
      { id: "tool-step-probe", triggers: [{ event: EVENT.name }] },
      async ({ step }) => {
        const stepRun = createTurnStepRunner((id, fn) => step.run(id, fn));
        try {
          return { output: await stepRun("tool-iter1-0", body) };
        } catch (err) {
          return { caught: err instanceof Error ? err.message : String(err) };
        }
      },
    );
  }

  /**
   * Run `fn` once against the memo the SDK builds from the server's payload
   * when `stepId` has failed: an entry carrying only `error`. `@inngest/test`
   * can only memoize a value — its mocked entries always carry a `data`
   * promise, which the engine reads as a result — so this starts the
   * execution the way its request handler does.
   */
  async function replayFailedStep(
    fn: ReturnType<typeof probe>,
    stepId: string,
    error: Error,
  ): Promise<unknown> {
    const hashed = InngestExecutionEngine._internals.hashId(stepId);
    const runId = "01JTOOLSTEPPROBE0000000000";
    const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    // biome-ignore lint/complexity/useLiteralKeys: `createExecution` is protected on InngestFunction; element access is TypeScript's sanctioned way in, and the one `@inngest/test` uses.
    const execution = fn["createExecution"]({
      partialOptions: {
        runId,
        // biome-ignore lint/complexity/useLiteralKeys: `client` is protected on InngestFunction, as above.
        client: fn["client"],
        data: { runId, attempt: 0, event: EVENT, events: [EVENT] },
        reqArgs: [],
        headers: {},
        stepCompletionOrder: [hashed],
        stepState: { [hashed]: { id: hashed, error: errors.serializeError(error) } },
        stepMode: types.StepMode.Async,
        disableImmediateExecution: false,
        timer: new ServerTiming.ServerTiming(silent),
      },
    });
    return execution.start();
  }

  it("fails the step on its first throw with the final opcode, keeping the message", async () => {
    const body = vi.fn(async (): Promise<string> => {
      throw new Error(REJECTION);
    });

    const { step, error } = await new InngestTestEngine({
      function: probe(body),
      events: [EVENT],
    }).executeStep("tool-iter1-0");

    expect(body).toHaveBeenCalledTimes(1);
    // `StepFailed` ends the step; a retriable failure is `StepError`.
    expect(step).toMatchObject({ op: "StepFailed" });
    expect(error).toMatchObject({ name: "NonRetriableError", message: REJECTION });
  });

  it("hands the cached rejection back on replay without re-running the body, and the run completes", async () => {
    const body = vi.fn(async () => "fresh");

    const result = await replayFailedStep(
      probe(body),
      "tool-iter1-0",
      asNonRetriable(new Error(REJECTION)),
    );

    expect(body).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: "function-resolved", data: { caught: REJECTION } });
  });
});
