import { NoSuchKey } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { encryptBuffer, isEncrypted } from "../secrets/blob-envelope.js";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../secrets/encryption.js";
import { createFileService } from "./files.js";

function mockS3Client(overrides?: { send?: ReturnType<typeof vi.fn> }) {
  return { send: overrides?.send ?? vi.fn(), destroy: vi.fn() } as any;
}

function firstSendInput(send: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = send.mock.calls[0];
  if (!call) throw new Error("expected s3 client send to have been called");
  const command = call[0] as { input?: Record<string, unknown> };
  return command.input ?? {};
}

function mockBody(content: string) {
  return { transformToString: vi.fn().mockResolvedValue(content) };
}

function mockBytesBody(bytes: Uint8Array) {
  return { transformToByteArray: vi.fn().mockResolvedValue(bytes) };
}

function testKey(): Uint8Array {
  return deriveMasterKey(parseMasterKey(generateMasterKey()), "cogmo/s3-attachments/v1");
}

describe("createFileService", () => {
  describe("read", () => {
    it("reads file content from S3", async () => {
      const send = vi.fn().mockResolvedValue({ Body: mockBody("hello world") });
      const files = createFileService(mockS3Client({ send }), "test-bucket");

      const result = await files.read("notes/test.md");

      expect(result).toBe("hello world");
      expect(firstSendInput(send)).toEqual({ Bucket: "test-bucket", Key: "notes/test.md" });
    });

    it("throws 'File not found' on NoSuchKey", async () => {
      const send = vi.fn().mockRejectedValue(new NoSuchKey({ $metadata: {}, message: "" }));
      const files = createFileService(mockS3Client({ send }), "test-bucket");

      await expect(files.read("missing.txt")).rejects.toThrow("File not found: missing.txt");
    });

    it("re-throws non-NoSuchKey errors", async () => {
      const send = vi.fn().mockRejectedValue(new Error("network error"));
      const files = createFileService(mockS3Client({ send }), "test-bucket");

      await expect(files.read("file.txt")).rejects.toThrow("network error");
    });
  });

  describe("write", () => {
    it("writes content to S3 with correct params", async () => {
      const send = vi.fn().mockResolvedValue({});
      const files = createFileService(mockS3Client({ send }), "test-bucket");

      await files.write("notes/new.md", "content here");

      expect(firstSendInput(send)).toMatchObject({
        Bucket: "test-bucket",
        Key: "notes/new.md",
        Body: "content here",
        ContentType: "text/plain; charset=utf-8",
      });
    });
  });

  describe("list", () => {
    it("lists files with prefix", async () => {
      const send = vi.fn().mockResolvedValue({
        Contents: [
          { Key: "notes/a.md", Size: 100, LastModified: new Date("2026-01-01") },
          { Key: "notes/b.md", Size: 200, LastModified: new Date("2026-01-02") },
        ],
      });
      const files = createFileService(mockS3Client({ send }), "test-bucket");

      const result = await files.list("notes/");

      expect(result).toEqual([
        { path: "notes/a.md", size: 100, lastModified: new Date("2026-01-01") },
        { path: "notes/b.md", size: 200, lastModified: new Date("2026-01-02") },
      ]);
      expect(firstSendInput(send)).toMatchObject({ Bucket: "test-bucket", Prefix: "notes/" });
    });

    it("returns empty array when no contents", async () => {
      const send = vi.fn().mockResolvedValue({ Contents: undefined });
      const files = createFileService(mockS3Client({ send }), "test-bucket");

      const result = await files.list();

      expect(result).toEqual([]);
    });

    it("omits prefix when not provided", async () => {
      const send = vi.fn().mockResolvedValue({ Contents: [] });
      const files = createFileService(mockS3Client({ send }), "test-bucket");

      await files.list();

      expect(firstSendInput(send)).toEqual({ Bucket: "test-bucket" });
    });
  });

  describe("with client-side encryption", () => {
    it("write: encrypts utf-8 bytes and stores with octet-stream content-type", async () => {
      const key = testKey();
      const send = vi.fn().mockResolvedValue({});
      const files = createFileService(mockS3Client({ send }), "test-bucket", { key });

      await files.write("notes/secret.md", "hello plaintext");

      const input = firstSendInput(send);
      expect(input).toMatchObject({
        Bucket: "test-bucket",
        Key: "notes/secret.md",
        ContentType: "application/octet-stream",
      });
      const body = input.Body;
      expect(Buffer.isBuffer(body)).toBe(true);
      const buf = body as Buffer;
      expect(isEncrypted(buf)).toBe(true);
      // Plaintext must NOT appear in the body that hits S3.
      expect(buf.includes(Buffer.from("hello plaintext"))).toBe(false);
    });

    it("read: decrypts a blob written by the encrypted writer", async () => {
      const key = testKey();
      const ciphertext = encryptBuffer(Buffer.from("notes content", "utf-8"), key);
      const send = vi.fn().mockResolvedValue({ Body: mockBytesBody(ciphertext) });
      const files = createFileService(mockS3Client({ send }), "test-bucket", { key });

      const result = await files.read("notes/secret.md");

      expect(result).toBe("notes content");
    });

    it("read: falls back to plaintext for pre-flag files (no magic prefix)", async () => {
      // Operator turned the flag on after the bucket already had files.
      const key = testKey();
      const legacyBytes = Buffer.from("legacy plaintext markdown", "utf-8");
      const send = vi.fn().mockResolvedValue({ Body: mockBytesBody(legacyBytes) });
      const files = createFileService(mockS3Client({ send }), "test-bucket", { key });

      const result = await files.read("notes/legacy.md");

      expect(result).toBe("legacy plaintext markdown");
    });

    it("read: throws on wrong key", async () => {
      const ciphertext = encryptBuffer(Buffer.from("secret", "utf-8"), testKey());
      const send = vi.fn().mockResolvedValue({ Body: mockBytesBody(ciphertext) });
      const files = createFileService(mockS3Client({ send }), "test-bucket", { key: testKey() });

      await expect(files.read("notes/secret.md")).rejects.toThrow();
    });

    it("write/read round-trip preserves UTF-8 (emoji, non-ASCII)", async () => {
      const key = testKey();
      let stored: Buffer | null = null;
      const send = vi.fn().mockImplementation(async (cmd: { input: { Body?: Buffer } }) => {
        if (cmd.input.Body !== undefined) {
          stored = cmd.input.Body;
          return {};
        }
        if (!stored) throw new Error("no body stored");
        return { Body: mockBytesBody(stored) };
      });
      const files = createFileService(mockS3Client({ send }), "test-bucket", { key });

      const original = "🔒 секрет 密码 — emoji + кириллица + 汉字";
      await files.write("notes/u.md", original);
      const result = await files.read("notes/u.md");

      expect(result).toBe(original);
    });

    it("list: object keys remain plaintext (matches AWS S3 Encryption Client convention)", async () => {
      // Encryption doesn't hide names — that's documented behavior, mirrors
      // AWS S3 Encryption Client. This test is a contract assertion: the
      // result of list() looks identical with or without encryption.
      const key = testKey();
      const send = vi.fn().mockResolvedValue({
        Contents: [
          { Key: "notes/sensitive_filename.md", Size: 50, LastModified: new Date("2026-05-09") },
        ],
      });
      const files = createFileService(mockS3Client({ send }), "test-bucket", { key });

      const result = await files.list("notes/");

      expect(result).toEqual([
        { path: "notes/sensitive_filename.md", size: 50, lastModified: new Date("2026-05-09") },
      ]);
    });
  });
});
