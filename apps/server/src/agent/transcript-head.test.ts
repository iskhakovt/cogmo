import { describe, expect, it } from "vitest";
import type { InputTransformation, Message, ToolDefinition } from "../llm/types.js";
import { canonicalJson, sha256 } from "../util/canonical-json.js";
import { isAttachmentRef, StoredMessageContentSchema, toStoredMessage } from "./stored-content.js";
import {
  baseDigest,
  isDivergingTransformation,
  type LoopRequests,
  rowHeads,
  TranscriptHasher,
  TranscriptHeadSchema,
} from "./transcript-head.js";

const TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Reads a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];
const BASE = baseDigest("system", TOOLS);

const USER: Message = { role: "user", content: "hi" };
const TOOL_CALL: Message = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "look it up", signature: "sig" },
    { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.txt", lines: [1, 2] } },
  ],
};
const TOOL_RESULT: Message = {
  role: "user",
  content: [{ type: "tool_result", toolUseId: "t1", content: "contents" }],
};
const REPLY: Message = { role: "assistant", content: [{ type: "text", text: "done" }] };

/** {@link TOOL_CALL} with every object's keys in another order. */
const TOOL_CALL_REORDERED: Message = {
  content: [
    { signature: "sig", thinking: "look it up", type: "thinking" },
    { input: { lines: [1, 2], path: "a.txt" }, name: "read_file", id: "t1", type: "tool_use" },
  ],
  role: "assistant",
};

/** `value` with every object's keys in reverse order, as a reload may return them. */
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([k, v]) => [k, reversedKeys(v)]),
  );
}

/**
 * `message` as `messages` stores it and a later turn renders it: through JSON
 * with its keys reordered, then the column's schema. These fixtures hold no
 * attachment refs, which the renderer would resolve.
 */
function reloaded(message: Message): Message {
  const stored = toStoredMessage(message);
  const content = StoredMessageContentSchema.parse(
    JSON.parse(JSON.stringify(reversedKeys(stored.content))),
  );
  return {
    role: stored.role,
    content:
      typeof content === "string"
        ? content
        : content.flatMap((block) => {
            if (isAttachmentRef(block)) throw new Error("these fixtures hold no attachment refs");
            return [block];
          }),
  };
}

/** The chain written out step by step, independent of {@link TranscriptHasher}. */
function chain(base: string, messages: ReadonlyArray<Message>): string {
  const sent = (m: Message): unknown =>
    JSON.parse(JSON.stringify(m, (key, value) => (key === "harness" ? undefined : value)));
  return messages.reduce((h, m) => sha256(h + sha256(canonicalJson(sent(m)))), base);
}

/** The digest a one-message request under {@link BASE} chains: what tells messages apart. */
function messageDigest(message: Message): string {
  return new TranscriptHasher().head(BASE, [message]).digest;
}

describe("a message's digest", () => {
  it("ignores key order", () => {
    expect(messageDigest(TOOL_CALL_REORDERED)).toBe(messageDigest(TOOL_CALL));
  });

  it("ignores the harness tag on text and tool_result blocks", () => {
    const tagged: Message = {
      role: "user",
      content: [
        { type: "text", text: "Please continue.", harness: "continuation" },
        { type: "tool_result", toolUseId: "t1", content: "nudge", harness: "volume_nudge" },
      ],
    };
    const sent: Message = {
      role: "user",
      content: [
        { type: "text", text: "Please continue." },
        { type: "tool_result", toolUseId: "t1", content: "nudge" },
      ],
    };
    expect(messageDigest(tagged)).toBe(messageDigest(sent));
  });

  it("changes with any content", () => {
    const variants: Message[] = [
      { role: "assistant", content: "hi" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: "hi!" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "look it up", signature: "sig2" },
          {
            type: "tool_use",
            id: "t1",
            name: "read_file",
            input: { path: "a.txt", lines: [1, 2] },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "look it up", signature: "sig" },
          {
            type: "tool_use",
            id: "t1",
            name: "read_file",
            input: { path: "a.txt", lines: [2, 1] },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "t1", content: "contents", isError: true }],
      },
    ];
    const digests = [USER, TOOL_CALL, TOOL_RESULT, ...variants].map(messageDigest);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("digests a reloaded row the same as the message the loop held", () => {
    const notice: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "Chapter one" },
        { type: "text", text: "[cut off]", harness: "truncation_notice" },
      ],
    };
    const withUndefined: Message = {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1", content: "ok", isError: undefined }],
    } as unknown as Message;
    for (const message of [USER, TOOL_CALL, TOOL_RESULT, REPLY, notice, withUndefined]) {
      expect(messageDigest(reloaded(message))).toBe(messageDigest(message));
    }
  });
});

describe("baseDigest", () => {
  it("changes with the system prompt or the tools, not their key order", () => {
    const reordered: ToolDefinition[] = [
      {
        parameters: {
          required: ["path"],
          properties: { path: { type: "string" } },
          type: "object",
        },
        description: "Reads a file",
        name: "read_file",
      },
    ];
    expect(baseDigest("system", reordered)).toBe(BASE);
    expect(baseDigest("system.", TOOLS)).not.toBe(BASE);
    expect(baseDigest("system", [])).not.toBe(BASE);
  });
});

describe("TranscriptHasher", () => {
  it("chains each message onto the base, so position matters", () => {
    const hasher = new TranscriptHasher();
    const head = hasher.head(BASE, [USER, TOOL_CALL, TOOL_RESULT, REPLY]);

    expect(head).toEqual({ length: 4, digest: chain(BASE, [USER, TOOL_CALL, TOOL_RESULT, REPLY]) });
    expect(hasher.head(BASE, [USER, TOOL_CALL, REPLY, TOOL_RESULT]).digest).not.toBe(head.digest);
    expect(hasher.head(BASE, [])).toEqual({ length: 0, digest: BASE });
    expect(hasher.head(baseDigest("other", TOOLS), [USER]).digest).not.toBe(
      hasher.head(BASE, [USER]).digest,
    );
  });

  it("extends a head by the messages from an index on, as hashing the whole would", () => {
    const hasher = new TranscriptHasher();
    const messages = [USER, TOOL_CALL, TOOL_RESULT, REPLY];
    const prefix = hasher.head(BASE, messages.slice(0, 2));

    expect(hasher.extend(prefix, messages, 2)).toEqual(new TranscriptHasher().head(BASE, messages));
  });
});

describe("TranscriptHeadSchema", () => {
  const head = {
    length: 2,
    digest: "b".repeat(64),
    base: "a".repeat(64),
    historyStart: "m1",
    status: "intact",
  };

  it("accepts a head and refuses extra keys, an unknown status and a non-digest", () => {
    expect(TranscriptHeadSchema.parse(head)).toEqual(head);
    expect(TranscriptHeadSchema.safeParse({ ...head, extra: 1 }).success).toBe(false);
    expect(TranscriptHeadSchema.safeParse({ ...head, status: "stale" }).success).toBe(false);
    expect(TranscriptHeadSchema.safeParse({ ...head, digest: "abc" }).success).toBe(false);
    expect(TranscriptHeadSchema.safeParse({ ...head, length: -1 }).success).toBe(false);
  });
});

describe("isDivergingTransformation", () => {
  const entry = (type: string, reason: string): InputTransformation => ({
    type,
    reason,
    path: "messages.1.content.0",
  });

  it.each([
    ["thinking_mismatch_allowed", "prefix_binding_mismatch", true],
    ["thinking_mismatch_allowed", "model_binding_mismatch", false],
    ["thinking_dropped", "prefix_binding_mismatch", true],
    ["thinking_dropped", "organization_binding_mismatch", true],
    ["thinking_dropped", "model_binding_mismatch", false],
    ["thinking_dropped", "end_user_binding_mismatch", false],
    ["some_future_type", "prefix_binding_mismatch", false],
  ])("%s for %s diverges: %s", (type, reason, diverges) => {
    expect(isDivergingTransformation(entry(type, reason))).toBe(diverges);
  });
});

describe("rowHeads", () => {
  const VIEW = { historyStart: "m1", compacted: false };

  /** The loop's record of requests over `transcript`, one per length in `lengths`. */
  function sentOver(
    transcript: ReadonlyArray<Message>,
    lengths: ReadonlyArray<number>,
    overrides?: Partial<LoopRequests>,
  ): LoopRequests {
    const hasher = new TranscriptHasher();
    return {
      base: BASE,
      historyLength: 1,
      sent: lengths.map((length) => hasher.head(BASE, transcript.slice(0, length))),
      diverged: false,
      ...overrides,
    };
  }

  /** The head the next request would send over `transcript[0..length)`. */
  function nextRequestHead(transcript: ReadonlyArray<Message>, length: number) {
    return { length, digest: chain(BASE, transcript.slice(0, length)) };
  }

  it("gives each assistant row the head of its request extended through it, and user rows none", () => {
    const rows = [TOOL_CALL, TOOL_RESULT, REPLY];
    const transcript = [USER, ...rows];

    const heads = rowHeads(sentOver(transcript, [1, 3]), rows, VIEW);

    expect(heads).toEqual([
      { ...nextRequestHead(transcript, 2), base: BASE, historyStart: "m1", status: "intact" },
      null,
      { ...nextRequestHead(transcript, 4), base: BASE, historyStart: "m1", status: "intact" },
    ]);
  });

  it("extends from the last request not past the row, skipping one that sent an unpersisted prompt", () => {
    // Iteration 2 sent a continuation prompt, then degraded; the prompt is not
    // persisted, and the apology takes its position.
    const continuation: Message = {
      role: "user",
      content: [{ type: "text", text: "Please continue.", harness: "continuation" }],
    };
    const apology: Message = { role: "assistant", content: [{ type: "text", text: "Sorry." }] };
    const sent = sentOver([USER, continuation], [1, 2]);

    const [head] = rowHeads(sent, [apology], VIEW);

    expect(head).toMatchObject(nextRequestHead([USER, apology], 2));
  });

  it("marks every row compacted over diverged, and diverged over intact", () => {
    const transcript = [USER, REPLY];
    const status = (compacted: boolean, diverged: boolean) =>
      rowHeads(sentOver(transcript, [1], { diverged }), [REPLY], {
        historyStart: "m1",
        compacted,
      })[0]?.status;

    expect(status(true, true)).toBe("compacted");
    expect(status(true, false)).toBe("compacted");
    expect(status(false, true)).toBe("diverged");
    expect(status(false, false)).toBe("intact");
  });

  it("gives no head to a row at or after a request whose memo predates heads", () => {
    const rows = [TOOL_CALL, TOOL_RESULT, REPLY];
    const transcript = [USER, ...rows];
    const hasher = new TranscriptHasher();
    const first = hasher.head(BASE, transcript.slice(0, 1));

    const allHeadless = rowHeads(
      sentOver(transcript, [], { sent: [{ length: 1, digest: null }] }),
      rows,
      VIEW,
    );
    const laterHeadless = rowHeads(
      sentOver(transcript, [], { sent: [first, { length: 3, digest: null }] }),
      rows,
      VIEW,
    );

    const earlierHeadless = rowHeads(
      sentOver(transcript, [], {
        sent: [{ length: 1, digest: null }, hasher.head(BASE, transcript.slice(0, 3))],
      }),
      rows,
      VIEW,
    );

    expect(allHeadless).toEqual([null, null, null]);
    expect(laterHeadless.map((h) => h?.length ?? null)).toEqual([2, null, null]);
    // A head-less request leaves the rows after it without one, headed requests included.
    expect(earlierHeadless).toEqual([null, null, null]);
  });

  it("gives no head when the loop sent no request", () => {
    expect(rowHeads(sentOver([USER], []), [REPLY], VIEW)).toEqual([null]);
  });
});
