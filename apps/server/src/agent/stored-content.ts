/**
 * The shape `messages.content` stores (design/prompt-caching.md → Stored
 * shapes). It is the canonical `ContentBlock` without the base64 `image` and
 * `document` blocks, plus `image_ref` and `document_ref`, which name an
 * attachment's write-once object instead of carrying its bytes. The renderer
 * (`render-stored-content.ts`) is the only conversion to a sent `Message`, so
 * adapters never see a ref.
 */

import { z } from "zod";
import {
  type ContentBlock,
  type Message,
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolResultBlockSchema,
  ToolUseBlockSchema,
} from "../llm/types.js";
import type { MessageRole } from "./store/schema.js";

const OriginalSchema = z.object({
  path: z.string().min(1),
  mediaType: z.string().min(1),
});

/**
 * A normalized image: a JPEG or PNG of at most 2000 px a side. `bytes` is the
 * object's size, so the attachment budget and the OpenAI-compatible count run
 * without reading it. `original` is the file as sent, which the model never
 * sees.
 */
const ImageRefBlockSchema = z.object({
  type: z.literal("image_ref"),
  path: z.string().min(1),
  mediaType: z.enum(["image/jpeg", "image/png"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  name: z.string().optional(),
  original: OriginalSchema,
});

/** A document as sent: a PDF, or a text-like file, `original` set when the sent copy is truncated. */
const DocumentRefBlockSchema = z.object({
  type: z.literal("document_ref"),
  path: z.string().min(1),
  mediaType: z.string().min(1),
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  original: OriginalSchema.optional(),
});

export const StoredContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ThinkingBlockSchema,
  ImageRefBlockSchema,
  DocumentRefBlockSchema,
]);

export type ImageRefBlock = z.infer<typeof ImageRefBlockSchema>;
export type DocumentRefBlock = z.infer<typeof DocumentRefBlockSchema>;
export type StoredContentBlock = z.infer<typeof StoredContentBlockSchema>;
export type AttachmentRef = ImageRefBlock | DocumentRefBlock;

/** `messages.content`: a string, or stored blocks. */
export const StoredMessageContentSchema = z.union([z.string(), z.array(StoredContentBlockSchema)]);
export type StoredContent = z.infer<typeof StoredMessageContentSchema>;

export interface StoredMessage {
  role: MessageRole;
  content: StoredContent;
}

/** A sent block that `messages.content` stores as it is: every one but `image` and `document`. */
export type StorableBlock = Exclude<ContentBlock, { type: "image" | "document" }>;

/** Whether `block` is an attachment reference. */
export function isAttachmentRef(block: StoredContentBlock): block is AttachmentRef {
  return block.type === "image_ref" || block.type === "document_ref";
}

/** A ref's size as base64, which is what a request carries. */
export function base64Bytes(ref: AttachmentRef): number {
  return 4 * Math.ceil(ref.bytes / 3);
}

/**
 * `content` as `messages.content` stores it. A message the agent loop appends
 * carries no base64 attachment: those reach a request only by rendering a
 * stored ref, so one here is a bug.
 */
export function toStoredContent(content: string | ReadonlyArray<ContentBlock>): StoredContent {
  if (typeof content === "string") return content;
  return content.map((block): StorableBlock => {
    if (block.type === "image" || block.type === "document") {
      throw new Error(`a ${block.type} block can't be stored; store a ref instead`);
    }
    return block;
  });
}

/** `message` as `messages` stores it; see {@link toStoredContent}. */
export function toStoredMessage(message: Message): StoredMessage {
  return { role: message.role, content: toStoredContent(message.content) };
}
