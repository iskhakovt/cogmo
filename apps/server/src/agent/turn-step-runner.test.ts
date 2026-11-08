import { NonRetriableError, StepError, serializeError } from "inngest";
import { errors } from "inngest/internals";
import { describe, expect, it } from "vitest";
import { assertInstanceOf } from "../test/assertions.js";
import { fakeDurable } from "../test/fake-durable.js";
import { asNonRetriable, createTurnStepRunner, failureCause } from "./turn-step-runner.js";

function withStatus(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe("createTurnStepRunner", () => {
  it("runs the body under the given step id and returns its value", async () => {
    const step = fakeDurable();
    const stepRun = createTurnStepRunner(step.run);

    await expect(stepRun("llm-iter1", async () => ({ ok: true }))).resolves.toEqual({ ok: true });
    expect(step.stepIds()).toEqual(["llm-iter1"]);
  });

  it.each([
    ["a deterministic failure", new Error("zod: expected string")],
    ["an outage", withStatus(503)],
  ])("makes %s in a tool step non-retriable — the model is the retry", async (_label, error) => {
    const stepRun = createTurnStepRunner(fakeDurable().run);

    const thrown = await stepRun("tool-iter2-0", async () => {
      throw error;
    }).catch((e: unknown) => e);

    assertInstanceOf(thrown, NonRetriableError);
    expect(thrown.cause).toBe(error);
  });

  it("fails fast on a deterministic provider error outside tool steps, naming the step and turn", async () => {
    const stepRun = createTurnStepRunner(fakeDurable().run, { cursor: "inbound-3" });
    const error = withStatus(400);

    const thrown = await stepRun("llm-iter1", async () => {
      throw error;
    }).catch((e: unknown) => e);

    assertInstanceOf(thrown, NonRetriableError);
    expect(thrown.message).toBe("HTTP 400");
    expect(failureCause(thrown)).toEqual({
      refusal: { status: 400, step: "llm-iter1", cursor: "inbound-3" },
      cause: error,
    });
  });

  it("leaves a stage turn's refusal as its own cause", async () => {
    const stepRun = createTurnStepRunner(fakeDurable().run);
    const error = withStatus(400);

    const thrown = await stepRun("llm-iter1", async () => {
      throw error;
    }).catch((e: unknown) => e);

    assertInstanceOf(thrown, NonRetriableError);
    expect(thrown.cause).toBe(error);
  });

  it.each([
    ["a rate limit", withStatus(429)],
    ["a server error", withStatus(502)],
    ["a network failure", new Error("ECONNRESET")],
  ])("rethrows %s unchanged so Inngest retries the step", async (_label, error) => {
    const stepRun = createTurnStepRunner(fakeDurable().run);

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

/** `error` as `onFailure` receives it, after the step and the function each fail with it. */
function asOnFailureReceives(error: Error): Error {
  // The step's failure is stored serialized; the body's replay rethrows it as
  // a StepError, which fails the function; `onFailure` deserializes that.
  const stepError = new StepError("llm-iter1", serializeError(error));
  return errors.deserializeError(serializeError(stepError));
}

describe("failureCause", () => {
  it("reads the refusal and the provider's error through the serialization onFailure receives", () => {
    const upstream = Object.assign(new Error("400 the PDF could not be read"), {
      name: "BadRequestError",
      status: 400,
    });

    const received = asOnFailureReceives(
      asNonRetriable(upstream, { step: "llm-iter1", cursor: "inbound-3" }),
    );

    expect(received.name).toBe("NonRetriableError");
    const { refusal, cause } = failureCause(received);
    expect(refusal).toEqual({ status: 400, step: "llm-iter1", cursor: "inbound-3" });
    expect(cause).toMatchObject({
      name: "BadRequestError",
      message: "400 the PDF could not be read",
    });
  });

  it("has no refusal for an error without a status", () => {
    const upstream = new TypeError("bad config");

    const { refusal, cause } = failureCause(
      asOnFailureReceives(asNonRetriable(upstream, { step: "llm-iter1", cursor: "inbound-3" })),
    );

    expect(refusal).toBeNull();
    expect(cause).toMatchObject({ name: "TypeError", message: "bad config" });
  });

  it("has no refusal or cause for an error that wraps nothing", () => {
    expect(failureCause(new Error("internal"))).toEqual({ refusal: null, cause: undefined });
  });

  it.each([
    ["JSON of another shape", "400"],
    ["not JSON", "refused"],
  ])("has no refusal when the link's message is %s", (_label, message) => {
    const upstream = new Error("refused");
    const link = Object.assign(new Error(message), { name: "ProviderRefusal", cause: upstream });

    expect(failureCause(new Error("failed", { cause: link }))).toEqual({
      refusal: null,
      cause: upstream,
    });
  });
});
