import { afterEach, describe, expect, it } from "vitest";
import {
  bundledSnapshot,
  candidateKeys,
  installLiveCatalog,
  LitellmCatalogSchema,
  liveCatalogStatus,
  lookupLitellm,
} from "./litellm-data.js";

describe("candidateKeys", () => {
  it("returns the bare id when no slash is present", () => {
    expect(candidateKeys("claude-sonnet-4-6")).toEqual([
      "claude-sonnet-4-6",
      "openrouter/claude-sonnet-4-6",
    ]);
  });

  it("expands x-ai/ to xai/ and adds openrouter/ prefix", () => {
    const keys = candidateKeys("x-ai/grok-4.3");
    // Exact key first, then openrouter-prefixed, then alias variants, then bare.
    expect(keys).toEqual([
      "x-ai/grok-4.3",
      "openrouter/x-ai/grok-4.3",
      "xai/grok-4.3",
      "openrouter/xai/grok-4.3",
      "grok-4.3",
    ]);
  });

  it("strips a leading openrouter/ when present, then adds aliases", () => {
    const keys = candidateKeys("openrouter/x-ai/grok-4.3");
    expect(keys).toEqual([
      "openrouter/x-ai/grok-4.3",
      "x-ai/grok-4.3",
      "openrouter/xai/grok-4.3",
      "xai/grok-4.3",
      "grok-4.3",
    ]);
  });

  it("dedupes within the candidate ladder", () => {
    // No alias applies and no openrouter prefix → just bare + openrouter form
    // + bare-after-slash. Should not produce duplicates.
    const keys = candidateKeys("anthropic/claude-haiku-4.5");
    const unique = [...new Set(keys)];
    expect(keys.length).toBe(unique.length);
  });
});

describe("lookupLitellm", () => {
  it("finds a directly-keyed Anthropic model", () => {
    const hit = lookupLitellm("claude-sonnet-4-6");
    expect(hit).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 64_000 });
  });

  it("finds an xAI model via the x-ai/ → xai/ alias", () => {
    // LiteLLM stores it under `xai/grok-4.3`; cogmo's id is `x-ai/grok-4.3`.
    const hit = lookupLitellm("x-ai/grok-4.3");
    expect(hit).toBeDefined();
    expect(hit?.contextWindow).toBeGreaterThan(0);
    expect(hit?.maxOutputTokens).toBeGreaterThan(0);
  });

  // Anthropic's current lineup, plus Sonnet 5, which existing installs'
  // default profiles still run. A missing id falls to the 128k/4k default and
  // compacts a 1M-context model at an eighth of its window.
  it.each([
    ["claude-fable-5-1", 1_000_000, 64_000],
    ["claude-opus-5-5", 1_000_000, 64_000],
    ["claude-sonnet-5-5", 1_000_000, 64_000],
    ["claude-sonnet-5", 1_000_000, 64_000],
    ["claude-haiku-4-5", 200_000, 50_000],
  ])("resolves %s's limits", (model, contextWindow, maxOutputTokens) => {
    expect(lookupLitellm(model)).toEqual({ contextWindow, maxOutputTokens });
  });

  it("returns undefined for a fully unknown model id", () => {
    expect(lookupLitellm("totally-made-up-model-xyz-2099")).toBeUndefined();
  });
});

describe("bundledSnapshot", () => {
  it("loads more than 1000 entries", () => {
    // Sanity check that the snapshot file is wired in. Exact count drifts
    // every refresh; only assert a healthy lower bound.
    expect(Object.keys(bundledSnapshot()).length).toBeGreaterThan(1_000);
  });

  it("is a catalog the live store would accept", () => {
    // Real upstream data, pruned by the same function a live refresh uses:
    // an entry the store's schema refuses would fail every refresh.
    expect(LitellmCatalogSchema.safeParse(bundledSnapshot()).error).toBeUndefined();
  });
});

describe("live catalog", () => {
  const fetchedAt = new Date("2026-09-28T06:17:00.000Z");

  afterEach(() => installLiveCatalog(null));

  it("is absent until one is installed", () => {
    expect(liveCatalogStatus()).toBeNull();
  });

  it("reports when it was fetched and its size", () => {
    installLiveCatalog({
      entries: { a: { contextWindow: 100_000, maxOutputTokens: 4_000 } },
      fetchedAt,
    });
    expect(liveCatalogStatus()).toEqual({ fetchedAt, size: 1 });
  });

  it("answers a model the bundled snapshot doesn't know", () => {
    const next = { contextWindow: 2_000_000, maxOutputTokens: 64_000 };
    installLiveCatalog({ entries: { "claude-next-6": next }, fetchedAt });
    expect(lookupLitellm("claude-next-6")).toEqual(next);
  });

  it("wins over the bundled entry for the same id", () => {
    const corrected = { contextWindow: 500_000, maxOutputTokens: 32_000 };
    installLiveCatalog({ entries: { "claude-sonnet-4-6": corrected }, fetchedAt });
    expect(lookupLitellm("claude-sonnet-4-6")).toEqual(corrected);
  });

  it("wins through a later alias over a bundled entry earlier in the ladder", () => {
    // `x-ai/grok-4.3`'s ladder tries `openrouter/x-ai/grok-4.3`, which the
    // bundled snapshot has, before `xai/grok-4.3`.
    const live = { contextWindow: 3_000_000, maxOutputTokens: 64_000 };
    installLiveCatalog({ entries: { "xai/grok-4.3": live }, fetchedAt });
    expect(lookupLitellm("x-ai/grok-4.3")).toEqual(live);
  });

  it("falls back to the bundled snapshot for a model it lacks", () => {
    installLiveCatalog({ entries: {}, fetchedAt });
    expect(lookupLitellm("claude-sonnet-4-6")).toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
    });
  });
});
