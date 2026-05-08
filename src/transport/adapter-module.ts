import type { Inngest } from "inngest";
import type { JsonValue } from "type-fest";
import type { CodingStore } from "../agent/coding/store/index.js";
import type { CodingStreamingRegistry } from "../agent/coding/streaming-registry.js";
import type { Transactor } from "../db/index.js";
import type { SkillStore } from "../skills/store/index.js";
import type { AttachmentStore } from "./attachment-store.js";
import type { TransportStore } from "./store/index.js";
import type { Transport } from "./transport.js";
import type { Adapter } from "./types.js";

/**
 * Coding-progress wiring — optional adapter dependency. Adapters that
 * surface coding tasks to the user (today: Telegram) use this to
 * register an Inngest function that subscribes to the streaming
 * registry and edits a per-task progress message in place. Adapters
 * that don't show coding output (Direct CLI) ignore the field.
 */
export interface CodingProgressDeps {
  inngest: Inngest;
  runInTx: Transactor;
  codingStore: CodingStore;
  transportStore: TransportStore;
  streamingRegistry: CodingStreamingRegistry;
}

/**
 * Skills-approval wiring — adapters that show approve-tier deploy keyboards
 * (today: Telegram) use this to register an Inngest function listening on
 * `skills/deploy/approval-requested`. Posts the inline keyboard into the
 * originating conversation's active session. Adapters without skills UX
 * leave it undefined.
 */
export interface SkillsApprovalDeps {
  inngest: Inngest;
  runInTx: Transactor;
  skillStore: SkillStore;
  transportStore: TransportStore;
}

/**
 * Dependencies available to adapter setup.
 */
export interface AdapterDeps {
  channelId: string;
  credentials: JsonValue;
  transport: Transport;
  /** Binary storage — adapters may download generated attachments for outbound delivery. */
  attachments: AttachmentStore;
  /** Optional — present only when the sandbox module is initialized. */
  codingProgress?: CodingProgressDeps;
  /** Optional — present only when the skills module is wired. */
  skillsApproval?: SkillsApprovalDeps;
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
 * Outbound document — bytes ready for platform delivery as a file attachment.
 *
 * Same resolve-then-deliver pattern as `OutboundImage`. `name` becomes the
 * filename the user sees in the channel UI.
 */
export interface OutboundDocument {
  data: Buffer;
  mediaType: string;
  name: string;
}

/**
 * Outbound voice clip — bytes ready for platform delivery as a voice message.
 * Telegram requires OGG/Opus for the voice-bubble UI; other formats fall
 * back to file delivery.
 */
export interface OutboundVoice {
  audio: Buffer;
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
  /** Documents to deliver alongside the text. Adapter decides native representation. */
  documents?: readonly OutboundDocument[];
}

/**
 * Type guard distinguishing a `RenderedMessage` from raw `JsonValue` content.
 *
 * `parseMode` and `images` are both optional — checking for `text` is the
 * only reliable structural discriminator. Adapters use this in `deliver()`
 * to decide between rendering paths without unsafe `as` casts.
 */
export function isRenderedMessage(content: unknown): content is RenderedMessage {
  return (
    typeof content === "object" &&
    content !== null &&
    "text" in content &&
    typeof (content as { text: unknown }).text === "string"
  );
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
