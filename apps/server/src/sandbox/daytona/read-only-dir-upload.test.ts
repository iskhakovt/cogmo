import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox as DaytonaSdkSandbox } from "@daytona/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadReadOnlyDir } from "./read-only-dir-upload.js";

let hostDir: string;

const uploadFiles =
  vi.fn<(files: Array<{ source: Buffer; destination: string }>) => Promise<void>>();

function fakeSandbox(): DaytonaSdkSandbox {
  // The upload touches `fs.uploadFiles` alone.
  return { id: "sb-test", fs: { uploadFiles } } as unknown as DaytonaSdkSandbox;
}

beforeEach(() => {
  hostDir = mkdtempSync(join(tmpdir(), "cogmo-read-only-dir-"));
  writeFileSync(join(hostDir, "gates.mjs"), "// the bundle\n");
  writeFileSync(join(hostDir, "grammar.wasm"), "\0asm");
  uploadFiles.mockReset();
});

afterEach(() => {
  rmSync(hostDir, { recursive: true, force: true });
});

const DIR = { containerDir: "/tmp/cogmo-gates", digest: "d1" };

describe("uploadReadOnlyDir", () => {
  it("uploads each file's bytes to the container directory in one call", async () => {
    await uploadReadOnlyDir({ sandbox: fakeSandbox(), dir: { ...DIR, hostDir } });

    expect(uploadFiles).toHaveBeenCalledTimes(1);
    const uploads = uploadFiles.mock.calls[0]?.[0] ?? [];
    expect(
      Object.fromEntries(uploads.map((u) => [u.destination, u.source.toString("utf8")])),
    ).toEqual({
      "/tmp/cogmo-gates/gates.mjs": "// the bundle\n",
      "/tmp/cogmo-gates/grammar.wasm": "\0asm",
    });
  });

  it("uploads only the regular files directly in the directory", async () => {
    mkdirSync(join(hostDir, "nested"));
    writeFileSync(join(hostDir, "nested", "inner.txt"), "not uploaded");
    symlinkSync(join(hostDir, "gates.mjs"), join(hostDir, "link.mjs"));

    await uploadReadOnlyDir({ sandbox: fakeSandbox(), dir: { ...DIR, hostDir } });

    const uploads = uploadFiles.mock.calls[0]?.[0] ?? [];
    expect(uploads.map((u) => u.destination).sort()).toEqual([
      "/tmp/cogmo-gates/gates.mjs",
      "/tmp/cogmo-gates/grammar.wasm",
    ]);
  });

  it("rejects when the upload fails", async () => {
    uploadFiles.mockRejectedValue(new Error("upload 503"));

    await expect(
      uploadReadOnlyDir({ sandbox: fakeSandbox(), dir: { ...DIR, hostDir } }),
    ).rejects.toThrow(/upload 503/);
  });

  it("rejects, uploading nothing, when the directory cannot be read", async () => {
    const missing = join(hostDir, "missing");

    await expect(
      uploadReadOnlyDir({ sandbox: fakeSandbox(), dir: { ...DIR, hostDir: missing } }),
    ).rejects.toThrow(missing);
    expect(uploadFiles).not.toHaveBeenCalled();
  });
});
