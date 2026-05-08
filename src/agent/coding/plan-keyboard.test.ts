import { describe, expect, it } from "vitest";
import { expectDefined } from "../../test/assertions.js";
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
    const row = expectDefined(kb.inline_keyboard[0], "first keyboard row");
    expect(row).toHaveLength(3);
    expect(row.map((b) => b.text)).toEqual(["✅ Approve", "✏️ Revise", "❌ Cancel"]);
    expect(expectDefined(row[0], "approve").callback_data).toBe(`plan:${TASK_ID}:approve`);
    expect(expectDefined(row[1], "revise").callback_data).toBe(`plan:${TASK_ID}:revise`);
    expect(expectDefined(row[2], "cancel").callback_data).toBe(`plan:${TASK_ID}:cancel`);
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

  it("rejects payloads with an action but no taskId", () => {
    // A spoofed/clipped tap that has the prefix and a valid action code but
    // no UUID between them must not slip through — the handler relies on
    // taskId presence to look up the task and check ownership.
    expect(parsePlanCallback("plan::approve")).toBeNull();
    expect(parsePlanCallback("plan:approve")).toBeNull();
    expect(parsePlanCallback("plan::revise")).toBeNull();
    expect(parsePlanCallback("plan::cancel")).toBeNull();
    // Whitespace where the UUID should be — also a no.
    expect(parsePlanCallback("plan: :approve")).toBeNull();
  });

  it("rejects payloads exceeding Telegram's 64-byte callback_data limit", () => {
    // Telegram's Bot API rejects callback_data > 64 bytes at send time, so a
    // tap can never carry more than 64 bytes in practice. But if a malicious
    // / buggy client crafts one, the parser still must reject it cleanly
    // rather than match a too-long taskId.
    const oversizedTaskId = `${TASK_ID}-padding-padding-padding-padding`;
    const oversized = `plan:${oversizedTaskId}:approve`;
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(64);
    expect(parsePlanCallback(oversized)).toBeNull();
  });

  it("PLAN_CALLBACK_REGEX rejects oversized payloads too", () => {
    // The grammY callback dispatcher uses PLAN_CALLBACK_REGEX directly, so
    // it must agree with parsePlanCallback on the rejection.
    const oversizedTaskId = `${TASK_ID}-padding-padding-padding-padding`;
    expect(PLAN_CALLBACK_REGEX.test(`plan:${oversizedTaskId}:approve`)).toBe(false);
  });
});

describe("plan-keyboard wire format", () => {
  // Pin the exact on-the-wire callback_data shape. Buttons issued by an old
  // app version live on user phones until the message is replaced — a wire
  // format change is a backwards-incompatible break and must be deliberate.
  it("encoder produces the documented shape for every action", () => {
    expect(encodePlanCallback(TASK_ID, "approve")).toBe(`plan:${TASK_ID}:approve`);
    expect(encodePlanCallback(TASK_ID, "revise")).toBe(`plan:${TASK_ID}:revise`);
    expect(encodePlanCallback(TASK_ID, "cancel")).toBe(`plan:${TASK_ID}:cancel`);
  });

  it("buildPlanKeyboard wires callback_data through encodePlanCallback verbatim", () => {
    const kb = buildPlanKeyboard(TASK_ID);
    const row = kb.inline_keyboard[0];
    expect(row?.[0]?.callback_data).toBe(encodePlanCallback(TASK_ID, "approve"));
    expect(row?.[1]?.callback_data).toBe(encodePlanCallback(TASK_ID, "revise"));
    expect(row?.[2]?.callback_data).toBe(encodePlanCallback(TASK_ID, "cancel"));
  });
});
