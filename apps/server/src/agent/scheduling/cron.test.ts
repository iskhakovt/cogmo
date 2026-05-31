import { describe, expect, it } from "vitest";
import { computeNextRun, MIN_CRON_INTERVAL_SECONDS, validateCron } from "./cron.js";

describe("validateCron", () => {
  it("accepts a standard 5-field cron in a valid IANA tz", () => {
    const result = validateCron("0 9 * * *", "Europe/London");
    expect(result.isOk()).toBe(true);
  });

  it("accepts * * * * * — every minute is exactly the minimum interval", () => {
    const result = validateCron("* * * * *", "UTC");
    expect(result.isOk()).toBe(true);
  });

  it("rejects 6-field cron (with seconds) to keep minutes as the smallest unit", () => {
    const result = validateCron("*/30 * * * * *", "UTC");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "unsupported_field_count",
      got: 6,
      expected: 5,
    });
  });

  it("rejects fewer than 5 fields", () => {
    const result = validateCron("* * *", "UTC");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("unsupported_field_count");
  });

  it("rejects an unknown timezone", () => {
    const result = validateCron("0 9 * * *", "Atlantis/Capital");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "invalid_timezone",
      timezone: "Atlantis/Capital",
    });
  });

  it("rejects a malformed cron expression (field count valid but values out of range)", () => {
    const result = validateCron("99 * * * *", "UTC");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("malformed");
  });

  it("rejects garbage in a field slot as malformed", () => {
    // Plain `?` is accepted by croner as Quartz-style wildcard, so use a
    // letter that has no cron meaning instead.
    const result = validateCron("0 * * * x", "UTC");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("malformed");
  });

  it("orders checks so field count fires before timezone validation", () => {
    // 4 fields + bad tz — we want the field-count error, not the tz error.
    const result = validateCron("* * * *", "Atlantis/Capital");
    expect(result._unsafeUnwrapErr().kind).toBe("unsupported_field_count");
  });
});

describe("computeNextRun", () => {
  it("returns the next occurrence strictly after `after`", () => {
    // 09:00 daily in UTC. After 2026-06-01T08:00Z → 2026-06-01T09:00Z.
    const next = computeNextRun("0 9 * * *", "UTC", new Date("2026-06-01T08:00:00Z"));
    expect(next.toISOString()).toBe("2026-06-01T09:00:00.000Z");
  });

  it("skips past `after` when `after` itself matches the cron", () => {
    // After 2026-06-01T09:00Z exactly → 2026-06-02T09:00Z (strict).
    const next = computeNextRun("0 9 * * *", "UTC", new Date("2026-06-01T09:00:00Z"));
    expect(next.toISOString()).toBe("2026-06-02T09:00:00.000Z");
  });

  it("throws when croner has no future occurrence (after is too far in the future)", () => {
    // Croner caps lookahead near JS Date max; querying from year 9999
    // returns null. Documented as "unreachable for recurring crons"
    // in production (after is always a recent timestamp), but we want
    // the throw to fire loudly rather than silently return undefined.
    expect(() => computeNextRun("0 9 * * *", "UTC", new Date("9999-12-31T23:59:59Z"))).toThrow(
      /no occurrence after/,
    );
  });

  it("resolves cron in the user's IANA tz, not UTC", () => {
    // 09:00 daily in Europe/London. In May 2026 BST is in effect (UTC+1),
    // so 09:00 BST = 08:00 UTC.
    const next = computeNextRun("0 9 * * *", "Europe/London", new Date("2026-05-15T00:00:00Z"));
    expect(next.toISOString()).toBe("2026-05-15T08:00:00.000Z");
  });

  describe("DST: spring forward", () => {
    // 2026-03-29: Europe/London clocks jump 01:00 GMT → 02:00 BST. A
    // "01:00 local" fire on that day doesn't exist as a local instant —
    // croner shifts it forward to the next valid instant (02:00 BST =
    // 01:00 UTC). This preserves "fires daily" semantics across DST
    // transitions; the user gets one fire that day, just one hour late
    // in local terms.
    it("shifts to the next valid instant on spring-forward when cron targets the missing hour", () => {
      const next = computeNextRun(
        "0 1 * * *", // 01:00 local, every day
        "Europe/London",
        new Date("2026-03-28T12:00:00Z"),
      );
      // 01:00 BST doesn't exist on 2026-03-29; croner shifts to the
      // next valid instant, which is 02:00 BST = 01:00 UTC.
      expect(next.toISOString()).toBe("2026-03-29T01:00:00.000Z");
    });

    it("resumes the normal cadence the day after spring-forward", () => {
      // Starting strictly after the shifted fire, the next occurrence
      // is the normal 01:00 BST = 00:00 UTC slot the following day.
      const next = computeNextRun("0 1 * * *", "Europe/London", new Date("2026-03-29T01:00:00Z"));
      expect(next.toISOString()).toBe("2026-03-30T00:00:00.000Z");
    });

    it("fires normally for a cron that doesn't land in the missing hour", () => {
      const next = computeNextRun(
        "0 9 * * *", // 09:00 local, every day
        "Europe/London",
        new Date("2026-03-28T12:00:00Z"),
      );
      // 2026-03-29 09:00 BST exists and = 2026-03-29T08:00:00Z.
      expect(next.toISOString()).toBe("2026-03-29T08:00:00.000Z");
    });
  });

  describe("DST: fall back", () => {
    // 2026-10-25: Europe/London clocks jump 02:00 BST → 01:00 GMT.
    // 01:00 local happens twice (once as BST, once as GMT). Croner
    // fires once at the first occurrence (01:00 BST = 00:00 UTC).
    it("fires once at the first occurrence on fall-back", () => {
      const next = computeNextRun(
        "0 1 * * *", // 01:00 local, every day
        "Europe/London",
        new Date("2026-10-24T12:00:00Z"),
      );
      // 01:00 BST on 2026-10-25 = 00:00 UTC. Should fire here, NOT
      // again at 01:00 GMT (= 01:00 UTC the same day).
      expect(next.toISOString()).toBe("2026-10-25T00:00:00.000Z");
    });

    it("does not re-fire at the second 01:00 (GMT) on fall-back", () => {
      // Starting strictly after the first 01:00 BST should jump to the
      // NEXT day, not catch the duplicate hour.
      const next = computeNextRun(
        "0 1 * * *",
        "Europe/London",
        new Date("2026-10-25T00:30:00Z"), // 30 min after first fire
      );
      // Next fire is 2026-10-26 01:00 GMT = 2026-10-26T01:00:00Z.
      expect(next.toISOString()).toBe("2026-10-26T01:00:00.000Z");
    });

    it("fires normally at 02:30 on a spring-forward day (not in the missing hour)", () => {
      // 02:30 local on 2026-03-29 is AFTER the DST jump (01:00 → 02:00),
      // so it exists as a normal BST instant. Pin that croner doesn't
      // accidentally drag this fire into the gap with the 01:00 case.
      const next = computeNextRun("30 2 * * *", "Europe/London", new Date("2026-03-29T00:00:00Z"));
      // 02:30 BST = 01:30 UTC.
      expect(next.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    });
  });

  describe("DST: southern hemisphere", () => {
    // Australia/Sydney DST runs the opposite calendar direction:
    //   - Starts Oct 5 2025 (clocks forward 02:00 AEST → 03:00 AEDT)
    //   - Ends   Apr 5 2026 (clocks back    03:00 AEDT → 02:00 AEST)
    // Confirms croner's tz arithmetic isn't northern-hemisphere-only.

    it("shifts to next valid instant on Sydney spring-forward (Oct)", () => {
      // "Every day at 02:30 local" — 02:30 AEST doesn't exist on
      // 2025-10-05 (clocks jump 02:00 → 03:00 AEDT). Croner's
      // convention: shift the missing local time forward by 1 hour
      // (same as the northern-hemisphere `01:00 → 02:00 BST` case),
      // NOT snap to the gap edge.
      const next = computeNextRun(
        "30 2 * * *",
        "Australia/Sydney",
        new Date("2025-10-04T12:00:00Z"),
      );
      // 03:30 AEDT on 2025-10-05 = 16:30 UTC on 2025-10-04 (Sydney is
      // UTC+11 post-DST, so the shifted-forward 03:30 local is the
      // previous calendar date in UTC).
      expect(next.toISOString()).toBe("2025-10-04T16:30:00.000Z");
    });

    it("fires once at first occurrence on Sydney fall-back (Apr)", () => {
      // 2026-04-05: clocks 03:00 AEDT → 02:00 AEST. 02:30 local happens
      // twice (AEDT and AEST). Fire once at the first.
      const next = computeNextRun(
        "30 2 * * *",
        "Australia/Sydney",
        new Date("2026-04-04T12:00:00Z"),
      );
      // 02:30 AEDT on 2026-04-05 = 15:30 UTC on 2026-04-04.
      expect(next.toISOString()).toBe("2026-04-04T15:30:00.000Z");
    });
  });

  describe("timezone validation policy", () => {
    // Policy: accept whatever Intl.DateTimeFormat accepts. Node 24's
    // Intl is permissive — it accepts legacy abbreviations (EST,
    // PST8PDT), fixed offsets (+01:00), and full IANA names. Users
    // who pass legacy strings get whatever DST behaviour those strings
    // imply (often: no DST at all for offset-only strings). We don't
    // restrict further at validation time.
    it("accepts UTC", () => {
      expect(validateCron("0 9 * * *", "UTC").isOk()).toBe(true);
    });

    it("accepts legacy abbreviation EST (Intl-permissive)", () => {
      expect(validateCron("0 9 * * *", "EST").isOk()).toBe(true);
    });

    it("accepts fixed offset +01:00 (Intl-permissive)", () => {
      expect(validateCron("0 9 * * *", "+01:00").isOk()).toBe(true);
    });

    it("accepts Etc/UTC IANA alias", () => {
      expect(validateCron("0 9 * * *", "Etc/UTC").isOk()).toBe(true);
    });
  });
});

describe("MIN_CRON_INTERVAL_SECONDS", () => {
  it("is 60 — minute granularity of standard 5-field cron", () => {
    expect(MIN_CRON_INTERVAL_SECONDS).toBe(60);
  });
});
