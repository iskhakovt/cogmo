/**
 * The append-only transcript a turn's loop sends (design/prompt-caching.md →
 * Transcript type). Opened once from the turn's settled view, it only grows:
 * a message a request carried is never edited, and the only change to one
 * not yet sent is to the last message.
 */

import type { Logger } from "pino";
import { match } from "ts-pattern";
import type { ContentBlock, Message, ToolDefinition } from "../llm/types.js";
import { validateHistory } from "./history-invariants.js";
import { baseDigest, type RequestHead, TranscriptHasher } from "./transcript-head.js";

/** What every request of a transcript sends ahead of its messages, and who opened its epoch. */
export interface TranscriptPrefix {
  system: string;
  /** The frozen tool definitions, in the order the loop dispatches on them. */
  tools: ReadonlyArray<ToolDefinition>;
  /**
   * `opened`: this turn opened the epoch at its own row, or a stage turn sends
   * a prefix of its own; `continued`: an earlier turn opened it.
   */
  epoch: "opened" | "continued";
}

/**
 * The view a turn opens its transcript from: as its rows render it, or
 * rewritten by its compaction, which only an epoch opening may send.
 */
export type TranscriptView =
  | { kind: "unchanged"; messages: ReadonlyArray<Message> }
  | { kind: "rewritten"; messages: ReadonlyArray<Message> };

/**
 * One request: the prefix, every message so far, and the head of the chain
 * over them. The arrays and the head are the caller's own; the messages and
 * tool definitions in them are the transcript's, shared rather than copied,
 * since a copy would duplicate every attachment's bytes on each request.
 */
export interface TranscriptRequest {
  readonly system: string;
  readonly tools: ReadonlyArray<Readonly<ToolDefinition>>;
  readonly messages: ReadonlyArray<Readonly<Message>>;
  readonly head: Readonly<RequestHead>;
}

/**
 * A turn's transcript. A message is sent once a request carried it, and the
 * opened view counts as sent: the opening is the only point at which it may
 * be rewritten, and every request of the turn replays it.
 * {@link Transcript.amendUnsent} and {@link Transcript.discardUnsent} touch
 * only an unsent last message and throw otherwise.
 */
export interface Transcript {
  /** h₀ of every request: the digest of the system prompt and tool definitions. */
  readonly base: string;
  readonly system: string;
  readonly tools: ReadonlyArray<Readonly<ToolDefinition>>;
  /** Every message, the opened view first. Reading records nothing, so forks read here. */
  readonly messages: ReadonlyArray<Readonly<Message>>;
  /** How many messages the opened view holds: where the turn's own messages start. */
  readonly openedLength: number;
  append(message: Message): void;
  /** Replaces the unsent last message with `blocks` appended to its content. */
  amendUnsent(blocks: ReadonlyArray<ContentBlock>): void;
  /** Removes the unsent last message. */
  discardUnsent(): void;
  /**
   * The request every message so far makes, recorded as sent. Called in the
   * bare body before each iteration's step, on every invocation, so a replay
   * records the same requests as the run that sent them.
   */
  request(): TranscriptRequest;
}

/**
 * Open a turn's transcript once its epoch is settled, from its rendered and
 * compacted view: the history sanitized as every request sends it, so rows an
 * earlier bug left orphaned still make a valid request, with repairs logged to
 * show whether such rows still turn up. A view compaction rewrote reaches a
 * request only through an epoch opening; a rewritten view under a continued
 * epoch is a bug in the decision that kept the epoch, and throws.
 */
export function openTranscript(
  prefix: TranscriptPrefix,
  view: TranscriptView,
  log: Logger,
): Transcript {
  match({ view: view.kind, epoch: prefix.epoch })
    .with({ view: "rewritten", epoch: "continued" }, () => {
      throw new Error("a rewritten view can only open a transcript on an epoch opening");
    })
    .with({ view: "unchanged" }, { epoch: "opened" }, () => undefined)
    .exhaustive();
  const { messages, repairs } = validateHistory(view.messages);
  if (repairs.length > 0) {
    log.warn({ repairCount: repairs.length, repairs }, "transcript history invariants repaired");
  }
  return new OpenedTranscript(prefix, messages);
}

class OpenedTranscript implements Transcript {
  readonly #system: string;
  readonly #tools: ReadonlyArray<ToolDefinition>;
  readonly #base: string;
  readonly #messages: Message[];
  readonly #openedLength: number;
  /** Digests each message once; messages are replaced, never edited, so its memo holds. */
  readonly #hasher = new TranscriptHasher();
  /** The head of the last request; null before the first. */
  #sent: RequestHead | null = null;

  constructor(prefix: TranscriptPrefix, messages: Message[]) {
    this.#system = prefix.system;
    this.#tools = [...prefix.tools];
    this.#base = baseDigest(prefix.system, prefix.tools);
    this.#messages = messages;
    this.#openedLength = messages.length;
  }

  get base(): string {
    return this.#base;
  }

  get system(): string {
    return this.#system;
  }

  get tools(): ReadonlyArray<Readonly<ToolDefinition>> {
    return this.#tools;
  }

  get messages(): ReadonlyArray<Readonly<Message>> {
    return [...this.#messages];
  }

  get openedLength(): number {
    return this.#openedLength;
  }

  append(message: Message): void {
    this.#messages.push(message);
  }

  amendUnsent(blocks: ReadonlyArray<ContentBlock>): void {
    const last = this.#unsentLast("amend");
    if (typeof last.content === "string") {
      throw new Error("can't amend a message whose content is a string");
    }
    this.#messages[this.#messages.length - 1] = {
      role: last.role,
      content: [...last.content, ...blocks],
    };
  }

  discardUnsent(): void {
    this.#unsentLast("discard");
    this.#messages.pop();
  }

  request(): TranscriptRequest {
    const messages = [...this.#messages];
    // Extending the last request's head is the full chain: no request's
    // messages change once sent.
    const head =
      this.#sent === null
        ? this.#hasher.head(this.#base, messages)
        : this.#hasher.extend(this.#sent, messages, this.#sent.length);
    this.#sent = head;
    return { system: this.#system, tools: [...this.#tools], messages, head: { ...head } };
  }

  /** The last message, when it is one the turn appended and no request carried. */
  #unsentLast(operation: "amend" | "discard"): Message {
    const index = this.#messages.length - 1;
    const last = this.#messages[index];
    if (last === undefined)
      throw new Error(`can't ${operation} the last message of an empty transcript`);
    if (index < Math.max(this.#openedLength, this.#sent?.length ?? 0)) {
      throw new Error(`can't ${operation} message ${index}: it has been sent`);
    }
    return last;
  }
}
