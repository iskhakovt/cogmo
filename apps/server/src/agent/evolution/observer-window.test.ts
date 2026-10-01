import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import type { Message } from "../../llm/types.js";
import type { AgentStore, ObserverBounds } from "../store/index.js";
import {
  chunkTokenLimit,
  estimateTokens,
  isCaughtUp,
  loadChunkTranscript,
  MAX_CHUNKS_PER_FIRE,
  MIN_CHUNK_TOKENS,
  PLAN_PAGE_SIZE,
  planPhaseChunks,
  truncateToTokens,
} from "./observer-window.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

/** A message whose ASCII transcript line ("User: " + text) estimates at `tokens`. */
function sized(id: string, tokens: number): Message & { id: string } {
  return { id, role: "user", content: "x".repeat(tokens * 3 - "User: ".length) };
}

function bounds(
  lastMessageId: string | null,
  corrections: string | null,
  memories: string | null,
): ObserverBounds {
  return { messageCount: 10, lastMessageId, observedThrough: { corrections, memories } };
}

describe("estimateTokens", () => {
  it("counts a third of a token per ASCII character", () => {
    expect(estimateTokens("x".repeat(300))).toBe(100);
  });

  it("counts other text by its UTF-8 bytes, half a token each", () => {
    // Three bytes a character: 1.5 tokens.
    expect(estimateTokens("漢".repeat(100))).toBe(150);
    // Two bytes: one token.
    expect(estimateTokens("ж".repeat(100))).toBe(100);
    // Four bytes: two tokens.
    expect(estimateTokens("🙂".repeat(100))).toBe(200);
  });
});

describe("truncateToTokens", () => {
  it("leaves text that fits as it is", () => {
    expect(truncateToTokens("short", 10)).toEqual({ text: "short", tokens: 2 });
  });

  it("cuts text past the limit to it, marking the cut", () => {
    const cut = truncateToTokens("x".repeat(3_000), 100);

    expect(cut.tokens).toBe(estimateTokens(cut.text));
    expect(cut.tokens).toBeLessThanOrEqual(100);
    expect(cut.text).toMatch(/^x+\n\[… \d+ characters truncated\]$/);
  });

  it("cuts non-Latin text by its weight, not its length", () => {
    const cut = truncateToTokens("漢".repeat(1_000), 100);

    expect(cut.tokens).toBe(estimateTokens(cut.text));
    expect(cut.tokens).toBeLessThanOrEqual(100);
    expect(cut.text).toContain("characters truncated");
  });
});

describe("isCaughtUp", () => {
  it("is caught up when the cursor names the last message, or there are no messages", () => {
    expect(isCaughtUp(bounds("m4", "m4", null), "corrections")).toBe(true);
    expect(isCaughtUp(bounds("m4", "m4", null), "memories")).toBe(false);
    expect(isCaughtUp(bounds("m4", "m2", null), "corrections")).toBe(false);
    expect(isCaughtUp(bounds(null, null, null), "memories")).toBe(true);
  });
});

describe("chunkTokenLimit", () => {
  it("is a quarter of the model's input budget", () => {
    // 200k context − 20k output − the 10k safety buffer.
    expect(
      chunkTokenLimit("unlisted-model", { contextWindow: 200_000, maxOutputTokens: 20_000 }, 4_000),
    ).toBe(42_500);
  });

  it("is at most half of what the system prompt leaves", () => {
    // A 10k budget less a 5k prompt leaves 5k: 2.5k a chunk, not a quarter of 10k.
    expect(chunkTokenLimit("m", { contextWindow: 21_000, maxOutputTokens: 1_000 }, 5_000)).toBe(
      2_500,
    );
  });

  it("is raised to the minimum when a quarter of the budget falls below it", () => {
    // A 3k budget: a quarter is 750, and with a small prompt a chunk and its context fit.
    expect(chunkTokenLimit("m", { contextWindow: 14_000, maxOutputTokens: 1_000 }, 500)).toBe(
      MIN_CHUNK_TOKENS,
    );
  });

  it("is null when the prompt leaves too little for a chunk and its context, or the budget is negative", () => {
    // A 3.5k budget beside the memory prompt's ~4k.
    expect(
      chunkTokenLimit("m", { contextWindow: 14_500, maxOutputTokens: 1_000 }, 4_000),
    ).toBeNull();
    expect(chunkTokenLimit("m", { contextWindow: 11_500, maxOutputTokens: 1_000 }, 0)).toBeNull();
    expect(chunkTokenLimit("m", { contextWindow: 8_000, maxOutputTokens: 4_000 }, 0)).toBeNull();
  });
});

/** A store over `window` that serves `listMessagesInRange` pages as Postgres would. */
function storeOver(window: ReadonlyArray<Message & { id: string }>) {
  const store = mock<AgentStore>();
  store.listMessagesInRange.mockImplementation(async (_tx, _conversationId, range) => {
    const after = window.filter(
      (m) => (range.after === null || m.id > range.after) && m.id <= range.through,
    );
    return range.limit === null ? after : after.slice(0, range.limit);
  });
  return store;
}

/** The chunks `planPhaseChunks` cuts `window` into, from `after`, at `tokenLimit`. */
async function chunksOf(
  window: ReadonlyArray<Message & { id: string }>,
  after: string | null,
  tokenLimit: number,
) {
  const plan = await planPhaseChunks(
    { runInTx: fakeRunInTx, store: storeOver(window) },
    { conversationId: "c", after, through: window.at(-1)?.id ?? "m0", tokenLimit },
  );
  return plan.kind === "planned" ? plan.chunks : plan;
}

describe("planPhaseChunks", () => {
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => `m${String(i + 1).padStart(4, "0")}`);

  it("closes a chunk before the message that would take it past the limit", async () => {
    const window = [sized("m1", 40), sized("m2", 50), sized("m3", 20), sized("m4", 30)];

    expect(await chunksOf(window, "m0", 100)).toEqual([
      { after: "m0", through: "m2", messages: 2 },
      { after: "m2", through: "m4", messages: 2 },
    ]);
  });

  it("makes a message larger than the limit a chunk of its own", async () => {
    const window = [sized("m1", 10), sized("m2", 500), sized("m3", 10)];

    expect(await chunksOf(window, null, 100)).toEqual([
      { after: null, through: "m1", messages: 1 },
      { after: "m1", through: "m2", messages: 1 },
      { after: "m2", through: "m3", messages: 1 },
    ]);
  });

  it("counts a message larger than the limit at the limit, so the next one starts a chunk", async () => {
    const window = [sized("m1", 5_000), sized("m2", 10)];

    expect(await chunksOf(window, null, 100)).toEqual([
      { after: null, through: "m1", messages: 1 },
      { after: "m1", through: "m2", messages: 1 },
    ]);
  });

  it(`keeps the first ${MAX_CHUNKS_PER_FIRE} chunks`, async () => {
    const window = ["m1", "m2", "m3", "m4", "m5"].map((id) => sized(id, 80));

    expect(await chunksOf(window, null, 100)).toEqual([
      { after: null, through: "m1", messages: 1 },
      { after: "m1", through: "m2", messages: 1 },
      { after: "m2", through: "m3", messages: 1 },
    ]);
  });

  it("plans nothing for an empty window", async () => {
    expect(await chunksOf([], "m0", 100)).toEqual([]);
  });

  it("reads one page when the chunks fill inside it", async () => {
    const window = ids(500).map((id) => sized(id, 40));
    const store = storeOver(window);

    const plan = await planPhaseChunks(
      { runInTx: fakeRunInTx, store },
      { conversationId: "c", after: null, through: "m0500", tokenLimit: 100 },
    );

    expect(store.listMessagesInRange).toHaveBeenCalledExactlyOnceWith(expect.anything(), "c", {
      after: null,
      through: "m0500",
      limit: PLAN_PAGE_SIZE,
    });
    expect(plan).toEqual({
      kind: "planned",
      tokenLimit: 100,
      chunks: [
        { after: null, through: "m0002", messages: 2 },
        { after: "m0002", through: "m0004", messages: 2 },
        { after: "m0004", through: "m0006", messages: 2 },
      ],
    });
  });

  it("reads further pages only until the chunks fill", async () => {
    // Fifty messages a chunk: the third closes on the second page.
    const window = ids(500).map((id) => sized(id, 2));
    const store = storeOver(window);

    const plan = await planPhaseChunks(
      { runInTx: fakeRunInTx, store },
      { conversationId: "c", after: null, through: "m0500", tokenLimit: 100 },
    );

    expect(
      store.listMessagesInRange.mock.calls.map(([, , range]) => [range.after, range.limit]),
    ).toEqual([
      [null, PLAN_PAGE_SIZE],
      ["m0100", PLAN_PAGE_SIZE],
    ]);
    expect(plan).toMatchObject({
      kind: "planned",
      chunks: [
        { after: null, through: "m0050", messages: 50 },
        { after: "m0050", through: "m0100", messages: 50 },
        { after: "m0100", through: "m0150", messages: 50 },
      ],
    });
  });

  it("plans the rest of a short window from its cursor", async () => {
    const window = ids(6).map((id) => sized(id, 10));
    const store = storeOver(window);

    const plan = await planPhaseChunks(
      { runInTx: fakeRunInTx, store },
      { conversationId: "c", after: "m0004", through: "m0006", tokenLimit: 100 },
    );

    expect(plan).toEqual({
      kind: "planned",
      tokenLimit: 100,
      chunks: [{ after: "m0004", through: "m0006", messages: 2 }],
    });
  });

  it("plans nothing, and reads nothing, when the model's budget is too small", async () => {
    const store = mock<AgentStore>();

    const plan = await planPhaseChunks(
      { runInTx: fakeRunInTx, store },
      { conversationId: "c", after: null, through: "m6", tokenLimit: null },
    );

    expect(plan).toEqual({ kind: "budget_too_small" });
    expect(store.listMessagesInRange).not.toHaveBeenCalled();
  });
});

describe("loadChunkTranscript", () => {
  it("reads a chunk at the start of the conversation with nothing before it", async () => {
    const store = mock<AgentStore>();
    store.listMessagesInRange.mockResolvedValue([
      sized("m1", 5),
      {
        id: "m2",
        role: "assistant",
        content: [{ type: "thinking", thinking: "x", signature: "s" }],
      },
    ]);

    const transcript = await loadChunkTranscript(
      { runInTx: fakeRunInTx, store },
      {
        conversationId: "conv-1",
        chunk: { after: null, through: "m2", messages: 2 },
        tokenLimit: 100,
      },
    );

    expect(transcript).toMatchObject({ summary: null, context: [] });
    // Only what the transcript shows is numbered.
    expect(transcript.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(store.listMessagesThrough).not.toHaveBeenCalled();
    expect(store.getLatestSummaryThrough).not.toHaveBeenCalled();
  });

  it("cuts a message past the limit, marking the cut", async () => {
    const store = mock<AgentStore>();
    store.listMessagesInRange.mockResolvedValue([sized("m1", 5_000)]);

    const transcript = await loadChunkTranscript(
      { runInTx: fakeRunInTx, store },
      {
        conversationId: "conv-1",
        chunk: { after: null, through: "m1", messages: 1 },
        tokenLimit: 100,
      },
    );

    const [only] = transcript.messages;
    expect(estimateTokens(only?.line ?? "")).toBeLessThanOrEqual(100);
    expect(only?.line).toContain("characters truncated");
  });

  it("reads the summary and the last 10 messages through the chunk's start, the oldest dropped past the limit", async () => {
    const store = mock<AgentStore>();
    store.listMessagesInRange.mockResolvedValue([sized("m12", 5)]);
    store.listMessagesThrough.mockResolvedValue([
      sized("m9", 60),
      sized("m10", 30),
      sized("m11", 30),
    ]);
    store.getLatestSummaryThrough.mockResolvedValue({
      id: "s",
      conversationId: "conv-1",
      summary: "Earlier, the user planned a trip.",
      throughMessageId: "m8",
      messagesSummarized: 8,
      model: "m",
      source: "turn",
      createdAt: new Date(),
    });

    const transcript = await loadChunkTranscript(
      { runInTx: fakeRunInTx, store },
      {
        conversationId: "conv-1",
        chunk: { after: "m11", through: "m12", messages: 1 },
        tokenLimit: 100,
      },
    );

    expect(store.listMessagesThrough).toHaveBeenCalledWith(expect.anything(), "conv-1", "m11", 10);
    expect(store.getLatestSummaryThrough).toHaveBeenCalledWith(expect.anything(), "conv-1", "m11");
    expect(store.listMessagesInRange).toHaveBeenCalledWith(expect.anything(), "conv-1", {
      after: "m11",
      through: "m12",
      limit: null,
    });
    expect(transcript.summary).toBe("Earlier, the user planned a trip.");
    // The summary takes 11 of the 100 tokens; m10 and m11 fit the rest, m9 doesn't.
    expect(transcript.context).toHaveLength(2);
    expect(transcript.messages.map((m) => m.id)).toEqual(["m12"]);
  });
});
