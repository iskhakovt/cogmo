import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { decryptBuffer, encryptBuffer, isEncrypted } from "../secrets/blob-envelope.js";
import type { FileEntry, Service } from "./service.js";

/**
 * Cap on bytes returned by `read`. Files larger than this come back
 * truncated with a marker, and the cached read entry is flagged as
 * a partial view — `write` and `edit` then refuse the file until the
 * caller has re-read it in full. The agent's context budget can't
 * absorb arbitrary file sizes, and a partial view of a file is not
 * a safe basis for an overwrite.
 */
const MAX_READ_LENGTH = 100_000;

/** Prompt guidance for the files Service namespace. */
export const FILES_PROMPT_GUIDANCE =
  "You have a persistent file workspace. Use it proactively — save meeting notes, draft emails, keep project summaries. Files persist across conversations. Read a file before overwriting or editing it; reach for `edit_file` rather than rewriting whole files.";

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

interface ReadEntry {
  content: string;
  lastModified: Date;
  isPartialView: boolean;
}

interface FetchResult {
  content: string;
  lastModified: Date;
}

/**
 * Create an S3-backed file service.
 *
 * All file operations are scoped to a single bucket and a single
 * conversation turn — the service instance keeps a per-path read
 * cache that gates overwrites and edits. The cache holds the bytes
 * the caller last saw plus the S3 `LastModified` at fetch time. A
 * later `write` or `edit` refuses to touch a path that has not been
 * read in this instance, refuses if the prior read was truncated,
 * and on mtime drift verifies the on-disk bytes haven't actually
 * changed before proceeding.
 *
 * Works with any S3-compatible API (AWS S3, MinIO, R2, etc.).
 */
export function createFileService(
  client: S3Client,
  bucket: string,
  encryption?: FileServiceEncryption,
): Service["files"] {
  const readState = new Map<string, ReadEntry>();

  async function fetchObject(path: string): Promise<FetchResult> {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: path }));
    const body = response.Body;
    if (!body) throw new Error(`Empty response for: ${path}`);
    const lastModified = response.LastModified ?? new Date();
    let content: string;
    if (encryption) {
      const blob = Buffer.from(await body.transformToByteArray());
      const plaintext = isEncrypted(blob) ? decryptBuffer(blob, encryption.key) : blob;
      content = plaintext.toString("utf-8");
    } else {
      content = await body.transformToString("utf-8");
    }
    return { content, lastModified };
  }

  async function headExisting(path: string): Promise<Date | null> {
    try {
      const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: path }));
      return response.LastModified ?? new Date();
    } catch (err) {
      if (err instanceof NotFound || err instanceof NoSuchKey) return null;
      throw err;
    }
  }

  /**
   * Confirm the bytes on disk still match what the caller has seen.
   *
   * Takes the current HEAD as an argument so the caller can capture
   * it once and reuse it (overwrite needs to know existence; edit
   * uses it for staleness). Three rejection paths:
   *   - Caller never read this path in this instance.
   *   - Caller's last read was truncated (partial view).
   *   - mtime advanced AND the on-disk bytes diverged from the cache.
   *
   * On a benign mtime bump (mtime advanced, content unchanged — e.g.
   * a re-upload of identical bytes), the cached timestamp is refreshed
   * and the operation proceeds. A `null` head means the file vanished
   * externally; the operation is allowed to proceed and (re-)create it.
   */
  async function assertFresh(
    path: string,
    kind: "edit" | "overwrite",
    head: Date | null,
  ): Promise<void> {
    const entry = readState.get(path);
    if (!entry) {
      throw new Error(
        `Cannot ${kind} ${path}: read the file first so you act on its current contents.`,
      );
    }
    if (entry.isPartialView) {
      throw new Error(
        `Cannot ${kind} ${path}: the last read returned a truncated view (file is larger than ${MAX_READ_LENGTH} bytes).`,
      );
    }
    if (!head) return;
    if (head.getTime() <= entry.lastModified.getTime()) return;
    // mtime advanced — verify content actually changed before failing.
    const fresh = await fetchObject(path);
    if (fresh.content !== entry.content) {
      throw new Error(
        `Cannot ${kind} ${path}: the file was modified since you read it. Re-read it and try again.`,
      );
    }
    entry.lastModified = fresh.lastModified;
  }

  async function putObject(path: string, content: string): Promise<void> {
    const body = encryption
      ? encryptBuffer(Buffer.from(content, "utf-8"), encryption.key)
      : content;
    const contentType = encryption ? "application/octet-stream" : "text/plain; charset=utf-8";
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: path, Body: body, ContentType: contentType }),
    );
  }

  return {
    async read(path: string): Promise<string> {
      let fetched: FetchResult;
      try {
        fetched = await fetchObject(path);
      } catch (err) {
        if (err instanceof NoSuchKey) throw new Error(`File not found: ${path}`);
        throw err;
      }
      const truncated = fetched.content.length > MAX_READ_LENGTH;
      readState.set(path, {
        content: fetched.content,
        lastModified: fetched.lastModified,
        isPartialView: truncated,
      });
      if (truncated) {
        return `${fetched.content.slice(0, MAX_READ_LENGTH)}\n\n[Content truncated at ${MAX_READ_LENGTH} characters. Edits and overwrites are blocked until the file is read in full.]`;
      }
      return fetched.content;
    },

    async write(path: string, content: string): Promise<void> {
      const head = await headExisting(path);
      if (head) await assertFresh(path, "overwrite", head);
      await putObject(path, content);
      // Reflect the write in the read cache — the caller now knows the current bytes.
      readState.set(path, {
        content,
        lastModified: new Date(),
        isPartialView: false,
      });
    },

    async edit(
      path: string,
      oldString: string,
      newString: string,
      opts?: { replaceAll?: boolean },
    ): Promise<void> {
      const replaceAll = opts?.replaceAll ?? false;
      const head = await headExisting(path);
      await assertFresh(path, "edit", head);
      // assertFresh guarantees a cached entry for `path`.
      const entry = readState.get(path);
      if (!entry) throw new Error(`Internal: read cache missing for ${path} after freshness check`);
      const current = entry.content;
      if (oldString === newString) {
        throw new Error(`Cannot edit ${path}: old_string and new_string are identical.`);
      }
      if (!current.includes(oldString)) {
        throw new Error(`Cannot edit ${path}: old_string not found.`);
      }
      let next: string;
      if (replaceAll) {
        next = current.replaceAll(oldString, newString);
      } else {
        const occurrences = current.split(oldString).length - 1;
        if (occurrences > 1) {
          throw new Error(
            `Cannot edit ${path}: old_string appears ${occurrences} times. Pass replace_all to replace every occurrence, or extend old_string with surrounding context to make it unique.`,
          );
        }
        next = current.replace(oldString, newString);
      }
      await putObject(path, next);
      readState.set(path, {
        content: next,
        lastModified: new Date(),
        isPartialView: false,
      });
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
