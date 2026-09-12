import { describe, expect, it } from "vitest";
import {
  buildPipelineGateKeyboard,
  encodePipelineGateCallback,
  PIPELINE_GATE_CALLBACK_REGEX,
  parsePipelineGateCallback,
} from "./gate-keyboard.js";

const RUN_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("pipeline gate keyboard", () => {
  it("builds Approve / Cancel buttons carrying the run id", () => {
    const keyboard = buildPipelineGateKeyboard(RUN_ID);
    expect(keyboard.inline_keyboard).toEqual([
      [
        { text: "✅ Approve", callback_data: `pipe:${RUN_ID}:approve` },
        { text: "❌ Cancel run", callback_data: `pipe:${RUN_ID}:cancel` },
      ],
    ]);
  });

  it("stays within Telegram's 64-byte callback_data limit", () => {
    for (const action of ["approve", "cancel"] as const) {
      expect(Buffer.byteLength(encodePipelineGateCallback(RUN_ID, action))).toBeLessThanOrEqual(64);
    }
  });

  it("round-trips both actions", () => {
    expect(parsePipelineGateCallback(encodePipelineGateCallback(RUN_ID, "approve"))).toEqual({
      runId: RUN_ID,
      action: "approve",
    });
    expect(parsePipelineGateCallback(encodePipelineGateCallback(RUN_ID, "cancel"))).toEqual({
      runId: RUN_ID,
      action: "cancel",
    });
  });

  it.each([
    ["a revise action", `pipe:${RUN_ID}:revise`],
    ["a non-uuid run id", "pipe:not-a-uuid:approve"],
    ["the coding plan prefix", `plan:${RUN_ID}:approve`],
    ["trailing data", `pipe:${RUN_ID}:approve:extra`],
  ])("rejects %s", (_label, data) => {
    expect(parsePipelineGateCallback(data)).toBeNull();
    expect(PIPELINE_GATE_CALLBACK_REGEX.test(data)).toBe(false);
  });
});
