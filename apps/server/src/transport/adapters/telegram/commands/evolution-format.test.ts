import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./evolution-format.js";

describe("formatRelativeTime", () => {
  const now = new Date("2026-06-01T12:00:00Z");

  it("renders sub-45s deltas as 'now'", () => {
    expect(formatRelativeTime(new Date("2026-06-01T11:59:30Z"), now)).toBe("now");
  });

  it("renders minute deltas", () => {
    expect(formatRelativeTime(new Date("2026-06-01T11:55:00Z"), now)).toBe("5 minutes ago");
  });

  it("renders hour deltas", () => {
    expect(formatRelativeTime(new Date("2026-06-01T09:00:00Z"), now)).toBe("3 hours ago");
  });

  it("renders 'yesterday' for ~24h ago", () => {
    expect(formatRelativeTime(new Date("2026-05-31T12:00:00Z"), now)).toBe("yesterday");
  });

  it("renders day deltas within a week", () => {
    expect(formatRelativeTime(new Date("2026-05-29T12:00:00Z"), now)).toBe("3 days ago");
  });

  it("falls back to ISO date for older-than-a-week", () => {
    expect(formatRelativeTime(new Date("2026-04-15T12:00:00Z"), now)).toBe("2026-04-15");
  });

  it("handles future timestamps without crashing", () => {
    // A future createdAt would be a stamping bug; the renderer should
    // still produce something rather than blow up.
    expect(formatRelativeTime(new Date("2026-06-01T13:00:00Z"), now)).toBe("in 1 hour");
  });
});
