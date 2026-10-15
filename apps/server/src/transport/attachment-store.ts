import { randomUUID } from "node:crypto";
import { GetObjectCommand, NoSuchKey, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { err, ok, type Result } from "neverthrow";

/**
 * Why an object can never be read: its key is gone, or its bytes don't
 * decrypt. Retrying changes neither.
 */
export type AttachmentUnreadable = { kind: "missing" } | { kind: "undecryptable" };

/**
 * Binary attachment storage — system-facing, not exposed to agent tools.
 *
 * Used by Transport (upload inbound images) and the orchestrator
 * (load images before sending to LLM). Separate from Service.files
 * which is the agent's text workspace.
 */
export interface AttachmentStore {
  /**
   * Upload bytes to storage. The `prefix` partitions the storage path
   * (`inbound/` for platform uploads, `generated/` for agent-generated
   * content, etc.).
   */
  upload(data: Buffer, mediaType: string, prefix: string): Promise<string>;
  /**
   * Write bytes under a caller-chosen key stem, replacing any object there,
   * and return the path: the stem plus the extension the store gives
   * `mediaType`, as `upload` does. A stem derived from durable state (an
   * original's key, a content digest) makes a retried write land on the same
   * object.
   */
  put(stem: string, data: Buffer, mediaType: string): Promise<string>;
  download(path: string): Promise<Buffer>;
  /**
   * The object's bytes, or why it can never be read. A transient failure (the
   * bucket unreachable, a timeout) throws, so a retry reads it.
   */
  read(path: string): Promise<Result<Buffer, AttachmentUnreadable>>;
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "application/octet-stream": "bin",
};

export function mediaTypeToExt(mediaType: string): string {
  return MIME_EXT[mediaType] ?? mediaType.split("/")[1]?.split("+")[0] ?? "bin";
}

/**
 * S3-backed attachment store.
 */
export function createAttachmentStore(client: S3Client, bucket: string): AttachmentStore {
  async function read(path: string): Promise<Result<Buffer, AttachmentUnreadable>> {
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: path }));
      const body = response.Body;
      if (!body) throw new Error(`Empty response for: ${path}`);
      return ok(Buffer.from(await body.transformToByteArray()));
    } catch (e) {
      if (e instanceof NoSuchKey) return err({ kind: "missing" });
      throw e;
    }
  }

  async function put(stem: string, data: Buffer, mediaType: string): Promise<string> {
    const path = `${stem}.${mediaTypeToExt(mediaType)}`;
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: path, Body: data, ContentType: mediaType }),
    );
    return path;
  }

  return {
    async upload(data: Buffer, mediaType: string, prefix: string): Promise<string> {
      return put(`${prefix}/${randomUUID()}`, data, mediaType);
    },

    put,

    async download(path: string): Promise<Buffer> {
      const bytes = await read(path);
      if (bytes.isErr()) throw new Error(`Attachment not found: ${path}`);
      return bytes.value;
    },

    read,
  };
}
