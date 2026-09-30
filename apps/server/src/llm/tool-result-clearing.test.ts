import * as R from "remeda";
import { describe, expect, it } from "vitest";
import {
  CLEARED_PLACEHOLDER,
  canonicalPromptParts,
  cl100k,
  encodedLength,
  withClearedToolResults,
} from "./tool-result-clearing.js";
import type { CountTokensParams, Message, ToolResultClearing } from "./types.js";

const enc = cl100k();
/** One encode of the whole text: the reference `encodedLength` chunks against. */
const whole = (text: string) => enc.encode(text, [], []).length;

function letters(n: number): string {
  let seed = 7;
  return Array.from({ length: n }, () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return "abcdefghijklmnopqrstuvwxyz"[seed % 26];
  }).join("");
}

describe("encodedLength", () => {
  it("counts a special-token marker as the text it is", () => {
    expect(encodedLength(enc, "a <|endoftext|> b")).toBeGreaterThan(encodedLength(enc, "a  b"));
  });

  it("counts prose as one encode does", () => {
    const prose = "The harbor lantern glowed over the granite quay at dusk. ".repeat(400);

    expect(encodedLength(enc, prose)).toBe(whole(prose));
  });

  it("counts a long unbroken run within a token per seam of one encode", () => {
    const run = letters(1000);
    // One seam every 64 code points, and one where the run starts.
    const seams = Math.ceil(run.length / 64);

    expect(
      Math.abs(encodedLength(enc, `word ${run} word`) - whole(`word ${run} word`)),
    ).toBeLessThanOrEqual(seams);
  });

  it("keeps an astral letter's surrogate pair whole at a seam", () => {
    // One code unit, then two per letter: a seam every 64 code units would
    // fall inside a pair.
    const run = `a${"𝐀".repeat(100)}`;

    expect(encodedLength(enc, run)).toBe(whole(`a${"𝐀".repeat(63)}`) + whole("𝐀".repeat(37)));
  });

  it.each([
    ["letters", () => letters(16_000)],
    ["spaces", () => " ".repeat(16_000)],
    ["punctuation", () => "=".repeat(16_000)],
  ])("encodes 16,000 unbroken %s in well under a second", (_kind, make) => {
    const text = make();
    const start = performance.now();

    encodedLength(enc, text);

    // One encode takes about ten seconds; the pieces take tens of milliseconds.
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("canonicalPromptParts", () => {
  it("yields the system prompt, each message with its framing, and each tool", () => {
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

    expect([...canonicalPromptParts(params)]).toEqual([
      whole("Be brief."),
      4 + whole("read the log"),
      4 +
        whole("It wants the log.") +
        whole("Reading it.") +
        whole("read") +
        whole(JSON.stringify({ path: "/var/log/app" })),
      // Images and documents at a flat 85, whatever their size.
      4 + whole("all quiet") + 85 + 85,
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

  /** The rule with every sum taken in full: what the early-stopping decision must agree with. */
  function referenceDecision(params: CountTokensParams, clearing: ToolResultClearing): number {
    const prompt = R.sum([...canonicalPromptParts(params)]);
    if (prompt <= clearing.triggerTokens) return 0;
    const results = params.messages.flatMap((m) =>
      typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "tool_result"),
    );
    const cleared = results.slice(0, Math.max(0, results.length - clearing.keep));
    if (cleared.length === 0) return 0;
    const tokens = R.sumBy(cleared, (r) => whole(r.content));
    return tokens >= clearing.clearAtLeastTokens ? cleared.length : 0;
  }

  const placeholders = (messages: Message[]) =>
    messages.flatMap((m) =>
      typeof m.content === "string"
        ? []
        : m.content.filter((b) => b.type === "tool_result" && b.content === CLEARED_PLACEHOLDER),
    ).length;

  it("decides as the full sums do, across triggers, keeps and minimums", () => {
    const params = { model: "m", system: "sys", messages: toolHeavy() };
    const prompt = R.sum([...canonicalPromptParts(params)]);
    const results = toolHeavy()
      .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
      .filter((b) => b.type === "tool_result")
      .map((b) => whole(b.content));
    const minimums = [
      0,
      1,
      ...R.range(1, results.length + 1).map((n) => R.sum(results.slice(0, n))),
    ];
    let decisions = 0;
    for (const triggerTokens of [0, 1000, prompt - 1, prompt, prompt + 1]) {
      for (const keep of [0, 1, 3, 6, 7]) {
        for (const base of minimums) {
          for (const clearAtLeastTokens of [base - 1, base, base + 1].filter((n) => n >= 0)) {
            const clearing = { triggerTokens, keep, clearAtLeastTokens };
            const cleared = withClearedToolResults(
              { ...params, clearToolResults: clearing },
              (messages) => canonicalPromptParts({ ...params, messages }),
            );
            expect(placeholders(cleared), JSON.stringify(clearing)).toBe(
              referenceDecision(params, clearing),
            );
            decisions += 1;
          }
        }
      }
    }
    expect(decisions).toBeGreaterThan(300);
  });

  it("stops reading the prompt once it passes the trigger", () => {
    const params = {
      model: "m",
      system: "A system prompt of more than one token.",
      messages: toolHeavy(),
    };
    let read = 0;
    const parts = function* () {
      for (const part of canonicalPromptParts(params)) {
        read += 1;
        yield part;
      }
    };

    withClearedToolResults(
      { ...params, clearToolResults: { triggerTokens: 1, keep: 0, clearAtLeastTokens: 0 } },
      parts,
    );

    expect(read).toBe(1);
  });
});
