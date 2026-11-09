/**
 * A connector's session: one open `Connect` stream, and the queue of messages
 * the hub sends down it.
 */

import type { ConnectResponse } from "@cogmo/connector-proto";
import { match } from "ts-pattern";
import type { ActiveConnector } from "./store/index.js";

/** Why the hub ended a session. */
export type SessionEnd = "replaced" | "unauthenticated" | "auth_unavailable" | "shutdown";

/** The session as the `Connect` handler drives it. */
export interface ConnectorSession {
  /**
   * The queued messages, in order, while the session is open and `signal` has
   * not aborted. Once either stops, nothing more is yielded.
   */
  messages(signal: AbortSignal): AsyncIterable<ConnectResponse>;
  /** Why the hub ended the session; `null` while open, or once the connector left. */
  readonly endReason: SessionEnd | null;
  /** Aborts when the hub ends the session, so the stream's owner can close a stream stuck writing. */
  readonly ended: AbortSignal;
  /** The connector's stream closed. Idempotent. */
  close(): void;
}

/** The session as the hub drives it. */
export interface HubSession extends ConnectorSession {
  readonly connector: ActiveConnector;
  /** Queues a message; dropped once the session is over. */
  send(message: ConnectResponse): void;
  /** Queues a heartbeat unless messages are already waiting, which prove the stream alive once they arrive. */
  heartbeat(message: ConnectResponse): void;
  /** Ends the session from the hub's side. Idempotent. */
  end(reason: SessionEnd): void;
}

type SessionState =
  | { status: "open" }
  | { status: "ended"; reason: SessionEnd }
  | { status: "closed" };

export class Session implements HubSession {
  readonly connector: ActiveConnector;
  readonly #onClosed: (session: HubSession) => void;
  readonly #ended = new AbortController();
  #queue: ConnectResponse[] = [];
  #wake: (() => void) | null = null;
  #state: SessionState = { status: "open" };

  /** `onClosed` runs once, when the session is over from either side. */
  constructor(connector: ActiveConnector, onClosed: (session: HubSession) => void) {
    this.connector = connector;
    this.#onClosed = onClosed;
  }

  get endReason(): SessionEnd | null {
    return match(this.#state)
      .with({ status: "ended" }, ({ reason }) => reason)
      .with({ status: "open" }, { status: "closed" }, () => null)
      .exhaustive();
  }

  get ended(): AbortSignal {
    return this.#ended.signal;
  }

  send(message: ConnectResponse): void {
    if (this.#state.status !== "open") return;
    this.#queue.push(message);
    this.#wake?.();
  }

  heartbeat(message: ConnectResponse): void {
    if (this.#queue.length > 0) return;
    this.send(message);
  }

  end(reason: SessionEnd): void {
    if (this.#state.status !== "open") return;
    this.#state = { status: "ended", reason };
    this.#ended.abort();
    this.#finish();
  }

  close(): void {
    if (this.#state.status !== "open") return;
    this.#state = { status: "closed" };
    this.#finish();
  }

  async *messages(signal: AbortSignal): AsyncGenerator<ConnectResponse> {
    const onAbort = () => this.#wake?.();
    signal.addEventListener("abort", onAbort);
    try {
      for (;;) {
        if (this.#state.status !== "open" || signal.aborted) return;
        const next = this.#queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
        this.#wake = null;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  #finish(): void {
    this.#queue = [];
    this.#wake?.();
    this.#onClosed(this);
  }
}
