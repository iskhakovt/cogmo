import { describe, expect, it } from "vitest";
import {
  buildSkillsApprovalKeyboard,
  encodeSkillsApprovalCallback,
  parseSkillsApprovalCallback,
  SKILLS_APPROVAL_CALLBACK_REGEX,
} from "./skills-keyboard.js";

const PENDING_ID = "019d0000-0000-7000-8000-000000000001";

describe("skills-keyboard encoding", () => {
  it("buildSkillsApprovalKeyboard returns Approve / Deny in one row", () => {
    const kb = buildSkillsApprovalKeyboard(PENDING_ID);
    expect(kb.inline_keyboard).toHaveLength(1);
    const row = kb.inline_keyboard[0];
    expect(row).toHaveLength(2);
    expect(row?.map((b) => b.text)).toEqual(["✅ Approve", "❌ Deny"]);
    expect(row?.[0]?.callback_data).toBe(`skill:${PENDING_ID}:approve`);
    expect(row?.[1]?.callback_data).toBe(`skill:${PENDING_ID}:deny`);
  });

  it("encodeSkillsApprovalCallback stays within Telegram's 64-byte callback_data cap", () => {
    expect(
      Buffer.byteLength(encodeSkillsApprovalCallback(PENDING_ID, "approve"), "utf8"),
    ).toBeLessThanOrEqual(64);
    expect(
      Buffer.byteLength(encodeSkillsApprovalCallback(PENDING_ID, "deny"), "utf8"),
    ).toBeLessThanOrEqual(64);
  });
});

describe("skills-keyboard parsing", () => {
  it("round-trips encode → parse for both actions", () => {
    for (const action of ["approve", "deny"] as const) {
      const data = encodeSkillsApprovalCallback(PENDING_ID, action);
      expect(parseSkillsApprovalCallback(data)).toEqual({ pendingId: PENDING_ID, action });
    }
  });

  it("returns null for malformed input", () => {
    expect(parseSkillsApprovalCallback("skill:not-a-uuid:approve")).toBeNull();
    expect(parseSkillsApprovalCallback(`skill:${PENDING_ID}:bogus`)).toBeNull();
    expect(parseSkillsApprovalCallback(`plan:${PENDING_ID}:approve`)).toBeNull();
    expect(parseSkillsApprovalCallback("")).toBeNull();
    expect(parseSkillsApprovalCallback("skill:")).toBeNull();
    expect(parseSkillsApprovalCallback(`skill:${PENDING_ID}:approve:extra`)).toBeNull();
  });

  it("rejects payloads without a UUID between prefix and action", () => {
    expect(parseSkillsApprovalCallback("skill::approve")).toBeNull();
    expect(parseSkillsApprovalCallback("skill:approve")).toBeNull();
    expect(parseSkillsApprovalCallback("skill: :deny")).toBeNull();
  });

  it("rejects pathological 36-char strings the loose regex would accept", () => {
    const allDashes = "------------------------------------";
    expect(parseSkillsApprovalCallback(`skill:${allDashes}:approve`)).toBeNull();
    const wrongLayout = "00000000-0000-0000-0000-000000000-00";
    expect(parseSkillsApprovalCallback(`skill:${wrongLayout}:deny`)).toBeNull();
  });

  it("SKILLS_APPROVAL_CALLBACK_REGEX matches what parseSkillsApprovalCallback accepts", () => {
    expect(SKILLS_APPROVAL_CALLBACK_REGEX.test(`skill:${PENDING_ID}:approve`)).toBe(true);
    expect(SKILLS_APPROVAL_CALLBACK_REGEX.test(`skill:${PENDING_ID}:deny`)).toBe(true);
    expect(SKILLS_APPROVAL_CALLBACK_REGEX.test("skill:bad:approve")).toBe(false);
  });

  it("rejects oversized payloads", () => {
    const oversizedId = `${PENDING_ID}-padding-padding-padding-padding`;
    const oversized = `skill:${oversizedId}:approve`;
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(64);
    expect(parseSkillsApprovalCallback(oversized)).toBeNull();
    expect(SKILLS_APPROVAL_CALLBACK_REGEX.test(oversized)).toBe(false);
  });
});

describe("skills-keyboard wire format", () => {
  // Pin the exact on-the-wire callback_data shape — wire-format changes
  // break in-flight buttons on user phones.
  it("encoder produces the documented shape for both actions", () => {
    expect(encodeSkillsApprovalCallback(PENDING_ID, "approve")).toBe(`skill:${PENDING_ID}:approve`);
    expect(encodeSkillsApprovalCallback(PENDING_ID, "deny")).toBe(`skill:${PENDING_ID}:deny`);
  });

  it("buildSkillsApprovalKeyboard wires callback_data through encodeSkillsApprovalCallback verbatim", () => {
    const kb = buildSkillsApprovalKeyboard(PENDING_ID);
    const row = kb.inline_keyboard[0];
    expect(row?.[0]?.callback_data).toBe(encodeSkillsApprovalCallback(PENDING_ID, "approve"));
    expect(row?.[1]?.callback_data).toBe(encodeSkillsApprovalCallback(PENDING_ID, "deny"));
  });
});
