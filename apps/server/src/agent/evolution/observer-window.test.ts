import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import type { Message } from "../../llm/types.js";
import type { AgentStore, ObserverBounds } from "../store/index.js";
import {
  chunkTokenLimit,
  isCaughtUp,
  loadChunkTranscript,
  MAX_CHUNKS_PER_FIRE,
  planChunks,
  planObserverChunks,
} from "./observer-window.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

/** A message whose transcript line ("User: " + text) is `tokens` × 4 characters. */
function sized(id: string, tokens: number): Message & { id: string } {
  return { id, role: "user", content: "x".repeat(tokens * 4 - "User: ".length) };
}

function bounds(
  lastMessageId: string | null,
  corrections: string | null,
  memories: string | null,
): ObserverBounds {
  return { messageCount: 10, lastMessageId, observedThrough: { corrections, memories } };
}

describe("planChunks", () => {
  it("closes a chunk before the message that would take it past the limit", () => {
    const window = [sized("m1", 40), sized("m2", 50), sized("m3", 20), sized("m4", 30)];

    expect(planChunks(window, "m0", 100, 3)).toEqual([
      { after: "m0", through: "m2", messages: 2 },
      { after: "m2", through: "m4", messages: 2 },
    ]);
  });

  it("makes a message larger than the limit a chunk of its own", () => {
    const window = [sized("m1", 10), sized("m2", 500), sized("m3", 10)];

    expect(planChunks(window, null, 100, 3)).toEqual([
      { after: null, through: "m1", messages: 1 },
      { after: "m1", through: "m2", messages: 1 },
      { after: "m2", through: "m3", messages: 1 },
    ]);
  });

  it("keeps the first `maxChunks` chunks", () => {
    const window = ["m1", "m2", "m3", "m4", "m5"].map((id) => sized(id, 80));

    expect(planChunks(window, null, 100, 2)).toEqual([
      { after: null, through: "m1", messages: 1 },
      { after: "m1", through: "m2", messages: 1 },
    ]);
  });

  it("plans nothing for an empty window", () => {
    expect(planChunks([], "m0", 100, MAX_CHUNKS_PER_FIRE)).toEqual([]);
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
      chunkTokenLimit("unlisted-model", { contextWindow: 200_000, maxOutputTokens: 20_000 }),
    ).toBe(42_500);
  });
});

describe("planObserverChunks", () => {
  const BOTH = ["corrections", "memories"] as const;
  const WINDOW = ["m3", "m4", "m5", "m6"].map((id) => sized(id, 10));

  it("reads from the lower cursor once and plans each phase from its own", async () => {
    const store = mock<AgentStore>();
    store.listMessagesInRange.mockResolvedValue(WINDOW);

    const plan = await planObserverChunks(
      { runInTx: fakeRunInTx, store },
      {
        conversationId: "conv-1",
        bounds: bounds("m6", "m4", "m2"),
        phases: BOTH,
        tokenLimit: 1_000,
      },
    );

    expect(store.listMessagesInRange).toHaveBeenCalledExactlyOnceWith(expect.anything(), "conv-1", {
      after: "m2",
      through: "m6",
    });
    expect(plan).toEqual({
      tokenLimit: 1_000,
      chunks: {
        corrections: [{ after: "m4", through: "m6", messages: 2 }],
        memories: [{ after: "m2", through: "m6", messages: 4 }],
      },
    });
  });

  it("reads from the start for a phase never observed, and plans nothing for one caught up", async () => {
    const store = mock<AgentStore>();
    store.listMessagesInRange.mockResolvedValue(WINDOW);

    const plan = await planObserverChunks(
      { runInTx: fakeRunInTx, store },
      {
        conversationId: "conv-1",
        bounds: bounds("m6", null, "m6"),
        phases: BOTH,
        tokenLimit: 1_000,
      },
    );

    expect(store.listMessagesInRange).toHaveBeenCalledWith(expect.anything(), "conv-1", {
      after: null,
      through: "m6",
    });
    expect(plan.chunks).toEqual({
      corrections: [{ after: null, through: "m6", messages: 4 }],
      memories: [],
    });
  });

  it("plans only the phases it is given, reading from their lowest cursor", async () => {
    const store = mock<AgentStore>();
    store.listMessagesInRange.mockResolvedValue(WINDOW.slice(2));

    const plan = await planObserverChunks(
      { runInTx: fakeRunInTx, store },
      {
        conversationId: "conv-1",
        bounds: bounds("m6", "m4", null),
        phases: ["corrections"],
        tokenLimit: 1_000,
      },
    );

    expect(store.listMessagesInRange).toHaveBeenCalledWith(expect.anything(), "conv-1", {
      after: "m4",
      through: "m6",
    });
    expect(plan.chunks).toEqual({
      corrections: [{ after: "m4", through: "m6", messages: 2 }],
      memories: [],
    });
  });

  it("reads nothing when both phases are caught up", async () => {
    const store = mock<AgentStore>();

    const plan = await planObserverChunks(
      { runInTx: fakeRunInTx, store },
      {
        conversationId: "conv-1",
        bounds: bounds("m6", "m6", "m6"),
        phases: BOTH,
        tokenLimit: 1_000,
      },
    );

    expect(store.listMessagesInRange).not.toHaveBeenCalled();
    expect(plan.chunks).toEqual({ corrections: [], memories: [] });
  });
});

describe("loadChunkTranscript", () => {
  it("reads a chunk at the start of the conversation with nothing before it", async () => {
    const store = mock<AgentStore>();
    store.listMessagesInRange.mockResolvedValue([sized("m1", 5)]);

    const transcript = await loadChunkTranscript(
      { runInTx: fakeRunInTx, store },
      {
        conversationId: "conv-1",
        chunk: { after: null, through: "m1", messages: 1 },
        tokenLimit: 100,
      },
    );

    expect(transcript).toMatchObject({ summary: null, context: [], throughMessageId: "m1" });
    expect(transcript.messages).toHaveLength(1);
    expect(store.listMessagesThrough).not.toHaveBeenCalled();
    expect(store.getLatestSummaryThrough).not.toHaveBeenCalled();
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
    expect(store.listMessagesInRange).toHaveBeenCalledWith(
      expect.anything(),
      "conv-1",
      expect.objectContaining({ after: "m11", through: "m12" }),
    );
    expect(transcript.summary).toBe("Earlier, the user planned a trip.");
    expect(transcript.context).toEqual([sized("m10", 30), sized("m11", 30)]);
    expect(transcript.throughMessageId).toBe("m12");
  });
});
