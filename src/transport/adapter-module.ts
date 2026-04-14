import type { JsonValue } from "type-fest";
import type { AttachmentStore } from "./attachment-store.js";
import type { Transport } from "./transport.js";
import type { Adapter } from "./types.js";

/**
 * Dependencies available to adapter setup.
 */
export interface AdapterDeps {
  channelId: string;
  credentials: JsonValue;
  transport: Transport;
  /** Binary storage — adapters may download generated attachments for outbound delivery. */
  attachments: AttachmentStore;
}

/**
 * Result of setting up an adapter for a channel.
 */
export interface AdapterSetupResult {
  /** Running adapter instance (deliver + stop). */
  adapter: Adapter;
  /** Inngest functions the adapter needs registered (e.g., event-driven inbound). */
  // biome-ignore lint/suspicious/noExplicitAny: Inngest function types vary by trigger
  functions: any[];
}

/**
 * Outbound image — bytes ready for platform delivery.
 *
 * The orchestrator resolves AttachmentStore paths to Buffers before passing
 * to delivery (same pattern as inbound ImageRef resolution). Adapters receive
 * bytes, not paths, so they never need AttachmentStore access in the batch path.
 */
export interface OutboundImage {
  data: Buffer;
  mediaType: string;
}

/**
 * Channel-rendered message — the result of converting canonical markdown
 * to a channel-specific wire format.
 */
export interface RenderedMessage {
  text: string;
  parseMode?: "HTML" | "MarkdownV2";
  /** Images to deliver alongside the text. Adapter decides native representation. */
  images?: readonly OutboundImage[];
}

/**
 * Contract every adapter module must satisfy.
 *
 * The barrel (adapters/index.ts) enforces this via `satisfies`.
 * The registry uses channelType to match DB rows to adapter setup.
 */
export interface AdapterModule {
  channelType: string;
  setup: (deps: AdapterDeps) => Promise<AdapterSetupResult>;
  /** Convert canonical markdown to channel-specific format. Undefined = identity (raw markdown). */
  renderOutput?: (markdown: string) => RenderedMessage;
}
