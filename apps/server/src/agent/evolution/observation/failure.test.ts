import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  MissingToolCallError,
  OutputCutOffError,
  ProviderProtocolError,
  ToolArgsCutOffError,
} from "../../../llm/errors.js";
import { AllProvidersFailedError, RefusalError } from "../../../llm/fallback.js";
import { classifyTurnFailure, isTerminalTurnFailure } from "./failure.js";

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("classifyTurnFailure", () => {
  it.each([
    ["a refusal", new RefusalError("refused"), "refusal"],
    ["a cut-off reply", new OutputCutOffError("x", "max_tokens"), "output_cut_off"],
    [
      "cut-off tool arguments",
      new ToolArgsCutOffError(new ProviderProtocolError("bad", undefined)),
      "output_cut_off",
    ],
    [
      "a reply with no tool call",
      new MissingToolCallError("x", {
        reply: "",
        instruction: "",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      "parse",
    ],
    ["an unusable payload", new ProviderProtocolError("bad", undefined), "parse"],
    ["a schema mismatch after repair", new ZodError([]), "parse"],
    [
      "a 400 naming the context window",
      httpError(400, "prompt is too long: 250000 tokens"),
      "context_overflow",
    ],
    ["another 4xx", httpError(422, "unprocessable"), "rejected"],
  ])("counts %s against the turn", (_label, err, kind) => {
    expect(classifyTurnFailure(err)).toMatchObject({ kind });
  });

  it.each([
    ["an outage", httpError(503, "unavailable")],
    ["a rate limit", httpError(429, "slow down")],
    ["an expired key", httpError(401, "unauthorized")],
    ["a forbidden key", httpError(403, "forbidden")],
    ["a payment failure", httpError(402, "payment required")],
    ["a missing model", httpError(404, "model not found")],
    ["a 400 naming billing", httpError(400, "Your credit balance is too low")],
    ["a network failure", new Error("ECONNRESET")],
    ["every provider down", new AllProvidersFailedError([])],
    ["a non-error throw", "boom"],
  ])("leaves %s for the step to retry", (_label, err) => {
    expect(classifyTurnFailure(err)).toBeNull();
  });
});

describe("isTerminalTurnFailure", () => {
  it("ends a turn at once on a failure every attempt repeats, and counts the rest", () => {
    expect(isTerminalTurnFailure({ kind: "context_overflow", message: "" })).toBe(true);
    expect(isTerminalTurnFailure({ kind: "refusal", message: "" })).toBe(true);
    expect(isTerminalTurnFailure({ kind: "output_cut_off", message: "" })).toBe(true);
    expect(isTerminalTurnFailure({ kind: "parse", message: "" })).toBe(false);
    expect(isTerminalTurnFailure({ kind: "rejected", message: "" })).toBe(false);
  });
});
