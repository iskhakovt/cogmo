import { describe, expect, it } from "vitest";
import {
  actionToDecision,
  buildPermissionKeyboard,
  encodePermissionCallback,
  PERMISSION_CALLBACK_REGEX,
  parsePermissionCallback,
  shortenRequestId,
} from "./permission-keyboard.js";

const TASK_ID = "019d0000-0000-7000-8000-00000000aaaa";

describe("permission-keyboard", () => {
  it("builds the three-button row with single-char wire codes", () => {
    const kb = buildPermissionKeyboard(TASK_ID, "req_xyz");
    expect(kb.inline_keyboard).toHaveLength(1);
    expect(kb.inline_keyboard[0]?.map((b) => b.text)).toEqual(["✅ Once", "✅ Task", "❌ Deny"]);
    expect(kb.inline_keyboard[0]?.map((b) => b.callback_data)).toEqual([
      `perm:${TASK_ID}:req_xyz:o`,
      `perm:${TASK_ID}:req_xyz:t`,
      `perm:${TASK_ID}:req_xyz:d`,
    ]);
  });

  it.each([
    "allow_once" as const,
    "allow_task" as const,
    "deny" as const,
  ])("round-trips action %s through encode + parse", (action) => {
    const data = encodePermissionCallback(TASK_ID, "req_42", action);
    const parsed = parsePermissionCallback(data);
    expect(parsed).toEqual({ taskId: TASK_ID, requestIdShort: "req_42", action });
  });

  it("returns null on malformed callback_data", () => {
    expect(parsePermissionCallback("perm:not-a-uuid:req:o")).toBeNull();
    expect(parsePermissionCallback("perm")).toBeNull();
    expect(parsePermissionCallback(`perm:${TASK_ID}:req:x`)).toBeNull();
    expect(parsePermissionCallback(`plan:${TASK_ID}:req:o`)).toBeNull();
  });

  it("PERMISSION_CALLBACK_REGEX matches valid forms", () => {
    expect(PERMISSION_CALLBACK_REGEX.test(`perm:${TASK_ID}:req_x:o`)).toBe(true);
    expect(PERMISSION_CALLBACK_REGEX.test(`perm:${TASK_ID}:req_x:t`)).toBe(true);
    expect(PERMISSION_CALLBACK_REGEX.test(`perm:${TASK_ID}:abcd1234:d`)).toBe(true);
    expect(PERMISSION_CALLBACK_REGEX.test(`perm:${TASK_ID}:abcd1234:x`)).toBe(false);
  });

  it("shortenRequestId truncates at 16 chars and strips disallowed characters", () => {
    expect(shortenRequestId("req_abc")).toBe("req_abc");
    expect(shortenRequestId("0123456789abcdef0123")).toBe("0123456789abcdef");
    expect(shortenRequestId("req:with:colons")).toBe("reqwithcolons");
    expect(shortenRequestId("req with spaces")).toBe("reqwithspaces");
  });

  it.each([
    "",
    ":::",
    "..",
    "  ",
    "🔥💥",
  ])("shortenRequestId(%s) falls back to a parseable placeholder", (input) => {
    const short = shortenRequestId(input);
    expect(short.length).toBeGreaterThan(0);
    // Must round-trip through the parse regex so callback_data stays
    // valid even if Claude Code ever ships a weird request_id.
    const callback = encodePermissionCallback(TASK_ID, short, "deny");
    expect(parsePermissionCallback(callback)?.requestIdShort).toBe(short);
  });

  it("shortenRequestId fallback is collision-resistant across distinct malformed inputs", () => {
    // Two distinct unrepresentable inputs MUST produce distinct shortened
    // forms, otherwise a wait filtered on one's id could be unblocked by
    // the other's keyboard tap (the Inngest filter compares the truncated
    // string equality, not the original request_id).
    const ids = ["🔥", "💥", "", ":::", "..", "@@@", "🔥🔥🔥"];
    const shortened = ids.map(shortenRequestId);
    expect(new Set(shortened).size).toBe(ids.length);
    // Same input must still round-trip to the same shortened form.
    expect(shortenRequestId("🔥")).toBe(shortenRequestId("🔥"));
  });

  it("callback_data stays under Telegram's 64-byte limit for a full-UUID + 16-char id + worst-case action", () => {
    for (const action of ["allow_once", "allow_task", "deny"] as const) {
      const data = encodePermissionCallback(TASK_ID, "0123456789abcdef", action);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    }
  });

  describe("actionToDecision", () => {
    it("maps allow_once → allow/once", () => {
      expect(actionToDecision("allow_once")).toEqual({ decision: "allow", scope: "once" });
    });
    it("maps allow_task → allow/task", () => {
      expect(actionToDecision("allow_task")).toEqual({ decision: "allow", scope: "task" });
    });
    it("maps deny → deny/once", () => {
      expect(actionToDecision("deny")).toEqual({ decision: "deny", scope: "once" });
    });
  });
});
