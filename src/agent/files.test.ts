import { NoSuchKey } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { createFileService } from "./files.js";

function mockS3Client(overrides?: { send?: ReturnType<typeof vi.fn> }) {
  return { send: overrides?.send ?? vi.fn(), destroy: vi.fn() } as any;
}

function mockBody(content: string) {
  return { transformToString: vi.fn().mockResolvedValue(content) };
}

describe("createFileService", () => {
  describe("read", () => {
    it("reads file content from S3", async () => {
      const send = vi.fn().mockResolvedValue({ Body: mockBody("hello world") });
      const files = createFileService(mockS3Client({ send }), "test-bucket");

      const result = await files.read("notes/test.md");

      expect(result).toBe("hello world");
      const command = send.mock.calls[0][0];
      expect(command.input).toEqual({ Bucket: "test-bucket", Key: "notes/test.md" });
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

      const command = send.mock.calls[0][0];
      expect(command.input).toMatchObject({
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
      const command = send.mock.calls[0][0];
      expect(command.input).toMatchObject({ Bucket: "test-bucket", Prefix: "notes/" });
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

      const command = send.mock.calls[0][0];
      expect(command.input).toEqual({ Bucket: "test-bucket" });
    });
  });
});
