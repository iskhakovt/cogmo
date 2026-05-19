import { describe, expect, it, vi } from "vitest";
import { mockFilesService } from "../test/factories.js";
import { fileTools } from "./file-tools.js";
import type { Service } from "./service.js";

const [readFile, writeFile, editFile, listFiles] = fileTools;

function mockService(filesOverrides?: Partial<Service["files"]>): Service {
  const files = mockFilesService({
    read: vi.fn().mockResolvedValue("file content"),
    ...filesOverrides,
  });
  return {
    memory: {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
      retain: vi.fn().mockResolvedValue(undefined),
      reflect: vi.fn().mockResolvedValue({ answer: "" }),
      stageRetain: vi.fn().mockResolvedValue(undefined),
    },
    files,
    coreMemory: {
      get: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
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

  it("passes through truncation marker from service", async () => {
    // Truncation now lives in the service; the tool returns whatever read produces.
    const truncated = `${"x".repeat(100_000)}\n\n[Content truncated at 100000 characters. Edits and overwrites are blocked until the file is read in full.]`;
    const svc = mockService({ read: vi.fn().mockResolvedValue(truncated) });
    const result = await readFile!.handler({ path: "big.txt" }, svc);

    expect(result).toContain("[Content truncated");
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

  it("propagates service errors verbatim", async () => {
    const svc = mockService({
      write: vi.fn().mockRejectedValue(new Error("read the file first before overwriting")),
    });

    await expect(writeFile!.handler({ path: "notes/x.md", content: "y" }, svc)).rejects.toThrow(
      "read the file first",
    );
  });
});

describe("edit_file", () => {
  it("calls service.files.edit with old/new strings and default replace_all=false", async () => {
    const svc = mockService();
    const result = await editFile!.handler(
      { path: "notes/n.md", old_string: "a", new_string: "b" },
      svc,
    );

    expect(svc.files.edit).toHaveBeenCalledWith("notes/n.md", "a", "b", { replaceAll: false });
    expect(result).toBe("Edited notes/n.md");
  });

  it("threads replace_all=true into the service call", async () => {
    const svc = mockService();
    await editFile!.handler(
      { path: "notes/n.md", old_string: "a", new_string: "b", replace_all: true },
      svc,
    );

    expect(svc.files.edit).toHaveBeenCalledWith("notes/n.md", "a", "b", { replaceAll: true });
  });

  it("propagates service errors verbatim", async () => {
    const svc = mockService({
      edit: vi.fn().mockRejectedValue(new Error("old_string appears 3 times")),
    });

    await expect(
      editFile!.handler({ path: "n.md", old_string: "x", new_string: "y" }, svc),
    ).rejects.toThrow("old_string appears 3 times");
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
