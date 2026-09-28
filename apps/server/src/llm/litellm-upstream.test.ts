import { describe, expect, it } from "vitest";
import { expectDefined } from "../test/assertions.js";
import { pruneLitellmRegistry } from "./litellm-upstream.js";

function prune(raw: unknown) {
  return pruneLitellmRegistry(raw)._unsafeUnwrap();
}

describe("pruneLitellmRegistry", () => {
  it.each([
    ["an array", [1, 2]],
    ["null", null],
    ["a string", "{}"],
  ])("fails on %s", (_label, raw) => {
    expect(pruneLitellmRegistry(raw).isErr()).toBe(true);
  });

  it("prefers max_input_tokens over max_tokens for the context window", () => {
    const { entries } = prune({
      m: { max_input_tokens: 200_000, max_tokens: 8_192, max_output_tokens: 8_192 },
    });
    expect(entries.m).toEqual({ contextWindow: 200_000, maxOutputTokens: 8_192 });
  });

  it("falls back to max_tokens for a missing or null field", () => {
    const { entries } = prune({
      noInput: { max_tokens: 100_000, max_output_tokens: 4_096 },
      nullOutput: { max_input_tokens: 100_000, max_tokens: 4_096, max_output_tokens: null },
    });
    expect(entries.noInput).toEqual({ contextWindow: 100_000, maxOutputTokens: 4_096 });
    expect(entries.nullOutput).toEqual({ contextWindow: 100_000, maxOutputTokens: 4_096 });
  });

  it("caps output at 64k and at a quarter of the context window", () => {
    const { entries } = prune({
      huge: { max_input_tokens: 1_000_000, max_output_tokens: 1_000_000 },
      small: { max_input_tokens: 64_000, max_output_tokens: 64_000 },
    });
    expect(entries.huge?.maxOutputTokens).toBe(64_000);
    expect(entries.small?.maxOutputTokens).toBe(16_000);
  });

  it("truncates fractional token counts", () => {
    const { entries } = prune({ m: { max_input_tokens: 100_000.7, max_output_tokens: 4_096.9 } });
    expect(entries.m).toEqual({ contextWindow: 100_000, maxOutputTokens: 4_096 });
  });

  it("skips entries without numeric token data, keeping the rest", () => {
    const pruned = prune({
      sample_spec: { max_input_tokens: "max input tokens, if the provider specifies it" },
      embedding: { mode: "embedding" },
      notAnObject: 42,
      stringOutput: { max_input_tokens: 100_000, max_output_tokens: "8k" },
      good: { max_input_tokens: 100_000, max_output_tokens: 4_096 },
    });
    expect(Object.keys(pruned.entries)).toEqual(["good"]);
    expect(pruned.skippedNoTokenData).toBe(4);
  });

  it("ignores a non-numeric field the fallback never reads", () => {
    // `max_tokens` only matters when one of the specific fields is absent.
    const { entries } = prune({
      m: { max_input_tokens: 100_000, max_output_tokens: 4_096, max_tokens: "legacy" },
    });
    expect(expectDefined(entries.m, "m").contextWindow).toBe(100_000);
  });

  it("skips entries whose budget after the output cap is not positive", () => {
    const pruned = prune({ tiny: { max_input_tokens: 8_192, max_output_tokens: 2_048 } });
    expect(pruned.entries).toEqual({});
    expect(pruned.skippedNonPositiveBudget).toBe(1);
  });
});
