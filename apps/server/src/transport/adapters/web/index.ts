import type { StreamEvent } from "../../../llm/types.js";
import type { AdapterModule } from "../../adapter-module.js";
import type { StreamHandle, StreamingAdapter } from "../../types.js";
import type { WebStreamRegistry } from "./stream-registry.js";

/** SSE `event:` names for the non-data lifecycle frames (stream events use the default event). */
const TURN_END = "turn-end";
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

  constructor(registry: WebStreamRegistry, platformAddress: string, onClose: () => void) {
    this.#registry = registry;
    this.#platformAddress = platformAddress;
    this.#onClose = onClose;
  }

  async push(event: StreamEvent): Promise<void> {
    this.#registry.send(this.#platformAddress, { data: JSON.stringify(event) });
  }

  async finish(): Promise<void> {
    this.#registry.send(this.#platformAddress, { event: TURN_END, data: "{}" });
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
 * `(runId, address)` pair reopens and returns the existing handle. The key
 * separator is `:` — a server-minted `runId` never contains one, so the split
 * point is unambiguous regardless of the tab address.
 */
class WebUiAdapter implements StreamingAdapter {
  readonly #registry: WebStreamRegistry;
  readonly #active = new Map<string, StreamHandle>();

  constructor(registry: WebStreamRegistry) {
    this.#registry = registry;
  }

  async openStream(platformAddress: string, runId: string): Promise<StreamHandle> {
    const key = `${runId}:${platformAddress}`;
    const existing = this.#active.get(key);
    if (existing) return existing;
    const handle = new WebStreamHandle(this.#registry, platformAddress, () =>
      this.#active.delete(key),
    );
    this.#active.set(key, handle);
    return handle;
  }

  async stop(): Promise<void> {
    this.#active.clear();
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
