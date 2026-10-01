import type { ContentBlock } from "../../llm/types.js";
import type { AttachmentStore } from "../../transport/attachment-store.js";
import { contentToBlocks } from "../../transport/content.js";
import type { SubstitutedInbound } from "./inbound-batch.js";

/**
 * The turn's inbound as LLM content blocks, image and document refs resolved
 * to base64 (S3 → base64). Voice substitution already happened upstream, so
 * flattening through `contentToBlocks` produces a block stream with text in
 * place of voice — no voice_ref branch needed here.
 *
 * Bare body, on every invocation: the payloads must stay out of step state
 * (design/crash-recovery.md → Adding a new durable boundary).
 */
export async function resolveInboundAttachments(
  attachments: Pick<AttachmentStore, "download">,
  substitutedMessages: ReadonlyArray<SubstitutedInbound>,
): Promise<ContentBlock[]> {
  const blocks = substitutedMessages.flatMap(({ content }) => contentToBlocks(content));
  return Promise.all(
    blocks.map(async (block): Promise<ContentBlock> => {
      if (block.type === "image_ref") {
        const bytes = await attachments.download(block.path);
        return {
          type: "image",
          source: "base64",
          data: bytes.toString("base64"),
          mediaType: block.mediaType,
        };
      }
      if (block.type === "document_ref") {
        const bytes = await attachments.download(block.path);
        return {
          type: "document",
          source: "base64",
          data: bytes.toString("base64"),
          mediaType: block.mediaType,
          ...(block.name && { name: block.name }),
        };
      }
      // voice_ref is substituted to text upstream in substitutedMessages
      // — this branch is unreachable in practice. Keep an explicit
      // mapping rather than a cast so a future code path that bypasses
      // the substitution still produces a sane block instead of
      // crashing the loop's return-type inference.
      if (block.type === "voice_ref") return { type: "text", text: "" };
      return block;
    }),
  );
}
