/**
 * A connector's session: one open `Connect` stream, and the queue of messages
 * the hub sends down it.
 */

import type { ConnectResponse } from "@cogmo/connector-proto";
import type { ActiveConnector } from "./store/index.js";

/** Why the hub ended a session. */
export type SessionEnd = "replaced" | "unauthenticated" | "shutdown";

/** The session as the `Connect` handler drives it. */
export interface ConnectorSession {
  /**
   * The messages to send, in order, until the hub ends the session or `signal`
   * aborts.
   */
  messages(signal: AbortSignal): AsyncIterable<ConnectResponse>;
  /** Why the hub ended the session; `null` while open, or once the connector left. */
  readonly endReason: SessionEnd | null;
  /** The connector's stream closed. Idempotent. */
  close(): void;
}

/** The session as the hub drives it. */
export interface HubSession extends ConnectorSession {
  readonly connector: ActiveConnector;
  /** Queues a message; dropped once the session is over. */
  send(message: ConnectResponse): void;
  /** Ends the session from the hub's side. Idempotent. */
  end(reason: SessionEnd): void;
}

export class Session implements HubSession {
  readonly connector: ActiveConnector;
  readonly #onClosed: (session: Session) => void;
  readonly #queue: ConnectResponse[] = [];
  #wake: (() => void) | null = null;
  #endReason: SessionEnd | null = null;
  #over = false;

  /** `onClosed` runs once, when the session is over from either side. */
  constructor(connector: ActiveConnector, onClosed: (session: Session) => void) {
    this.connector = connector;
    this.#onClosed = onClosed;
  }

  get endReason(): SessionEnd | null {
    return this.#endReason;
  }

  send(message: ConnectResponse): void {
    if (this.#over) return;
    this.#queue.push(message);
    this.#wake?.();
  }

  end(reason: SessionEnd): void {
    if (this.#over) return;
    this.#endReason = reason;
    this.#finish();
  }

  close(): void {
    if (this.#over) return;
    this.#finish();
  }

  async *messages(signal: AbortSignal): AsyncGenerator<ConnectResponse> {
    const onAbort = () => this.#wake?.();
    signal.addEventListener("abort", onAbort);
    try {
      for (;;) {
        const next = this.#queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (this.#over || signal.aborted) return;
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
    this.#over = true;
    this.#wake?.();
    this.#onClosed(this);
  }
}
