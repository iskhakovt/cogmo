import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { FileEntry, Service } from "./service.js";

/**
 * Create an S3-backed file service.
 *
 * All file operations are scoped to a single bucket.
 * Works with any S3-compatible API (AWS S3, MinIO, R2, etc.).
 */
export function createFileService(client: S3Client, bucket: string): Service["files"] {
  return {
    async read(path: string): Promise<string> {
      const command = new GetObjectCommand({ Bucket: bucket, Key: path });
      const response = await client.send(command);
      if (!response.Body) {
        throw new Error(`File not found: ${path}`);
      }
      return response.Body.transformToString("utf-8");
    },

    async write(path: string, content: string): Promise<void> {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: path,
        Body: content,
        ContentType: "text/plain; charset=utf-8",
      });
      await client.send(command);
    },

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
