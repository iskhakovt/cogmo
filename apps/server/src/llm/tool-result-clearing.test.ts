import * as R from "remeda";
import { describe, expect, it, vi } from "vitest";
import {
  CLEARED_PLACEHOLDER,
  canonicalPromptParts,
  cl100k,
  type TextTokens,
  textTokens,
  withClearedToolResults,
} from "./tool-result-clearing.js";
import type { CountTokensParams, Message, ToolResultClearing } from "./types.js";

const enc = cl100k();
/** One encode of the whole text: the reference the slices are measured against. */
const whole = (text: string) => enc.encode(text, [], []).length;
/** Every token of `text`, as {@link textTokens} counts it. */
const encodedLength = (text: string) => R.sum([...textTokens(enc)(text)]);

function letters(n: number): string {
  let seed = 7;
  return Array.from({ length: n }, () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return "abcdefghijklmnopqrstuvwxyz"[seed % 26];
  }).join("");
}

describe("textTokens, summed", () => {
  it("counts a special-token marker as the text it is", () => {
    expect(encodedLength("a <|endoftext|> b")).toBeGreaterThan(encodedLength("a  b"));
  });

  it("counts prose as one encode does, across slices", () => {
    const prose = "The harbor lantern glowed over the granite quay at dusk. ".repeat(400);

    expect(prose.length).toBeGreaterThan(20_000);
    expect(encodedLength(prose)).toBe(whole(prose));
  });

  it("encodes a long run 64 UTF-8 bytes at a time, a token at each seam where tokens merge", () => {
    // Whole, 1,000 spaces are 9 tokens; in 64-byte pieces, one a piece.
    expect(whole(" ".repeat(1000))).toBe(9);
    expect(encodedLength(" ".repeat(1000))).toBe(16);
  });

  it("caps a piece in bytes, not code points", () => {
    // Three bytes a dash, twenty-one to a piece; whole, the run merges to 8 tokens.
    const dashes = "—".repeat(128);
    const pieces = [...R.times(6, () => "—".repeat(21)), "—".repeat(2)];

    expect(encodedLength(dashes)).toBe(R.sumBy(pieces, whole));
    expect(R.sumBy(pieces, whole)).not.toBe(R.sumBy(["—".repeat(64), "—".repeat(64)], whole));
  });

  it("keeps a surrogate pair whole at a seam", () => {
    // Four bytes a letter: sixteen to a piece, after the one-byte `a`.
    const run = `a${"𝐀".repeat(100)}`;
    const pieces = [`a${"𝐀".repeat(15)}`, ...R.times(5, () => "𝐀".repeat(16)), "𝐀".repeat(5)];

    expect(encodedLength(run)).toBe(R.sumBy(pieces, whole));
  });

  it.each([
    ["letters", () => letters(16_000)],
    ["spaces", () => " ".repeat(16_000)],
    ["punctuation", () => "=".repeat(16_000)],
    ["emoji", () => "😀".repeat(16_000)],
  ])("encodes 16,000 unbroken %s in well under a second", (_kind, make) => {
    const text = make();
    const start = performance.now();

    encodedLength(text);

    // One encode takes about ten seconds; the pieces take tens of milliseconds.
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("textTokens", () => {
  it("yields a long text a slice at a time, lazily", () => {
    const text = "word ".repeat(10_000);
    const slices = [...textTokens(enc)(text)];

    expect(slices.length).toBeGreaterThan(5);
    expect(R.sum(slices)).toBe(whole(text));
  });

  it("encodes a text once, however many passes read it", () => {
    const text = "word ".repeat(10_000);
    const tokens = textTokens(enc);
    const encode = vi.spyOn(enc, "encode");
    try {
      const first = [...tokens(text)];
      const calls = encode.mock.calls.length;
      const again = [...tokens(text)];

      expect(again).toEqual(first);
      expect(encode.mock.calls.length).toBe(calls);
    } finally {
      encode.mockRestore();
    }
  });

  it("looks for a space only within the slice's window", () => {
    // No spaces: a search back from each window's end would read to the start.
    const text = "字".repeat(100_000);
    const search = vi.spyOn(String.prototype, "lastIndexOf");
    try {
      [...textTokens(enc)(text)];

      expect(search).toHaveBeenCalled();
      for (const searched of search.mock.contexts) {
        expect(String(searched).length).toBeLessThanOrEqual(8193);
      }
    } finally {
      search.mockRestore();
    }
  });

  it("cuts a window whose only space opens it at the window's end", () => {
    const text = ` ${"x".repeat(8191)}${"y".repeat(9000)}`;

    expect(encodedLength(text)).toBe(
      encodedLength(` ${"x".repeat(8191)}`) + encodedLength("y".repeat(9000)),
    );
  });

  it("never cuts a slice inside a surrogate pair", () => {
    // No spaces, and pairs from index 1: the 8,192nd code unit ends a pair's first half.
    const run = `a${"𝐀".repeat(5000)}`;
    // This letter's tokens never merge across letters, so any cut between
    // letters counts the same, and a cut inside one doesn't.
    const letter = whole("𝐀");
    expect(whole("𝐀".repeat(16))).toBe(16 * letter);

    expect(encodedLength(run)).toBe(whole(`a${"𝐀".repeat(15)}`) + 4985 * letter);
  });
});

describe("canonicalPromptParts", () => {
  it("sums the system prompt, each message's framing and blocks, and each tool", () => {
    const params = {
      system: "Be brief.",
      messages: [
        { role: "user", content: "read the log" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "It wants the log.", signature: "sig" },
            { type: "text", text: "Reading it." },
            { type: "tool_use", id: "t1", name: "read", input: { path: "/var/log/app" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "t1", content: "all quiet" },
            { type: "image", source: "base64", data: "a".repeat(10_000), mediaType: "image/png" },
            {
              type: "document",
              source: "base64",
              data: "b".repeat(10_000),
              mediaType: "application/pdf",
            },
          ],
        },
      ] satisfies Message[],
      tools: [{ name: "read", description: "Read a file.", parameters: { type: "object" } }],
    } satisfies Pick<CountTokensParams, "system" | "messages" | "tools">;

    expect([...canonicalPromptParts(params, textTokens(enc))]).toEqual([
      whole("Be brief."),
      4,
      whole("read the log"),
      4,
      whole("It wants the log."),
      whole("Reading it."),
      whole("read"),
      whole(JSON.stringify({ path: "/var/log/app" })),
      4,
      whole("all quiet"),
      // Images and documents at a flat 85, whatever their size.
      85,
      85,
      whole(JSON.stringify(params.tools[0])),
    ]);
  });
});

describe("withClearedToolResults", () => {
  const RESULT = "line of output from the tool\n".repeat(40);

  function toolHeavy(): Message[] {
    return [
      { role: "user", content: "read the logs" },
      ...[1, 2, 3, 4, 5, 6].flatMap((n): Message[] => [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: `t${n}`, name: "read", input: { part: n } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: `t${n}`, content: `${n}: ${RESULT.repeat(n)}` },
          ],
        },
      ]),
      { role: "user", content: "summarize" },
    ];
  }

  const placeholders = (messages: Message[]) =>
    messages.flatMap((m) =>
      typeof m.content === "string"
        ? []
        : m.content.filter((b) => b.type === "tool_result" && b.content === CLEARED_PLACEHOLDER),
    ).length;

  it("decides as the full sums do, across triggers, keeps and minimums", () => {
    const params = { model: "m", system: "sys", messages: toolHeavy() };
    // Every sum taken in full, once: what the early-stopping decision must agree with.
    const prompt = R.sum([...canonicalPromptParts(params, textTokens(enc))]);
    const results = toolHeavy()
      .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
      .filter((b) => b.type === "tool_result")
      .map((b) => whole(b.content));
    const reference = (clearing: ToolResultClearing): number => {
      if (prompt <= clearing.triggerTokens) return 0;
      const cleared = results.slice(0, Math.max(0, results.length - clearing.keep));
      if (cleared.length === 0) return 0;
      return R.sum(cleared) >= clearing.clearAtLeastTokens ? cleared.length : 0;
    };
    const minimums = R.range(1, results.length + 1).map((n) => R.sum(results.slice(0, n)));
    // One memory across the grid, as each decision would build its own.
    const tokens = textTokens(enc);
    let decisions = 0;
    for (const triggerTokens of [0, prompt - 1, prompt]) {
      for (const keep of [0, 2, 6, 7]) {
        for (const base of [0, ...minimums]) {
          for (const clearAtLeastTokens of [base - 1, base, base + 1].filter((n) => n >= 0)) {
            const clearing = { triggerTokens, keep, clearAtLeastTokens };
            const cleared = withClearedToolResults(
              { ...params, clearToolResults: clearing },
              (messages, sliceTokens) => canonicalPromptParts({ ...params, messages }, sliceTokens),
              tokens,
            );
            expect(placeholders(cleared), JSON.stringify(clearing)).toBe(reference(clearing));
            decisions += 1;
          }
        }
      }
    }
    expect(decisions).toBeGreaterThan(200);
  });

  /** A {@link TextTokens} that counts the slices each text gave up. */
  function spying(): { tokens: TextTokens; read: Map<string, number> } {
    const inner = textTokens(enc);
    const read = new Map<string, number>();
    const tokens: TextTokens = function* (text) {
      for (const slice of inner(text)) {
        read.set(text, (read.get(text) ?? 0) + 1);
        yield slice;
      }
    };
    return { tokens, read };
  }

  /** Three results of several slices each. */
  function longResults(): Message[] {
    return [
      { role: "user", content: "read the logs" },
      ...[1, 2, 3].flatMap((n): Message[] => [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: `t${n}`, name: "read", input: { part: n } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: `t${n}`, content: `${n} ${"word ".repeat(10_000)}` },
          ],
        },
      ]),
    ];
  }

  it("stops each pass within the slice that passes its threshold", () => {
    const params = {
      model: "m",
      system: "A system prompt of more than one token.",
      messages: longResults(),
    };
    const { tokens, read } = spying();

    const cleared = withClearedToolResults(
      { ...params, clearToolResults: { triggerTokens: 1, keep: 0, clearAtLeastTokens: 1 } },
      (messages, sliceTokens) => canonicalPromptParts({ ...params, messages }, sliceTokens),
      tokens,
    );

    expect(placeholders(cleared)).toBe(3);
    // The prompt pass stops at the system prompt, the cleared pass at the
    // first result's first slice; nothing else is read.
    expect(Object.fromEntries(read)).toEqual({
      [params.system]: 1,
      [`1 ${"word ".repeat(10_000)}`]: 1,
    });
  });
});
