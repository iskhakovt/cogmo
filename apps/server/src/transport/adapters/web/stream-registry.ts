/**
 * Process-local bridge between the web SSE routes (connection side) and the
 * `WebUiAdapter` (delivery side). The agent loop runs in the same process as the
 * UI server, so the adapter can write streamed events straight to the open
 * `ServerResponse` a browser tab holds — keyed by the tab's per-tab
 * `platformAddress`.
 *
 * Pure by design: it knows nothing about `node:http`. The route supplies an
 * `SseConnection` that owns the actual `ServerResponse` writes; the registry
 * just maps an address to whichever connection is currently live for it.
 */

/** One server-sent-events frame. Serialized to the wire by the route's `SseConnection`. */
export interface SseFrame {
  /** SSE `event:` field. Omit for the default ("message") event. */
  event?: string;
  /** SSE `data:` payload — already serialized (typically JSON). */
  data: string;
  /**
   * SSE `id:` field — the `Last-Event-ID` reconnect cursor. Unused in Phase 2a
   * (no replay); Phase 2b assigns it from the per-turn event sequence.
   */
  id?: string;
}

/** A live SSE connection for one browser tab. Owned by the route; the registry only references it. */
export interface SseConnection {
  /**
   * Write one frame. Returns whether it actually reached the socket —
   * `false` when the underlying response is already gone. Registration
   * outlives the socket by a tick (the route deregisters from the response's
   * async `close` event), so "a connection is registered" is not the same
   * claim as "the frame was delivered", and callers that dedup on delivery
   * need the stronger one.
   */
  send(frame: SseFrame): boolean;
}

/**
 * Maps a per-tab `platformAddress` to its currently-live SSE connection. A tab
 * reconnecting replaces its entry (last writer wins); the stale connection's
 * deregister is a no-op because it only removes the entry if it still owns it.
 */
export class WebStreamRegistry {
  readonly #connections = new Map<string, SseConnection>();

  /**
   * Register `conn` as the live connection for `platformAddress`, returning a
   * deregister callback. The callback removes the entry only if `conn` is still
   * the registered one — so a reconnect that replaced it isn't clobbered when
   * the old connection later closes.
   */
  register(platformAddress: string, conn: SseConnection): () => void {
    this.#connections.set(platformAddress, conn);
    return () => {
      if (this.#connections.get(platformAddress) === conn) {
        this.#connections.delete(platformAddress);
      }
    };
  }

  /**
   * Send a frame to the tab's live connection. Returns whether it was
   * written — false when no tab is registered, and equally false when the
   * registered connection's socket is already gone.
   */
  send(platformAddress: string, frame: SseFrame): boolean {
    const conn = this.#connections.get(platformAddress);
    if (!conn) return false;
    return conn.send(frame);
  }

  /** Number of live connections — for diagnostics and tests. */
  get size(): number {
    return this.#connections.size;
  }
}
