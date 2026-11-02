import { describe, expect, it } from "vitest";
import {
  buildSkillsApprovalKeyboard,
  buildSkillsLiveKeyboard,
  encodeSkillsDeployCallback,
  parseSkillsDeployCallback,
  SKILLS_DEPLOY_CALLBACK_REGEX,
} from "./skills-keyboard.js";

const PENDING_ID = "019d0000-0000-7000-8000-000000000001";
const SKILL_ID = "019d0000-0000-7000-8000-0000000000ab";

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

  it("buildSkillsLiveKeyboard returns one Disable button keyed by the skill id", () => {
    const kb = buildSkillsLiveKeyboard(SKILL_ID);
    expect(kb.inline_keyboard).toEqual([
      [{ text: "🚫 Disable", callback_data: `skill:${SKILL_ID}:disable` }],
    ]);
  });

  it("encodeSkillsDeployCallback stays within Telegram's 64-byte callback_data cap", () => {
    expect(
      Buffer.byteLength(encodeSkillsDeployCallback(PENDING_ID, "approve"), "utf8"),
    ).toBeLessThanOrEqual(64);
    expect(
      Buffer.byteLength(encodeSkillsDeployCallback(PENDING_ID, "deny"), "utf8"),
    ).toBeLessThanOrEqual(64);
    expect(
      Buffer.byteLength(encodeSkillsDeployCallback(SKILL_ID, "disable"), "utf8"),
    ).toBeLessThanOrEqual(64);
  });
});

describe("skills-keyboard parsing", () => {
  it("round-trips encode → parse for every action", () => {
    for (const action of ["approve", "deny"] as const) {
      const data = encodeSkillsDeployCallback(PENDING_ID, action);
      expect(parseSkillsDeployCallback(data)).toEqual({ pendingId: PENDING_ID, action });
    }
    expect(parseSkillsDeployCallback(encodeSkillsDeployCallback(SKILL_ID, "disable"))).toEqual({
      skillId: SKILL_ID,
      action: "disable",
    });
  });

  it("returns null for malformed input", () => {
    expect(parseSkillsDeployCallback("skill:not-a-uuid:approve")).toBeNull();
    expect(parseSkillsDeployCallback(`skill:${PENDING_ID}:bogus`)).toBeNull();
    expect(parseSkillsDeployCallback(`plan:${PENDING_ID}:approve`)).toBeNull();
    expect(parseSkillsDeployCallback("")).toBeNull();
    expect(parseSkillsDeployCallback("skill:")).toBeNull();
    expect(parseSkillsDeployCallback(`skill:${PENDING_ID}:approve:extra`)).toBeNull();
  });

  it("rejects payloads without a UUID between prefix and action", () => {
    expect(parseSkillsDeployCallback("skill::approve")).toBeNull();
    expect(parseSkillsDeployCallback("skill:approve")).toBeNull();
    expect(parseSkillsDeployCallback("skill: :deny")).toBeNull();
  });

  it("rejects pathological 36-char strings the loose regex would accept", () => {
    const allDashes = "------------------------------------";
    expect(parseSkillsDeployCallback(`skill:${allDashes}:approve`)).toBeNull();
    const wrongLayout = "00000000-0000-0000-0000-000000000-00";
    expect(parseSkillsDeployCallback(`skill:${wrongLayout}:deny`)).toBeNull();
  });

  it("SKILLS_DEPLOY_CALLBACK_REGEX matches what parseSkillsDeployCallback accepts", () => {
    expect(SKILLS_DEPLOY_CALLBACK_REGEX.test(`skill:${PENDING_ID}:approve`)).toBe(true);
    expect(SKILLS_DEPLOY_CALLBACK_REGEX.test(`skill:${PENDING_ID}:deny`)).toBe(true);
    expect(SKILLS_DEPLOY_CALLBACK_REGEX.test(`skill:${SKILL_ID}:disable`)).toBe(true);
    expect(SKILLS_DEPLOY_CALLBACK_REGEX.test(`skill:${SKILL_ID}:enable`)).toBe(false);
    expect(SKILLS_DEPLOY_CALLBACK_REGEX.test("skill:bad:approve")).toBe(false);
  });

  it("rejects oversized payloads", () => {
    const oversizedId = `${PENDING_ID}-padding-padding-padding-padding`;
    const oversized = `skill:${oversizedId}:approve`;
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(64);
    expect(parseSkillsDeployCallback(oversized)).toBeNull();
    expect(SKILLS_DEPLOY_CALLBACK_REGEX.test(oversized)).toBe(false);
  });
});

describe("skills-keyboard wire format", () => {
  // Pin the exact on-the-wire callback_data shape — wire-format changes
  // break in-flight buttons on user phones.
  it("encoder produces the documented shape for every action", () => {
    expect(encodeSkillsDeployCallback(PENDING_ID, "approve")).toBe(`skill:${PENDING_ID}:approve`);
    expect(encodeSkillsDeployCallback(PENDING_ID, "deny")).toBe(`skill:${PENDING_ID}:deny`);
    expect(encodeSkillsDeployCallback(SKILL_ID, "disable")).toBe(`skill:${SKILL_ID}:disable`);
  });

  it("buildSkillsApprovalKeyboard wires callback_data through encodeSkillsDeployCallback verbatim", () => {
    const kb = buildSkillsApprovalKeyboard(PENDING_ID);
    const row = kb.inline_keyboard[0];
    expect(row?.[0]?.callback_data).toBe(encodeSkillsDeployCallback(PENDING_ID, "approve"));
    expect(row?.[1]?.callback_data).toBe(encodeSkillsDeployCallback(PENDING_ID, "deny"));
  });
});
