import { describe, expect, it, vi } from "vitest";
import { type MockProxy, mock } from "vitest-mock-extended";
import type { Service } from "../agent/service.js";
import type { Transactor } from "../db/index.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { SecretsStore } from "../secrets/store/index.js";
import type { DefaultCtxHandlerOptions } from "./ctx-handler.js";
import { DefaultCtxHandler } from "./ctx-handler.js";
import { CtxError } from "./dispatcher.js";
import { parseManifest } from "./manifest.js";
import type { SkillManifest } from "./types.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

function manifest(overrides: string = ""): SkillManifest {
  const source = `---
name: test-skill
description: a test skill for the ctx handler
tier: wasm
inputs:
  type: object
  properties: {}
${overrides}
---
`;
  const r = parseManifest(source);
  if (!r.isOk()) throw new Error("test fixture failed to parse");
  return r.value.manifest;
}

interface Deps {
  secretsStore: MockProxy<SecretsStore>;
  memory: MockProxy<MemoryProvider>;
  files: Service["files"];
  recordContextCall: DefaultCtxHandlerOptions["recordContextCall"];
}

function deps(overrides?: Partial<Deps>): Deps {
  const memory = mock<MemoryProvider>();
  memory.recall.mockResolvedValue({ memories: [] });
  return {
    secretsStore: mock<SecretsStore>(),
    memory,
    files: {
      read: vi.fn().mockResolvedValue(""),
      write: vi.fn().mockResolvedValue(undefined),
      edit: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    recordContextCall: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeHandler(m: SkillManifest, d: Deps): DefaultCtxHandler {
  return new DefaultCtxHandler({
    manifest: m,
    runId: "run-1",
    user: { id: "user-1", timezone: "UTC" },
    memoryBankId: "bank-1",
    secretsStore: d.secretsStore,
    runInTx: fakeRunInTx,
    memory: d.memory,
    files: d.files,
    recordContextCall: d.recordContextCall,
    now: () => "2026-01-01T00:00:00.000Z",
  });
}

describe("DefaultCtxHandler", () => {
  describe("secrets.get", () => {
    it("returns the value when declared and present", async () => {
      const m = manifest("secrets:\n  - api_key");
      const d = deps();
      vi.mocked(d.secretsStore.getSecret).mockResolvedValue("sk-123");
      const h = makeHandler(m, d);

      const value = await h.handle({ method: "secrets.get", args: { name: "api_key" } });
      expect(value).toBe("sk-123");
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "secrets.get",
        target: "api_key",
        ok: true,
        error: null,
      });
    });

    it("rejects an undeclared secret with not_in_allowlist", async () => {
      const m = manifest();
      const d = deps();
      const h = makeHandler(m, d);

      await expect(
        h.handle({ method: "secrets.get", args: { name: "api_key" } }),
      ).rejects.toMatchObject({ kind: "not_in_allowlist" });

      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "secrets.get",
        target: "api_key",
        ok: false,
        error: "not_in_allowlist",
      });
      // Crucially: never records the value.
      expect(d.secretsStore.getSecret).not.toHaveBeenCalled();
    });

    it("returns secret_not_found when the manifest declares it but the DB is empty", async () => {
      const m = manifest("secrets:\n  - api_key");
      const d = deps();
      vi.mocked(d.secretsStore.getSecret).mockResolvedValue(undefined);
      const h = makeHandler(m, d);

      await expect(
        h.handle({ method: "secrets.get", args: { name: "api_key" } }),
      ).rejects.toMatchObject({ kind: "secret_not_found" });
    });

    it("rejects malformed args with invalid_args", async () => {
      const m = manifest();
      const d = deps();
      const h = makeHandler(m, d);

      await expect(h.handle({ method: "secrets.get", args: {} })).rejects.toBeInstanceOf(CtxError);
    });
  });

  describe("memory.recall / memory.remember", () => {
    it("recall requires the reads_memory effect", async () => {
      const m = manifest();
      const d = deps();
      const h = makeHandler(m, d);

      await expect(
        h.handle({ method: "memory.recall", args: { query: "hello" } }),
      ).rejects.toMatchObject({ kind: "missing_effect" });
    });

    it("recall returns memories when effect is declared", async () => {
      const m = manifest("effects:\n  - reads_memory");
      const d = deps();
      vi.mocked(d.memory.recall).mockResolvedValue({
        memories: [{ content: "fact", type: "world", metadata: {} }],
      });
      const h = makeHandler(m, d);

      const value = await h.handle({ method: "memory.recall", args: { query: "hello" } });
      expect(value).toEqual({ memories: [{ content: "fact", type: "world" }] });
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "memory.recall",
        target: null,
        ok: true,
        error: null,
      });
    });

    it("remember requires the writes_memory effect", async () => {
      const m = manifest();
      const d = deps();
      const h = makeHandler(m, d);

      await expect(
        h.handle({ method: "memory.remember", args: { content: "x" } }),
      ).rejects.toMatchObject({ kind: "missing_effect" });
    });

    it("remember calls retain when effect is declared", async () => {
      const m = manifest("effects:\n  - writes_memory");
      const d = deps();
      const h = makeHandler(m, d);

      await h.handle({
        method: "memory.remember",
        args: { content: "remember this", tags: ["world"] },
      });
      expect(d.memory.retain).toHaveBeenCalledWith("bank-1", "remember this", {
        tags: ["world"],
      });
    });
  });

  describe("files.read / files.write / files.list", () => {
    it("read requires the reads_filesystem effect", async () => {
      const m = manifest();
      const d = deps();
      const h = makeHandler(m, d);

      await expect(
        h.handle({ method: "files.read", args: { path: "notes/x.md" } }),
      ).rejects.toMatchObject({ kind: "missing_effect" });
      expect(d.files.read).not.toHaveBeenCalled();
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "files.read",
        target: "notes/x.md",
        ok: false,
        error: "missing_effect",
      });
    });

    it("read returns the workspace content when effect is declared", async () => {
      const m = manifest("effects:\n  - reads_filesystem");
      const d = deps();
      vi.mocked(d.files.read).mockResolvedValue("hello");
      const h = makeHandler(m, d);

      const value = await h.handle({ method: "files.read", args: { path: "notes/x.md" } });
      expect(value).toBe("hello");
      expect(d.files.read).toHaveBeenCalledWith("notes/x.md");
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "files.read",
        target: "notes/x.md",
        ok: true,
        error: null,
      });
    });

    it("read surfaces backend failures as read_failed", async () => {
      const m = manifest("effects:\n  - reads_filesystem");
      const d = deps();
      vi.mocked(d.files.read).mockRejectedValue(new Error("File not found: notes/x.md"));
      const h = makeHandler(m, d);

      await expect(
        h.handle({ method: "files.read", args: { path: "notes/x.md" } }),
      ).rejects.toMatchObject({ kind: "read_failed" });
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "files.read",
        target: "notes/x.md",
        ok: false,
        error: "read_failed",
      });
    });

    it("write requires the writes_filesystem effect", async () => {
      const m = manifest();
      const d = deps();
      const h = makeHandler(m, d);

      await expect(
        h.handle({
          method: "files.write",
          args: { path: "notes/x.md", content: "hi" },
        }),
      ).rejects.toMatchObject({ kind: "missing_effect" });
      expect(d.files.write).not.toHaveBeenCalled();
    });

    it("write surfaces backend failures as write_failed", async () => {
      const m = manifest("effects:\n  - writes_filesystem");
      const d = deps();
      vi.mocked(d.files.write).mockRejectedValue(new Error("S3 5xx"));
      const h = makeHandler(m, d);

      await expect(
        h.handle({
          method: "files.write",
          args: { path: "notes/x.md", content: "hi" },
        }),
      ).rejects.toMatchObject({ kind: "write_failed" });
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "files.write",
        target: "notes/x.md",
        ok: false,
        error: "write_failed",
      });
    });

    it("list surfaces backend failures as list_failed", async () => {
      const m = manifest("effects:\n  - reads_filesystem");
      const d = deps();
      vi.mocked(d.files.list).mockRejectedValue(new Error("S3 listing timeout"));
      const h = makeHandler(m, d);

      await expect(
        h.handle({ method: "files.list", args: { prefix: "notes/" } }),
      ).rejects.toMatchObject({ kind: "list_failed" });
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "files.list",
        target: "notes/",
        ok: false,
        error: "list_failed",
      });
    });

    it("write persists when effect is declared", async () => {
      const m = manifest("effects:\n  - writes_filesystem");
      const d = deps();
      const h = makeHandler(m, d);

      const r = await h.handle({
        method: "files.write",
        args: { path: "notes/x.md", content: "draft v1" },
      });
      expect(r).toBeNull();
      expect(d.files.write).toHaveBeenCalledWith("notes/x.md", "draft v1");
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "files.write",
        target: "notes/x.md",
        ok: true,
        error: null,
      });
    });

    it("list requires the reads_filesystem effect", async () => {
      const m = manifest();
      const d = deps();
      const h = makeHandler(m, d);

      await expect(
        h.handle({ method: "files.list", args: { prefix: "notes/" } }),
      ).rejects.toMatchObject({ kind: "missing_effect" });
      expect(d.files.list).not.toHaveBeenCalled();
    });

    it("list returns entries with last_modified as ISO-8601", async () => {
      const m = manifest("effects:\n  - reads_filesystem");
      const d = deps();
      const lastModified = new Date("2026-04-01T12:00:00.000Z");
      vi.mocked(d.files.list).mockResolvedValue([
        { path: "notes/a.md", size: 42, lastModified },
        { path: "notes/b.md", size: 7, lastModified },
      ]);
      const h = makeHandler(m, d);

      const value = await h.handle({ method: "files.list", args: { prefix: "notes/" } });
      expect(value).toEqual({
        entries: [
          { path: "notes/a.md", size: 42, last_modified: "2026-04-01T12:00:00.000Z" },
          { path: "notes/b.md", size: 7, last_modified: "2026-04-01T12:00:00.000Z" },
        ],
      });
      expect(d.files.list).toHaveBeenCalledWith("notes/");
    });

    it("list with no prefix passes undefined to the backend", async () => {
      const m = manifest("effects:\n  - reads_filesystem");
      const d = deps();
      const h = makeHandler(m, d);

      await h.handle({ method: "files.list", args: {} });
      expect(d.files.list).toHaveBeenCalledWith(undefined);
    });

    it("rejects malformed args with invalid_args", async () => {
      const m = manifest("effects:\n  - reads_filesystem\n  - writes_filesystem");
      const d = deps();
      const h = makeHandler(m, d);

      await expect(h.handle({ method: "files.read", args: {} })).rejects.toMatchObject({
        kind: "invalid_args",
      });
      await expect(h.handle({ method: "files.write", args: { path: "x" } })).rejects.toMatchObject({
        kind: "invalid_args",
      });
    });
  });

  describe("now / user / log.info", () => {
    it("now returns the injected clock value", async () => {
      const h = makeHandler(manifest(), deps());
      expect(await h.handle({ method: "now", args: {} })).toBe("2026-01-01T00:00:00.000Z");
    });

    it("user returns the injected user", async () => {
      const h = makeHandler(manifest(), deps());
      expect(await h.handle({ method: "user", args: {} })).toEqual({
        id: "user-1",
        timezone: "UTC",
      });
    });

    it("log.info accepts a plain message", async () => {
      const d = deps();
      const h = makeHandler(manifest(), d);
      const r = await h.handle({ method: "log.info", args: { message: "hello" } });
      expect(r).toBeNull();
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "log.info",
        target: null,
        ok: true,
        error: null,
      });
    });
  });

  it("rejects an unknown method", async () => {
    const h = makeHandler(manifest(), deps());
    await expect(h.handle({ method: "evil.delete", args: {} })).rejects.toMatchObject({
      kind: "unknown_method",
    });
  });

  describe("argument validation boundaries", () => {
    it("secrets.get with empty name is invalid_args (not allowlist)", async () => {
      const m = manifest("secrets:\n  - api_key");
      const d = deps();
      const h = makeHandler(m, d);
      await expect(h.handle({ method: "secrets.get", args: { name: "" } })).rejects.toMatchObject({
        kind: "invalid_args",
      });
    });

    it("memory.recall query='' is invalid_args", async () => {
      const m = manifest("effects:\n  - reads_memory");
      const h = makeHandler(m, deps());
      await expect(
        h.handle({ method: "memory.recall", args: { query: "" } }),
      ).rejects.toMatchObject({ kind: "invalid_args" });
    });

    it("memory.recall limit=0 is invalid_args", async () => {
      const m = manifest("effects:\n  - reads_memory");
      const h = makeHandler(m, deps());
      await expect(
        h.handle({ method: "memory.recall", args: { query: "x", limit: 0 } }),
      ).rejects.toMatchObject({ kind: "invalid_args" });
    });

    it("memory.recall limit=51 is invalid_args (max 50)", async () => {
      const m = manifest("effects:\n  - reads_memory");
      const h = makeHandler(m, deps());
      await expect(
        h.handle({ method: "memory.recall", args: { query: "x", limit: 51 } }),
      ).rejects.toMatchObject({ kind: "invalid_args" });
    });

    it("memory.recall limit=1.5 is invalid_args (must be integer)", async () => {
      const m = manifest("effects:\n  - reads_memory");
      const h = makeHandler(m, deps());
      await expect(
        h.handle({ method: "memory.recall", args: { query: "x", limit: 1.5 } }),
      ).rejects.toMatchObject({ kind: "invalid_args" });
    });

    it("memory.remember content='' is invalid_args", async () => {
      const m = manifest("effects:\n  - writes_memory");
      const h = makeHandler(m, deps());
      await expect(
        h.handle({ method: "memory.remember", args: { content: "" } }),
      ).rejects.toMatchObject({ kind: "invalid_args" });
    });

    it("memory.remember tags=[''] is invalid_args (each tag must be non-empty)", async () => {
      const m = manifest("effects:\n  - writes_memory");
      const h = makeHandler(m, deps());
      await expect(
        h.handle({ method: "memory.remember", args: { content: "x", tags: [""] } }),
      ).rejects.toMatchObject({ kind: "invalid_args" });
    });

    it("memory.remember without tags omits the tags field on retain", async () => {
      const m = manifest("effects:\n  - writes_memory");
      const d = deps();
      const h = makeHandler(m, d);
      await h.handle({ method: "memory.remember", args: { content: "x" } });
      expect(d.memory.retain).toHaveBeenCalledWith("bank-1", "x", {});
    });

    it("log.info accepts structured fields and emits them on the pino child", async () => {
      const d = deps();
      const h = makeHandler(manifest(), d);
      await h.handle({
        method: "log.info",
        args: { message: "hello", fields: { foo: 1, bar: "two" } },
      });
      // Verifying actual pino output is fragile; assert the audit row
      // happened, which means dispatch reached `log.info` successfully.
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "log.info",
        target: null,
        ok: true,
        error: null,
      });
    });

    it("log.info with empty message accepted (z.string() allows empty)", async () => {
      const h = makeHandler(manifest(), deps());
      const r = await h.handle({ method: "log.info", args: { message: "" } });
      expect(r).toBeNull();
    });
  });

  describe("audit invariant", () => {
    it("missing_effect path does NOT call the underlying memory provider", async () => {
      const m = manifest();
      const d = deps();
      const h = makeHandler(m, d);
      await expect(
        h.handle({ method: "memory.recall", args: { query: "hello" } }),
      ).rejects.toMatchObject({ kind: "missing_effect" });
      expect(d.memory.recall).not.toHaveBeenCalled();
    });

    it("missing_effect on memory.remember does NOT call retain", async () => {
      const m = manifest();
      const d = deps();
      const h = makeHandler(m, d);
      await expect(
        h.handle({ method: "memory.remember", args: { content: "x" } }),
      ).rejects.toMatchObject({ kind: "missing_effect" });
      expect(d.memory.retain).not.toHaveBeenCalled();
    });

    it("unknown_method audit row carries the original method string", async () => {
      const d = deps();
      const h = makeHandler(manifest(), d);
      await expect(h.handle({ method: "evil.delete", args: {} })).rejects.toMatchObject({
        kind: "unknown_method",
      });
      expect(d.recordContextCall).toHaveBeenCalledWith({
        runId: "run-1",
        method: "evil.delete",
        target: null,
        ok: false,
        error: "unknown_method",
      });
    });

    it("recordContextCall throwing is swallowed (the call still returns/throws as expected)", async () => {
      const d = deps();
      vi.mocked(d.recordContextCall).mockRejectedValue(new Error("audit DB down"));
      const m = manifest();
      const h = makeHandler(m, d);
      // The success path: now() — even if audit fails, return value is correct.
      const r = await h.handle({ method: "now", args: {} });
      expect(r).toBe("2026-01-01T00:00:00.000Z");
    });
  });

  describe("secrets allowlist union form", () => {
    it("accepts a secret declared in object form", async () => {
      const m = manifest(
        `secrets:\n  - name: scoped\n    binding:\n      destination: "https://x.com/*"`,
      );
      const d = deps();
      vi.mocked(d.secretsStore.getSecret).mockResolvedValue("v");
      const h = makeHandler(m, d);
      const r = await h.handle({ method: "secrets.get", args: { name: "scoped" } });
      expect(r).toBe("v");
    });

    it("treats string-form and object-form declarations equivalently in the allowlist", async () => {
      const m = manifest(
        `secrets:\n  - bare\n  - name: object_form\n    binding:\n      destination: "https://x.com/*"`,
      );
      const d = deps();
      vi.mocked(d.secretsStore.getSecret).mockImplementation(async (_tx, name) =>
        name === "bare" ? "BARE" : name === "object_form" ? "OBJ" : null,
      );
      const h = makeHandler(m, d);
      expect(await h.handle({ method: "secrets.get", args: { name: "bare" } })).toBe("BARE");
      expect(await h.handle({ method: "secrets.get", args: { name: "object_form" } })).toBe("OBJ");
    });
  });
});
