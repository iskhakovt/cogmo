import { describe, expect, it, vi } from "vitest";
import { fileTools } from "./file-tools.js";
import type { Service } from "./service.js";

const [readFile, writeFile, listFiles] = fileTools;

function mockService(filesOverrides?: Partial<Service["files"]>): Service {
  return {
    memory: {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
      retain: vi.fn().mockResolvedValue(undefined),
    },
    files: {
      read: vi.fn().mockResolvedValue("file content"),
      write: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      ...filesOverrides,
    },
  };
}

describe("read_file", () => {
  it("reads file content via service", async () => {
    const svc = mockService({ read: vi.fn().mockResolvedValue("hello world") });
    const result = await readFile!.handler({ path: "notes/test.md" }, svc);

    expect(result).toBe("hello world");
    expect(svc.files.read).toHaveBeenCalledWith("notes/test.md");
  });

  it("truncates large files", async () => {
    const large = "x".repeat(200_000);
    const svc = mockService({ read: vi.fn().mockResolvedValue(large) });
    const result = await readFile!.handler({ path: "big.txt" }, svc);

    expect(result).toContain("[Content truncated");
    expect(result.length).toBeLessThan(200_000);
  });
});

describe("write_file", () => {
  it("writes content via service and returns byte count", async () => {
    const svc = mockService();
    const result = await writeFile!.handler({ path: "notes/new.md", content: "hello" }, svc);

    expect(svc.files.write).toHaveBeenCalledWith("notes/new.md", "hello");
    expect(result).toContain("5 bytes");
    expect(result).toContain("notes/new.md");
  });
});

describe("list_files", () => {
  it("returns formatted file listing", async () => {
    const svc = mockService({
      list: vi.fn().mockResolvedValue([
        { path: "notes/a.md", size: 512, lastModified: new Date("2026-01-01") },
        { path: "notes/b.md", size: 2048, lastModified: new Date("2026-01-02") },
      ]),
    });

    const result = await listFiles!.handler({ prefix: "notes/" }, svc);

    expect(result).toContain("notes/a.md");
    expect(result).toContain("512B");
    expect(result).toContain("notes/b.md");
    expect(result).toContain("2.0KB");
    expect(svc.files.list).toHaveBeenCalledWith("notes/");
  });

  it("handles empty workspace", async () => {
    const svc = mockService({ list: vi.fn().mockResolvedValue([]) });
    const result = await listFiles!.handler({}, svc);

    expect(result).toContain("No files");
  });

  it("shows prefix in empty message when filtered", async () => {
    const svc = mockService({ list: vi.fn().mockResolvedValue([]) });
    const result = await listFiles!.handler({ prefix: "drafts/" }, svc);

    expect(result).toContain('prefix "drafts/"');
  });
});
