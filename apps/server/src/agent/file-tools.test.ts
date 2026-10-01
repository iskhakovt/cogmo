import { GetObjectCommand, HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { err, ok } from "neverthrow";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { LlmProvider } from "../llm/provider.js";
import type { LlmResponse } from "../llm/types.js";
import { mockFilesService } from "../test/factories.js";
import { editFile, listFiles, readFile, writeFile } from "./file-tools.js";
import { createFileService } from "./files.js";
import { runAgentLoop } from "./loop.js";
import type { Service } from "./service.js";
import { ToolRegistry } from "./tools.js";

function mockService(filesOverrides?: Partial<Service["files"]>): Service {
  const files = mockFilesService({
    read: vi.fn().mockResolvedValue(ok("file content")),
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
    const svc = mockService({ read: vi.fn().mockResolvedValue(ok("hello world")) });
    const result = (await readFile.handler({ path: "notes/test.md" }, svc))._unsafeUnwrap();

    expect(result).toBe("hello world");
    expect(svc.files.read).toHaveBeenCalledWith("notes/test.md");
  });

  it("passes through truncation marker from service", async () => {
    // Truncation now lives in the service; the tool returns whatever read produces.
    const truncated = `${"x".repeat(100_000)}\n\n[Content truncated at 100000 characters. Edits and overwrites are blocked until the file is read in full.]`;
    const svc = mockService({ read: vi.fn().mockResolvedValue(ok(truncated)) });
    const result = (await readFile.handler({ path: "big.txt" }, svc))._unsafeUnwrap();

    expect(result).toContain("[Content truncated");
  });

  it("rejects a missing file", async () => {
    const svc = mockService({
      read: vi.fn().mockResolvedValue(err({ kind: "not_found", path: "gone.md" })),
    });

    const result = await readFile.handler({ path: "gone.md" }, svc);

    expect(result._unsafeUnwrapErr().message).toBe("File not found: gone.md");
  });
});

describe("write_file", () => {
  it("writes content via service and returns byte count", async () => {
    const svc = mockService();
    const result = (
      await writeFile.handler({ path: "notes/new.md", content: "hello" }, svc)
    )._unsafeUnwrap();

    expect(svc.files.write).toHaveBeenCalledWith("notes/new.md", "hello");
    expect(result).toContain("5 bytes");
    expect(result).toContain("notes/new.md");
  });

  it("rejects with the service's file error", async () => {
    const svc = mockService({
      write: vi
        .fn()
        .mockResolvedValue(err({ kind: "not_read", path: "notes/x.md", op: "overwrite" })),
    });

    const result = await writeFile.handler({ path: "notes/x.md", content: "y" }, svc);

    expect(result._unsafeUnwrapErr().message).toBe(
      "Cannot overwrite notes/x.md: read the file first so you act on its current contents.",
    );
  });
});

describe("edit_file", () => {
  it("calls service.files.edit with old/new strings and default replace_all=false", async () => {
    const svc = mockService();
    const result = (
      await editFile.handler({ path: "notes/n.md", old_string: "a", new_string: "b" }, svc)
    )._unsafeUnwrap();

    expect(svc.files.edit).toHaveBeenCalledWith("notes/n.md", "a", "b", { replaceAll: false });
    expect(result).toBe("Edited notes/n.md");
  });

  it("threads replace_all=true into the service call", async () => {
    const svc = mockService();
    await editFile.handler(
      { path: "notes/n.md", old_string: "a", new_string: "b", replace_all: true },
      svc,
    );

    expect(svc.files.edit).toHaveBeenCalledWith("notes/n.md", "a", "b", { replaceAll: true });
  });

  it("rejects with the service's file error", async () => {
    const svc = mockService({
      edit: vi
        .fn()
        .mockResolvedValue(err({ kind: "ambiguous_old_string", path: "n.md", occurrences: 3 })),
    });

    const result = await editFile.handler({ path: "n.md", old_string: "x", new_string: "y" }, svc);

    expect(result._unsafeUnwrapErr().message).toContain("old_string appears 3 times");
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

    const result = (await listFiles.handler({ prefix: "notes/" }, svc))._unsafeUnwrap();

    expect(result).toContain("notes/a.md");
    expect(result).toContain("512B");
    expect(result).toContain("notes/b.md");
    expect(result).toContain("2.0KB");
    expect(svc.files.list).toHaveBeenCalledWith("notes/");
  });

  it("handles empty workspace", async () => {
    const svc = mockService({ list: vi.fn().mockResolvedValue([]) });
    const result = (await listFiles.handler({}, svc))._unsafeUnwrap();

    expect(result).toContain("No files");
  });

  it("shows prefix in empty message when filtered", async () => {
    const svc = mockService({ list: vi.fn().mockResolvedValue([]) });
    const result = (await listFiles.handler({ prefix: "drafts/" }, svc))._unsafeUnwrap();

    expect(result).toContain('prefix "drafts/"');
  });
});

describe("file tools in the loop", () => {
  const MODIFIED = new Date("2026-05-19T10:00:00Z");

  /** An S3 client holding one object, `notes/n.md`, reading "hello world". */
  function oneObjectClient(): S3Client {
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof HeadObjectCommand) return { LastModified: MODIFIED };
      if (cmd instanceof GetObjectCommand) {
        return { Body: { transformToString: async () => "hello world" }, LastModified: MODIFIED };
      }
      throw new Error("unexpected S3 command");
    });
    // A structural stub: the file service only calls `send`.
    return { send } as unknown as S3Client;
  }

  function toolUse(name: string, id: string, input: unknown): LlmResponse {
    return {
      content: [{ type: "tool_use", id, name, input }],
      stopReason: "tool_use",
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }

  it("answers an edit whose old_string is missing with an is_error result and logs no bug", async () => {
    const chat = vi
      .fn<LlmProvider["chat"]>()
      .mockResolvedValueOnce(toolUse("read_file", "t1", { path: "notes/n.md" }))
      .mockResolvedValueOnce(
        toolUse("edit_file", "t2", { path: "notes/n.md", old_string: "absent", new_string: "x" }),
      )
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    const provider = mock<LlmProvider>({ name: "mock", chat });
    const tools = new ToolRegistry();
    tools.register(readFile);
    tools.register(editFile);
    const service = mockService();
    service.files = createFileService(oneObjectClient(), "bucket");
    const turnLogger = mock<Logger>();

    const result = await runAgentLoop({
      provider,
      model: "test",
      systemPrompt: "sys",
      service,
      turnLogger,
      tools,
      messages: [{ role: "user", content: "edit it" }],
    });

    expect(result.messages[4]?.content).toEqual([
      {
        type: "tool_result",
        toolUseId: "t2",
        content: "Error: Cannot edit notes/n.md: old_string not found.",
        isError: true,
      },
    ]);
    expect(turnLogger.error).not.toHaveBeenCalled();
  });
});
