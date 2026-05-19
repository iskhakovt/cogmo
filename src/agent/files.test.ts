import {
  GetObjectCommand,
  type GetObjectCommandInput,
  HeadObjectCommand,
  type HeadObjectCommandInput,
  ListObjectsV2Command,
  type ListObjectsV2CommandInput,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { encryptBuffer, isEncrypted } from "../secrets/blob-envelope.js";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../secrets/encryption.js";
import { createFileService } from "./files.js";

type S3Command = HeadObjectCommand | GetObjectCommand | PutObjectCommand | ListObjectsV2Command;

type CommandLog =
  | { kind: "head"; input: HeadObjectCommandInput }
  | { kind: "get"; input: GetObjectCommandInput }
  | { kind: "put"; input: PutObjectCommandInput }
  | { kind: "list"; input: ListObjectsV2CommandInput };

/**
 * Subset of the SDK's response shapes that `createFileService` actually
 * reads. Decoupled from the SDK's union types — the production code
 * only touches `Body.transformTo*` and `LastModified`, so a structural
 * stub avoids having to fabricate full ReadableStream + SdkStreamMixin
 * conformance in tests.
 */
interface StreamLike {
  transformToString?: (encoding?: string) => Promise<string>;
  transformToByteArray?: () => Promise<Uint8Array>;
}
interface GetResponse {
  Body?: StreamLike;
  LastModified?: Date;
}
interface HeadResponse {
  LastModified?: Date;
}
interface PutResponse {
  ETag?: string;
}
interface ListResponse {
  Contents?: ReadonlyArray<{ Key?: string; Size?: number; LastModified?: Date }>;
}

interface Routes {
  head?: (input: HeadObjectCommandInput) => HeadResponse;
  get?: (input: GetObjectCommandInput) => GetResponse;
  put?: (input: PutObjectCommandInput) => PutResponse;
  list?: (input: ListObjectsV2CommandInput) => ListResponse;
}

/**
 * Build a fake S3Client that dispatches by command class to per-kind
 * handlers and records every call. Default `head` rejects with
 * `NotFound`, modelling a fresh bucket; default `get` rejects with
 * `NoSuchKey`; default `put` accepts with `{}`; default `list`
 * returns no contents.
 */
function s3Mock(routes: Routes = {}) {
  const calls: CommandLog[] = [];
  const send = vi.fn(async (cmd: S3Command) => {
    if (cmd instanceof HeadObjectCommand) {
      calls.push({ kind: "head", input: cmd.input });
      if (!routes.head) throw new NotFound({ $metadata: {}, message: "" });
      return await routes.head(cmd.input);
    }
    if (cmd instanceof GetObjectCommand) {
      calls.push({ kind: "get", input: cmd.input });
      if (!routes.get) throw new NoSuchKey({ $metadata: {}, message: "" });
      return await routes.get(cmd.input);
    }
    if (cmd instanceof PutObjectCommand) {
      calls.push({ kind: "put", input: cmd.input });
      if (!routes.put) return {};
      return await routes.put(cmd.input);
    }
    if (cmd instanceof ListObjectsV2Command) {
      calls.push({ kind: "list", input: cmd.input });
      if (!routes.list) return { Contents: [] };
      return await routes.list(cmd.input);
    }
    // S3Command is the union of the four classes above — this branch is unreachable.
    throw new Error("Unhandled S3 command");
  });
  const client = { send, destroy: vi.fn() } as never;
  return { client, send, calls };
}

function body(content: string): StreamLike {
  return { transformToString: async () => content };
}

function bytesBody(bytes: Uint8Array): StreamLike {
  return { transformToByteArray: async () => bytes };
}

function testKey(): Uint8Array {
  return deriveMasterKey(parseMasterKey(generateMasterKey()), "cogmo/s3-objects/v1");
}

const T0 = new Date("2026-05-19T10:00:00Z");
const T1 = new Date("2026-05-19T11:00:00Z");

describe("createFileService.read", () => {
  it("returns file content from S3 GET", async () => {
    const { client, calls } = s3Mock({
      get: () => ({ Body: body("hello world"), LastModified: T0 }),
    });
    const files = createFileService(client, "bucket");

    const result = await files.read("notes/test.md");

    expect(result).toBe("hello world");
    expect(calls).toEqual([{ kind: "get", input: { Bucket: "bucket", Key: "notes/test.md" } }]);
  });

  it("throws 'File not found' on NoSuchKey", async () => {
    const { client } = s3Mock();
    const files = createFileService(client, "bucket");

    await expect(files.read("missing.txt")).rejects.toThrow("File not found: missing.txt");
  });

  it("re-throws non-NoSuchKey errors from GET", async () => {
    const { client } = s3Mock({
      get: () => {
        throw new Error("network error");
      },
    });
    const files = createFileService(client, "bucket");

    await expect(files.read("f")).rejects.toThrow("network error");
  });

  it("re-throws non-NotFound errors from HEAD (via write existence check)", async () => {
    const { client } = s3Mock({
      head: () => {
        throw new Error("head exploded");
      },
    });
    const files = createFileService(client, "bucket");

    await expect(files.write("f.md", "x")).rejects.toThrow("head exploded");
  });

  it("truncates oversized content and appends a marker", async () => {
    const huge = "x".repeat(150_000);
    const { client } = s3Mock({ get: () => ({ Body: body(huge), LastModified: T0 }) });
    const files = createFileService(client, "bucket");

    const result = await files.read("big.txt");

    expect(result).toContain("[Content truncated");
    expect(result.length).toBeLessThan(huge.length);
  });
});

describe("createFileService.write", () => {
  it("creates a new file without requiring a prior read", async () => {
    // HEAD returns NotFound by default, so write skips the freshness check.
    const { client, calls } = s3Mock();
    const files = createFileService(client, "bucket");

    await files.write("notes/new.md", "fresh content");

    expect(calls.map((c) => c.kind)).toEqual(["head", "put"]);
    const put = calls[1];
    expect(put?.input).toMatchObject({
      Bucket: "bucket",
      Key: "notes/new.md",
      Body: "fresh content",
      ContentType: "text/plain; charset=utf-8",
    });
  });

  it("rejects overwrite of an existing file when it was never read", async () => {
    const { client } = s3Mock({ head: () => ({ LastModified: T0 }) });
    const files = createFileService(client, "bucket");

    await expect(files.write("notes/existing.md", "new")).rejects.toThrow("read the file first");
  });

  it("allows overwrite after read, sending the new bytes through PUT", async () => {
    const { client, calls } = s3Mock({
      head: () => ({ LastModified: T0 }),
      get: () => ({ Body: body("original"), LastModified: T0 }),
    });
    const files = createFileService(client, "bucket");

    await files.read("notes/x.md");
    await files.write("notes/x.md", "updated");

    const put = calls.find((c) => c.kind === "put");
    expect(put?.input).toMatchObject({ Key: "notes/x.md", Body: "updated" });
  });

  it("issues a single HEAD per overwrite — existence check and freshness check are one pass", async () => {
    const { client, calls } = s3Mock({
      head: () => ({ LastModified: T0 }),
      get: () => ({ Body: body("original"), LastModified: T0 }),
    });
    const files = createFileService(client, "bucket");

    await files.read("notes/x.md");
    await files.write("notes/x.md", "updated");

    expect(calls.filter((c) => c.kind === "head")).toHaveLength(1);
  });

  it("rejects overwrite when the file changed on disk since the read", async () => {
    const { client } = s3Mock({
      head: () => ({ LastModified: T1 }), // mtime is newer than what read captured
      get: vi
        .fn()
        // First GET (the read).
        .mockResolvedValueOnce({ Body: body("original"), LastModified: T0 })
        // Freshness re-fetch sees different bytes.
        .mockResolvedValueOnce({ Body: body("someone else wrote"), LastModified: T1 }),
    });
    const files = createFileService(client, "bucket");

    await files.read("notes/x.md");
    await expect(files.write("notes/x.md", "my edit")).rejects.toThrow(
      "modified since you read it",
    );
  });

  it("allows overwrite when mtime advanced but bytes are identical", async () => {
    // Benign mtime bump — e.g. an idempotent re-upload. Content compare clears it.
    const { client, calls } = s3Mock({
      head: () => ({ LastModified: T1 }),
      get: vi
        .fn()
        .mockResolvedValueOnce({ Body: body("same"), LastModified: T0 })
        .mockResolvedValueOnce({ Body: body("same"), LastModified: T1 }),
    });
    const files = createFileService(client, "bucket");

    await files.read("notes/x.md");
    await files.write("notes/x.md", "replacement");

    expect(calls.some((c) => c.kind === "put")).toBe(true);
  });

  it("rejects overwrite when the read returned a truncated view", async () => {
    const huge = "y".repeat(150_000);
    const { client } = s3Mock({
      head: () => ({ LastModified: T0 }),
      get: () => ({ Body: body(huge), LastModified: T0 }),
    });
    const files = createFileService(client, "bucket");

    await files.read("big.txt"); // returns truncated marker, caches isPartialView
    await expect(files.write("big.txt", "short replacement")).rejects.toThrow("truncated view");
  });

  it("read always issues a fresh GET, even after a write populated the cache", async () => {
    // The cache exists to gate edits/overwrites, not to serve reads. If disk
    // and cache diverge (e.g. another process wrote in between), read must
    // surface the on-disk bytes — pinning so a future "optimization" that
    // serves read from cache has to consciously update this contract.
    const { client, calls } = s3Mock({
      get: () => ({ Body: body("from disk"), LastModified: T0 }),
    });
    const files = createFileService(client, "bucket");

    await files.write("notes/x.md", "from write");
    const result = await files.read("notes/x.md");

    expect(result).toBe("from disk");
    expect(calls.filter((c) => c.kind === "get")).toHaveLength(1);
  });

  it("writing populates the read cache so a subsequent edit works without re-reading", async () => {
    // Stateful HEAD: starts as NotFound (so write creates), flips to Found
    // after PUT (so the follow-up edit sees the file as still present).
    let exists = false;
    const { client, calls } = s3Mock({
      head: () => {
        if (!exists) throw new NotFound({ $metadata: {}, message: "" });
        return { LastModified: T0 };
      },
      put: () => {
        exists = true;
        return {};
      },
    });
    const files = createFileService(client, "bucket");

    await files.write("notes/n.md", "alpha beta gamma");
    await files.edit("notes/n.md", "beta", "BETA");

    const puts = calls.filter((c) => c.kind === "put");
    expect(puts).toHaveLength(2);
    expect(puts[1]?.input).toMatchObject({ Body: "alpha BETA gamma" });
  });
});

describe("createFileService.edit", () => {
  it("rejects edit when the file no longer exists on disk since the read", async () => {
    // GET succeeds for the initial read; HEAD on the subsequent edit returns
    // NotFound, modelling an external deletion between read and edit. Edit
    // must surface this rather than silently recreating the file from cache.
    const { client } = s3Mock({
      get: () => ({ Body: body("contents"), LastModified: T0 }),
    });
    const files = createFileService(client, "bucket");

    await files.read("f.md");
    await expect(files.edit("f.md", "contents", "new contents")).rejects.toThrow(
      "no longer exists",
    );
  });

  it("rejects edit with an empty old_string at the service layer", async () => {
    // Defense in depth: the tool schema rejects empty strings with Zod, but a
    // direct service caller (e.g. a skill) goes around the schema and the
    // service must still refuse.
    const { client } = s3Mock({
      head: () => ({ LastModified: T0 }),
      get: () => ({ Body: body("contents"), LastModified: T0 }),
    });
    const files = createFileService(client, "bucket");

    await files.read("f.md");
    await expect(files.edit("f.md", "", "x")).rejects.toThrow("must be non-empty");
  });

  it("rejects edit when the file was not read first", async () => {
    const { client } = s3Mock({ head: () => ({ LastModified: T0 }) });
    const files = createFileService(client, "bucket");

    await expect(files.edit("f.md", "a", "b")).rejects.toThrow("read the file first");
  });

  it("rejects edit when the read returned a truncated view", async () => {
    const huge = `prefix ${"y".repeat(150_000)} needle ${"z".repeat(50_000)}`;
    const { client } = s3Mock({
      head: () => ({ LastModified: T0 }),
      get: () => ({ Body: body(huge), LastModified: T0 }),
    });
    const files = createFileService(client, "bucket");

    await files.read("big.txt");
    await expect(files.edit("big.txt", "needle", "found")).rejects.toThrow("truncated view");
  });

  it("rejects edit when old_string is absent", async () => {
    const { client } = s3Mock({
      head: () => ({ LastModified: T0 }),
      get: () => ({ Body: body("alpha"), LastModified: T0 }),
    });
    const files = createFileService(client, "bucket");

    await files.read("f.md");
    await expect(files.edit("f.md", "missing", "x")).rejects.toThrow("old_string not found");
  });

  it("rejects edit when old_string is ambiguous and replace_all is not set", async () => {
    const { client } = s3Mock({
      head: () => ({ LastModified: T0 }),
      get: () => ({ Body: body("foo foo"), LastModified: T0 }),
    });
    const files = createFileService(client, "bucket");

    await files.read("f.md");
    await expect(files.edit("f.md", "foo", "bar")).rejects.toThrow("old_string appears 2 times");
  });

  it("replaces the single occurrence by default", async () => {
    const { client, calls } = s3Mock({
      head: () => ({ LastModified: T0 }),
      get: () => ({ Body: body("Hello, world!"), LastModified: T0 }),
    });
    const files = createFileService(client, "bucket");

    await files.read("f.md");
    await files.edit("f.md", "world", "there");

    const put = calls.find((c) => c.kind === "put");
    expect(put?.input).toMatchObject({ Body: "Hello, there!" });
  });

  it("replaces every occurrence with replace_all", async () => {
    const { client, calls } = s3Mock({
      head: () => ({ LastModified: T0 }),
      get: () => ({ Body: body("foo foo foo"), LastModified: T0 }),
    });
    const files = createFileService(client, "bucket");

    await files.read("f.md");
    await files.edit("f.md", "foo", "bar", { replaceAll: true });

    const put = calls.find((c) => c.kind === "put");
    expect(put?.input).toMatchObject({ Body: "bar bar bar" });
  });

  it("rejects when old_string equals new_string", async () => {
    const { client } = s3Mock({
      head: () => ({ LastModified: T0 }),
      get: () => ({ Body: body("alpha"), LastModified: T0 }),
    });
    const files = createFileService(client, "bucket");

    await files.read("f.md");
    await expect(files.edit("f.md", "alpha", "alpha")).rejects.toThrow("identical");
  });

  it("rejects edit when the file changed on disk since the read", async () => {
    const { client } = s3Mock({
      head: () => ({ LastModified: T1 }),
      get: vi
        .fn()
        .mockResolvedValueOnce({ Body: body("original needle"), LastModified: T0 })
        .mockResolvedValueOnce({ Body: body("rewritten"), LastModified: T1 }),
    });
    const files = createFileService(client, "bucket");

    await files.read("f.md");
    await expect(files.edit("f.md", "needle", "thread")).rejects.toThrow(
      "modified since you read it",
    );
  });

  it("after a successful edit, the cache reflects the new bytes — chained edits work", async () => {
    const { client, calls } = s3Mock({
      head: () => ({ LastModified: T0 }),
      get: () => ({ Body: body("one two three"), LastModified: T0 }),
    });
    const files = createFileService(client, "bucket");

    await files.read("f.md");
    await files.edit("f.md", "two", "TWO");
    await files.edit("f.md", "three", "THREE");

    const puts = calls.filter((c) => c.kind === "put");
    expect(puts.at(-1)?.input).toMatchObject({ Body: "one TWO THREE" });
  });
});

describe("createFileService — read state is per-instance", () => {
  it("a separate service instance does not inherit reads", async () => {
    const { client: clientA } = s3Mock({
      head: () => ({ LastModified: T0 }),
      get: () => ({ Body: body("contents"), LastModified: T0 }),
    });
    const { client: clientB } = s3Mock({ head: () => ({ LastModified: T0 }) });

    const a = createFileService(clientA, "bucket");
    const b = createFileService(clientB, "bucket");

    await a.read("f.md");
    // Instance B never read f.md — even though it exists on its (mock) S3.
    await expect(b.write("f.md", "x")).rejects.toThrow("read the file first");
  });
});

describe("createFileService.list", () => {
  it("returns mapped entries with prefix", async () => {
    const { client, calls } = s3Mock({
      list: () => ({
        Contents: [
          { Key: "notes/a.md", Size: 100, LastModified: new Date("2026-01-01") },
          { Key: "notes/b.md", Size: 200, LastModified: new Date("2026-01-02") },
        ],
      }),
    });
    const files = createFileService(client, "bucket");

    const result = await files.list("notes/");

    expect(result).toEqual([
      { path: "notes/a.md", size: 100, lastModified: new Date("2026-01-01") },
      { path: "notes/b.md", size: 200, lastModified: new Date("2026-01-02") },
    ]);
    expect(calls[0]?.input).toMatchObject({ Bucket: "bucket", Prefix: "notes/" });
  });

  it("returns empty array when no contents", async () => {
    // S3 omits Contents when the bucket is empty; we model that with an empty list response.
    const { client } = s3Mock({ list: () => ({}) });
    const files = createFileService(client, "bucket");

    expect(await files.list()).toEqual([]);
  });

  it("omits prefix when not provided", async () => {
    const { client, calls } = s3Mock({ list: () => ({ Contents: [] }) });
    const files = createFileService(client, "bucket");

    await files.list();

    expect(calls[0]?.input).toEqual({ Bucket: "bucket" });
  });
});

describe("createFileService — client-side encryption", () => {
  it("write encrypts utf-8 bytes and stores with octet-stream content-type", async () => {
    const key = testKey();
    const { client, calls } = s3Mock();
    const files = createFileService(client, "bucket", { key });

    await files.write("notes/secret.md", "hello plaintext");

    const put = calls.find((c) => c.kind === "put");
    expect(put?.input).toMatchObject({
      Bucket: "bucket",
      Key: "notes/secret.md",
      ContentType: "application/octet-stream",
    });
    const bodyBytes = put?.input.Body;
    if (!Buffer.isBuffer(bodyBytes)) throw new Error("expected Body to be a Buffer");
    expect(isEncrypted(bodyBytes)).toBe(true);
    expect(bodyBytes.includes(Buffer.from("hello plaintext"))).toBe(false);
  });

  it("read decrypts a blob written by the encrypted writer", async () => {
    const key = testKey();
    const ciphertext = encryptBuffer(Buffer.from("notes content", "utf-8"), key);
    const { client } = s3Mock({
      get: () => ({ Body: bytesBody(ciphertext), LastModified: T0 }),
    });
    const files = createFileService(client, "bucket", { key });

    expect(await files.read("notes/secret.md")).toBe("notes content");
  });

  it("read falls back to plaintext for pre-flag files (no magic prefix)", async () => {
    const key = testKey();
    const legacy = Buffer.from("legacy plaintext markdown", "utf-8");
    const { client } = s3Mock({
      get: () => ({ Body: bytesBody(legacy), LastModified: T0 }),
    });
    const files = createFileService(client, "bucket", { key });

    expect(await files.read("notes/legacy.md")).toBe("legacy plaintext markdown");
  });

  it("read throws on wrong key", async () => {
    const ciphertext = encryptBuffer(Buffer.from("secret", "utf-8"), testKey());
    const { client } = s3Mock({
      get: () => ({ Body: bytesBody(ciphertext), LastModified: T0 }),
    });
    const files = createFileService(client, "bucket", { key: testKey() });

    await expect(files.read("notes/secret.md")).rejects.toThrow();
  });

  it("write/read round-trip preserves UTF-8 (emoji, non-ASCII)", async () => {
    const key = testKey();
    let stored: Buffer | null = null;
    const { client } = s3Mock({
      head: () => {
        throw new NotFound({ $metadata: {}, message: "" });
      },
      put: (input) => {
        if (Buffer.isBuffer(input.Body)) stored = input.Body;
        return {};
      },
      get: () => {
        if (!stored) throw new Error("no body stored");
        return { Body: bytesBody(stored), LastModified: T0 };
      },
    });
    const files = createFileService(client, "bucket", { key });

    const original = "🔒 секрет 密码 — emoji + кириллица + 汉字";
    await files.write("notes/u.md", original);
    expect(await files.read("notes/u.md")).toBe(original);
  });

  it("edit round-trips through encryption — decrypts on read, re-encrypts on PUT", async () => {
    // Edit goes GET (decrypt) → replace → PUT (encrypt). Confirms the put-side
    // encryption is wired through edit, not only through write.
    const key = testKey();
    const ciphertext = encryptBuffer(Buffer.from("alpha beta gamma", "utf-8"), key);
    const { client, calls } = s3Mock({
      head: () => ({ LastModified: T0 }),
      get: () => ({ Body: bytesBody(ciphertext), LastModified: T0 }),
    });
    const files = createFileService(client, "bucket", { key });

    await files.read("notes/secret.md");
    await files.edit("notes/secret.md", "beta", "BETA");

    const put = calls.find((c) => c.kind === "put");
    expect(put?.input.ContentType).toBe("application/octet-stream");
    const written = put?.input.Body;
    if (!Buffer.isBuffer(written)) throw new Error("expected Body to be a Buffer");
    expect(isEncrypted(written)).toBe(true);
    // Plaintext (old or new) must not appear in the ciphertext written back.
    expect(written.includes(Buffer.from("alpha BETA gamma"))).toBe(false);
    expect(written.includes(Buffer.from("alpha beta gamma"))).toBe(false);
  });

  it("list: object keys remain plaintext (matches AWS S3 Encryption Client convention)", async () => {
    const key = testKey();
    const { client } = s3Mock({
      list: () => ({
        Contents: [
          { Key: "notes/sensitive_filename.md", Size: 50, LastModified: new Date("2026-05-09") },
        ],
      }),
    });
    const files = createFileService(client, "bucket", { key });

    expect(await files.list("notes/")).toEqual([
      { path: "notes/sensitive_filename.md", size: 50, lastModified: new Date("2026-05-09") },
    ]);
  });
});
