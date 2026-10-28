import { describe, expect, it } from "vitest";
import { describePipelineRunFailure } from "./run-failure.js";
import { PIPELINE_RUN_FAILED_REASONS } from "./store/schema.js";

describe("describePipelineRunFailure", () => {
  it("appends the detail when the reason has one", () => {
    expect(describePipelineRunFailure({ reason: "stage_error", detail: "TypeError" })).toBe(
      "the stage failed (TypeError)",
    );
    expect(
      describePipelineRunFailure({ reason: "artifact_invalid", detail: "/title is required" }),
    ).toBe("the stage's result did not match its declared output (/title is required)");
  });

  it("states a reason without detail on its own", () => {
    expect(describePipelineRunFailure({ reason: "turn_truncated", detail: null })).toBe(
      "the stage's reply was cut off at the model's output limit",
    );
  });

  it("has prose for every failed reason", () => {
    expect(
      PIPELINE_RUN_FAILED_REASONS.map((reason) =>
        describePipelineRunFailure({ reason, detail: null }),
      ),
    ).toEqual([
      "the stage failed",
      "the stage is not in the pinned definition",
      "wait stages are not supported yet",
      "the stage's agent turn could not finish",
      "the stage's reply was cut off at the model's output limit",
      "the stage's result did not match its declared output",
      "the checkpoint's timeout could not be applied",
    ]);
  });
});
