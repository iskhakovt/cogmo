import * as R from "remeda";
import { describe, expect, it, vi } from "vitest";
import { MAX_REQUEST_BYTES } from "../llm/request-size.js";
import type { ContentBlock, Message, ToolDefinition, ToolResultClearing } from "../llm/types.js";
import { expectDefined } from "../test/assertions.js";
import {
  type ContextManagerDeps,
  compactMessages,
  extractSummaryText,
  SUMMARIZATION_PROMPT,
  shouldSkipCounting,
  snapToPairBoundary,
  summarizationRequest,
  toolResultClearing,
  truncations,
} from "./context.js";

/** Strategy 1's intent at a budget of 1,000 tokens. */
const CLEARING: ToolResultClearing = { triggerTokens: 600, keep: 5, clearAtLeastTokens: 100 };

/** Helper: create a simple text message. */
function msg(role: "user" | "assistant", text: string): Message {
  return { role, content: text };
}

/** Helper: create a user message with tool results. */
function toolResultMsg(results: Array<{ id: string; content: string }>): Message {
  return {
    role: "user",
    content: results.map((r) => ({
      type: "tool_result" as const,
      toolUseId: r.id,
      content: r.content,
    })),
  };
}

/** Helper: create an assistant message with a tool call. */
function toolCallMsg(id: string, name: string): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  };
}

describe("compactMessages", () => {
  it("passes messages through unchanged when under budget", async () => {
    const messages = [msg("user", "hello"), msg("assistant", "hi")];
    const result = await compactMessages("system", messages, undefined, {
      countTokens: vi.fn().mockResolvedValue(100),
      budget: 1000,
      clearToolResults: CLEARING,
      maxRequestBytes: MAX_REQUEST_BYTES,
    });

    expect(result.didCompact).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.event).toBeUndefined();
  });

  it("counts with Strategy 1's intent and leaves every tool result as it is", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 7; i++) {
      messages.push(msg("user", `query ${i}`));
      messages.push(toolCallMsg(`t${i}`, `search_${i}`));
      messages.push(toolResultMsg([{ id: `t${i}`, content: `result-${i}-${"x".repeat(1000)}` }]));
      messages.push(msg("assistant", `answer ${i}`));
    }
    const before = structuredClone(messages);
    // Past the clearing threshold, under the summarization one.
    const countTokens = vi.fn().mockResolvedValue(700);

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      maxRequestBytes: MAX_REQUEST_BYTES,
      summarize: vi.fn(),
    });

    expect(result.didCompact).toBe(false);
    expect(result.messages).toEqual(before);
    expect(countTokens).toHaveBeenCalledOnce();
    expect(countTokens).toHaveBeenCalledWith(
      expect.objectContaining({ messages: before, clearToolResults: CLEARING }),
    );
  });

  it("carries the intent on every count, after a summary and a truncation too", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(msg("user", `q${i}`));
      messages.push(msg("assistant", `a${i}`));
    }
    const countTokens = vi
      .fn()
      .mockResolvedValueOnce(980)
      .mockResolvedValueOnce(960)
      .mockResolvedValueOnce(200);

    await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      maxRequestBytes: MAX_REQUEST_BYTES,
      summarize: vi.fn().mockResolvedValue("a summary"),
    });

    expect(countTokens).toHaveBeenCalledTimes(3);
    for (const [params] of countTokens.mock.calls) {
      expect(params.clearToolResults).toEqual(CLEARING);
    }
  });

  it("does not summarize when the count after clearing is under 80%", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 7; i++) {
      messages.push(msg("user", `q${i}`));
      messages.push(toolCallMsg(`t${i}`, "search"));
      messages.push(toolResultMsg([{ id: `t${i}`, content: "x".repeat(1000) }]));
      messages.push(msg("assistant", `a${i}`));
    }

    // Over 60%, which the intent clears, and under 80%.
    const countTokens = vi.fn().mockResolvedValueOnce(700);
    const summarize = vi.fn();

    await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      maxRequestBytes: MAX_REQUEST_BYTES,
      summarize,
    });

    expect(summarize).not.toHaveBeenCalled();
  });

  it("summarizes conversation prefix at 80% threshold", async () => {
    const messages = [
      msg("user", "old message 1"),
      msg("assistant", "old reply 1"),
      msg("user", "old message 2"),
      msg("assistant", "old reply 2"),
      msg("user", "old message 3"),
      msg("assistant", "old reply 3"),
      msg("user", "old message 4"),
      msg("assistant", "old reply 4"),
      msg("user", "recent question"),
      msg("assistant", "recent answer"),
      msg("user", "latest question"),
      msg("assistant", "latest answer"),
    ];

    const countTokens = vi
      .fn()
      .mockResolvedValueOnce(900) // after clearing: over 80%
      .mockResolvedValueOnce(300); // after summarization: under
    const summarize = vi.fn().mockResolvedValue("Summary of old messages");

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      maxRequestBytes: MAX_REQUEST_BYTES,
      summarize,
    });

    expect(result.didCompact).toBe(true);
    expect(result.event?.strategies).toEqual(["summarize"]);
    expect(summarize).toHaveBeenCalledOnce();

    // Should keep last 6 messages, summarize the rest
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.content).toContain("[Previous conversation summary]");
    expect(result.messages[0]?.content).toContain("Summary of old messages");
    // 1 summary + 6 kept = 7 messages
    expect(result.messages).toHaveLength(7);
  });

  // Locks the contract documented on `ContextManagerDeps.summarize`. The
  // hardcoded `summarize-prefix-outcome` step ID in `handle-message.ts` depends on
  // this — Inngest throws on duplicate step IDs, so a future change that
  // calls `summarize` twice (e.g., segmented summarization) would surface
  // only at runtime under specific conversation lengths. This test catches
  // it at unit-test time.
  it("calls summarize at most once even when both rewriting strategies fire", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(msg("user", `q${i}`));
      messages.push(toolCallMsg(`t${i}`, `search_${i}`));
      messages.push(toolResultMsg([{ id: `t${i}`, content: "x".repeat(500) }]));
      messages.push(msg("assistant", `a${i}`));
    }

    // Stay above the 95% truncate threshold through summarization so both
    // fire in sequence: summarize → truncate.
    const countTokens = vi
      .fn()
      .mockResolvedValueOnce(980) // initial: over 95%
      .mockResolvedValueOnce(960) // after summarization: still over 95%
      .mockResolvedValueOnce(200); // after truncation: under
    const summarize = vi.fn().mockResolvedValue("Summary of old messages");

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      maxRequestBytes: MAX_REQUEST_BYTES,
      summarize,
    });

    expect(result.event?.strategies).toEqual(["summarize", "truncate"]);
    expect(summarize).toHaveBeenCalledOnce();
  });

  it("falls through to truncation when summarization fails", async () => {
    const messages = [
      msg("user", "m1"),
      msg("assistant", "r1"),
      msg("user", "m2"),
      msg("assistant", "r2"),
      msg("user", "m3"),
      msg("assistant", "r3"),
      msg("user", "m4"),
      msg("assistant", "r4"),
      msg("user", "m5"),
      msg("assistant", "r5"),
    ];

    // Over 95% throughout — summarize fails, falls through to truncation
    const countTokens = vi
      .fn()
      .mockResolvedValueOnce(980) // initial
      .mockResolvedValueOnce(500); // after truncation
    const summarize = vi.fn().mockRejectedValue(new Error("LLM timeout"));

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      maxRequestBytes: MAX_REQUEST_BYTES,
      summarize,
    });

    expect(result.event?.strategies).toContain("truncate");
    expect(result.event?.strategies).not.toContain("summarize");
  });

  it("truncation preserves alternation — inserts synthetic user message", async () => {
    // Old turns longer than the marker, so dropping them shrinks the view.
    const messages = [
      msg("user", "old question ".repeat(10)),
      msg("assistant", "old answer ".repeat(10)),
      msg("assistant", "remaining"), // would be first after truncation
      msg("user", "latest"),
    ];

    // Over 95%
    const countTokens = vi
      .fn()
      .mockResolvedValueOnce(960) // initial
      .mockResolvedValueOnce(400); // after truncation

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      maxRequestBytes: MAX_REQUEST_BYTES,
    });

    expect(result.didCompact).toBe(true);
    // If first remaining is assistant, synthetic user message is prepended
    const first = result.messages[0];
    if (first?.role === "user") {
      expect(
        first.content === "[Earlier conversation history was truncated]" ||
          first.content === "latest",
      ).toBe(true);
    }
  });

  it("keeps the prefix when the summarizer returns no text", async () => {
    // The summary is substituted for the whole prefix, so an empty one
    // would leave a bare `[Previous conversation summary]` header standing
    // in for that span of the conversation. Reachable whenever the
    // summarization model spends its output budget on reasoning.
    const messages: Message[] = [
      msg("user", "m1"),
      msg("assistant", "r1"),
      msg("user", "m2"),
      msg("assistant", "r2"),
      msg("user", "m3"),
      msg("assistant", "r3"),
      msg("user", "m4"),
      msg("assistant", "r4"),
    ];

    const countTokens = vi.fn().mockResolvedValue(850);

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      maxRequestBytes: MAX_REQUEST_BYTES,
      summarize: vi.fn().mockResolvedValue("   "),
    });

    expect(
      result.messages.some((m) => String(m.content).includes("Previous conversation summary")),
    ).toBe(false);
    expect(result.event?.messagesSummarized ?? 0).toBe(0);
  });

  it("reports correct CompactionEvent stats", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(msg("user", `q${i}`));
      messages.push(toolCallMsg(`t${i}`, `search_${i}`));
      messages.push(toolResultMsg([{ id: `t${i}`, content: "x".repeat(1000) }]));
      messages.push(msg("assistant", `a${i}`));
    }

    const countTokens = vi
      .fn()
      .mockResolvedValueOnce(900) // after clearing: over 80%
      .mockResolvedValueOnce(400); // after summarization: under

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      maxRequestBytes: MAX_REQUEST_BYTES,
      summarize: vi.fn().mockResolvedValue("summary"),
    });

    expect(result.event).toEqual({
      strategies: ["summarize"],
      tokensBefore: 900,
      tokensAfter: 400,
      requestBytesBefore: Buffer.byteLength(
        JSON.stringify({ system: "system", messages, tools: undefined }),
      ),
      // 32 messages, six kept: the split at 26 lands on a tool result and snaps back to its call.
      messagesSummarized: 25,
    });
  });

  describe("past the request cap", () => {
    /** Eight turns, each with a large tool result. */
    function heavy(): Message[] {
      return Array.from({ length: 8 }, (_, i) => [
        msg("user", `q${i}`),
        toolCallMsg(`t${i}`, `read_${i}`),
        toolResultMsg([{ id: `t${i}`, content: `result ${i} `.repeat(500) }]),
        msg("assistant", `a${i}`),
      ]).flat();
    }

    const bytesOf = (messages: ReadonlyArray<Message>) =>
      Buffer.byteLength(JSON.stringify({ system: "system", messages, tools: undefined }));

    it.each([false, true])(
      "summarizes without counting the view first, whatever the count after clearing (fast path: %s)",
      async (skip) => {
        const messages = heavy();
        // The view is past 80% of the cap, and its count far under the budget.
        const maxRequestBytes = Math.floor(bytesOf(messages) / 0.85);
        const countTokens = vi.fn().mockResolvedValue(100);
        const summarize = vi.fn().mockResolvedValue("a summary");

        const result = await compactMessages(
          "system",
          messages,
          undefined,
          {
            countTokens,
            budget: 1_000_000,
            clearToolResults: CLEARING,
            maxRequestBytes,
            summarize,
          },
          skip,
        );

        expect(summarize).toHaveBeenCalledOnce();
        expect(result.event).toMatchObject({
          strategies: ["summarize"],
          tokensBefore: null,
          tokensAfter: 100,
          requestBytesBefore: bytesOf(messages),
        });
        // The one count is of the summarized view, which fits.
        expect(countTokens).toHaveBeenCalledOnce();
        expect(countTokens.mock.calls[0]?.[0].messages).toEqual(result.messages);
        expect(bytesOf(result.messages)).toBeLessThanOrEqual(maxRequestBytes * 0.8);
      },
    );

    it("truncates until the view fits when the summary doesn't come", async () => {
      const messages = heavy();
      // Past 80% after a single 30% cut, so truncation has to go round again.
      const maxRequestBytes = Math.floor(bytesOf(messages) / 1.1);
      const countTokens = vi.fn().mockResolvedValue(100);

      const result = await compactMessages("system", messages, undefined, {
        countTokens,
        budget: 1_000_000,
        clearToolResults: CLEARING,
        maxRequestBytes,
        summarize: vi.fn().mockRejectedValue(new Error("413 request_too_large")),
      });

      expect(result.event?.strategies).toEqual(["truncate"]);
      expect(bytesOf(result.messages)).toBeLessThanOrEqual(maxRequestBytes * 0.8);
      expect(bytesOf(truncatedOnce(messages))).toBeGreaterThan(maxRequestBytes * 0.8);
      expect(countTokens).toHaveBeenCalledOnce();
      assertNoOrphanedToolResults(result.messages);
    });

    /** The view after one 30% cut, the first rung of truncation. */
    function truncatedOnce(messages: ReadonlyArray<Message>): Message[] {
      const cut = snapToPairBoundary(messages, Math.ceil(messages.length * 0.3));
      return messages.slice(cut);
    }

    /** A user message attaching `bytes` of base64. */
    function docTurn(bytes: number, text = "What does it say?"): Message {
      return {
        role: "user",
        content: [
          {
            type: "document",
            source: "base64",
            data: "A".repeat(bytes),
            mediaType: "application/pdf",
          },
          { type: "text", text },
        ],
      };
    }

    function deps(overrides: Partial<ContextManagerDeps> = {}): ContextManagerDeps {
      return {
        countTokens: vi.fn().mockResolvedValue(100),
        budget: 1_000_000,
        clearToolResults: CLEARING,
        maxRequestBytes: MAX_REQUEST_BYTES,
        ...overrides,
      };
    }

    it("summarizes history off a heavy tail over the cap, and sends the tail under it", async () => {
      // 5 MB of tool results, then a 17 MB PDF turn: 22 MB, over the cap,
      // with a tail no cut gets under the threshold.
      const messages: Message[] = [
        ...Array.from({ length: 10 }, (_, i) => [
          msg("user", `read part ${i}`),
          toolCallMsg(`t${i}`, "read"),
          toolResultMsg([{ id: `t${i}`, content: "r".repeat(500_000) }]),
          msg("assistant", `read ${i}`),
        ]).flat(),
        docTurn(17_000_000),
      ];
      const countTokens = vi.fn().mockResolvedValue(100);
      const summarize = vi.fn().mockResolvedValue("a summary");

      const result = await compactMessages(
        "system",
        messages,
        undefined,
        deps({ countTokens, summarize }),
        true,
      );

      expect(bytesOf(messages)).toBeGreaterThan(MAX_REQUEST_BYTES);
      expect(summarize).toHaveBeenCalledOnce();
      expect(result.messages.at(-1)).toEqual(messages.at(-1));
      expect(bytesOf(result.messages)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
      expect(bytesOf(result.messages)).toBeLessThan(17_600_000);
      // The first count is of the view that fits the cap.
      expect(countTokens).toHaveBeenCalledOnce();
      expect(countTokens.mock.calls[0]?.[0].messages).toEqual(result.messages);
    });

    it("cuts a first message that alone keeps the view over the cap", async () => {
      // 10 MB, a reply, 11 MB: 21 MB. Only the marker cut gets it under.
      const messages: Message[] = [
        docTurn(10_000_000),
        msg("assistant", "read it"),
        docTurn(11_000_000),
      ];

      const result = await compactMessages("system", messages, undefined, deps(), true);

      expect(result.event?.strategies).toEqual(["truncate"]);
      expect(result.messages).toEqual([
        { role: "user", content: "[Earlier conversation history was truncated]" },
        messages[1],
        messages[2],
      ]);
      expect(bytesOf(result.messages)).toBeLessThan(11_100_000);
    });

    it("sends the smallest view when no cut fits the cap, uncounted", async () => {
      const messages: Message[] = [
        msg("user", "hello ".repeat(100)),
        msg("assistant", "hi"),
        docTurn(21_000_000),
      ];
      const countTokens = vi.fn().mockResolvedValue(100);

      const result = await compactMessages("system", messages, undefined, deps({ countTokens }));

      expect(result.messages).toEqual(R.last(truncations(messages)));
      expect(result.event?.tokensAfter).toBeNull();
      expect(countTokens).not.toHaveBeenCalled();
    });

    it("does nothing at exactly the threshold", async () => {
      const base = [msg("user", ""), msg("assistant", "a"), msg("user", "q")];
      const maxRequestBytes = 10_000;
      const threshold = Math.floor(maxRequestBytes * 0.8);
      const messages = [msg("user", "x".repeat(threshold - bytesOf(base))), ...base.slice(1)];
      expect(bytesOf(messages)).toBe(threshold);
      const summarize = vi.fn().mockResolvedValue("a summary");

      const result = await compactMessages(
        "system",
        messages,
        undefined,
        deps({ maxRequestBytes, summarize }),
        true,
      );

      expect(result.didCompact).toBe(false);
      expect(summarize).not.toHaveBeenCalled();
    });

    /** Twenty short messages, then a turn attaching a 12.5 MB PDF (16.7 MB of base64). */
    function pdfTurn(): Message[] {
      return [
        ...Array.from({ length: 20 }, (_, i) =>
          msg(
            i % 2 === 0 ? "user" : "assistant",
            `${i % 2 === 0 ? "question" : "answer"} ${i / 2}`,
          ),
        ),
        {
          role: "user",
          content: [
            {
              type: "document",
              source: "base64",
              data: "A".repeat(16_666_668),
              mediaType: "application/pdf",
              name: "report.pdf",
            },
            { type: "text", text: "What does the report conclude?" },
          ],
        },
      ];
    }

    it.each([false, true])(
      "sends a view whose last exchange alone is past the threshold as it is (fast path: %s)",
      async (skip) => {
        // Compaction can't remove the turn's own attachment, so a summary and
        // truncation would only throw away history the request fits with.
        const messages = pdfTurn();
        const countTokens = vi.fn().mockResolvedValue(100);
        const summarize = vi.fn().mockResolvedValue("a summary");

        const result = await compactMessages(
          "system",
          messages,
          undefined,
          {
            countTokens,
            budget: 1_000_000,
            clearToolResults: CLEARING,
            maxRequestBytes: MAX_REQUEST_BYTES,
            summarize,
          },
          skip,
        );

        expect(bytesOf(messages)).toBeGreaterThan(MAX_REQUEST_BYTES * 0.8);
        expect(summarize).not.toHaveBeenCalled();
        expect(result.didCompact).toBe(false);
        expect(result.messages).toEqual(messages);
        // Under the cap, it is counted like any view, and not on the fast path.
        expect(countTokens).toHaveBeenCalledTimes(skip ? 0 : 1);
      },
    );

    it.each([
      [[msg("user", "x".repeat(100_000)), msg("assistant", "a"), msg("user", "q")]],
      [
        [
          msg("user", "x".repeat(100_000)),
          toolCallMsg("t1", "read"),
          toolResultMsg([{ id: "t1", content: "ok" }]),
          msg("assistant", "a"),
          msg("user", "q"),
        ],
      ],
    ])(
      "cuts over the budget even when the cut only puts the marker first: %#",
      async (messages) => {
        const result = await compactMessages("system", messages, undefined, {
          countTokens: vi.fn().mockResolvedValue(990),
          budget: 1000,
          clearToolResults: CLEARING,
          maxRequestBytes: MAX_REQUEST_BYTES,
        });

        expect(result.event?.strategies).toEqual(["truncate"]);
        expect(result.messages[0]).toEqual({
          role: "user",
          content: "[Earlier conversation history was truncated]",
        });
        expect(result.messages).toHaveLength(messages.length);
      },
    );

    it("records no truncation when no cut shortens the view", async () => {
      const result = await compactMessages("system", [msg("user", "q")], undefined, {
        countTokens: vi.fn().mockResolvedValue(990),
        budget: 1000,
        clearToolResults: CLEARING,
        maxRequestBytes: MAX_REQUEST_BYTES,
      });

      expect(result.didCompact).toBe(false);
      expect(result.messages).toEqual([msg("user", "q")]);
    });

    it("cuts once for the budget, and keeps the tail, when the tail alone is past the threshold", async () => {
      const messages = pdfTurn();

      const result = await compactMessages("system", messages, undefined, {
        // Past 95% of the budget: truncation fires on tokens.
        countTokens: vi.fn().mockResolvedValue(990),
        budget: 1000,
        clearToolResults: CLEARING,
        maxRequestBytes: MAX_REQUEST_BYTES,
      });

      expect(result.event?.strategies).toEqual(["truncate"]);
      expect(result.messages).toEqual(truncations(messages)[1]);
      expect(result.messages.at(-1)).toEqual(messages.at(-1));
    });

    it("cuts as many times as the view needs to fit", async () => {
      const messages = heavy();
      const cuts = truncations(messages);
      // Past 80% after two cuts: the third is the first that fits.
      const maxRequestBytes = Math.floor(bytesOf(expectDefined(cuts[2], "two cuts")) / 0.8) - 1;
      expect(bytesOf(expectDefined(cuts[3], "three cuts"))).toBeLessThanOrEqual(
        maxRequestBytes * 0.8,
      );

      const result = await compactMessages("system", messages, undefined, {
        countTokens: vi.fn().mockResolvedValue(100),
        budget: 1_000_000,
        clearToolResults: CLEARING,
        maxRequestBytes,
      });

      expect(result.event?.strategies).toEqual(["truncate"]);
      expect(result.messages).toEqual(cuts[3]);
    });

    it("measures bytes, not characters", async () => {
      // Three bytes to each of these characters in UTF-8, in history compaction can remove.
      const messages = [msg("user", "字".repeat(3000)), ...heavy().slice(0, 8)];
      const chars = JSON.stringify({ system: "system", messages, tools: undefined }).length;
      // Past 80% of the cap in bytes, under it in characters.
      const maxRequestBytes = Math.ceil(chars / 0.8) + 100;
      expect(bytesOf(messages)).toBeGreaterThan(maxRequestBytes * 0.8);
      const summarize = vi.fn().mockResolvedValue("a summary");

      await compactMessages(
        "system",
        messages,
        undefined,
        {
          countTokens: vi.fn().mockResolvedValue(100),
          budget: 1_000_000,
          clearToolResults: CLEARING,
          maxRequestBytes,
          summarize,
        },
        true,
      );

      expect(summarize).toHaveBeenCalledOnce();
    });

    it("counts the tool definitions toward the view's bytes", async () => {
      const messages = heavy();
      const tools: ToolDefinition[] = [
        { name: "read", description: "x".repeat(40_000), parameters: { type: "object" } },
      ];
      // Past 80% of the cap with the tools, under it without them.
      const maxRequestBytes = Math.floor((bytesOf(messages) + 20_000) / 0.8);
      const summarize = vi.fn().mockResolvedValue("a summary");

      await compactMessages(
        "system",
        messages,
        tools,
        {
          countTokens: vi.fn().mockResolvedValue(100),
          budget: 1_000_000,
          clearToolResults: CLEARING,
          maxRequestBytes,
          summarize,
        },
        true,
      );

      expect(summarize).toHaveBeenCalledOnce();
    });
  });

  it("leaves a same-tool cluster verbatim, on the fast path and off it", async () => {
    // Five `web_search` results: no rung of compaction rewrites a same-tool cluster.
    const messages: Message[] = ["alpha", "beta", "gamma", "delta", "epsilon"].flatMap(
      (q, i): Message[] => [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: `t${i}`, name: "web_search", input: { query: q } }],
        },
        toolResultMsg([{ id: `t${i}`, content: `body-of-${q}-${"·".repeat(500)}` }]),
      ],
    );
    const before = structuredClone(messages);

    for (const skip of [true, false]) {
      const result = await compactMessages(
        "system",
        messages,
        undefined,
        {
          countTokens: vi.fn().mockResolvedValue(100),
          budget: 1000,
          clearToolResults: CLEARING,
          maxRequestBytes: MAX_REQUEST_BYTES,
        },
        skip,
      );

      expect(result.didCompact).toBe(false);
      expect(result.messages).toEqual(before);
    }
  });

  it("does not call countTokens when skipBudgetStrategies is set", async () => {
    const countTokens = vi.fn().mockResolvedValue(100);
    const result = await compactMessages(
      "system",
      [msg("user", "hello"), msg("assistant", "hi")],
      undefined,
      { countTokens, budget: 1000, clearToolResults: CLEARING, maxRequestBytes: MAX_REQUEST_BYTES },
      true,
    );

    expect(result.didCompact).toBe(false);
    expect(countTokens).not.toHaveBeenCalled();
  });
});

describe("truncations", () => {
  const size = (view: ReadonlyArray<Message>) => Buffer.byteLength(JSON.stringify(view));

  it("cuts, each view smaller in bytes, down to the marker and the last exchange", () => {
    const messages = Array.from({ length: 13 }, (_, i) =>
      msg(i % 2 === 0 ? "user" : "assistant", `message ${i} `.repeat(20)),
    );

    const views = truncations(messages);

    expect(views[0]).toEqual(messages);
    for (const [i, view] of views.entries()) {
      if (i > 0) expect(size(view)).toBeLessThan(size(expectDefined(views[i - 1], "previous")));
    }
    expect(R.last(views)).toEqual([
      { role: "user", content: "[Earlier conversation history was truncated]" },
      ...messages.slice(-2),
    ]);
  });

  it("keeps a tool call with its result: five messages after a tool call", () => {
    const messages: Message[] = [
      msg("user", "x".repeat(10_000)),
      toolCallMsg("t1", "read"),
      toolResultMsg([{ id: "t1", content: "ok" }]),
      msg("assistant", "done"),
      msg("user", "thanks"),
    ];

    expect(R.last(truncations(messages))).toEqual([
      { role: "user", content: "[Earlier conversation history was truncated]" },
      ...messages.slice(1),
    ]);
  });

  it.each([
    [[msg("user", "q"), msg("assistant", "a")]],
    // A cut that leaves an assistant first adds the truncation marker, as long as it was.
    [[msg("assistant", "a"), msg("user", "q")]],
    [[msg("user", "q")]],
    [[]],
  ])("stops at a view no cut shortens: %j", (messages: Message[]) => {
    expect(truncations(messages)).toEqual([messages]);
  });
});

describe("toolResultClearing", () => {
  it("clears past 60% of the budget, keeps five results, and frees at least a tenth", () => {
    expect(toolResultClearing(200_000)).toEqual({
      triggerTokens: 120_000,
      keep: 5,
      clearAtLeastTokens: 20_000,
    });
  });
});

describe("snapToPairBoundary", () => {
  it("returns splitIdx unchanged when suffix starts with a text user message", () => {
    const messages: Message[] = [
      msg("user", "old"),
      msg("assistant", "old reply"),
      msg("user", "recent"),
      msg("assistant", "recent reply"),
    ];
    expect(snapToPairBoundary(messages, 2)).toBe(2);
  });

  it("snaps backward when suffix starts with orphaned tool_result", () => {
    const messages: Message[] = [
      msg("user", "question"),
      toolCallMsg("t1", "search"),
      toolResultMsg([{ id: "t1", content: "result" }]),
      msg("assistant", "final answer"),
    ];
    // Cutting at index 2 would orphan tool_result — snap back to 1 (the assistant with tool_use)
    expect(snapToPairBoundary(messages, 2)).toBe(1);
  });

  it("snaps past multiple consecutive tool rounds", () => {
    const messages: Message[] = [
      msg("user", "start"),
      toolCallMsg("t1", "search"), // 1: assistant
      toolResultMsg([{ id: "t1", content: "r1" }]), // 2: user (tool_result)
      toolCallMsg("t2", "fetch"), // 3: assistant (second tool call)
      toolResultMsg([{ id: "t2", content: "r2" }]), // 4: user (tool_result)
      msg("assistant", "done"), // 5
    ];
    // Cutting at 4 → snaps to 3, then 3 is assistant (no tool_result) → stop at 3
    expect(snapToPairBoundary(messages, 4)).toBe(3);
    // Cutting at 2 → snaps to 1
    expect(snapToPairBoundary(messages, 2)).toBe(1);
  });

  it("returns 0 when all messages are tool rounds", () => {
    const messages: Message[] = [
      toolCallMsg("t1", "search"),
      toolResultMsg([{ id: "t1", content: "r1" }]),
      toolCallMsg("t2", "fetch"),
      toolResultMsg([{ id: "t2", content: "r2" }]),
    ];
    // Cutting at 1 → user with tool_result → snap to 0 (assistant, stops because idx=0)
    expect(snapToPairBoundary(messages, 1)).toBe(0);
    // Cutting at 3 → snap to 2 (assistant with tool_use, no tool_result)
    expect(snapToPairBoundary(messages, 3)).toBe(2);
  });

  it("handles splitIdx at array boundaries", () => {
    const messages: Message[] = [msg("user", "hi"), msg("assistant", "hey")];
    expect(snapToPairBoundary(messages, 0)).toBe(0);
    expect(snapToPairBoundary(messages, 2)).toBe(2);
  });
});

/** Assert no message in the array has a tool_result without a matching tool_use in the preceding assistant. */
function assertNoOrphanedToolResults(messages: ReadonlyArray<Message>): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (typeof m.content !== "string" && m.content.some((b) => b.type === "tool_result")) {
      expect(i).toBeGreaterThan(0);
      const prev = messages[i - 1]!;
      expect(prev.role).toBe("assistant");
      expect(typeof prev.content).not.toBe("string");
      const toolUseIds = (prev.content as ContentBlock[])
        .filter((b) => b.type === "tool_use")
        .map((b) => b.id);
      const toolResultIds = (m.content as ContentBlock[])
        .filter((b) => b.type === "tool_result")
        .map((b) => b.toolUseId);
      for (const id of toolResultIds) {
        expect(toolUseIds).toContain(id);
      }
    }
  }
}

describe("compactMessages — pair-aware", () => {
  it("truncation never orphans a tool_use/tool_result pair", async () => {
    // 13 messages → 30% = 3.9 → ceil = 4 → naïve cut at index 4 (a tool_result user message)
    const msgs13: Message[] = [
      msg("user", "a"),
      msg("assistant", "b"),
      msg("user", "c"),
      toolCallMsg("t1", "search"), // 3
      toolResultMsg([{ id: "t1", content: "result" }]), // 4 ← naïve cut lands here
      msg("assistant", "d"),
      msg("user", "e"),
      msg("assistant", "f"),
      msg("user", "g"),
      msg("assistant", "h"),
      msg("user", "i"),
      msg("assistant", "j"),
      msg("user", "k"),
    ];
    // 30% of 13 = 3.9 → ceil = 4 → drop first 4, keep from index 4
    // messages[4] is user with tool_result → snapToPairBoundary snaps to 3

    const countTokens = vi.fn().mockResolvedValueOnce(960).mockResolvedValueOnce(400);

    const result = await compactMessages("system", msgs13, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      maxRequestBytes: MAX_REQUEST_BYTES,
    });

    assertNoOrphanedToolResults(result.messages);
  });

  it("summarization never orphans a tool_use/tool_result pair", async () => {
    // Place a tool pair right at the summarize boundary
    // keepTurns=6 → splitIdx = messages.length - 6
    const messages: Message[] = [
      msg("user", "old1"), // 0
      msg("assistant", "old2"), // 1
      toolCallMsg("t1", "search"), // 2: assistant with tool_use
      toolResultMsg([{ id: "t1", content: "result" }]), // 3: user with tool_result
      msg("assistant", "used the result"), // 4
      msg("user", "q1"), // 5 ← raw splitIdx = 9-6 = 3, snaps to 2
      msg("assistant", "a1"), // 6
      msg("user", "q2"), // 7
      msg("assistant", "a2"), // 8
    ];

    const countTokens = vi.fn().mockResolvedValueOnce(850).mockResolvedValueOnce(300);

    const result = await compactMessages("system", messages, undefined, {
      countTokens,
      budget: 1000,
      clearToolResults: CLEARING,
      maxRequestBytes: MAX_REQUEST_BYTES,
      summarize: vi.fn().mockResolvedValue("summary of old conversation"),
    });

    expect(result.didCompact).toBe(true);

    assertNoOrphanedToolResults(result.messages);
  });
});

describe("shouldSkipCounting", () => {
  it("returns false when no prior usage data", () => {
    expect(shouldSkipCounting(null, null, 100, 200_000)).toBe(false);
  });

  it("returns false when only input is known", () => {
    // Missing output = unknown — force count.
    expect(shouldSkipCounting(10_000, null, 400, 200_000)).toBe(false);
  });

  it("returns false when only output is known", () => {
    expect(shouldSkipCounting(null, 500, 400, 200_000)).toBe(false);
  });

  it("returns true when clearly under budget", () => {
    // 10_000 + 500 + 400/4 = 10_600, budget * 0.5 = 100_000
    expect(shouldSkipCounting(10_000, 500, 400, 200_000)).toBe(true);
  });

  it("returns false when the output term alone pushes past the 50% threshold", () => {
    // Without the output term, lastIn + newChars/4 = 90_000 + 100 = 90_100 < 100_000 → skip.
    // With output:            90_000 + 20_000 + 100 = 110_100 ≥ 100_000 → do NOT skip.
    // This is the regression the fix guards against — one response worth of
    // tokens that the old estimator ignored.
    expect(shouldSkipCounting(90_000, 20_000, 400, 200_000)).toBe(false);
  });

  it("returns false when estimate is near budget", () => {
    // 90_000 + 0 + 40_000/4 = 100_000, budget * 0.5 = 100_000 → strict < → not skipped
    expect(shouldSkipCounting(90_000, 0, 40_000, 200_000)).toBe(false);
  });

  it("returns false at exactly the 50% boundary", () => {
    // 40_000 + 10_000 + 200_000/4 = 100_000 = budget * 0.5 → strict < → not skipped
    expect(shouldSkipCounting(40_000, 10_000, 200_000, 200_000)).toBe(false);
  });

  it("returns true just under the 50% boundary", () => {
    // 40_000 + 10_000 + 199_996/4 = 99_999 < 100_000 → skip
    expect(shouldSkipCounting(40_000, 10_000, 199_996, 200_000)).toBe(true);
  });

  it("returns false when either value is the pre-migration -1 sentinel", () => {
    // -1 on either field means "unknown" — force a real count.
    expect(shouldSkipCounting(-1, 500, 400, 200_000)).toBe(false);
    expect(shouldSkipCounting(10_000, -1, 400, 200_000)).toBe(false);
    expect(shouldSkipCounting(-1, -1, 400, 200_000)).toBe(false);
  });
});

describe("the summarized count", () => {
  // Load-bearing for durable summaries: `handle-message` treats
  // `messagesSummarized` as an index into the history it loaded, mapping it to
  // a `through_message_id`. That holds because nothing before summarization
  // changes the array: Strategy 1 is an intent on the request.
  const cluster = (n: number): Message[] =>
    Array.from({ length: n }, (_, i) => [
      toolCallMsg(`t${i}`, "read_file"),
      toolResultMsg([{ id: `t${i}`, content: `contents of file ${i} `.repeat(40) }]),
    ]).flat();

  it("reports a summarized count that indexes the input array", async () => {
    const messages = [
      ...cluster(3),
      ...Array.from({ length: 6 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `tail ${i}`)),
    ];
    const summarize = vi.fn().mockResolvedValue("a summary");

    const result = await compactMessages(
      "system",
      messages,
      undefined,
      {
        countTokens: vi.fn().mockResolvedValue(900),
        budget: 1000,
        clearToolResults: CLEARING,
        maxRequestBytes: MAX_REQUEST_BYTES,
        summarize,
      },
      false,
    );

    const summarized = result.event?.messagesSummarized ?? 0;
    expect(summarized).toBeGreaterThan(0);
    // The prefix handed to the summarizer is exactly `input.slice(0, count)`.
    const prefix: Message[] = expectDefined(summarize.mock.calls[0], "summarize call")[1];
    expect(prefix).toEqual(messages.slice(0, summarized));
  });
});

describe("prefix veto", () => {
  function summarizeDeps(
    summarize: NonNullable<ContextManagerDeps["summarize"]>,
  ): ContextManagerDeps {
    return {
      countTokens: vi.fn().mockResolvedValue(900),
      budget: 1000,
      clearToolResults: CLEARING,
      maxRequestBytes: MAX_REQUEST_BYTES,
      summarize,
    };
  }

  const sevenMessages = () =>
    Array.from({ length: 7 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `turn ${i}`));

  it("summarizes a one-message prefix when no veto is supplied", async () => {
    // 7 messages at keepTurns 6 splits at 1. Size is not what makes a prefix
    // worth summarizing: one enormous message is the best case for Strategy 2,
    // and refusing it would hand the turn to lossy truncation.
    const summarize = vi.fn().mockResolvedValue("a summary");

    const result = await compactMessages(
      "system",
      sevenMessages(),
      undefined,
      summarizeDeps(summarize),
    );

    expect(summarize).toHaveBeenCalledOnce();
    expect(result.event?.messagesSummarized).toBe(1);
  });

  it("skips the LLM call when the caller vetoes the split", async () => {
    const summarize = vi.fn().mockResolvedValue("a summary");
    const canSummarizePrefix = vi.fn().mockReturnValue(false);

    const result = await compactMessages("system", sevenMessages(), undefined, {
      ...summarizeDeps(summarize),
      canSummarizePrefix,
    });

    expect(canSummarizePrefix).toHaveBeenCalledWith(1);
    expect(summarize).not.toHaveBeenCalled();
    expect(result.event?.strategies ?? []).not.toContain("summarize");
  });

  it("consults the veto with the chosen split, after pair-snapping", async () => {
    // The veto has to see the index the summary would actually cover, not the
    // raw `length - keepTurns` — the caller maps it back to a message id.
    const canSummarizePrefix = vi.fn().mockReturnValue(true);
    const messages = [
      msg("user", "t0"),
      msg("assistant", "t1"),
      toolCallMsg("t9", "read_file"),
      toolResultMsg([{ id: "t9", content: "x" }]),
      ...Array.from({ length: 5 }, (_, i) => msg(i % 2 === 0 ? "assistant" : "user", `u${i}`)),
    ];

    await compactMessages("system", messages, undefined, {
      ...summarizeDeps(vi.fn().mockResolvedValue("a summary")),
      canSummarizePrefix,
    });

    // 9 entries, keepTurns 6 → raw split 3, which lands on the user-role
    // tool_result and snaps back to 2 so the pair stays intact.
    expect(canSummarizePrefix).toHaveBeenCalledWith(2);
  });
});

describe("summarizationRequest", () => {
  it("repairs an orphan tool_use at the prefix tail", () => {
    // A split can land right after an assistant `tool_use` that history never
    // answered — a shape `validateHistory` exists for. Compaction runs upstream
    // of the agent loop's sanitizer, so this is the one LLM call in a turn that
    // would otherwise be built from raw history, and Anthropic rejects it.
    const params = summarizationRequest({
      model: "m",
      system: "s",
      messages: [msg("user", "do it"), toolCallMsg("t1", "read_file")],
      maxOutputTokens: 8192,
    });

    // The synthesized answer sits between the orphan call and the instruction.
    expect(expectDefined(params.messages.at(-2), "answering message")).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1" }],
    });
  });

  it("joins several text blocks on a paragraph break rather than fusing them", () => {
    // Blocks in a non-streaming response are discrete units. Joining with
    // nothing would run the last sentence of one into the first of the next,
    // and the result is stored rather than recomputed on the next turn.
    expect(
      extractSummaryText([
        { type: "text", text: "They settled the schema." },
        { type: "text", text: "Then they moved on." },
      ]),
    ).toBe("They settled the schema.\n\nThen they moved on.");
  });

  it("drops non-text blocks", () => {
    expect(
      extractSummaryText([
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "text", text: "the summary" },
      ]),
    ).toBe("the summary");
  });

  it("appends the instruction as the final user message", () => {
    const params = summarizationRequest({
      model: "m",
      system: "s",
      messages: [msg("user", "hello"), msg("assistant", "hi")],
      maxOutputTokens: 8192,
    });

    expect(params.messages.at(-1)).toEqual({ role: "user", content: SUMMARIZATION_PROMPT });
    expect(params.messages).toHaveLength(3);
  });

  it("carries the turn's Strategy 1 intent, and none without one", () => {
    const messages = [msg("user", "hello"), msg("assistant", "hi")];

    expect(
      summarizationRequest({
        model: "m",
        system: "s",
        messages,
        maxOutputTokens: 8192,
        clearToolResults: CLEARING,
      }).clearToolResults,
    ).toEqual(CLEARING);
    expect(
      summarizationRequest({ model: "m", system: "s", messages, maxOutputTokens: 8192 }),
    ).not.toHaveProperty("clearToolResults");
  });

  it("caps output at the model's own ceiling when it is below the default", () => {
    expect(
      summarizationRequest({ model: "m", system: "s", messages: [], maxOutputTokens: 4096 })
        .maxTokens,
    ).toBe(4096);
    expect(
      summarizationRequest({ model: "m", system: "s", messages: [], maxOutputTokens: 64_000 })
        .maxTokens,
    ).toBe(16_000);
  });
});
