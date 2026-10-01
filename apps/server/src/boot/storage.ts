/**
 * S3-compatible object storage (RustFS locally, AWS S3 / R2 in production):
 * the client, and the attachment store and file service on top of it.
 */

import { S3Client } from "@aws-sdk/client-s3";
import { createFileService } from "../agent/files.js";
import type { Service } from "../agent/service.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { deriveMasterKey, parseMasterKey } from "../secrets/encryption.js";
import type { AttachmentStore } from "../transport/attachment-store.js";
import { createAttachmentStore } from "../transport/attachment-store.js";
import { wrapAttachmentStoreWithEncryption } from "../transport/encrypted-attachment-store.js";
import { checkS3KeyPair } from "./checks.js";

export interface ObjectStorage {
  s3Client: S3Client;
  attachmentStore: AttachmentStore;
  fileService: Service["files"];
  /** Non-null when `S3_CLIENT_ENCRYPT=true`. Same key feeds files + attachments. */
  attachmentEncryptionKey: Uint8Array | null;
}

export function createObjectStorage(masterKey: string): ObjectStorage {
  checkS3KeyPair(env.S3_ACCESS_KEY, env.S3_SECRET_KEY);
  const s3Client = new S3Client({
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    region: env.S3_REGION,
    ...(env.S3_ACCESS_KEY && env.S3_SECRET_KEY
      ? { credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } }
      : {}),
  });
  // Optional client-side encryption — when enabled, attachment bodies AND
  // workspace file bodies are AES-256-GCM-encrypted before upload using
  // a key derived from `COGMO_MASTER_KEY` (already validated above).
  // Storage provider only ever sees ciphertext. Object keys remain
  // plaintext (matches the AWS S3 Encryption Client convention — if
  // file names need to stay secret, choose non-revealing names). See
  // the `S3_CLIENT_ENCRYPT` env-var doc for the full trade-off.
  const attachmentEncryptionKey = env.S3_CLIENT_ENCRYPT
    ? deriveMasterKey(parseMasterKey(masterKey), "cogmo/s3-objects/v1")
    : null;
  const fileService = createFileService(
    s3Client,
    env.S3_BUCKET,
    attachmentEncryptionKey ? { key: attachmentEncryptionKey } : undefined,
  );
  const baseAttachmentStore = createAttachmentStore(s3Client, env.S3_BUCKET);
  const attachmentStore = attachmentEncryptionKey
    ? wrapAttachmentStoreWithEncryption(baseAttachmentStore, attachmentEncryptionKey)
    : baseAttachmentStore;
  if (env.S3_CLIENT_ENCRYPT) {
    logger.info(
      "S3_CLIENT_ENCRYPT=true — attachments and workspace files encrypted client-side with AES-256-GCM",
    );
  }
  return { s3Client, attachmentStore, fileService, attachmentEncryptionKey };
}
