import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { ContentBlock, Message, ToolDefinition } from "../llm/types.js";
import { expectDefined } from "../test/assertions.js";
import { openTranscript, type Transcript, type TranscriptPrefix } from "./transcript.js";
import { baseDigest, TranscriptHasher } from "./transcript-head.js";

const TOOLS: ReadonlyArray<ToolDefinition> = [
  { name: "echo", description: "echo a value", parameters: { type: "object", properties: {} } },
];

function prefix(epoch: TranscriptPrefix["epoch"]): TranscriptPrefix {
  return { system: "sys", tools: TOOLS, epoch };
}

/** A two-message history a turn would open on: an earlier reply, then the turn's own message. */
function history(): Message[] {
  return [
    { role: "assistant", content: [{ type: "text", text: "earlier reply" }] },
    { role: "user", content: "the turn's message" },
  ];
}

function opened(messages: ReadonlyArray<Message>): Transcript {
  return openTranscript(prefix("continued"), { kind: "unchanged", messages }, mock<Logger>());
}

function assistant(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolResults(id: string): Message {
  return { role: "user", content: [{ type: "tool_result", toolUseId: id, content: "ok" }] };
}

/** The head of a request sending `messages`, chained from scratch. */
function fullChain(messages: ReadonlyArray<Message>) {
  return new TranscriptHasher().head(baseDigest("sys", TOOLS), messages);
}

describe("openTranscript", () => {
  it("opens a rewritten view on an epoch opening", () => {
    const transcript = openTranscript(
      prefix("opened"),
      { kind: "rewritten", messages: history() },
      mock<Logger>(),
    );
    expect(transcript.messages).toEqual(history());
  });

  it("opens an unchanged view on a continued epoch", () => {
    expect(opened(history()).messages).toEqual(history());
  });

  it("throws on a rewritten view under a continued epoch", () => {
    expect(() =>
      openTranscript(
        prefix("continued"),
        { kind: "rewritten", messages: history() },
        mock<Logger>(),
      ),
    ).toThrow("a rewritten view can only open a transcript on an epoch opening");
  });

  it("sanitizes the view as every request sends it, logging the repairs", () => {
    const log = mock<Logger>();
    const stray: Message = {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "ghost", content: "stray" },
        { type: "text", text: "real text" },
      ],
    };

    const transcript = openTranscript(
      prefix("continued"),
      { kind: "unchanged", messages: [...history(), stray] },
      log,
    );

    expect(transcript.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "real text" }],
    });
    expect(transcript.openedLength).toBe(3);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ repairCount: 1 }),
      "agent loop history invariants repaired",
    );
  });

  it("logs nothing when the view needs no repair", () => {
    const log = mock<Logger>();
    openTranscript(prefix("continued"), { kind: "unchanged", messages: history() }, log);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("holds the prefix and its h₀", () => {
    const transcript = opened(history());
    expect(transcript.system).toBe("sys");
    expect(transcript.tools).toEqual(TOOLS);
    expect(transcript.base).toBe(baseDigest("sys", TOOLS));
    expect(transcript.openedLength).toBe(2);
  });
});

describe("Transcript.request", () => {
  it("sends the prefix and every message, under the head of the full chain", () => {
    const transcript = opened(history());
    transcript.append(assistant("reply"));

    const request = transcript.request();

    const sent = [...history(), assistant("reply")];
    expect(request.system).toBe("sys");
    expect(request.tools).toEqual(TOOLS);
    expect(request.messages).toEqual(sent);
    expect(request.head).toEqual(fullChain(sent));
  });

  it("extends each head to the full chain over its request", () => {
    const transcript = opened(history());
    const first = transcript.request();
    transcript.append(assistant("calls a tool"));
    transcript.append(toolResults("t1"));
    const second = transcript.request();
    transcript.append(assistant("calls another"));
    transcript.append(toolResults("t2"));
    const third = transcript.request();

    expect(first.head).toEqual(fullChain(history()));
    expect(second.head).toEqual(fullChain(second.messages));
    expect(third.head).toEqual(fullChain(third.messages));
    expect(third.head.length).toBe(6);
  });

  it("hands out copies: changing a request's or a read's messages changes no later request", () => {
    const transcript = opened(history());
    const request = transcript.request();
    // Intentionally invalid: the arrays are typed readonly.
    (request.messages as unknown as Message[]).push(assistant("injected"));
    (transcript.messages as unknown as Message[]).push(assistant("injected"));

    expect(transcript.request().messages).toEqual(history());
  });
});

describe("Transcript.amendUnsent", () => {
  it("replaces the unsent last message with the blocks appended, leaving the original untouched", () => {
    const transcript = opened(history());
    transcript.request();
    const reply = assistant("partial");
    transcript.append(reply);
    const notice: ContentBlock = { type: "text", text: "[cut off]", harness: "truncation_notice" };

    transcript.amendUnsent([notice]);

    expect(transcript.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "partial" }, notice],
    });
    expect(transcript.messages.at(-1)).not.toBe(reply);
    expect(reply).toEqual(assistant("partial"));
  });

  it("throws once a request carried the message", () => {
    const transcript = opened(history());
    transcript.append(assistant("reply"));
    transcript.request();

    expect(() => transcript.amendUnsent([{ type: "text", text: "late" }])).toThrow(
      "can't amend message 2: it has been sent",
    );
  });

  it("throws on the opened view's last message, before any request", () => {
    const transcript = opened(history());
    expect(() => transcript.amendUnsent([{ type: "text", text: "late" }])).toThrow(
      "can't amend message 1: it has been sent",
    );
  });

  it("throws on an unsent message whose content is a string", () => {
    const transcript = opened(history());
    transcript.append({ role: "assistant", content: "plain" });
    expect(() => transcript.amendUnsent([{ type: "text", text: "more" }])).toThrow(
      "can't amend a message whose content is a string",
    );
  });
});

describe("Transcript.discardUnsent", () => {
  it("removes the unsent last message, and the one before it when that is unsent too", () => {
    const transcript = opened(history());
    transcript.request();
    transcript.append(assistant("calls a tool"));
    transcript.append(toolResults("t1"));

    transcript.discardUnsent();
    transcript.discardUnsent();

    expect(transcript.messages).toEqual(history());
  });

  it("lets the next request extend what is left", () => {
    const transcript = opened(history());
    transcript.request();
    transcript.append(assistant(""));
    transcript.discardUnsent();
    transcript.append({
      role: "user",
      content: [{ type: "text", text: "continue", harness: "continuation" }],
    });

    const request = transcript.request();

    expect(request.messages).toHaveLength(3);
    expect(request.head).toEqual(fullChain(request.messages));
  });

  it("throws once a request carried the message", () => {
    const transcript = opened(history());
    transcript.append(assistant("calls a tool"));
    transcript.append(toolResults("t1"));
    transcript.request();

    expect(() => transcript.discardUnsent()).toThrow("can't discard message 3: it has been sent");
    expect(expectDefined(transcript.messages.at(-1), "last message")).toEqual(toolResults("t1"));
  });

  it("throws on the opened view's last message, before any request", () => {
    const transcript = opened(history());
    expect(() => transcript.discardUnsent()).toThrow("can't discard message 1: it has been sent");
  });

  it("throws on an empty transcript", () => {
    expect(() => opened([]).discardUnsent()).toThrow(
      "can't discard the last message of an empty transcript",
    );
  });
});
