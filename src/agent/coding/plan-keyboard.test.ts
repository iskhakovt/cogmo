import { describe, expect, it } from "vitest";
import {
  buildPlanKeyboard,
  encodePlanCallback,
  PLAN_CALLBACK_REGEX,
  parsePlanCallback,
} from "./plan-keyboard.js";

const TASK_ID = "019d0000-0000-7000-8000-000000000001";

describe("plan-keyboard encoding", () => {
  it("buildPlanKeyboard returns Approve / Revise / Cancel in one row", () => {
    const kb = buildPlanKeyboard(TASK_ID);
    expect(kb.inline_keyboard).toHaveLength(1);
    const row = kb.inline_keyboard[0];
    expect(row).toHaveLength(3);
    expect(row.map((b) => b.text)).toEqual(["✅ Approve", "✏️ Revise", "❌ Cancel"]);
    expect(row[0].callback_data).toBe(`plan:${TASK_ID}:approve`);
    expect(row[1].callback_data).toBe(`plan:${TASK_ID}:revise`);
    expect(row[2].callback_data).toBe(`plan:${TASK_ID}:cancel`);
  });

  it("encodePlanCallback stays within Telegram's 64-byte callback_data cap", () => {
    // Worst case: longest action is "approve" (7).
    const data = encodePlanCallback(TASK_ID, "approve");
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
  });
});

describe("plan-keyboard parsing", () => {
  it("round-trips encode → parse for every action", () => {
    for (const action of ["approve", "revise", "cancel"] as const) {
      const data = encodePlanCallback(TASK_ID, action);
      expect(parsePlanCallback(data)).toEqual({ taskId: TASK_ID, action });
    }
  });

  it("returns null for malformed input", () => {
    expect(parsePlanCallback("plan:not-a-uuid:approve")).toBeNull();
    expect(parsePlanCallback(`plan:${TASK_ID}:bogus`)).toBeNull();
    expect(parsePlanCallback(`resume:${TASK_ID}`)).toBeNull();
    expect(parsePlanCallback("")).toBeNull();
    expect(parsePlanCallback("plan:")).toBeNull();
    // Trailing junk
    expect(parsePlanCallback(`plan:${TASK_ID}:approve:extra`)).toBeNull();
  });

  it("rejects pathological 36-char strings the loose regex would accept", () => {
    // Regression: previous regex was [0-9a-f-]{36}, which let through any
    // mix of hex + dashes. Tightened to the real UUID 8-4-4-4-12 shape.
    const allDashes = "------------------------------------"; // 36 chars
    expect(parsePlanCallback(`plan:${allDashes}:approve`)).toBeNull();
    const wrongLayout = "00000000-0000-0000-0000-000000000-00"; // 36 chars but wrong dashes
    expect(parsePlanCallback(`plan:${wrongLayout}:approve`)).toBeNull();
  });

  it("PLAN_CALLBACK_REGEX matches what parsePlanCallback accepts", () => {
    expect(PLAN_CALLBACK_REGEX.test(`plan:${TASK_ID}:approve`)).toBe(true);
    expect(PLAN_CALLBACK_REGEX.test(`plan:${TASK_ID}:revise`)).toBe(true);
    expect(PLAN_CALLBACK_REGEX.test(`plan:${TASK_ID}:cancel`)).toBe(true);
    expect(PLAN_CALLBACK_REGEX.test("plan:bad:approve")).toBe(false);
  });
});
