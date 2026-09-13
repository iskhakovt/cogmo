import { describe, expect, it } from "vitest";
import {
  buildPipelineGateKeyboard,
  encodePipelineGateCallback,
  gateToken,
  PIPELINE_GATE_CALLBACK_REGEX,
  parsePipelineGateCallback,
} from "./gate-keyboard.js";

const RUN_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const GATE_KEY = `${RUN_ID}:plan-gate:0`;
const TOKEN = gateToken(GATE_KEY);

describe("gateToken", () => {
  it("is 8 hex chars, stable per gate, and distinct across gates of one run", () => {
    expect(TOKEN).toMatch(/^[0-9a-f]{8}$/);
    expect(gateToken(GATE_KEY)).toBe(TOKEN);
    expect(gateToken(`${RUN_ID}:sign-off:0`)).not.toBe(TOKEN);
    expect(gateToken(`${RUN_ID}:plan-gate:1`)).not.toBe(TOKEN);
  });
});

describe("pipeline gate keyboard", () => {
  it("builds Approve / Cancel buttons carrying the run id and the gate's token", () => {
    const keyboard = buildPipelineGateKeyboard(RUN_ID, GATE_KEY);
    expect(keyboard.inline_keyboard).toEqual([
      [
        { text: "✅ Approve", callback_data: `pipe:${RUN_ID}:approve:${TOKEN}` },
        { text: "❌ Cancel run", callback_data: `pipe:${RUN_ID}:cancel:${TOKEN}` },
      ],
    ]);
  });

  it("stays within Telegram's 64-byte callback_data limit", () => {
    for (const action of ["approve", "cancel"] as const) {
      expect(
        Buffer.byteLength(encodePipelineGateCallback(RUN_ID, action, TOKEN)),
      ).toBeLessThanOrEqual(64);
    }
  });

  it("round-trips both actions with the token", () => {
    for (const action of ["approve", "cancel"] as const) {
      expect(parsePipelineGateCallback(encodePipelineGateCallback(RUN_ID, action, TOKEN))).toEqual({
        runId: RUN_ID,
        action,
        token: TOKEN,
      });
    }
  });

  it.each([
    ["a revise action", `pipe:${RUN_ID}:revise:${TOKEN}`],
    ["a non-uuid run id", `pipe:not-a-uuid:approve:${TOKEN}`],
    ["the coding plan prefix", `plan:${RUN_ID}:approve`],
    ["a missing token", `pipe:${RUN_ID}:approve`],
    ["a malformed token", `pipe:${RUN_ID}:approve:XYZ12345`],
    ["trailing data", `pipe:${RUN_ID}:approve:${TOKEN}:extra`],
  ])("rejects %s", (_label, data) => {
    expect(parsePipelineGateCallback(data)).toBeNull();
    expect(PIPELINE_GATE_CALLBACK_REGEX.test(data)).toBe(false);
  });
});
