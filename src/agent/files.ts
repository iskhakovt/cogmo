import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { decryptBuffer, encryptBuffer, isEncrypted } from "../secrets/blob-envelope.js";
import type { FileEntry, Service } from "./service.js";

/** Prompt guidance for the files Service namespace. */
export const FILES_PROMPT_GUIDANCE =
  "You have a persistent file workspace. Use it proactively — save meeting notes, draft emails, keep project summaries. Files persist across conversations.";

/**
 * Optional client-side encryption. When set, every `write` AES-256-GCM
 * encrypts the UTF-8 bytes before upload, sets `Content-Type:
 * application/octet-stream`, and stores the v1 envelope from
 * `secrets/blob-envelope.ts`. Reads dispatch on the magic prefix —
 * encrypted blobs decrypt strictly, anything else (pre-flag plaintext
 * files) is decoded as UTF-8 directly. Object keys are NOT encrypted —
 * matches the AWS S3 Encryption Client convention; if you need to
 * keep file names secret, choose non-revealing names. See the
 * `S3_CLIENT_ENCRYPT` env-var doc for the full trade-off.
 */
export interface FileServiceEncryption {
  key: Uint8Array;
}

/**
 * Create an S3-backed file service.
 *
 * All file operations are scoped to a single bucket.
 * Works with any S3-compatible API (AWS S3, MinIO, R2, etc.).
 */
export function createFileService(
  client: S3Client,
  bucket: string,
  encryption?: FileServiceEncryption,
): Service["files"] {
  return {
    async read(path: string): Promise<string> {
      try {
        const command = new GetObjectCommand({ Bucket: bucket, Key: path });
        const response = await client.send(command);
        const body = response.Body;
        if (!body) throw new Error(`Empty response for: ${path}`);
        if (encryption) {
          const blob = Buffer.from(await body.transformToByteArray());
          const plaintext = isEncrypted(blob) ? decryptBuffer(blob, encryption.key) : blob;
          return plaintext.toString("utf-8");
        }
        return await body.transformToString("utf-8");
      } catch (err) {
        if (err instanceof NoSuchKey) throw new Error(`File not found: ${path}`);
        throw err;
      }
    },

    async write(path: string, content: string): Promise<void> {
      const body = encryption
        ? encryptBuffer(Buffer.from(content, "utf-8"), encryption.key)
        : content;
      const contentType = encryption ? "application/octet-stream" : "text/plain; charset=utf-8";
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: path,
        Body: body,
        ContentType: contentType,
      });
      await client.send(command);
    },

    // TODO: handle pagination for >1000 files (ListObjectsV2 returns max 1000 per call)
    async list(prefix?: string): Promise<FileEntry[]> {
      const command = new ListObjectsV2Command({
        Bucket: bucket,
        ...(prefix ? { Prefix: prefix } : {}),
      });
      const response = await client.send(command);

      return (response.Contents ?? []).map((obj) => ({
        path: obj.Key ?? "",
        size: obj.Size ?? 0,
        lastModified: obj.LastModified ?? new Date(0),
      }));
    },
  };
}
