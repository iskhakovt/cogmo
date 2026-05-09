import { randomUUID } from "node:crypto";
import { GetObjectCommand, NoSuchKey, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

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
   * content, etc.). Defaults to `"inbound"` for backward compatibility.
   */
  upload(data: Buffer, mediaType: string, prefix?: string): Promise<string>;
  download(path: string): Promise<Buffer>;
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
  return {
    async upload(data: Buffer, mediaType: string, prefix = "inbound"): Promise<string> {
      const ext = mediaTypeToExt(mediaType);
      const path = `${prefix}/${randomUUID()}.${ext}`;
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: path,
          Body: data,
          ContentType: mediaType,
        }),
      );
      return path;
    },

    async download(path: string): Promise<Buffer> {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: path }));
        const body = response.Body;
        if (!body) throw new Error(`Empty response for: ${path}`);
        return Buffer.from(await body.transformToByteArray());
      } catch (err) {
        if (err instanceof NoSuchKey) throw new Error(`Attachment not found: ${path}`);
        throw err;
      }
    },
  };
}
