import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildGateKeyboard,
  encodeGateCallback,
  GATE_CALLBACK_REGEX,
  parseGateCallback,
  parseGateCommand,
} from "./gate-keyboard.js";

const RUN_ID = randomUUID();

describe("gate callback data", () => {
  it("round-trips every action", () => {
    for (const action of ["approve", "revise", "cancel"] as const) {
      expect(parseGateCallback(encodeGateCallback(RUN_ID, action))).toEqual({
        runId: RUN_ID,
        action,
      });
    }
  });

  it("stays inside Telegram's 64-byte callback_data limit", () => {
    const longest = encodeGateCallback(RUN_ID, "approve");
    expect(Buffer.byteLength(longest)).toBeLessThanOrEqual(64);
  });

  it("rejects a malformed run id rather than hitting the DB with it", () => {
    expect(parseGateCallback("pgate:not-a-uuid:approve")).toBeNull();
    expect(parseGateCallback(`pgate:${RUN_ID}:destroy`)).toBeNull();
    expect(parseGateCallback(`plan:${RUN_ID}:approve`)).toBeNull();
  });

  it("registers a regex matching exactly what it parses", () => {
    expect(GATE_CALLBACK_REGEX.test(encodeGateCallback(RUN_ID, "cancel"))).toBe(true);
    expect(GATE_CALLBACK_REGEX.test(`pgate:${RUN_ID}:approve extra`)).toBe(false);
  });

  it("builds one row of three buttons carrying the run id", () => {
    const keyboard = buildGateKeyboard(RUN_ID);
    const row = keyboard.inline_keyboard[0];
    expect(row).toHaveLength(3);
    expect(row?.map((b) => b.callback_data)).toEqual([
      `pgate:${RUN_ID}:approve`,
      `pgate:${RUN_ID}:revise`,
      `pgate:${RUN_ID}:cancel`,
    ]);
  });
});

describe("parseGateCommand", () => {
  it("parses a bare action", () => {
    expect(parseGateCommand(" approve ")).toEqual({ action: "approve" });
  });

  it("keeps everything after the action as feedback", () => {
    expect(parseGateCommand("revise use the staging DB, not prod")).toEqual({
      action: "revise",
      feedback: "use the staging DB, not prod",
    });
  });

  it("is case-insensitive on the action but preserves feedback casing", () => {
    expect(parseGateCommand("REVISE Use Staging")).toEqual({
      action: "revise",
      feedback: "Use Staging",
    });
  });

  it("returns null on anything that isn't one of the three decisions", () => {
    expect(parseGateCommand("")).toBeNull();
    expect(parseGateCommand("approved")).toBeNull();
    expect(parseGateCommand("yes please")).toBeNull();
  });
});
