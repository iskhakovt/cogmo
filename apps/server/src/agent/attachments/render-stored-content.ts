/**
 * The one renderer from stored content to sent content
 * (design/prompt-caching.md → One renderer): a ref becomes base64 of its
 * write-once object, or a placeholder naming the file when its row is at or
 * before the attachment cutoff or its object can never be read. Every request
 * that shows a row renders it here, so a row sends the same bytes each time.
 */

import { match } from "ts-pattern";
import type { ContentBlock, Message } from "../../llm/types.js";
import type { AttachmentRef, StoredContent, StoredMessage } from "../stored-content.js";
import type { AttachmentReader } from "./attachment-reader.js";

/**
 * Why a ref renders as a placeholder. `rejected` is an original the provider
 * refused (design/transport/attachments.md → Rejected attachments); its
 * wording is pinned here ahead of the marking that produces it.
 */
type PlaceholderReason = "cutoff" | "unreadable" | "rejected";

/** The name a placeholder shows: the file's, or what it is. */
function refName(ref: AttachmentRef): string {
  return ref.name ?? (ref.type === "image_ref" ? "photo" : "document");
}

function placeholderText(reason: PlaceholderReason, kind: AttachmentRef["type"], name: string) {
  const label = `${kind === "image_ref" ? "Image" : "Document"}: ${name}`;
  return match(reason)
    .with("cutoff", () => `[${label}. Sent earlier and no longer attached.]`)
    .with("unreadable", () => `[${label}. The stored file could not be read.]`)
    .with(
      "rejected",
      () => `[${label}. The model provider refused this file; ask for it another way.]`,
    )
    .exhaustive();
}

/**
 * The renderer's placeholder wording, which the configuration digest covers:
 * rewording a placeholder changes rows a stored head describes, so it opens
 * an epoch.
 */
export const RENDERER_PLACEHOLDERS: string = JSON.stringify(
  (["cutoff", "unreadable", "rejected"] as const).flatMap((reason) =>
    (["image_ref", "document_ref"] as const).map((kind) => placeholderText(reason, kind, "{name}")),
  ),
);

async function renderRef(
  ref: AttachmentRef,
  reader: AttachmentReader,
  beforeCutoff: boolean,
): Promise<ContentBlock> {
  const placeholder = (reason: PlaceholderReason): ContentBlock => ({
    type: "text",
    text: placeholderText(reason, ref.type, refName(ref)),
  });
  if (beforeCutoff) return placeholder("cutoff");
  const read = await reader.readBase64(ref.path);
  if (read.isErr()) return placeholder("unreadable");
  return match(ref)
    .with(
      { type: "image_ref" },
      (image): ContentBlock => ({
        type: "image",
        source: "base64",
        data: read.value,
        mediaType: image.mediaType,
        width: image.width,
        height: image.height,
      }),
    )
    .with(
      { type: "document_ref" },
      (document): ContentBlock => ({
        type: "document",
        source: "base64",
        data: read.value,
        mediaType: document.mediaType,
        name: document.name,
      }),
    )
    .exhaustive();
}

/** A row's content as sent. `beforeCutoff`: the row is at or before the attachment cutoff. */
export async function renderStoredContent(
  content: StoredContent,
  reader: AttachmentReader,
  beforeCutoff: boolean,
): Promise<Message["content"]> {
  if (typeof content === "string") return content;
  return Promise.all(
    content.map((block) =>
      block.type === "image_ref" || block.type === "document_ref"
        ? renderRef(block, reader, beforeCutoff)
        : Promise.resolve(block),
    ),
  );
}

/** Whether the row `id` is at or before `cutoff`; a synthetic entry (`null`) never is. */
export function isAtOrBefore(id: string | null, cutoff: string | null): boolean {
  // UUIDv7 text compares in the order the ids were minted.
  return id !== null && cutoff !== null && id <= cutoff;
}

/**
 * `messages` as sent, positionally aligned with `messageIds`: attachments in
 * rows at or before `cutoff` render as placeholders.
 */
export async function renderStoredMessages(
  messages: ReadonlyArray<StoredMessage>,
  messageIds: ReadonlyArray<string | null>,
  reader: AttachmentReader,
  cutoff: string | null,
): Promise<Message[]> {
  return Promise.all(
    messages.map(
      async (message, i): Promise<Message> => ({
        role: message.role,
        content: await renderStoredContent(
          message.content,
          reader,
          isAtOrBefore(messageIds[i] ?? null, cutoff),
        ),
      }),
    ),
  );
}
