import { describe, expect, it } from "vitest";
import { expectDefined } from "../test/assertions.js";
import type { ChannelError, ChannelLiveness, LoopState } from "../transport/types.js";
import { channelCheck, channelChecks } from "./channel-check.js";

const STALE_MS = 90_000;
const WEDGED_MS = 300_000;
const NOW = 1_000_000;

function liveness(overrides: Partial<ChannelLiveness> = {}): ChannelLiveness {
  return {
    state: { kind: "receiving" },
    progressAt: NOW - 1_000,
    handlingSince: null,
    conflicts: 0,
    thresholds: { staleAfterMs: STALE_MS, wedgedAfterMs: WEDGED_MS },
    ...overrides,
  };
}

const NETWORK: ChannelError = { code: "ECONNRESET", detail: null };

function retrying(since: number, error: ChannelError = NETWORK): LoopState {
  return { kind: "retrying", since, cause: "network", error };
}

describe("channelCheck", () => {
  it("passes a receiving loop with recent progress", () => {
    expect(channelCheck(liveness(), NOW)).toEqual({ status: "pass", observedValue: 1 });
  });

  it("warns failed with the cause's text and code, keeping detail for the log", () => {
    const reading = channelCheck(
      liveness({
        state: {
          kind: "failed",
          reason: "unauthorized",
          error: { code: "401", detail: "Unauthorized" },
        },
      }),
      NOW,
    );

    expect(reading).toEqual({
      status: "warn",
      reason: "failed",
      output: "failed: the platform refused the channel's credentials (401)",
      observedValue: 1,
      detail: "Unauthorized",
    });
  });

  it("warns failed with no code when the loop ended with no error", () => {
    const reading = channelCheck(
      liveness({ state: { kind: "failed", reason: "ended", error: null } }),
      NOW,
    );

    expect(reading).toMatchObject({
      reason: "failed",
      output: "failed: the receive loop ended without stop()",
      detail: null,
    });
  });

  it("puts only a normalized code in output", () => {
    const reading = channelCheck(
      liveness({
        state: {
          kind: "failed",
          reason: "rejected",
          error: { code: "https://api.telegram.org/bot1:secret", detail: null },
        },
      }),
      NOW,
    );

    expect(reading).toMatchObject({
      output: "failed: the platform rejected the receive loop (unknown)",
    });
  });

  it("passes a stopped loop whatever its ages", () => {
    const reading = channelCheck(
      liveness({ state: { kind: "stopped" }, progressAt: 0, handlingSince: 0, conflicts: 5 }),
      NOW,
    );

    expect(reading.status).toBe("pass");
  });

  describe("wedged", () => {
    it("warns once an update has been in hand for wedgedAfter", () => {
      const reading = channelCheck(liveness({ handlingSince: NOW - WEDGED_MS }), NOW);

      expect(reading).toMatchObject({ status: "warn", reason: "wedged" });
    });

    it("passes just inside wedgedAfter", () => {
      expect(channelCheck(liveness({ handlingSince: NOW - WEDGED_MS + 1 }), NOW).status).toBe(
        "pass",
      );
    });

    it("masks flapping and retrying", () => {
      const reading = channelCheck(
        liveness({
          state: retrying(NOW - STALE_MS),
          handlingSince: NOW - WEDGED_MS,
          conflicts: 3,
        }),
        NOW,
      );

      expect(reading).toMatchObject({ reason: "wedged" });
    });
  });

  describe("flapping", () => {
    it("warns at the second conflict in a row, with the backoff's error", () => {
      const reading = channelCheck(
        liveness({
          state: {
            kind: "retrying",
            since: NOW - 1_000,
            cause: "conflict",
            error: { code: "409", detail: "Conflict: terminated by other getUpdates request" },
          },
          conflicts: 2,
        }),
        NOW,
      );

      expect(reading).toEqual({
        status: "warn",
        reason: "flapping",
        output: "flapping: another poller or a webhook holds the token (409)",
        observedValue: 1,
        detail: "Conflict: terminated by other getUpdates request",
      });
    });

    it("passes a single conflict", () => {
      const reading = channelCheck(
        liveness({
          state: { kind: "retrying", since: NOW - 1_000, cause: "conflict", error: NETWORK },
          conflicts: 1,
        }),
        NOW,
      );

      expect(reading.status).toBe("pass");
    });

    it("warns during a run while the streak holds", () => {
      expect(channelCheck(liveness({ conflicts: 2 }), NOW)).toMatchObject({
        reason: "flapping",
        output: "flapping: another poller or a webhook holds the token",
      });
    });

    it("masks retrying", () => {
      const reading = channelCheck(
        liveness({ state: retrying(NOW - STALE_MS), conflicts: 2 }),
        NOW,
      );

      expect(reading).toMatchObject({ reason: "flapping" });
    });
  });

  describe("retrying", () => {
    it("warns once retrying for staleAfter, with the cause's text and code", () => {
      const reading = channelCheck(
        liveness({
          state: retrying(NOW - STALE_MS, { code: "ECONNRESET", detail: "socket hang up" }),
        }),
        NOW,
      );

      expect(reading).toEqual({
        status: "warn",
        reason: "retrying",
        output: "retrying: after a network error (ECONNRESET)",
        observedValue: 1,
        detail: "socket hang up",
      });
    });

    it("passes just inside staleAfter", () => {
      expect(channelCheck(liveness({ state: retrying(NOW - STALE_MS + 1) }), NOW).status).toBe(
        "pass",
      );
    });

    it("masks stale", () => {
      const reading = channelCheck(
        liveness({ state: retrying(NOW - STALE_MS), progressAt: NOW - 10 * STALE_MS }),
        NOW,
      );

      expect(reading).toMatchObject({ reason: "retrying" });
    });
  });

  describe("stale", () => {
    it("warns once progress is staleAfter old, reporting its age", () => {
      const reading = channelCheck(liveness({ progressAt: NOW - STALE_MS }), NOW);

      expect(reading).toEqual({
        status: "warn",
        reason: "stale",
        output: "stale: no reply or update for too long",
        observedValue: 90,
        detail: null,
      });
    });

    it("passes just inside staleAfter", () => {
      expect(channelCheck(liveness({ progressAt: NOW - STALE_MS + 1 }), NOW).status).toBe("pass");
    });

    it("warns a starting loop whose setup hasn't returned", () => {
      const reading = channelCheck(
        liveness({ state: { kind: "starting" }, progressAt: NOW - STALE_MS }),
        NOW,
      );

      expect(reading).toMatchObject({ reason: "stale" });
    });

    it("doesn't warn while an update is in hand short of wedgedAfter", () => {
      const reading = channelCheck(
        liveness({ progressAt: NOW - STALE_MS, handlingSince: NOW - STALE_MS }),
        NOW,
      );

      expect(reading.status).toBe("pass");
    });
  });
});

describe("channelChecks", () => {
  const loop = { liveness: () => liveness() };
  const noLoop = { liveness: () => null };

  it("adds a {type}:polling entry per started channel with a loop", () => {
    const checks = channelChecks(
      [
        { channelType: "telegram", channelId: "tg-1", adapter: loop },
        { channelType: "web", channelId: "web-1", adapter: noLoop },
      ],
      [],
    );

    expect(checks.map(({ check, componentId }) => ({ check, componentId }))).toEqual([
      { check: "telegram:polling", componentId: "tg-1" },
    ]);
    expect(expectDefined(checks[0], "telegram entry").evaluate(NOW).status).toBe("pass");
  });

  it("adds a channels:adapter entry per unsupported row that always warns", () => {
    const [check] = channelChecks([], [{ channelType: "discord", channelId: "dc-1" }]);
    const entry = expectDefined(check, "unsupported entry");

    expect(entry).toMatchObject({ check: "channels:adapter", componentId: "dc-1" });
    expect(entry.evaluate(NOW)).toEqual({
      status: "warn",
      reason: "unsupported",
      output: "unsupported: this build has no adapter for the channel's type",
      observedValue: null,
      detail: null,
    });
  });

  it("throws when a loop's projection goes null after registering", () => {
    let reporting = true;
    const [check] = channelChecks(
      [
        {
          channelType: "telegram",
          channelId: "tg-1",
          adapter: { liveness: () => (reporting ? liveness() : null) },
        },
      ],
      [],
    );
    reporting = false;

    expect(() => expectDefined(check, "telegram entry").evaluate(NOW)).toThrow(/went null/);
  });
});
