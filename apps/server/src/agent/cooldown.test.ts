import { describe, expect, it } from "vitest";
import {
  buildInCooldownReply,
  COOLDOWN_BASE_SECONDS,
  COOLDOWN_CAP_SECONDS,
  cooldownEndsAt,
  formatRemainingCooldown,
  isInCooldown,
  nextCooldownState,
} from "./cooldown.js";
import type { CooldownState } from "./store/schema.js";

const NOW = new Date("2026-05-19T12:00:00.000Z");

describe("nextCooldownState", () => {
  it("starts at base for a fresh failure", () => {
    expect(nextCooldownState(null, NOW)).toEqual({
      lastErroredAt: NOW.toISOString(),
      cooldownSeconds: 60,
      consecutiveFailures: 1,
    });
  });

  it("doubles cooldown on subsequent failures", () => {
    const prior: CooldownState = {
      lastErroredAt: "2026-05-19T11:59:00.000Z",
      cooldownSeconds: 60,
      consecutiveFailures: 1,
    };
    expect(nextCooldownState(prior, NOW)).toEqual({
      lastErroredAt: NOW.toISOString(),
      cooldownSeconds: 120,
      consecutiveFailures: 2,
    });
  });

  it("caps cooldown at 1 hour", () => {
    const prior: CooldownState = {
      lastErroredAt: NOW.toISOString(),
      cooldownSeconds: 1920,
      consecutiveFailures: 6,
    };
    const next = nextCooldownState(prior, NOW);
    expect(next.cooldownSeconds).toBe(COOLDOWN_CAP_SECONDS);
    expect(next.consecutiveFailures).toBe(7);
  });

  it("keeps consecutiveFailures incrementing past the cap", () => {
    const prior: CooldownState = {
      lastErroredAt: NOW.toISOString(),
      cooldownSeconds: COOLDOWN_CAP_SECONDS,
      consecutiveFailures: 7,
    };
    const next = nextCooldownState(prior, NOW);
    expect(next.cooldownSeconds).toBe(COOLDOWN_CAP_SECONDS);
    expect(next.consecutiveFailures).toBe(8);
  });

  it("reaches the cap on the 7th failure", () => {
    let state: CooldownState | null = null;
    for (let i = 0; i < 7; i++) {
      state = nextCooldownState(state, NOW);
    }
    expect(state?.cooldownSeconds).toBe(COOLDOWN_CAP_SECONDS);
    expect(state?.consecutiveFailures).toBe(7);
  });
});

describe("isInCooldown", () => {
  it("is false when state is null (Closed)", () => {
    expect(isInCooldown(null, NOW)).toBe(false);
  });

  it("is true mid-window (Open)", () => {
    const state: CooldownState = {
      lastErroredAt: NOW.toISOString(),
      cooldownSeconds: COOLDOWN_BASE_SECONDS,
      consecutiveFailures: 1,
    };
    const midWindow = new Date(NOW.getTime() + 30 * 1000);
    expect(isInCooldown(state, midWindow)).toBe(true);
  });

  it("is false past the window (Half-open)", () => {
    const state: CooldownState = {
      lastErroredAt: NOW.toISOString(),
      cooldownSeconds: COOLDOWN_BASE_SECONDS,
      consecutiveFailures: 1,
    };
    const past = new Date(NOW.getTime() + 61 * 1000);
    expect(isInCooldown(state, past)).toBe(false);
  });

  it("is false exactly at the boundary", () => {
    const state: CooldownState = {
      lastErroredAt: NOW.toISOString(),
      cooldownSeconds: COOLDOWN_BASE_SECONDS,
      consecutiveFailures: 1,
    };
    const at = new Date(NOW.getTime() + 60 * 1000);
    expect(isInCooldown(state, at)).toBe(false);
  });
});

describe("cooldownEndsAt", () => {
  it("returns lastErroredAt + cooldownSeconds", () => {
    const state: CooldownState = {
      lastErroredAt: NOW.toISOString(),
      cooldownSeconds: 120,
      consecutiveFailures: 2,
    };
    expect(cooldownEndsAt(state).toISOString()).toBe("2026-05-19T12:02:00.000Z");
  });
});

describe("formatRemainingCooldown", () => {
  function withRemaining(seconds: number): CooldownState {
    return {
      lastErroredAt: NOW.toISOString(),
      cooldownSeconds: seconds,
      consecutiveFailures: 1,
    };
  }

  it("formats sub-minute remainders in seconds", () => {
    expect(formatRemainingCooldown(withRemaining(45), NOW)).toBe("45 seconds");
  });

  it("singularises 1 second", () => {
    expect(formatRemainingCooldown(withRemaining(1), NOW)).toBe("1 second");
  });

  it("formats minute-range remainders in minutes", () => {
    expect(formatRemainingCooldown(withRemaining(120), NOW)).toBe("2 minutes");
  });

  it("singularises 1 minute", () => {
    expect(formatRemainingCooldown(withRemaining(60), NOW)).toBe("1 minute");
  });

  it("formats hour-range remainders in hours", () => {
    expect(formatRemainingCooldown(withRemaining(3600), NOW)).toBe("1 hour");
  });

  it("returns 'a moment' when the window has elapsed", () => {
    const past = new Date(NOW.getTime() + 90 * 1000);
    expect(formatRemainingCooldown(withRemaining(60), past)).toBe("a moment");
  });
});

describe("buildInCooldownReply", () => {
  it("contains the retry estimate", () => {
    const state: CooldownState = {
      lastErroredAt: NOW.toISOString(),
      cooldownSeconds: 120,
      consecutiveFailures: 2,
    };
    expect(buildInCooldownReply(state, NOW)).toBe(
      "I hit an error on the last message and I'm waiting before trying again. Try again in 2 minutes.",
    );
  });
});
