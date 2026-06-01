import { describe, expect, it } from "vitest";
import { normalizeHappenedIn } from "./llmock-happened-in.js";

/**
 * Pins the llmock date-normalizer. The bug class it guards is "a normalization
 * path was missed" — a regex regression here would silently reintroduce the
 * month-rollover fixture drift (only the integration tier would catch it, and
 * only once the calendar moved).
 */
describe("normalizeHappenedIn", () => {
  it("collapses a fact-attached (happened in <Month> <Year>) suffix to a stable token", () => {
    expect(normalizeHappenedIn("Homelab IP is 10.0.10.10 (happened in June 2026)")).toBe(
      "Homelab IP is 10.0.10.10 (happened in [WHEN])",
    );
  });

  it("normalizes regardless of month/year (no calendar drift)", () => {
    expect(normalizeHappenedIn("x (happened in May 2026)")).toBe(
      normalizeHappenedIn("x (happened in December 2031)"),
    );
  });

  it("replaces every occurrence (chat prompts batch multiple facts)", () => {
    expect(normalizeHappenedIn("a (happened in January 2026) and b (happened in March 2027)")).toBe(
      "a (happened in [WHEN]) and b (happened in [WHEN])",
    );
  });

  it("leaves a meaningful date that isn't the temporal suffix untouched", () => {
    expect(normalizeHappenedIn("wife's birthday is March 15")).toBe("wife's birthday is March 15");
  });

  it("passes undefined through (no embedding input)", () => {
    expect(normalizeHappenedIn(undefined)).toBeUndefined();
  });
});
