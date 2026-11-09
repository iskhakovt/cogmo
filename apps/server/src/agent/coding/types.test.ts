import { describe, expect, it } from "vitest";
import { WorktreeAssignmentSchema } from "./types.js";

function withBase(baseSha: string) {
  return WorktreeAssignmentSchema.safeParse({ type: "git-remote", branch: "cogmo/x", baseSha });
}

describe("WorktreeAssignmentSchema's baseSha, a SHA-1 or SHA-256 commit id", () => {
  it.each([40, 64])("accepts %i lowercase hex characters", (length) => {
    expect(withBase("a".repeat(length)).success).toBe(true);
  });

  it.each([39, 41, 63, 65])("refuses %i hex characters", (length) => {
    expect(withBase("a".repeat(length)).success).toBe(false);
  });

  it("refuses uppercase hex", () => {
    expect(withBase("A".repeat(40)).success).toBe(false);
  });
});
