import { describe, expect, it } from "vitest";
import { candidateKeys, lookupLitellm, snapshotSize } from "./litellm-data.js";

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

  it("returns undefined for a fully unknown model id", () => {
    expect(lookupLitellm("totally-made-up-model-xyz-2099")).toBeUndefined();
  });
});

describe("snapshotSize", () => {
  it("loads more than 1000 entries from the bundled snapshot", () => {
    // Sanity check that the snapshot file is wired in. Exact count drifts
    // every refresh; only assert a healthy lower bound.
    expect(snapshotSize()).toBeGreaterThan(1_000);
  });
});
