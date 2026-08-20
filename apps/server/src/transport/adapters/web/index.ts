import type { StreamEvent } from "../../../llm/types.js";
import type { AdapterModule } from "../../adapter-module.js";
import type { StreamHandle, StreamingAdapter } from "../../types.js";
import type { WebStreamRegistry } from "./stream-registry.js";

/** SSE `event:` names for the non-data lifecycle frames (stream events use the default event). */
const TURN_END = "turn-end";
/** Bound on remembered finished (runId, address) keys — see WebUiAdapter.#finished. */
const FINISHED_RUNS_CAP = 1_000;
const TURN_ABORT = "turn-abort";

/**
 * Per-turn stream handle for one tab. Writes each `StreamEvent` as a default
 * ("message") SSE frame to whichever connection is live for the address; turn
 * completion and failure are distinct named frames. It never closes the
 * connection — the SSE socket is long-lived per tab and carries every turn, so
 * `finish`/`abort` only mark the turn boundary and release the dedup slot.
 *
 * If the tab isn't connected, `registry.send` drops the frame (Phase 2a has no
 * replay buffer — a mid-stream disconnect loses in-flight deltas; the completed
 * turn still lands in history). Phase 2b adds `id:` + `Last-Event-ID` replay.
 */
class WebStreamHandle implements StreamHandle {
  readonly #registry: WebStreamRegistry;
  readonly #platformAddress: string;
  readonly #onClose: () => void;
  readonly #onFirstFinish: () => boolean;

  constructor(
    registry: WebStreamRegistry,
    platformAddress: string,
    onClose: () => void,
    onFirstFinish: () => boolean,
  ) {
    this.#registry = registry;
    this.#platformAddress = platformAddress;
    this.#onClose = onClose;
    this.#onFirstFinish = onFirstFinish;
  }

  async push(event: StreamEvent): Promise<void> {
    this.#registry.send(this.#platformAddress, { data: JSON.stringify(event) });
  }

  async finish(): Promise<void> {
    // Inngest re-invokes handle-message at every step boundary and each
    // invocation calls `delivery.finish()`, so after the first real finish
    // frees the dedup slot, every later boundary opens a fresh handle and
    // finishes it again. Only the run's FIRST finish per tab emits the
    // turn-end lifecycle frame — a later one is a replay phantom by
    // definition, and its frame would reset the tab's running indicator
    // mid-queue (the client nulls its streaming id on every turn-end).
    // Keying on first-finish rather than on whether this handle pushed
    // keeps the frame for a turn that legitimately streamed nothing, and
    // for a cross-process retry whose pushes all replayed from the step
    // cache. `abort` stays unconditional: a failure must always reset the
    // tab's UI.
    if (this.#onFirstFinish()) {
      this.#registry.send(this.#platformAddress, { event: TURN_END, data: "{}" });
    }
    this.#onClose();
  }

  async abort(error: string): Promise<void> {
    this.#registry.send(this.#platformAddress, {
      event: TURN_ABORT,
      data: JSON.stringify({ message: error }),
    });
    this.#onClose();
  }
}

/**
 * SSE streaming adapter for the web channel. A pure `StreamingAdapter` — web has
 * no batch path, so the DeliveryRouter's `notifyConversation` skips it via the
 * `hasDeliver` guard (web push-on-schedule is a separate, deferred concern).
 *
 * Dedup is keyed by `(runId, platformAddress)`: one conversation fans out to
 * every tab watching it (each a `receive:"all"` session on its own address), so
 * — unlike Telegram's one-chat-per-run — keying on `runId` alone would hand a
 * second tab the first tab's handle. On an Inngest retry the same
 * `(runId, address)` pair reopens and returns the existing handle. The `:`
 * separator keeps the concatenation injective — a server-minted `runId` never
 * contains one, so no two distinct pairs collide on the same key (the key is
 * only ever compared for Map equality; it's never split back apart).
 */
class WebUiAdapter implements StreamingAdapter {
  readonly #registry: WebStreamRegistry;
  readonly #active = new Map<string, StreamHandle>();
  /**
   * `(runId, address)` keys whose turn-end frame has been sent. Consulted by
   * the handle's first-finish gate. Insertion-ordered with a hard cap so the
   * per-turn entries can't grow without bound in a long-lived process —
   * evicting the oldest is safe because a key only matters while its run's
   * trailing boundary invocations are still finishing, i.e. seconds.
   */
  readonly #finished = new Set<string>();

  constructor(registry: WebStreamRegistry) {
    this.#registry = registry;
  }

  async openStream(platformAddress: string, runId: string): Promise<StreamHandle> {
    const key = `${runId}:${platformAddress}`;
    const existing = this.#active.get(key);
    if (existing) return existing;
    const handle = new WebStreamHandle(
      this.#registry,
      platformAddress,
      () => this.#active.delete(key),
      () => this.#markFinished(key),
    );
    this.#active.set(key, handle);
    return handle;
  }

  /** Record the run's finish for this tab; true only the first time. */
  #markFinished(key: string): boolean {
    if (this.#finished.has(key)) return false;
    this.#finished.add(key);
    if (this.#finished.size > FINISHED_RUNS_CAP) {
      const oldest = this.#finished.values().next().value;
      if (oldest !== undefined) this.#finished.delete(oldest);
    }
    return true;
  }

  async stop(): Promise<void> {
    this.#active.clear();
    this.#finished.clear();
  }
}

/**
 * Web channel adapter module. The streaming registry is the bridge to the SSE
 * routes and is injected at boot; its absence is a wiring bug, so setup fails
 * loud rather than degrading to a no-op.
 */
const web: AdapterModule = {
  channelType: "web",
  setup: async (deps) => {
    if (!deps.webStream) {
      throw new Error("web adapter requires a WebStreamRegistry (deps.webStream)");
    }
    return { adapter: new WebUiAdapter(deps.webStream), functions: [] };
  },
};

export default web;
export { WebUiAdapter };
