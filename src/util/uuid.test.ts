import { describe, expect, it } from "vitest";
import { isUuid, UUID_PATTERN, UUID_RE, UuidSchema } from "./uuid.js";

const VALID = "019d0000-0000-7000-8000-00000000aaaa";

describe("UUID utilities", () => {
  it.each([
    "019d0000-0000-7000-8000-00000000aaaa",
    "01234567-89ab-cdef-0123-456789abcdef",
    "019d1234-5678-7abc-89de-f01234567890",
  ])("isUuid(%s) → true", (s) => {
    expect(isUuid(s)).toBe(true);
  });

  it.each([
    "",
    "not-a-uuid",
    "019D0000-0000-7000-8000-00000000AAAA", // upper-case rejected
    "019d000000007000800000000000aaaa", // dashes stripped
    "019d0000-0000-7000-8000-00000000aaaa-extra",
    "019d0000-0000-7000-8000-00000000aaa", // 11 hex in last group
    "g19d0000-0000-7000-8000-00000000aaaa", // 'g' isn't hex
  ])("isUuid(%s) → false", (s) => {
    expect(isUuid(s)).toBe(false);
  });

  it("UUID_PATTERN embeds in a larger regex without anchors", () => {
    const re = new RegExp(`^perm:(${UUID_PATTERN}):x$`);
    const m = re.exec(`perm:${VALID}:x`);
    expect(m?.[1]).toBe(VALID);
  });

  it("UUID_RE is anchored at both ends (no substring match)", () => {
    expect(UUID_RE.test(`prefix-${VALID}`)).toBe(false);
    expect(UUID_RE.test(`${VALID}-suffix`)).toBe(false);
  });

  it("UuidSchema parses valid + rejects invalid via Zod", () => {
    expect(UuidSchema.safeParse(VALID).success).toBe(true);
    expect(UuidSchema.safeParse("nope").success).toBe(false);
    expect(UuidSchema.safeParse(VALID.toUpperCase()).success).toBe(false);
  });
});
