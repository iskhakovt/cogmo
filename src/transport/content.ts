import { z } from "zod";
import type { ContentBlock } from "../llm/types.js";

/**
 * Inbound block shapes — what adapters pack into `inbound_messages.content`.
 * `text` is a plain text run; `image` carries either an S3 path (after
 * `uploadAttachment`) or inline base64/url data.
 *
 * The two image variants share `type: "image"`, so they live in a single
 * object schema with `path` and `data` both optional and a `refine` that
 * requires at least one. `discriminatedUnion` can't represent overlapping
 * literals, and the alternative — splitting into two object schemas in a
 * `z.union` — would deserialise ambiguously when both keys are present.
 */
const InboundTextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const InboundImageBlockSchema = z
  .object({
    type: z.literal("image"),
    path: z.string().optional(),
    data: z.string().optional(),
    mediaType: z.string(),
    source: z.enum(["base64", "url"]).optional(),
  })
  .refine((v) => v.path != null || v.data != null, {
    message: "image block requires either path or data",
  });

const InboundDocumentBlockSchema = z
  .object({
    type: z.literal("document"),
    path: z.string().optional(),
    data: z.string().optional(),
    mediaType: z.string(),
    source: z.enum(["base64", "url"]).optional(),
    name: z.string().optional(),
  })
  .refine((v) => v.path != null || v.data != null, {
    message: "document block requires either path or data",
  });

const InboundBlockSchema = z.union([
  InboundTextBlockSchema,
  InboundImageBlockSchema,
  InboundDocumentBlockSchema,
]);

/**
 * Inbound message content as persisted in `inbound_messages.content`.
 * A bare string is the wire-cheap form for text-only messages; the array
 * form is used when an adapter packages text + attachments together.
 */
export const InboundContentSchema = z.union([z.string(), z.array(InboundBlockSchema)]);
export type InboundContent = z.infer<typeof InboundContentSchema>;

export function contentToText(content: InboundContent): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** Inbound image reference — S3 path, needs resolution before sending to LLM. */
export interface ImageRef {
  type: "image_ref";
  path: string;
  mediaType: string;
}

/** Inbound document reference — S3 path, needs resolution before sending to LLM. */
export interface DocumentRef {
  type: "document_ref";
  path: string;
  mediaType: string;
  name?: string;
}

export type InboundBlock = ContentBlock | ImageRef | DocumentRef;

/**
 * Convert inbound message content to blocks.
 *
 * Returns a mix of ContentBlock (ready for LLM), ImageRef and DocumentRef
 * (need S3 resolution). The orchestrator resolves *Refs before passing to
 * the agent loop.
 */
export function contentToBlocks(content: InboundContent): InboundBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  return content.flatMap<InboundBlock>((block) => {
    if (block.type === "text") {
      return [{ type: "text", text: block.text }];
    }
    if (block.type === "image") {
      if (block.path != null) {
        return [{ type: "image_ref", path: block.path, mediaType: block.mediaType }];
      }
      if (block.data != null) {
        return [
          {
            type: "image",
            source: block.source ?? "base64",
            data: block.data,
            mediaType: block.mediaType,
          },
        ];
      }
      return [];
    }
    // document
    if (block.path != null) {
      return [
        {
          type: "document_ref",
          path: block.path,
          mediaType: block.mediaType,
          ...(block.name && { name: block.name }),
        },
      ];
    }
    if (block.data != null) {
      return [
        {
          type: "document",
          source: block.source ?? "base64",
          data: block.data,
          mediaType: block.mediaType,
          ...(block.name && { name: block.name }),
        },
      ];
    }
    return [];
  });
}
